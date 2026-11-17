// SPDX-FileCopyrightText: 2026 GSConnect fork contributors
// SPDX-License-Identifier: GPL-2.0-or-later
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const lan = readFileSync(new URL('../../src/service/backends/lan.js', import.meta.url), 'utf8');
const utility = readFileSync(new URL('../../src/service/utils/transferCancellation.js', import.meta.url), 'utf8');
/** In-memory cancellation, matching the signal/exception contract. */
class Token {
    constructor() { this.handlers = new Map(); this.serial = 0; this.cancelled = false; }
    is_cancelled() { return this.cancelled; }
    set_error_if_cancelled() { if (this.cancelled) throw Error('cancelled'); }
    connect(fn) { if (this.cancelled) { fn(); return 0; } this.handlers.set(++this.serial, fn); return this.serial; }
    disconnect(id) { this.handlers.delete(id); }
    cancel() { if (this.cancelled) return; this.cancelled = true; for (const fn of this.handlers.values()) fn(); }
}
/**
 * Load production operations behind socket/TLS/stream boundaries.
 * @param {string} stage - Phase to hold until canceled
 * @returns {object} Fixture state
 */
function fixture(stage) {
    const seen = [];
    const timers = new Map();
    let nextTimer = 0;
    const wait = (name, token, result) => {
        seen.push(name);
        token?.set_error_if_cancelled();
        if (stage !== name) return Promise.resolve(result);
        return new Promise((resolve, reject) => token.connect(() => reject(Error(`cancelled ${name}`))));
    };
    const closable = name => ({close_async(_priority, token, callback) {
        assert.equal(token.is_cancelled(), false, 'fresh cleanup token');
        seen.push(`close ${name}`);
        callback(this, {});
    }, close_finish() {}});
    const raw = {...closable('raw'), socket: {close() { seen.push('socket closed'); }, remote_address: {}}};
    const tls = {...closable('tls'), set_certificate() {}, connect() { return 1; }, disconnect() {},
        handshake_async: (_priority, token) => wait('tls', token),
        input_stream: {read_bytes_async(_count, _priority, token, callback) {
            wait('read', token, new Uint8Array([1])).then(bytes => callback(this, {bytes}), error => callback(this, {error}));
        }, read_bytes_finish(result) { if (result.error) throw result.error; return {get_data: () => result.bytes}; }},
        output_stream: {splice_async: (_source, _flags, _priority, token) => wait('splice', token, 1)}};
    const target = {...closable('target'), write_all_async: (_bytes, _priority, token) => wait('write', token)};
    const source = closable('source');
    const scope = {writeBytes: (target, bytes, token) => target.write_all_async(bytes, 0, token), Promise, Set, Error, debug() {}, logError() {}, _configureSocket() {},
        TRANSFER_MIN: 1739, TRANSFER_MAX: 1740,
        GLib: {PRIORITY_DEFAULT: 0, SOURCE_REMOVE: false,
            timeout_add_seconds(_priority, seconds, callback) { assert.equal(seconds, 5); timers.set(++nextTimer, callback); return nextTimer; },
            source_remove(id) { timers.delete(id); }},
        Gio: {Cancellable: Token, TlsCertificateFlags: {EXPIRED: 1}, TlsAuthenticationMode: {REQUIRED: 1},
            TlsClientConnection: {new: () => tls}, TlsServerConnection: {new: () => tls},
            InetSocketAddress: {new_from_string: () => ({})},
            SocketClient: class { connect_async(_address, token) { return wait('connect', token, raw); } },
            SocketListener: class {
                add_inet_port() { seen.push('listen'); }
                close() { seen.push('listener closed'); }
                accept_async(token) { return wait('accept', token, [raw]); }
            }, OutputStreamSpliceFlags: {CLOSE_SOURCE: 1, CLOSE_TARGET: 2},
            IOErrorEnum: class extends Error { constructor({message}) { super(message); } }},
        Core: {Packet: class { constructor(packet) { Object.assign(this, packet); } }},
        copyExact: async (_size, read, write) => write(await read(1)),
    };
    vm.runInNewContext(utility.replace(/^import .*;\n/gm, '').replace(/export /g, '') +
        '\nthis.linkCancellables=linkCancellables;this.closeTransferSocket=closeTransferSocket;this.closeTransferStreams=closeTransferStreams;', scope);
    const auth = lan.slice(lan.indexOf('    async _authenticate('), lan.indexOf('    async _exchangeIdentities('));
    const methods = lan.slice(lan.indexOf('    async download('), lan.lastIndexOf('\n});'));
    vm.runInNewContext(`this.Channel=class {${auth}${methods}}`, scope);
    const channel = new scope.Channel();
    channel.cancellable = new Token();
    channel.device = {settings: {get_string: () => ''}, unpair() { throw Error('must not unpair on cancellation'); }};
    channel.sendPacket = (_packet, token) => stage === 'send-fail' ? Promise.reject(Error('send failed')) : wait('send', token);
    const token = new Token();
    return {channel, token, target, source, seen, timers, raw};
}
const packet = () => ({type: 'gsconnect.clipboard.rich', body: {}, payloadSize: 1, payloadTransferInfo: {port: 1739}});
/**
 * Let bounded async setup advance to a held mocked GIO phase.
 * @param {object} f - Fixture
 * @param {string} phase - Expected phase
 */
