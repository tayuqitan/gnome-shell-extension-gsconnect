// SPDX-License-Identifier: GPL-2.0-or-later
// Production methods/helper with mocked GIO boundary. No Device/backend imports.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const load = path => readFileSync(new URL(path, import.meta.url), 'utf8');
const core = load('../../src/service/core.js');
const device = load('../../src/service/device.js');
const lan = load('../../src/service/backends/lan.js');
const helper = load('../../src/service/utils/packetBytes.js');
/**
 * Extract a unique unchanged production method.
 * @param {string} source - Source text
 * @param {string} signature - Method boundary
 * @returns {string} Method text
 */
function extract(source, signature) {
    assert.equal(source.split(signature).length, 2);
    const start = source.indexOf(signature);
    const end = source.indexOf('\n    /**', start);
    assert.ok(end > start);
    return source.slice(start, end);
}
/**
 * Instantiate production methods with fake native pending/completion semantics.
 * @returns {object} Captured state and operation controls
 */
function fixture() {
    class IOError extends Error {
        static CANCELLED = 1;
        static FAILED = 2;
        static PENDING = 3;
        static PARTIAL_INPUT = 4;
        constructor({code, message}) { super(message); this.code = code; }
        matches(domain, code) { return domain === IOError && this.code === code; }
    }
    class Bytes {
        constructor(bytes) { this.bytes = new Uint8Array(bytes); }
        get_size() { return this.bytes.length; }
    }
    const inputs = [], calls = [], delivered = [], logs = [];
    let completion = null;
    const target = {
        splice_async(input, flags, priority, token, callback) {
            calls.push({input, flags, priority, token});
            if (completion) {
                queueMicrotask(() => callback(target, {error: new IOError({code: IOError.PENDING, message: 'PENDING'})}));
                return;
            }
            completion = (error, count = input.owned.get_size()) => {
                completion = null;
                if (!error)
                    delivered.push(new TextDecoder().decode(input.owned.bytes));
                callback(target, {error, count});
            };
        },
        splice_finish(result) { if (result.error) throw result.error; return result.count; },
    };
    const scope = {TextEncoder, GLib: {Bytes, PRIORITY_DEFAULT: 0},
        Gio: {IOErrorEnum: IOError, OutputStreamSpliceFlags: {CLOSE_SOURCE: 1},
            MemoryInputStream: {new_from_bytes(owned) {
                const input = {owned, closed: false, close() { this.closed = true; }};
                inputs.push(input);
                return input;
            }}},
        debug: (...args) => logs.push(args),
    };
    vm.runInNewContext(helper.replace(/^import .*;$/gm, '').replace('export ', ''), scope);
    vm.runInNewContext(`this.Packet = class {
        constructor(data) { Object.assign(this, data); }
        ${extract(core, '    serialize() {')}
    };
    this.Channel = class {${extract(core, '    sendPacket(packet, cancellable = null) {')}};
    this.Queue = class {${extract(device, '    async sendPacket(packet) {')}};
    this.Lan = class {${extract(lan, '    async _exchangeIdentities() {')}};`, scope);
    scope.Core = {Packet: scope.Packet};
    const channel = new scope.Channel();
    channel.output_stream = target;
    channel.cancellable = {name: 'channel-token'};
    const queue = new scope.Queue();
    Object.assign(queue, {channel, connected: true, paired: true,
        _outputQueue: [], _outputLock: false, name: 'fixture'});
    return {queue, channel, scope, calls, delivered, logs, inputs, IOError,
        complete: (error, count) => { assert.ok(completion); completion(error, count); },
        packet: text => new scope.Packet({type: 'fixture', body: {text}})};
}
const tick = async () => { await Promise.resolve(); await Promise.resolve(); };
const data = text => ({type: 'fixture', body: {text}});

