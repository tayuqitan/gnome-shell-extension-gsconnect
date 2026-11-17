// SPDX-FileCopyrightText: 2026 GSConnect fork contributors
// SPDX-License-Identifier: GPL-2.0-or-later
// Protocol unit tests with GI adapters mocked; not GNOME integration tests.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

const historySource = await readFile(new URL('../src/service/utils/clipboardHistory.js', import.meta.url), 'utf8');
const {default: ClipboardHistory} = await import(`data:text/javascript;base64,${Buffer.from(historySource).toString('base64')}`);
const source = await readFile(new URL('../src/service/utils/richClipboard.js', import.meta.url), 'utf8');
let sequence = 0;
async function rig() {
    const timers = new Map();
    const sent = [], rejected = [], transfers = [], offered = [], reads = [];
    const values = new Map([['image/png', new Uint8Array([1, 2, 3])]]);
    const settings = {send: true, receive: true, connect: () => 1, disconnect() {},
        get_uint(key) { return key === 'history-max-items' ? 50 : key === 'history-max-bytes' ? 67108864 : 3600; },
        get_boolean(key) { return key === 'send-content' ? this.send : this.receive; }};
    const callbacks = new Map();
    const clipboard = {richAvailable: true, generation: 1, mimetypes: ['image/png'],
        connect(name, fn) { callbacks.set(name, fn); return 1; }, disconnect() {},
        async readValue(mime) { reads.push(mime); return values.get(mime); },
        async offer(...args) { offered.push(args); }, async clearOffer() {}};
    const capability = 'gsconnect.clipboard.rich';
    const device = {connected: true, settings: {get_strv: () => [capability]},
        sendPacket(packet) { sent.push(packet); }, rejectTransfer(packet) { rejected.push(packet); },
        createTransfer() {
            const transfer = {started: false, canceled: false, addFile(packet, file) { this.item = {packet, file}; },
                addStream(packet, stream, size) { this.item = {packet, stream, size}; },
                async start() { this.started = true; const total = this.item.packet.payloadSize ?? this.item.size ?? 0; this.onProgress?.(total, total); }, cancel() { this.canceled = true; }};
            transfers.push(transfer); return transfer;
        }};
    const mocks = {
        Gio: {Application: {get_default: () => ({settings: {get_value: () => ({deepUnpack: () => 10737418240})}})}, ThemedIcon: class { constructor(properties) { this.properties = properties; } }, IOErrorEnum: {CANCELLED: 19}, Cancellable: class {
            constructor() { this.handlers = new Map(); this.serial = 0; this.canceled = false; }
            is_cancelled() { return this.canceled; }
            connect(fn) { this.handlers.set(++this.serial, fn); if (this.canceled) fn(); return this.serial; }
            disconnect(id) { this.handlers.delete(id); }
            cancel() { if (this.canceled) return; this.canceled = true; for (const fn of this.handlers.values()) fn(); }
        }, File: {new_for_path: path => ({get_uri: () => `file://${path}`})}, MemoryInputStream: {new_from_bytes: bytes => bytes},
            MemoryOutputStream: {new_resizable: () => ({steal_as_bytes: () => ({get_data: () => new Uint8Array([4])})})},
            FileQueryInfoFlags: {NOFOLLOW_SYMLINKS: 1}, FileType: {REGULAR: 1}},
        GLib: {Variant: class { constructor(type, value) { this.type = type; this.value = value; } }, format_size: bytes => `${bytes} B`, get_user_cache_dir: () => '/cache', build_filenamev: parts => parts.join('/'),
            mkdir_with_parents() {}, idle_add(_priority, callback) { queueMicrotask(callback); return 1; },
            PRIORITY_DEFAULT: 0, SOURCE_REMOVE: false, Bytes: class { constructor(value) { this.value = value; } },
            uuid_string_random: () => `request-${++sequence}`,
            timeout_add_seconds(priority, seconds, fn) { const id = ++sequence; timers.set(id, fn); return id; },
            source_remove(id) { timers.delete(id); }},
    };
    globalThis.__richClipboardTestMocks = mocks;
    globalThis.__clipboardHistory = ClipboardHistory;
    // Disk/GIO behavior is covered by the real storage suite; keep protocol
    // fixtures isolated while exercising the actual fetchFiles integration.
    globalThis.__clipboardCacheStorage = {
        begin(files) { return {handle: {children: files.map((file, index) => ({
            file: mocks.Gio.File.new_for_path(`/cache/test/${index}/${file.name}`),
        }))}}; },
        complete(transaction) { return transaction.handle.children.map(child => child.file.get_uri()); },
        async rollback() {},
    };
    globalThis.debug = () => {};
    globalThis._ = text => text;
    const transformed = source.replace("import Gio from 'gi://Gio';", 'const Gio = globalThis.__richClipboardTestMocks.Gio;')
        .replace("import GLib from 'gi://GLib';", 'const GLib = globalThis.__richClipboardTestMocks.GLib;')
        .replace("import ClipboardHistory from './clipboardHistory.js';", 'const ClipboardHistory = globalThis.__clipboardHistory;')
        .replace("import {getClipboardCacheStorage} from './clipboardCacheStorage.js';",
            'const getClipboardCacheStorage = () => globalThis.__clipboardCacheStorage;');
    const {default: RichClipboard} = await import(`data:text/javascript;base64,${Buffer.from(transformed + `\n// ${++sequence}`).toString('base64')}`);
    const helper = new RichClipboard({device, settings}, clipboard);
    helper.remoteReady = true; // Ready handshake already completed in this fixture.
    return {helper, clipboard, settings, device, sent, rejected, transfers, offered, reads, timers, values, callbacks};
}
const offer = (extra = {}) => ({version: 1, op: 'offer', id: 'offer-1', revision: 1, origin: 'remote-origin', types: ['image/png'], files: [], ...extra});
const packet = (body, size = 3) => ({body, payloadSize: size, hasPayload: () => true});

test('publish advertises metadata without reading or transferring image bytes', async () => {
    const r = await rig(); await r.helper.publish();
    assert.equal(r.sent.at(-1).body.op, 'offer');
    assert.deepEqual(r.reads, ['image/png']); assert.equal(r.transfers.length, 0);
});
test('legacy peer receives no private protocol packets', async () => {
    const r = await rig(); r.device.settings.get_strv = () => ['kdeconnect.clipboard'];
    await r.helper.publish(); await r.helper.handle(packet(offer()));
    assert.equal(r.helper.enabled, false); assert.equal(r.sent.length, 0); assert.equal(r.offered.length, 0);
});
test('send and receive permissions block clipboard publication and acceptance', async () => {
    const r = await rig(); r.settings.send = false; r.settings.receive = false;
    await r.helper.publish(); await r.helper.accept(offer());
    assert.equal(r.sent.length, 0); assert.equal(r.offered.length, 0);
});
test('remote offer installs a lazy provider and sends request only when read', async () => {
    const r = await rig(); await r.helper.accept(offer());
    assert.equal(r.sent.length, 0); assert.equal(r.transfers.length, 0);
    const reading = r.offered[0][2]('image/png');
    const request = r.sent.at(-1).body;
    assert.equal(request.op, 'request');
    await r.helper.receive(packet({op: 'value', id: 'offer-1', request: request.request}));
    assert.deepEqual(await reading, new Uint8Array([4]));
    assert.equal(r.timers.size, 0);
});
test('malicious filenames and declared sizes are rejected before clipboard ownership', async () => {
    for (const file of [{name: '../x', size: 1}, {name: '/x', size: 1}, {name: 'a\\b', size: 1},
        {name: '..', size: 1}, {name: 'x\0', size: 1}, {name: 'x', size: -1},
        {name: 'x', size: 2 ** 53}, {name: 'x', size: 101 * 1024 ** 3}]) {
        const r = await rig(); await r.helper.accept(offer({types: ['text/uri-list'], files: [file]}));
        assert.equal(r.offered.length, 0, JSON.stringify(file));
    }
});
test('stale and unsolicited payloads are rejected without downloading', async () => {
    const r = await rig(); await r.helper.accept(offer());
    await r.helper.receive(packet({op: 'value', id: 'offer-1', request: 'unknown'}));
    assert.equal(r.rejected.length, 1); assert.equal(r.transfers.length, 0);
    const reading = r.helper.request(r.helper.remote, {mime: 'image/png'});
    const fail = assert.rejects(reading, /expired/); r.helper.clearRemote(); await fail;
    await r.helper.receive(packet({op: 'value', id: 'offer-1', request: r.sent.at(-1).body.request}));
    assert.equal(r.rejected.length, 2); assert.equal(r.transfers.length, 0);
});
test('oversized representation rejects request and cleans timer', async () => {
    const r = await rig(); await r.helper.accept(offer());
    const reading = r.helper.request(r.helper.remote, {mime: 'image/png'});
    const fail = assert.rejects(reading, /payload size/);
    await r.helper.receive(packet({op: 'value', id: 'offer-1', request: r.sent.at(-1).body.request}, 16 * 1024 ** 2 + 1));
    await fail; assert.equal(r.rejected.length, 1); assert.equal(r.timers.size, 0);
});
test('request timeout cancels transfer and releases pending request', async () => {
    const r = await rig(); await r.helper.accept(offer());
    const reading = r.helper.request(r.helper.remote, {mime: 'image/png'});
    const fail = assert.rejects(reading, /timed out/);
    const pending = [...r.helper.pending.values()][0];
    pending.transfer = {canceled: false, cancel() { this.canceled = true; }};
    [...r.timers.values()][0](); await fail;
    assert.equal(pending.transfer.canceled, true); assert.equal(r.helper.pending.size, 0);
});
test('sender validates offer ID, generation, requested format, and permissions', async () => {
    const r = await rig(); await r.helper.publish(); const id = r.helper.local.id;
    await assert.rejects(r.helper.serve({id: 'wrong', request: 'x', mime: 'image/png'}), /expired/);
    await assert.rejects(r.helper.serve({id, request: 'x', mime: 'application/secret'}), /format/);
    r.helper.history.remove(`local:${id}`);
    r.clipboard.generation++;
    await assert.rejects(r.helper.serve({id, request: 'x', mime: 'image/png'}), /expired/);
    r.clipboard.generation--; r.settings.send = false;
    await assert.rejects(r.helper.serve({id, request: 'x', mime: 'image/png'}), /expired/);
    assert.equal(r.transfers.filter(item => item.started).length, 0);
});
test('sender transfers only requested MIME after a valid lease request', async () => {
    const r = await rig(); await r.helper.publish();
    await r.helper.serve({id: r.helper.local.id, request: 'x', mime: 'image/png'});
    assert.deepEqual(r.reads, ['image/png']); assert.equal(r.transfers[0].started, true);
});

test('changing selection during file metadata lookup revokes the outgoing request', async () => {
    const r = await rig();
    let resume;
    const file = {query_info_async: () => new Promise(resolve => { resume = resolve; }),
        async read_async() { return {close() {}, async query_info_async() { return {
            get_size: () => 3, get_attribute_uint64: () => 10, get_attribute_string: () => 'file-id'}; }}; }};
    r.helper.local = {id: 'file-offer', generation: 1, files: [{file, size: 3, modified: 10, identity: 'file-id'}], types: ['text/uri-list']};
    const serving = r.helper.serve({id: 'file-offer', request: 'file-request', index: 0});
    const rejected = assert.rejects(serving, /expired|changed|cancel/i);
    r.helper.local = null;
    r.clipboard.generation++;
    resume({get_size: () => 3, get_attribute_uint64: () => 10, get_is_symlink: () => false, get_file_type: () => 1});
    await rejected;
    assert.equal(r.transfers.filter(item => item.started).length, 0);
});

 test('rich transport waits for live peer readiness and falls back when unavailable', async () => {
    const r = await rig();
    r.helper.connected();
    assert.equal(r.helper.enabled, false);
    assert.equal(r.sent.at(-1).body.op, 'hello');
    await r.helper.handle(packet({version: 1, op: 'hello', available: false}));
    assert.equal(r.helper.enabled, false);
    await r.helper.handle(packet({version: 1, op: 'hello', available: true}));
    assert.equal(r.helper.enabled, true);
    assert.equal(r.sent.at(-1).body.op, 'offer');
});

test('crossed simultaneous offers elect one owner that can still serve', async () => {
    const a = await rig(), b = await rig();
    a.helper.origin = 'a'; b.helper.origin = 'b';
    await Promise.all([a.helper.publish(), b.helper.publish()]);
    const ao = a.sent.at(-1), bo = b.sent.at(-1);
    await Promise.all([a.helper.handle(bo), b.helper.handle(ao)]);
    assert.equal(a.helper.local, null);
    assert.equal(a.helper.remote.id, bo.body.id);
    assert.equal(b.helper.remote, null);
    assert.equal(b.helper.local.id, bo.body.id);
    await b.helper.serve({id: bo.body.id, request: 'crossed-copy', mime: 'image/png'});
    assert.equal(b.transfers.at(-1).started, true);
    // A later local copy advances past the observed peer revision.
    a.clipboard.generation++;
    await a.helper.publish();
    const next = a.sent.at(-1);
    assert.ok(next.body.revision > bo.body.revision);
    await b.helper.handle(next);
    assert.equal(b.helper.local, null);
    assert.equal(b.helper.remote.id, next.body.id);
});

test('duplicate offers do not cancel an existing remote provider', async () => {
    const r = await rig();
    await r.helper.accept(offer());
    const remote = r.helper.remote;
    await r.helper.accept(offer());
    assert.equal(r.helper.remote, remote);
    assert.equal(r.offered.length, 1);
});

test('an empty local clipboard does not prevent adopting a peer offer', async () => {
    const r = await rig();
    r.helper.origin = 'z';
    r.clipboard.mimetypes = [];
    await r.helper.publish();
    await r.helper.accept(offer({origin: 'a'}));
    assert.equal(r.helper.remote.id, 'offer-1');
});

test('whole-paste cancellation stops active transfer and prevents subsequent files', async () => {
    const r = await rig();
    await r.helper.accept(offer({types: ['text/uri-list'],
        files: [{name: 'first.docx', size: 3}, {name: 'second.xlsx', size: 3}]}));
    const callbacks = new Map(); let canceled = false, id = 0;
    const cancellation = {is_cancelled: () => canceled,
        connect(fn) { callbacks.set(++id, fn); return id; },
        disconnect(key) { callbacks.delete(key); },
        cancel() { canceled = true; for (const callback of callbacks.values()) callback(); }};
    const downloading = r.helper.fetchFiles(r.helper.remote, cancellation);
    const failed = assert.rejects(downloading, /cancelled/);
    const pending = [...r.helper.pending.values()][0];
    const transfer = {canceled: false, cancel() { this.canceled = true; }};
    pending.transfer = transfer;
    cancellation.cancel();
    await failed;
    assert.equal(transfer.canceled, true);
    assert.equal(r.helper.pending.size, 0);
    assert.equal(callbacks.size, 0);
    assert.equal(r.sent.filter(packet => packet.body.op === 'request').length, 1);
});

test('unsafe and ambiguous peer revisions cannot poison the local clock', async () => {
    const r = await rig();
    for (const revision of [Number.MAX_SAFE_INTEGER - 1, Number.MAX_SAFE_INTEGER,
        Infinity, -1, 0x100000000, 0x80000000]) {
        await r.helper.accept(offer({revision}));
        assert.equal(r.helper.remote, null);
        assert.equal(r.helper.clock, 0);
    }
    await r.helper.publish();
    assert.equal(r.helper.local.revision, 1);
});

test('uint32 revision rollover preserves local publication and peer ordering', async () => {
    const a = await rig(), b = await rig();
    a.helper.clock = 0xffffffff;
    b.helper.clock = 0xffffffff;
    b.helper.local = {revision: 0xffffffff, origin: 'z'};
    await a.helper.publish();
    assert.equal(a.helper.local.revision, 0);
    await b.helper.handle(a.sent.at(-1));
    assert.equal(b.helper.local, null);
    assert.equal(b.helper.clock, 0);
    b.clipboard.generation++;
    await b.helper.publish();
    assert.equal(b.helper.local.revision, 1);
});


test('cancel before payload arrival rejects it before the idle cleanup runs', async () => {
    const r = await rig();
    await r.helper.accept(offer());
    let canceled = false, handler;
    const cancellation = {is_cancelled: () => canceled,
        connect(fn) { handler = fn; return 1; }, disconnect() {},
        cancel() { canceled = true; handler(); }};
    const reading = r.helper.request(r.helper.remote, {mime: 'image/png'}, null, cancellation);
    const failed = assert.rejects(reading, /cancelled/);
    const request = r.sent.at(-1).body.request;
    cancellation.cancel();
    // receive enters synchronously, before the queued idle/microtask cleanup.
    await r.helper.receive(packet({op: 'value', id: 'offer-1', request}));
    await failed;
    assert.equal(r.transfers.length, 0);
    assert.equal(r.rejected.length, 1);
    assert.equal(r.helper.pending.size, 0);
});

test('cancellation during transfer creation cancels the newly registered transfer', async () => {
    const r = await rig();
    await r.helper.accept(offer());
    let canceled = false, handler;
    const cancellation = {is_cancelled: () => canceled,
        connect(fn) { handler = fn; return 1; }, disconnect() {},
        cancel() { canceled = true; handler(); }};
    const reading = r.helper.request(r.helper.remote, {mime: 'image/png'}, null, cancellation);
    const failed = assert.rejects(reading, /cancelled/);
    const request = r.sent.at(-1).body.request;
    const create = r.device.createTransfer.bind(r.device);
    r.device.createTransfer = () => { const result = create(); cancellation.cancel(); return result; };
    await r.helper.receive(packet({op: 'value', id: 'offer-1', request}));
    await failed;
    assert.equal(r.transfers.length, 1);
    assert.equal(r.transfers[0].started, false);
    assert.equal(r.transfers[0].canceled, true);
    assert.equal(r.helper.pending.size, 0);
});


test('canceling the first shared file reader leaves the second reader alive', async () => {
    const r = await rig(); await r.helper.accept(offer());
    let resolveFiles, transferToken, starts = 0;
    r.helper.fetchFiles = (_remote, token) => {
        starts++; transferToken = token; return new Promise(resolve => { resolveFiles = resolve; });
    };
    const token = () => {
        let canceled = false, handler;
        return {is_cancelled: () => canceled, connect(fn) { handler = fn; return 1; }, disconnect() {},
            cancel() { canceled = true; handler?.(); }};
    };
    const first = token(), second = token();
    const one = r.helper.getFiles(r.helper.remote, first);
    const failed = assert.rejects(one, /cancelled/);
    const two = r.helper.getFiles(r.helper.remote, second);
    await Promise.resolve();
    first.cancel(); await failed;
    assert.equal(transferToken.is_cancelled(), false);
    resolveFiles(['file:///cache/document.docx']);
    assert.deepEqual(await two, ['file:///cache/document.docx']);
    assert.equal(starts, 1);
    assert.deepEqual(await r.helper.getFiles(r.helper.remote), ['file:///cache/document.docx']);
});

test('shared transfer is canceled only when the final reader cancels', async () => {
    const r = await rig(); await r.helper.accept(offer());
    let transferToken;
    r.helper.fetchFiles = (_remote, token) => {
        transferToken = token;
        return new Promise((_resolve, reject) => token.connect(() => reject(new Error('cancelled'))));
    };
    const token = () => {
        let canceled = false, handler;
        return {is_cancelled: () => canceled, connect(fn) { handler = fn; return 1; }, disconnect() {},
            cancel() { canceled = true; handler?.(); }};
    };
    const first = token(), second = token();
    const one = r.helper.getFiles(r.helper.remote, first), two = r.helper.getFiles(r.helper.remote, second);
    const failureOne = assert.rejects(one, /cancelled/), failureTwo = assert.rejects(two, /cancelled/);
    await Promise.resolve();
    first.cancel(); assert.equal(transferToken.is_cancelled(), false);
    second.cancel(); assert.equal(transferToken.is_cancelled(), true);
    await Promise.all([failureOne, failureTwo]);
});


test('GNOME progress reports aggregate bytes, cancel action, and completion', async () => {
    const r = await rig(); const notifications = [];
    r.device.showNotification = notification => notifications.push(notification);
    await r.helper.accept(offer({types: ['text/uri-list'],
        files: [{name: 'one.docx', size: 3}, {name: 'two.xlsx', size: 4}]}));
    const reading = r.helper.fetchFiles(r.helper.remote);
    assert.equal(notifications[0].buttons[0].action, 'clipboardCancel');
    let request = r.sent.at(-1).body.request;
    await r.helper.receive(packet({op: 'value', id: 'offer-1', request}, 3));
    await Promise.resolve();
    request = r.sent.at(-1).body.request;
    await r.helper.receive(packet({op: 'value', id: 'offer-1', request}, 4));
    assert.equal((await reading).length, 2);
    assert.match(notifications.at(-1).body, /Completed: 7 B \/ 7 B \(100%\).*2\/2/);
    assert.equal(notifications.at(-1).buttons.length, 0);
});

test('GNOME progress shows failure without a success notification', async () => {
    const r = await rig(); const notifications = [];
    r.device.showNotification = notification => notifications.push(notification);
    await r.helper.accept(offer({types: ['text/uri-list'], files: [{name: 'one.docx', size: 3}]}));
    r.helper.request = async () => { throw new Error('Disk full'); };
    await assert.rejects(r.helper.fetchFiles(r.helper.remote), /Disk full/);
    assert.match(notifications.at(-1).body, /Failed:.*\nDisk full/);
    assert.equal(notifications.some(item => item.body.startsWith('Completed:')), false);
});

test('notification cancellation stops the shared download and reports cancelled', async () => {
    const r = await rig(); const notifications = [];
    r.device.showNotification = notification => notifications.push(notification);
    await r.helper.accept(offer({types: ['text/uri-list'], files: [{name: 'one.docx', size: 3}]}));
    const reading = r.helper.getFiles(r.helper.remote);
    const failed = assert.rejects(reading, /cancelled/);
    await Promise.resolve();
    r.helper.cancelDownload(r.helper.remote.progress.id);
    await failed;
    assert.match(notifications.at(-1).body, /Cancelled:/);
    assert.equal(r.helper.pending.size, 0);
});


test('retained local snapshot can serve after source clipboard changes and expires on removal', async () => {
    const r = await rig(); await r.helper.publish();
    const id = r.helper.local.id;
    r.clipboard.generation++; r.helper.local = null;
    await r.helper.serve({id, request: 'historical-read', mime: 'image/png'});
    assert.equal(r.transfers.at(-1).started, true);
    assert.deepEqual(r.reads, ['image/png']);
    r.helper.history.remove(`local:${id}`);
    await assert.rejects(r.helper.serve({id, request: 'expired-history', mime: 'image/png'}), /expired/);
});

test('local history restores captured bytes without network while disconnected', async () => {
    const r = await rig(); await r.helper.publish();
    const entry = r.helper.history.getLocalLease(r.helper.local.id);
    r.device.connected = false; r.sent.length = 0;
    await r.helper.activateHistory(entry);
    assert.deepEqual(await r.offered.at(-1)[2]('image/png'), new Uint8Array([1, 2, 3]));
    assert.equal(r.sent.length, 0);
});

test('uncached remote history requires a live source and uses retained original offer ID', async () => {
    const r = await rig(); await r.helper.accept(offer());
    const entry = r.helper.history.get('remote:offer-1');
    r.device.connected = false;
    await assert.rejects(r.helper.activateHistory(entry), /在线/);
    r.device.connected = true;
    await r.helper.activateHistory(entry);
    assert.equal(r.helper.remote.id, 'offer-1');
});


test('changed history source files fail before replacing the clipboard', async () => {
    const r = await rig();
    const file = {is_native: () => true, get_uri: () => 'file:///source/report.docx',
        async query_info_async() { return {get_file_type: () => 1, get_is_symlink: () => false,
            get_size: () => 3, get_attribute_string: () => 'replaced-file', get_attribute_uint64: () => 10}; }};
    const entry = r.helper.history.addLocal({id: 'files', types: ['text/uri-list'],
        files: [{file, name: 'report.docx', size: 3, identity: 'original-file', modified: 10}]});
    await assert.rejects(r.helper.activateHistory(entry), /修改|替换/);
    assert.equal(r.offered.length, 0);
});


test('password-marked local clipboard is not retained and propagates history suppression', async () => {
    const r = await rig(); r.clipboard.mimetypes.push('x-kde-passwordManagerHint');
    await r.helper.publish();
    assert.equal(r.helper.history.list().length, 0);
    assert.deepEqual(r.reads, []);
    assert.equal(r.sent.at(-1).body.sensitive, true);
    const peer = await rig(); await peer.helper.handle(r.sent.at(-1));
    assert.equal(peer.helper.history.list().length, 0);
});


test('sensitive remote offer removes any reused history ID and cannot recache payload', async () => {
    const r = await rig(); await r.helper.accept(offer());
    assert.ok(r.helper.history.get('remote:offer-1'));
    await r.helper.accept(offer({sensitive: true, revision: 2}));
    assert.equal(r.helper.history.get('remote:offer-1'), null);
    const reading = r.helper.request(r.helper.remote, {mime: 'image/png'});
    const request = r.sent.at(-1).body.request;
    await r.helper.receive(packet({op: 'value', id: 'offer-1', request}, 3));
    await reading;
    assert.equal(r.helper.history.get('remote:offer-1'), null);
});


test('uncached remote history reports disabled receive permission instead of false success', async () => {
    const r = await rig(); await r.helper.accept(offer());
    const entry = r.helper.history.get('remote:offer-1');
    const original = r.helper.remote;
    r.settings.receive = false; r.offered.length = 0;
    await assert.rejects(r.helper.activateHistory(entry), /关闭接收剪贴板/);
    assert.equal(r.offered.length, 0);
    assert.equal(r.helper.remote, original);
});


test('evicting history cancels a transfer that started while its offer was current', async () => {
    const r = await rig(); await r.helper.publish();
    const id = r.helper.local.id;
    let complete;
    const create = r.device.createTransfer.bind(r.device);
    r.device.createTransfer = () => {
        const transfer = create(); transfer.start = () => new Promise(resolve => { complete = resolve; });
        return transfer;
    };
    const sending = r.helper.serve({id, request: 'retained-upload', mime: 'image/png'});
    const transfer = r.transfers.at(-1);
    assert.equal(transfer.historyKey, `local:${id}`);
    r.clipboard.generation++;
    await r.helper.publish();
    assert.notEqual(r.helper.local.id, id);
    r.helper.history.remove(`local:${id}`);
    assert.equal(transfer.canceled, true);
    complete(); await sending;
});

test('clearing current history keeps live clipboard transfer, but later copy revokes it', async () => {
    const r = await rig(); await r.helper.publish();
    const id = r.helper.local.id;
    let complete;
    const create = r.device.createTransfer.bind(r.device);
    r.device.createTransfer = () => {
        const transfer = create(); transfer.start = () => new Promise(resolve => { complete = resolve; });
        return transfer;
    };
    const sending = r.helper.serve({id, request: 'current-upload', mime: 'image/png'});
    const transfer = r.transfers.at(-1);
    r.helper.history.remove(`local:${id}`);
    assert.equal(transfer.canceled, false);
    r.clipboard.generation++;
    r.helper.cancelRevokedTransfers();
    assert.equal(transfer.canceled, true);
    complete(); await sending;
});


test('remote takeover cancels an upload whose live offer has no retained history', async () => {
    const r = await rig(); await r.helper.publish();
    const id = r.helper.local.id;
    let complete;
    const create = r.device.createTransfer.bind(r.device);
    r.device.createTransfer = () => {
        const transfer = create(); transfer.start = () => new Promise(resolve => { complete = resolve; });
        return transfer;
    };
    const sending = r.helper.serve({id, request: 'takeover-upload', mime: 'image/png'});
    const transfer = r.transfers.at(-1);
    r.helper.history.remove(`local:${id}`);
    assert.equal(transfer.canceled, false);
    await r.helper.accept(offer({revision: r.helper.clock + 1}));
    assert.equal(r.helper.local, null);
    assert.equal(transfer.canceled, true);
    complete(); await sending;
});


test('publication invalidation revokes unretained uploads even without an owner signal', async () => {
    const r = await rig(); await r.helper.publish();
    const id = r.helper.local.id;
    let complete;
    const create = r.device.createTransfer.bind(r.device);
    r.device.createTransfer = () => {
        const transfer = create(); transfer.start = () => new Promise(resolve => { complete = resolve; });
        return transfer;
    };
    const sending = r.helper.serve({id, request: 'republish-upload', mime: 'image/png'});
    const transfer = r.transfers.at(-1);
    r.helper.history.remove(`local:${id}`);
    r.clipboard.mimetypes = [];
    await r.helper.publish();
    assert.equal(transfer.canceled, true);
    complete(); await sending;
});


test('persisted history restores cached bytes offline and never requests an old lease', async () => {
    const r = await rig();
    const entry = r.helper.history.addRemote(offer(), 'peer');
    r.helper.history.attachValue(entry.id, 'image/png', new Uint8Array([8, 9]));
    entry.persisted = true;
    r.device.connected = false;
    await r.helper.activateHistory(entry);
    assert.equal(r.sent.filter(p => p.body.op === 'request').length, 0);
    assert.deepEqual(r.offered.at(-1)[2]('image/png'), new Uint8Array([8, 9]));
});

test('persisted empty history cannot fall back to requesting the source', async () => {
    const r = await rig();
    const entry = r.helper.history.addRemote(offer(), 'peer');
    entry.persisted = true;
    await assert.rejects(r.helper.activateHistory(entry), /持久化记录没有可用字节快照/);
    assert.equal(r.sent.filter(p => p.body.op === 'request').length, 0);
});
