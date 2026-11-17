// SPDX-FileCopyrightText: 2026 GSConnect fork contributors
// SPDX-License-Identifier: GPL-2.0-or-later
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
const source = await readFile(new URL('../../src/service/utils/clipboardHistory.js', import.meta.url), 'utf8');
const {default: History, MAX_PERSISTED_BYTES, MAX_PERSISTED_VALUE_BYTES} =
    await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
const offer = (id, types = ['text/plain']) => ({id, origin: 'old-peer', revision: 10, types, files: []});
/**
 * Build local and remote cached snapshot fixtures.
 * @returns {History} Populated history
 */
function populated() {
    const history = new History();
    history.addLocal(offer('local'), new Map([['text/plain', new Uint8Array([0, 255, 1, 99])]]));
    history.addRemote(offer('remote', ['image/png']), '电脑 A');
    history.attachValue('remote', 'image/png', new Uint8Array([1, 2]));
    return history;
}
test('codec roundtrip retains snapshots and labels but never revives source leases', () => {
    const original = populated();
    const text = original.serializePersistent();
    const history = new History();
    assert.equal(history.restorePersistent(text), 2);
    assert.deepEqual(history.list().map(x => [x.id, x.direction, x.peerName]),
        original.list().map(x => [x.id, x.direction, x.peerName]));
    assert.deepEqual(history.get('local:local').values.get('text/plain'), new Uint8Array([0, 255, 1, 99]));
    assert.equal(history.getLocalLease('local'), null);
    assert.ok(history.list().every(entry => entry.persisted && entry.values.size &&
        !entry.uris && !entry.offer.files.length && entry.offer.revision === undefined));
    assert.equal(text.includes('old-peer'), false);
    assert.equal(history.serializePersistent(), text);
});
test('codec excludes file offers, URI MIME, sensitive types and uncached remote data', () => {
    const history = populated();
    for (const [id, types, props] of [
        ['file', ['text/plain'], {files: [{file: {}, name: 'private', size: 2}]}],
        ['uri', ['text/uri-list'], {}], ['url', ['text/x-moz-url'], {}],
        ['secret', ['text/plain', 'application/password'], {}],
        ['flag', ['text/plain'], {sensitive: true}],
    ]) history.addLocal({...offer(id, types), ...props}, new Map([[types[0], new Uint8Array([1])]]));
    history.addRemote(offer('empty'), 'Peer');
    assert.deepEqual(JSON.parse(history.serializePersistent()).entries.map(x => x.id), ['local', 'remote']);
});
test('codec rejects invalid trailing entry atomically without notifying', () => {
    const history = populated(); const before = history.list(); let changes = 0;
    history.subscribe(() => changes++);
    const document = JSON.parse(history.serializePersistent());
    document.entries.push({...document.entries[0], id: 'bad', path: '/private/source'});
    assert.throws(() => history.restorePersistent(JSON.stringify(document)));
    assert.deepEqual(history.list(), before); assert.equal(changes, 0);
});
test('codec strict schema and bounded metadata reject unsafe documents', () => {
    const good = JSON.parse(populated().serializePersistent());
    for (const mutate of [
        d => { d.version = 2; }, d => { d.extra = true; },
        d => { d.entries[0].direction = '__proto__'; }, d => { d.entries[0].id = ''; },
        d => { d.entries[0].id = 'x'.repeat(129); }, d => { d.entries[0].peerName = 'x'.repeat(257); },
        d => { d.entries[0].created = -1; }, d => { d.entries[0].created = 1.5; },
        d => { d.entries[0].values = []; },
        d => { d.entries[0].values[0].mime = 'text/uri-list'; },
        d => { d.entries[0].values[0].mime = '/'; },
        d => { d.entries[0].values.push(d.entries[0].values[0]); },
        d => { d.entries.push(d.entries[0]); },
        d => { d.entries = new Array(1001).fill(d.entries[0]); },
        ...['AB==', 'AAB=', '====', 'YW Jj', 'a'].map(data => d => { d.entries[0].values[0].data = data; }),
    ]) {
        const document = structuredClone(good); mutate(document);
        assert.throws(() => new History().restorePersistent(JSON.stringify(document)));
    }
    assert.throws(() => new History().restorePersistent(' '.repeat(MAX_PERSISTED_BYTES + 1)));
});
test('codec restoration respects capacity and never replaces live entries', () => {
    const text = populated().serializePersistent(); const history = new History({maxItems: 2});
    history.addLocal(offer('local'), new Map([['text/plain', new Uint8Array([77])]]));
    assert.equal(history.restorePersistent(text), 1);
    assert.equal(history.getLocalLease('local').values.get('text/plain')[0], 77);
    assert.equal(history.list()[0].id, 'local');
    const disabled = new History({maxItems: 0, maxBytes: 0});
    assert.equal(disabled.restorePersistent(text), 0);
    const small = new History({maxItems: 1}); assert.equal(small.restorePersistent(text), 1);
    assert.equal(small.list()[0].id, 'remote');
});
test('codec base64 covers all bytes and chunk/padding boundaries', () => {
    for (const length of [0, 1, 2, 3, 255, 256, 257, 12287, 12288, 12289]) {
        const bytes = Uint8Array.from({length}, (_, i) => i % 256); const history = new History();
        history.addLocal(offer('bytes'), new Map([['text/plain', bytes]]));
        const text = history.serializePersistent();
        assert.equal(JSON.parse(text).entries[0].values[0].data, Buffer.from(bytes).toString('base64'));
        const restored = new History(); restored.restorePersistent(text);
        assert.deepEqual(restored.get('local:bytes').values.get('text/plain'), bytes);
    }
});
test('codec disk cap keeps newest whole snapshots without trimming session memory', () => {
    const history = new History();
    history.addLocal(offer('old'), new Map([['text/plain', new Uint8Array(1)]]));
    history.addLocal(offer('new', ['image/png']), new Map([['image/png', new Uint8Array(MAX_PERSISTED_VALUE_BYTES)]]));
    history.addLocal(offer('oversized', ['image/png']), new Map([['image/png', new Uint8Array(MAX_PERSISTED_VALUE_BYTES + 1)]]));
    const before = history.bytes; const text = history.serializePersistent();
    assert.ok(Buffer.byteLength(text) <= MAX_PERSISTED_BYTES);
    assert.deepEqual(JSON.parse(text).entries.map(x => x.id), ['new']);
    assert.equal(history.bytes, before); assert.equal(history.list().length, 3);
    const restored = new History(); assert.equal(restored.restorePersistent(text), 1);
    assert.equal(restored.get('local:new').values.get('image/png').length, MAX_PERSISTED_VALUE_BYTES);
});