test('production Device queue serializes packets; queued caller retains existing early-return semantics', async () => {
    const f = fixture();
    const first = f.queue.sendPacket(data('first'));
    await f.queue.sendPacket(data('中文 second'));
    assert.equal(f.calls.length, 1);
    assert.equal(f.queue._outputQueue.length, 1);
    assert.equal(f.queue._outputLock, true);
    f.complete();
    await tick();
    assert.equal(f.calls.length, 2);
    f.complete();
    assert.equal(await first, undefined);
    assert.equal(f.queue._outputLock, false);
    assert.deepEqual(f.delivered.map(line => JSON.parse(line).body.text), ['first', '中文 second']);
    assert.ok(f.inputs.every(input => input.closed));
});

for (const name of ['CANCELLED', 'FAILED']) {
    test(`production Device ${name} releases lock; pending queue resumes only on later send`, async () => {
        const f = fixture();
        const first = f.queue.sendPacket(data('failed first'));
        await f.queue.sendPacket(data('queued second'));
        f.complete(new f.IOError({code: f.IOError[name], message: name}));
        await first;
        assert.equal(f.queue._outputLock, false);
        assert.equal(f.queue._outputQueue.length, 1);
        assert.equal(f.calls.length, 1);
        assert.equal(f.logs.length, name === 'CANCELLED' ? 0 : 1);
        const later = f.queue.sendPacket(data('later third'));
        f.complete();
        await tick();
        f.complete();
        await later;
        assert.equal(f.queue._outputLock, false);
        assert.deepEqual(f.delivered.map(line => JSON.parse(line).body.text), ['queued second', 'later third']);
    });
}

test('new helper invalid byte count is a GIO error and does not lock Device queue', async () => {
    const f = fixture();
    const first = f.queue.sendPacket(data('bad count'));
    f.complete(null, -1);
    await first;
    assert.equal(f.queue._outputLock, false);
    assert.equal(f.logs.length, 1);
    assert.equal(f.logs[0][0].code, f.IOError.PARTIAL_INPUT);
    const next = f.queue.sendPacket(data('later valid'));
    f.complete();
    await next;
    assert.equal(f.queue._outputLock, false);
});

test('production Device connection/pairing gates do not reach output', async () => {
    const f = fixture();
    f.queue.connected = false;
    await f.queue.sendPacket(data('offline'));
    f.queue.connected = true;
    f.queue.paired = false;
    await f.queue.sendPacket(data('unpaired'));
    assert.equal(f.calls.length, 0);
    const pair = f.queue.sendPacket({type: 'kdeconnect.pair', body: {pair: false}});
    assert.equal(f.calls.length, 1);
    f.complete();
    await pair;
});

test('direct Core callers preserve [count], explicit token and mocked native PENDING without interleaving', async () => {
    const f = fixture();
    const token = {name: 'explicit'};
    const first = f.channel.sendPacket(f.packet('first'), token);
    await assert.rejects(f.channel.sendPacket(f.packet('second')), error => error.code === f.IOError.PENDING);
    assert.equal(f.calls[0].token, token);
    assert.equal(f.calls[1].token, f.channel.cancellable);
    assert.equal(f.inputs[0].closed, false);
    assert.equal(f.inputs[1].closed, true);
    f.complete();
    const count = await first;
    assert.deepEqual(Array.from(count), [new TextEncoder().encode(f.delivered[0]).length]);
    assert.equal(f.delivered.length, 1);
});

test('actual LAN identity exchange awaits Core send completion and ignores count result', async () => {
    const f = fixture();
    let reads = 0;
    const identity = {body: {protocolVersion: 8, deviceId: 'fixture-id'}};
    const channel = new f.scope.Lan();
    Object.assign(channel, {identity, backend: {identity: f.packet('identity')},
        sendPacket: f.channel.sendPacket.bind(f.channel),
        readPacket: async () => { reads++; return identity; }});
    const exchange = channel._exchangeIdentities();
    assert.equal(reads, 0);
    f.complete();
    assert.equal(await exchange, undefined);
    assert.equal(reads, 1);
    assert.equal(channel.identity, identity);
});

