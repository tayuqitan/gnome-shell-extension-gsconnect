// SPDX-FileCopyrightText: 2026 GSConnect fork contributors
// SPDX-License-Identifier: GPL-2.0-or-later
import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';

const root = new URL('../src/service/utils/', import.meta.url);
const read = file => readFileSync(new URL(file, root), 'utf8');
const fileTypes = ['text/uri-list', 'x-special/gnome-copied-files'];
const body = (changes = {}) => ({id: 'remote-one', revision: 1, origin: 'peer',
    types: [...fileTypes], files: [{name: 'file.txt', size: 3}], ...changes});
const tick = () => new Promise(resolve => setImmediate(resolve));

/**
 * Load real clipboard orchestration and history; all desktop/network edges are synthetic.
 * @returns {object} Test controls
 */
function fixture() {
    let serial = 0;
    const notifications = [], packets = [], publications = [], cleared = [], downloads = [];
    const timers = new Map();
    class Cancellable {
        constructor() { this.cancelled = false; this.callbacks = new Map(); }
        is_cancelled() { return this.cancelled; }
        connect(callback) { const id = ++serial; this.callbacks.set(id, callback); return id; }
        disconnect(id) { this.callbacks.delete(id); }
        cancel() {
            if (this.cancelled) return;
            this.cancelled = true;
            for (const callback of [...this.callbacks.values()]) callback();
        }
    }
    const values = {'receive-content': true, 'send-content': true};
    const settings = {get_boolean: key => values[key], get_uint: key => ({
        'history-max-items': 50, 'history-max-bytes': 1048576, 'rich-transfer-timeout': 3600,
    })[key], connect: () => ++serial, disconnect() {}};
    const device = {name: 'synthetic peer', connected: true,
        settings: {get_strv: () => ['gsconnect.clipboard.rich']},
        sendPacket: packet => packets.push(packet),
        showNotification: notification => notifications.push(notification), hideNotification() {}};
    const clipboard = {richAvailable: true, generation: 7, mimetypes: [], currentOfferId: null,
        connect: () => ++serial, disconnect() {},
        offer(id, types, provider) {
            this.generation++;
            this.currentOfferId = id;
            publications.push({id, types, provider});
            return Promise.resolve();
        },
        async isCurrentOffer(id) { return this.currentOfferId === id; },
        async clearOffer(id) {
            cleared.push(id);
            if (this.currentOfferId === id) this.currentOfferId = null;
        },
    };
    const scope = {TextEncoder, TextDecoder, Uint8Array, Map, Set, Promise,
        debug() {}, _: text => text,
        Gio: {Cancellable, ThemedIcon: class {constructor(options) {Object.assign(this, options);}}},
        GLib: {uuid_string_random: () => `synthetic-${++serial}`,
            Variant: class {constructor(type, value) {this.type = type; this.value = value;}},
            PRIORITY_DEFAULT: 0, SOURCE_REMOVE: false,
            timeout_add_seconds(_priority, _seconds, callback) {
                const id = ++serial; timers.set(id, callback); return id;
            }, source_remove(id) { timers.delete(id); },
            idle_add(_priority, callback) {queueMicrotask(callback); return ++serial;}},
    };
    const history = read('clipboardHistory.js').replace(/^export const /gm, 'const ')
        .replace('export default class ClipboardHistory', 'this.ClipboardHistory = class ClipboardHistory');
    vm.runInNewContext(history, scope);
    const richSource = read('richClipboard.js').replace(/^import .*;\n/gm, '')
        .replace('export const CAPABILITY', 'const CAPABILITY')
        .replace('export default class RichClipboard', 'this.RichClipboard = class RichClipboard');
    vm.runInNewContext(richSource, scope);
    const rich = new scope.RichClipboard({device, settings}, clipboard);
    rich.remoteReady = true;
    rich.fetchFiles = (remote, cancellable) => new Promise((resolve, reject) => {
        downloads.push({remote, cancellable, resolve, reject});
    });
    return {rich, clipboard, device, values, notifications, packets, publications, cleared, downloads, timers,
        complete: (index = 0) => downloads[index].resolve(['file:///synthetic-cache/file.txt'])};
}

