// SPDX-FileCopyrightText: 2026 GSConnect fork contributors
// SPDX-License-Identifier: GPL-2.0-or-later
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
const source = await readFile(new URL('../src/service/utils/exactTransfer.js', import.meta.url), 'utf8');
const {copyExact} = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);

function streams(length) {
    let remaining = length;
    const reads = [];
    const writes = [];
    return {reads, writes, async read(count) {
        reads.push(count);
        const size = Math.min(count, remaining);
        remaining -= size;
        return new Uint8Array(size);
    }, async write(bytes) { writes.push(bytes.length); }};
}

test('copies exact payload with at most 64 KiB per read and EOF probe', async () => {
    const s = streams(200000);
    assert.equal(await copyExact(200000, s.read, s.write), 200000);
    assert.deepEqual(s.reads, [65536, 65536, 65536, 3392, 1]);
    assert.equal(s.writes.reduce((sum, size) => sum + size, 0), 200000);
});
test('rejects extra bytes without writing them', async () => {
    const s = streams(200001);
    await assert.rejects(copyExact(200000, s.read, s.write), /Extra/);
    assert.equal(s.writes.reduce((sum, size) => sum + size, 0), 200000);
});
test('rejects truncation', async () => {
    const s = streams(5);
    await assert.rejects(copyExact(10, s.read, s.write), /Incomplete: 5\/10/);
});
test('empty file still requires EOF', async () => {
    const empty = streams(0);
    assert.equal(await copyExact(0, empty.read, empty.write), 0);
    assert.deepEqual(empty.reads, [1]); assert.deepEqual(empty.writes, []);
    const dishonest = streams(1);
    await assert.rejects(copyExact(0, dishonest.read, dishonest.write), /Extra/);
    assert.deepEqual(dishonest.writes, []);
});
test('invalid lengths are rejected without reading', async () => {
    for (const length of [-1, 1.5, Infinity, NaN, '3', 2 ** 53]) {
        const s = streams(1);
        await assert.rejects(copyExact(length, s.read, s.write), /Invalid payload size/);
        assert.deepEqual(s.reads, []);
    }
});
test('read bounds are enforced before writes', async () => {
    let wrote = false;
    await assert.rejects(copyExact(2, async () => new Uint8Array(3), async () => { wrote = true; }), /bounded read/);
    assert.equal(wrote, false);
});
test('read and write errors propagate immediately', async () => {
    await assert.rejects(copyExact(10, async () => { throw new Error('cancelled'); }, async () => {}), /cancelled/);
    const s = streams(10);
    await assert.rejects(copyExact(10, s.read, async () => { throw new Error('disk full'); }), /disk full/);
    assert.deepEqual(s.reads, [10]);
});

// Exercise the actual LAN adapter body with asynchronous GI callbacks mocked.
const lan = await readFile(new URL('../src/service/backends/lan.js', import.meta.url), 'utf8');
const downloadBody = lan.split('    async download(packet, target, cancellable = null, onProgress = null) {')[1]
    .split('\n    async upload(')[0].replace(/\n    }\s*$/, '');