test('LAN upload caller contracts await direct send; plaintext identity write remains outside helper', () => {
    assert.match(lan, /const requestUpload = this\.sendPacket\(new Core\.Packet\(packet\),\s*cancellable\)/);
    assert.match(lan, /await Promise\.all\(\[requestUpload,\s*acceptConnection\]\)/);
    assert.match(lan, /sending = this\.sendPacket\(new Core\.Packet\(packet\), cancellable\)/);
    assert.match(lan, /await Promise\.all\(\[sending, accepting\]\)/);
    assert.match(lan, /connection\.get_output_stream\(\)\.write_all_async\(\s*this\.backend\.identity\.serialize\(\)/);
});

// Previously a failing TODO: ordinary errors caused e.matches() to throw and
// leave _outputLock set. This is now an enforced regression, not hidden history.
test('ordinary JS output error releases the owner lock and later FIFO work resumes', async () => {
    const f = fixture();
    const sent = f.queue.sendPacket(data('failure'));
    await f.queue.sendPacket(data('queued'));
    f.complete(Error('ordinary JS failure'));
    await sent;
    assert.equal(f.queue._outputLock, false);
    assert.equal(f.logs[0][0].message, 'ordinary JS failure');
    assert.equal(f.queue._outputQueue.length, 1);
    const later = f.queue.sendPacket(data('later'));
    f.complete();
    await tick();
    f.complete();
    await later;
    assert.deepEqual(f.delivered.map(line => JSON.parse(line).body.text), ['queued', 'later']);
});

for (const [name, thrown] of [
    ['serialization Error', Error('serialization')],
    ['null', null], ['undefined', undefined], ['string', 'non-Error'],
    ['throwing matches method', {matches() { throw Error('bad matches'); }}],
    ['throwing matches getter', {get matches() { throw Error('bad getter'); }}],
]) {
    test(`${name} is logged and owner lock always releases`, async () => {
        const f = fixture();
        const original = f.scope.Packet.prototype.serialize;
        f.scope.Packet.prototype.serialize = () => { throw thrown; };
        await f.queue.sendPacket(data('bad serialization'));
        assert.equal(f.queue._outputLock, false);
        assert.equal(f.logs.length, 1);
        assert.equal(f.logs[0][0], thrown);
        f.scope.Packet.prototype.serialize = original;
        const recovered = f.queue.sendPacket(data('recovered'));
        f.complete();
        await recovered;
        assert.equal(f.queue._outputLock, false);
        assert.equal(JSON.parse(f.delivered[0]).body.text, 'recovered');
    });
}

test('logger failure propagates but owner finally releases lock without losing queued work', async () => {
    const f = fixture();
    const logging = f.scope.debug;
    f.scope.debug = () => { throw Error('logger failed'); };
    const sent = f.queue.sendPacket(data('bad'));
    await f.queue.sendPacket(data('queued'));
    f.complete(Error('write failure'));
    await assert.rejects(sent, /logger failed/);
    assert.equal(f.queue._outputLock, false);
    assert.equal(f.queue._outputQueue.length, 1);
    f.scope.debug = logging;
    const later = f.queue.sendPacket(data('later'));
    f.complete();
    await tick();
    f.complete();
    await later;
    assert.deepEqual(f.delivered.map(line => JSON.parse(line).body.text), ['queued', 'later']);
});

test('non-owner concurrent early returns and construction errors never release another caller lock', async () => {
    const f = fixture();
    const sent = f.queue.sendPacket(data('owner'));
    await f.queue.sendPacket(data('queued'));
    assert.equal(f.queue._outputLock, true);
    const original = f.scope.Core.Packet;
    f.scope.Core.Packet = class { constructor() { throw Error('construction failure'); } };
    await f.queue.sendPacket(data('not enqueued'));
    assert.equal(f.queue._outputLock, true);
    assert.equal(f.calls.length, 1);
    assert.equal(f.queue._outputQueue.length, 1);
    f.scope.Core.Packet = original;
    f.complete();
    await tick();
    f.complete();
    await sent;
    assert.equal(f.queue._outputLock, false);
    assert.deepEqual(f.delivered.map(line => JSON.parse(line).body.text), ['owner', 'queued']);
});