test('file metadata arrival and normal history restoration never publish or download', async () => {
    const f = fixture();
    await f.rich.accept(body());
    const firstToken = f.rich.remote.receiveToken;
    assert.ok(firstToken);
    assert.equal(f.notifications[0].buttons[0].parameter.value, firstToken);
    assert.equal(f.notifications[0].buttons[0].action, 'clipboardReceiveFiles');
    const entry = f.rich.history.get('remote:remote-one');
    await f.rich.activateHistory(entry);
    assert.notEqual(f.rich.remote.receiveToken, firstToken);
    assert.equal(f.publications.length, 0);
    assert.equal(f.downloads.length, 0);
    assert.equal(f.packets.length, 0);
    f.rich.destroy();
});

test('unauthorized getFiles and file request fail without network packets', async () => {
    const f = fixture(); await f.rich.accept(body());
    await assert.rejects(f.rich.getFiles(f.rich.remote));
    await assert.rejects(f.rich.request(f.rich.remote, {index: 0}, {}));
    assert.equal(f.packets.length, 0);
    assert.equal(f.downloads.length, 0);
    f.rich.destroy();
});

test('explicit receive deduplicates, waits for download, then serves only local URI bytes', async () => {
    const f = fixture(); await f.rich.accept(body());
    const token = f.rich.remote.receiveToken;
    const a = f.rich.receiveFiles(token), b = f.rich.receiveFiles(token);
    assert.equal(a, b);
    await tick();
    assert.equal(f.downloads.length, 1);
    assert.equal(f.publications.length, 0);
    f.complete(); await a;
    assert.equal(f.publications.length, 1);
    assert.notEqual(f.publications[0].id, 'remote-one');
    for (let n = 0; n < 5; n++) {
        for (const mime of fileTypes)
            assert.match(new TextDecoder().decode(f.publications[0].provider(mime)), /file:\/\/\/synthetic-cache/);
    }
    assert.equal(f.downloads.length, 1);
    assert.equal(f.packets.length, 0);
    assert.equal(f.rich.remote.authorized, false);
    assert.ok(f.notifications.some(item => item.title === '文件已接收'));
    f.rich.destroy();
});

test('stale token cannot select a replacement offer or mutate its file snapshot', async () => {
    const f = fixture(); const first = body(); await f.rich.accept(first);
    const token = f.rich.remote.receiveToken;
    first.files[0].name = 'changed';
    assert.equal(f.rich.remote.files[0].name, 'file.txt');
    await f.rich.accept(body({revision: 2}));
    assert.notEqual(f.rich.remote.receiveToken, token);
    await assert.rejects(f.rich.receiveFiles(token));
    assert.equal(f.downloads.length, 0);
    f.rich.destroy();
});

for (const reason of ['cancel', 'replacement', 'generation', 'disconnect', 'receive-disabled', 'destroy']) {
    test(`${reason} while receiving cannot publish completed stale download`, async () => {
        const f = fixture(); await f.rich.accept(body());
        const result = f.rich.receiveFiles(f.rich.remote.receiveToken);
        const rejected = assert.rejects(result);
        await tick();
        if (reason === 'cancel') f.rich.remote.download.cancellable.cancel();
        if (reason === 'replacement') await f.rich.accept(body({id: 'remote-two', revision: 2}));
        if (reason === 'generation') f.clipboard.generation++;
        if (reason === 'disconnect') f.device.connected = false;
        if (reason === 'receive-disabled') f.values['receive-content'] = false;
        if (reason === 'destroy') f.rich.destroy();
        f.complete(); await rejected;
        assert.equal(f.publications.length, 0);
        assert.ok(!f.notifications.some(item => item.title === '文件已接收'));
        f.rich.destroy();
    });
}