async function reach(f, phase) {
    for (let i = 0; i < 50 && !f.seen.includes(phase); i++) await Promise.resolve();
    assert.ok(f.seen.includes(phase), `reached ${phase}`);
}
for (const stage of ['connect', 'tls', 'read', 'write']) {
    for (const parent of ['token', 'channel']) {
        test(`rich download ${stage} settles on ${parent} cancellation without unpair`, async () => {
            const f = fixture(stage);
            const promise = f.channel.download(packet(), f.target, f.token);
            const rejected = assert.rejects(promise, /cancelled/);
            await reach(f, stage);
            (parent === 'token' ? f.token : f.channel.cancellable).cancel();
            await rejected;
            assert.ok(f.seen.includes('close target'));
            assert.equal(f.timers.size, 0);
            assert.equal(f.token.handlers.size, 0);
            assert.equal(f.channel.cancellable.handlers.size, 0);
        });
    }
}
for (const stage of ['accept', 'send', 'tls', 'splice']) {
  for (const parent of ['token', 'channel']) {
    test(`rich upload ${stage} settles and closes listener on ${parent} cancellation`, async () => {
        const f = fixture(stage);
        const promise = f.channel.upload(packet(), f.source, 1, f.token);
        const rejected = assert.rejects(promise, /cancelled/);
        await reach(f, stage);
        (parent === 'token' ? f.token : f.channel.cancellable).cancel();
        await rejected;
        assert.ok(f.seen.includes('listener closed'));
        assert.ok(f.seen.includes('close source'));
        assert.equal(f.token.handlers.size, 0);
        assert.equal(f.channel.cancellable.handlers.size, 0);
        assert.equal(f.timers.size, 0);
    });
  }
}
for (const direction of ['upload', 'download']) {
    test(`successful rich ${direction} releases parent handlers and cleanup timers`, async () => {
        const f = fixture('none');
        if (direction === 'upload') await f.channel.upload(packet(), f.source, 1, f.token);
        else await f.channel.download(packet(), f.target, f.token);
        assert.equal(f.token.handlers.size, 0);
        assert.equal(f.channel.cancellable.handlers.size, 0);
        assert.equal(f.timers.size, 0);
        assert.equal(f.token.is_cancelled(), false);
    });
}
test('rich upload packet-send failure cancels pending accept without canceling owner tokens', async () => {
    const f = fixture('accept');
    f.channel.sendPacket = () => Promise.reject(Error('send failed'));
    await assert.rejects(f.channel.upload(packet(), f.source, 1, f.token), /send failed/);
    assert.equal(f.token.is_cancelled(), false);
    assert.equal(f.channel.cancellable.is_cancelled(), false);
    assert.ok(f.seen.includes('close source'));
    assert.equal(f.token.handlers.size, 0);
});
test('already-canceled rich operations do not bind or connect', async () => {
    const f = fixture('none'); f.token.cancel();
    await assert.rejects(f.channel.upload(packet(), f.source, 1, f.token), /cancelled/);
    await assert.rejects(f.channel.download(packet(), f.target, f.token), /cancelled/);
    assert.ok(!f.seen.includes('listen') && !f.seen.includes('connect'));
});
test('large batches of rejected rich payloads never create outbound connections', async () => {
    const f = fixture('connect');
    for (let i = 0; i < 10000; i++) await f.channel.rejectTransfer({...packet(), hasPayload: () => true});
    assert.deepEqual(f.seen, []);
});