test('codec preserves epoch and empty bytes but rejects invalid timestamps', () => {
    const history = new History();
    history.addLocal(offer('epoch'), new Map([['text/plain', new Uint8Array()]]));
    history.get('local:epoch').created = 0;
    for (const [index, created] of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER].entries()) {
        const id = `invalid-${index}`;
        history.addLocal(offer(id), new Map([['text/plain', new Uint8Array([1])]]));
        history.get(`local:${id}`).created = created;
    }
    const text = history.serializePersistent();
    assert.deepEqual(JSON.parse(text).entries.map(entry => entry.id), ['epoch']);
    const restored = new History(); restored.restorePersistent(text);
    assert.equal(restored.get('local:epoch').created, 0);
    assert.equal(restored.get('local:epoch').values.get('text/plain').length, 0);
    const document = JSON.parse(text);
    document.entries[0].created = Number.MAX_SAFE_INTEGER;
    assert.throws(() => restored.restorePersistent(JSON.stringify(document)));
});

test('clear evicts every entry but emits one empty-history notification', () => {
    const evicted = [];
    const history = new History({maxItems: 1000, onEvict: entry => evicted.push(entry.id)});
    for (let i = 0; i < 1000; i++)
        history.addLocal(offer(`entry-${i}`), new Map([['text/plain', new Uint8Array([i % 256])]]));
    const snapshots = [];
    history.subscribe(() => snapshots.push(history.serializePersistent()));
    history.clear();
    assert.equal(evicted.length, 1000);
    assert.equal(new Set(evicted).size, 1000);
    assert.equal(history.entries.size, 0);
    assert.equal(snapshots.length, 1);
    assert.deepEqual(JSON.parse(snapshots[0]), {version: 1, entries: []});
    history.clear();
    assert.equal(snapshots.length, 1);
});