test('explicit history receive downloads while ordinary activation does not', async () => {
    const f = fixture(); await f.rich.accept(body());
    const entry = f.rich.history.get('remote:remote-one');
    await f.rich.activateHistory(entry);
    assert.equal(f.downloads.length, 0);
    const result = f.rich.receiveHistoryFiles(entry);
    await tick(); assert.equal(f.downloads.length, 1);
    f.complete(); await result;
    assert.equal(f.publications.length, 1);
    assert.equal(entry.uris[0], 'file:///synthetic-cache/file.txt');
    f.rich.destroy();
});

test('history deletion during explicit download prevents publication', async () => {
    const f = fixture(); await f.rich.accept(body());
    const entry = f.rich.history.get('remote:remote-one');
    const result = f.rich.receiveHistoryFiles(entry);
    const rejected = assert.rejects(result);
    await tick(); f.rich.history.remove(entry.key); f.complete(); await rejected;
    assert.equal(f.publications.length, 0);
    f.rich.destroy();
});

test('download error permits retry without reusing failed transaction', async () => {
    const f = fixture(); await f.rich.accept(body());
    const token = f.rich.remote.receiveToken;
    const first = f.rich.receiveFiles(token);
    const rejected = assert.rejects(first, /failed/);
    await tick(); f.downloads[0].reject(new Error('failed')); await rejected;
    assert.equal(f.rich.remote.authorized, false);
    const second = f.rich.receiveFiles(token);
    await tick(); assert.equal(f.downloads.length, 2);
    f.complete(1); await second;
    assert.equal(f.publications.length, 1);
    f.rich.destroy();
});

test('non-file offers retain demand-driven behavior', async () => {
    const f = fixture(); await f.rich.accept(body({types: ['image/png'], files: []}));
    assert.equal(f.publications.length, 1);
    let requests = 0;
    f.rich.request = async (_remote, detail) => {requests++; assert.equal(detail.mime, 'image/png'); return new Uint8Array([1]);};
    assert.deepEqual([...await f.publications[0].provider('image/png')], [1]);
    assert.equal(requests, 1);
    assert.equal(f.downloads.length, 0);
    f.rich.destroy();
});

test('history action cannot authorize an offer replacing it across the accept await', async () => {
    const f = fixture(); await f.rich.accept(body());
    const entry = f.rich.history.get('remote:remote-one');
    const result = f.rich.receiveHistoryFiles(entry);
    // accept(file) changes this.remote synchronously before returning its Promise.
    await f.rich.accept(body({id: 'replacement', revision: 2}));
    let failed = false;
    const settled = result.catch(() => {failed = true;});
    await tick();
    if (f.downloads.length) {
        f.downloads[0].reject(new Error('cleanup unexpected download'));
        await settled;
    }
    assert.equal(f.downloads.length, 0, 'old history approval must not download replacement files');
    await settled;
    assert.equal(failed, true);
    assert.equal(f.publications.length, 0);
    f.rich.destroy();
});

test('receive token cancels before download or progress exists', async () => {
    const f = fixture(); await f.rich.accept(body());
    const token = f.rich.remote.receiveToken;
    const result = f.rich.receiveFiles(token);
    const rejected = assert.rejects(result);
    f.rich.cancelDownload(token);
    await rejected;
    assert.equal(f.downloads.length, 0);
    assert.equal(f.publications.length, 0);
    f.rich.destroy();
});

test('same-id different revision download cannot populate the older history snapshot', async () => {
    const f = fixture(); await f.rich.accept(body());
    const oldEntry = f.rich.history.get('remote:remote-one');
    await f.rich.accept(body({revision: 2, files: [{name: 'new.txt', size: 3}]}));
    const result = f.rich.receiveFiles(f.rich.remote.receiveToken);
    await tick(); f.complete(); await result;
    assert.equal(oldEntry.offer.revision, 1);
    assert.equal(oldEntry.uris, null);
    assert.equal(f.publications.length, 1);
    f.rich.destroy();
});