function adapter(length, options = {}) {
    let remaining = length;
    const closed = [];
    const input = {read_bytes_async(count, priority, cancellable, callback) {
        const size = Math.min(count, remaining);
        remaining -= size;
        queueMicrotask(() => callback(input, new Uint8Array(size)));
    }, read_bytes_finish(result) { return {get_data: () => result}; }};
    const closable = label => ({close_async(priority, cancellable, callback) {
        assert.equal(cancellable, null);
        closed.push(label); queueMicrotask(() => callback(this, null));
    }, close_finish() { return true; }});
    const connection = {...closable('connection'), input_stream: input};
    const writes = [];
    const target = {...closable('target'), async write_all_async(bytes) {
        if (options.writeError)
            throw new Error('disk full');
        writes.push(bytes.length);
    }};
    const Gio = {InetSocketAddress: {new_from_string: () => ({})},
        SocketClient: class { async connect_async() { return connection; } }};
    const linkCancellables = () => ({cancellable: {connect() { return 0; }, set_error_if_cancelled() {}}, dispose() {}});
    const closeTransferStreams = streams => Promise.allSettled([...new Set(streams.filter(Boolean))].map(stream => new Promise((resolve, reject) => stream.close_async(0, null, (source, result) => { try { source.close_finish(result); resolve(); } catch (e) { reject(e); } }))));
    const download = new Function('Gio', 'GLib', 'copyExact', 'linkCancellables', 'closeTransferSocket', 'closeTransferStreams', 'writeBytes',
        `return async function(packet,target,cancellable=null,onProgress=null) {${downloadBody}}`)(Gio, {PRIORITY_DEFAULT: 0}, copyExact, linkCancellables, () => {}, closeTransferStreams, (target, bytes, token) => target.write_all_async(bytes, 0, token));
    return {closed, writes, run: (size, onProgress = null) => download.call({host: 'localhost', _encryptClient: value => value},
        {type: 'gsconnect.clipboard.rich', payloadSize: size, payloadTransferInfo: {port: 1}}, target, {}, onProgress)};
}
test('LAN adapter closes both streams after success', async () => {
    const a = adapter(5); await a.run(5);
    assert.deepEqual(a.closed.sort(), ['connection', 'target']);
    assert.deepEqual(a.writes, [5]);
});
test('LAN adapter closes both streams after overflow, truncation, and disk failure', async () => {
    for (const [length, options, message] of [[6, {}, /Extra/], [4, {}, /Incomplete/], [5, {writeError: true}, /disk full/]]) {
        const a = adapter(length, options); await assert.rejects(a.run(5), message);
        assert.deepEqual(a.closed.sort(), ['connection', 'target']);
    }
});


test('progress reports only committed writes and verified final byte count', async () => {
    const s = streams(70000);
    const events = [];
    await copyExact(70000, s.read, s.write, (done, total) => {
        assert.equal(s.writes.reduce((sum, count) => sum + count, 0), done);
        events.push([done, total]);
    });
    assert.deepEqual(events, [[0, 70000], [65536, 70000], [70000, 70000]]);
});

test('progress does not report completion for excess, truncated or failed writes', async () => {
    for (const [length, failWrite] of [[70001, false], [65537, false], [70000, true]]) {
        const s = streams(length);
        const events = [];
        await assert.rejects(copyExact(70000, s.read, async bytes => {
            if (failWrite) throw new Error('disk full');
            await s.write(bytes);
        }, (done, total) => events.push([done, total])));
        assert.equal(events.at(-1)[0] < 70000, true);
        if (failWrite) assert.deepEqual(events, [[0, 70000]]);
    }
});

test('empty progress is one zero event and is not a success signal', async () => {
    for (const length of [0, 1]) {
        const s = streams(length);
        const events = [];
        const result = copyExact(0, s.read, s.write, (done, total) => events.push([done, total]));
        if (length) await assert.rejects(result, /Extra/);
        else await result;
        assert.deepEqual(events, [[0, 0]]);
    }
});

test('LAN adapter forwards progress through exact copy', async () => {
    const a = adapter(70000);
    const events = [];
    await a.run(70000, (done, total) => events.push([done, total]));
    assert.deepEqual(events, [[0, 70000], [65536, 70000], [70000, 70000]]);
});

test('Core transfer forwards optional progress and cancellation to download', async () => {
    const core = await readFile(new URL('../src/service/core.js', import.meta.url), 'utf8');
    const body = core.split('    async start(cancellable = null) {')[1]
        .split('\n    /**\n     * Retire a transfer')[0].replace(/\n    }\s*$/, '');
    const events = [];
    const token = {cancel() { events.push('cancelled'); }};
    const progress = () => {};
    const packet = {hasPayload: () => true};
    const target = {};
    const transfer = {_items: [{packet, target}], _cancellable: token,
        onProgress: progress, device: null, async _ensureStream() {},
        channel: {closed: false, async download(p, t, c, notify) {
            assert.equal(p, packet); assert.equal(t, target);
            assert.equal(c, token); assert.equal(notify, progress);
        }}, notify(name) { events.push(name); }};
    class Cancellable { connect(fn) { fn(); } }
    const run = new Function('Gio', `return async function(cancellable=null) {${body}}`)({Cancellable});
    await run.call(transfer, new Cancellable());
    assert.deepEqual(events, ['cancelled', 'completed']);
});