test('clipboard replacement during publication clears only this publication and reports cancellation', async () => {
    const f = fixture(); await f.rich.accept(body());
    let resolvePublication;
    const originalOffer = f.clipboard.offer.bind(f.clipboard);
    f.clipboard.offer = (...args) => {
        originalOffer(...args);
        return new Promise(resolve => {resolvePublication = resolve;});
    };
    const result = f.rich.receiveFiles(f.rich.remote.receiveToken);
    const rejected = assert.rejects(result);
    await tick(); f.complete(); await tick();
    assert.equal(f.publications.length, 1);
    f.clipboard.generation++;
    f.clipboard.currentOfferId = 'other-device-publication';
    resolvePublication(); await rejected;
    assert.ok(f.cleared.includes(f.publications[0].id));
    assert.ok(!f.notifications.some(item => item.title === '文件已接收'));
    f.rich.destroy();
});

test('file network requests carry the explicitly selected revision and origin', async () => {
    const f = fixture(); await f.rich.accept(body());
    const remote = f.rich.remote;
    remote.authorized = true;
    const request = f.rich.request(remote, {index: 0}, {});
    assert.equal(f.packets.length, 1);
    assert.equal(f.packets[0].body.revision, remote.revision);
    assert.equal(f.packets[0].body.origin, remote.origin);
    f.rich.finish(f.packets[0].body.request, null);
    await request;
    f.rich.destroy();
});

test('own Shell OwnerChange during publication must not invalidate the received files', async () => {
    const f = fixture(); await f.rich.accept(body());
    const originalOffer = f.clipboard.offer.bind(f.clipboard);
    f.clipboard.offer = (...args) => {
        originalOffer(...args);
        // Real component _onOwnerChange increments generation even if GetOffer
        // later confirms this same GSConnect-owned source and emits no changed.
        return Promise.resolve().then(() => { f.clipboard.generation++; });
    };
    const result = f.rich.receiveFiles(f.rich.remote.receiveToken);
    await tick(); f.complete();
    await result;
    assert.equal(f.publications.length, 1);
    assert.ok(f.notifications.some(item => item.title === '文件已接收'));
    f.rich.destroy();
});

for (const scenario of ['own-generation', 'different-owner', 'same-id-replacement']) {
    test(`real component offer identity check: ${scenario}`, async () => {
        const source = readFileSync(new URL('../src/service/components/clipboard.js', import.meta.url), 'utf8');
        const start = source.indexOf('    async isCurrentOffer(');
        const end = source.indexOf('    async clearOffer(', start);
        assert.ok(start >= 0 && end > start);
        const scope = {};
        vm.runInNewContext(`this.Component = class {${source.slice(start, end)}};`, scope);
        const component = new scope.Component();
        component.available = true;
        component._offer = {id: 'received-fixture'};
        component._generation = 1;
        let answer;
        component._call = method => {
            assert.equal(method, 'GetOffer');
            return new Promise(resolve => {answer = resolve;});
        };
        const result = component.isCurrentOffer('received-fixture');
        if (scenario === 'own-generation') component._generation++;
        if (scenario === 'same-id-replacement') component._offer = {id: 'received-fixture'};
        answer({deepUnpack: () => [scenario === 'different-owner' ? 'other' : 'received-fixture']});
        assert.equal(await result, scenario === 'own-generation');
    });
}

for (const reason of ['cancel', 'receive-disabled', 'disconnect']) {
    test(`${reason} during owner verification removes published offer`, async () => {
        const f = fixture(); await f.rich.accept(body());
        const token = f.rich.remote.receiveToken;
        let verify;
        f.clipboard.isCurrentOffer = () => new Promise(resolve => {verify = resolve;});
        const result = f.rich.receiveFiles(token);
        const rejected = assert.rejects(result);
        await tick(); f.complete(); await tick();
        assert.equal(f.publications.length, 1);
        if (reason === 'cancel') f.rich.cancelDownload(token);
        if (reason === 'receive-disabled') f.values['receive-content'] = false;
        if (reason === 'disconnect') f.device.connected = false;
        verify(true); await rejected;
        assert.equal(f.clipboard.currentOfferId, null);
        assert.ok(!f.notifications.some(item => item.title === '文件已接收'));
        f.rich.destroy();
    });
}

test('owner verification error removes an already-published offer', async () => {
    const f = fixture(); await f.rich.accept(body());
    f.clipboard.isCurrentOffer = async () => {throw new Error('D-Bus unavailable');};
    const result = f.rich.receiveFiles(f.rich.remote.receiveToken);
    const rejected = assert.rejects(result, /D-Bus unavailable/);
    await tick(); f.complete(); await rejected;
    assert.equal(f.publications.length, 1);
    assert.equal(f.clipboard.currentOfferId, null);
    assert.ok(!f.notifications.some(item => item.title === '文件已接收'));
    f.rich.destroy();
});

test('overall receive deadline prevents publication and permits clean retry', async () => {
    const f = fixture(); await f.rich.accept(body());
    const token = f.rich.remote.receiveToken;
    const result = f.rich.receiveFiles(token);
    const rejected = assert.rejects(result);
    await tick();
    assert.equal(f.timers.size, 1);
    const [id, callback] = f.timers.entries().next().value;
    f.timers.delete(id); callback();
    f.complete(); await rejected;
    assert.equal(f.publications.length, 0);
    assert.equal(f.timers.size, 0);
    const retry = f.rich.receiveFiles(token);
    await tick(); assert.equal(f.timers.size, 1);
    f.complete(1); await retry;
    assert.equal(f.publications.length, 1);
    assert.equal(f.timers.size, 0);
    f.rich.destroy();
});

test('duplicate history receive actions reuse one acceptance and download', async () => {
    const f = fixture(); await f.rich.accept(body());
    const entry = f.rich.history.get('remote:remote-one');
    let acceptances = 0;
    const accept = f.rich.accept.bind(f.rich);
    f.rich.accept = (...args) => { acceptances++; return accept(...args); };
    const first = f.rich.receiveHistoryFiles(entry);
    await tick();
    const token = f.rich.remote.receiveToken;
    const second = f.rich.receiveHistoryFiles(entry);
    await tick();
    assert.equal(acceptances, 1);
    assert.equal(f.rich.remote.receiveToken, token);
    assert.equal(f.downloads.length, 1);
    f.complete(); await Promise.all([first, second]);
    assert.equal(f.publications.length, 1);
    assert.equal(f.timers.size, 0);
    f.rich.destroy();
});

test('notification failures do not prevent receiving or clearing the offer', async () => {
    const f = fixture();
    f.device.showNotification = () => { throw new Error('notification unavailable'); };
    f.device.hideNotification = () => { throw new Error('notification removal unavailable'); };
    await f.rich.accept(body());
    const token = f.rich.remote.receiveToken;
    const result = f.rich.receiveFiles(token);
    await tick(); f.complete(); await result;
    assert.equal(f.publications.length, 1);
    assert.equal(f.timers.size, 0);
    assert.equal(f.rich.remote.authorized, false);
    assert.doesNotThrow(() => f.rich.clearRemote());
    assert.equal(f.rich.remote, null);
    assert.equal(f.clipboard.currentOfferId, null);
    f.rich.destroy();
});

test('same-tick history receive actions share acceptance before its await resumes', async () => {
    const f = fixture(); await f.rich.accept(body());
    const entry = f.rich.history.get('remote:remote-one');
    let acceptances = 0;
    const accept = f.rich.accept.bind(f.rich);
    f.rich.accept = (...args) => { acceptances++; return accept(...args); };
    const first = f.rich.receiveHistoryFiles(entry);
    const second = f.rich.receiveHistoryFiles(entry);
    const both = Promise.all([first, second]);
    assert.equal(acceptances, 1);
    await tick();
    assert.equal(f.downloads.length, 1);
    f.complete(); await both;
    assert.equal(f.publications.length, 1);
    assert.equal(f.timers.size, 0);
    f.rich.destroy();
});
