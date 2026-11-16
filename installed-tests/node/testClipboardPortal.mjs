// SPDX-FileCopyrightText: GSConnect Developers https://github.com/GSConnect
// SPDX-License-Identifier: GPL-2.0-or-later

// JS adapter contract tests only. The native helper has separate GI/runtime
// tests; no JavaScript fake async vfunc is used to claim Mutter compatibility.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

function fixture({available = true, nativeAdapter = null, experimental = false} = {}) {
    let serial = 0;
    const signals = [], sources = [], owners = [], unsets = [], transfers = [];
    const callbacks = new Map();
    const logs = [];
    let failConstruction = false;
    class ObjectBase {
        constructor(...args) { this._init(...args); }
        _init() {}
        emit(...args) { signals.push(args); }
    }
    class IOError extends Error {
        constructor({message, code}) { super(message); this.code = code; }
    }
    class Bytes {
        constructor(value) { this.value = typeof value === 'string' ? new TextEncoder().encode(value) : value; }
        static new(value) { return new Bytes(value); }
        get_size() { return this.value.length; }
        get_data() { return this.value; }
    }
    const GLib = {
        PRIORITY_DEFAULT: 0, PRIORITY_DEFAULT_IDLE: 0, SOURCE_REMOVE: false,
        idle_add: (_priority, callback) => { const id = ++serial; callbacks.set(id, callback); return id; },
        source_remove: id => callbacks.delete(id), Bytes,
        Variant: class { constructor(signature, value) { this.signature = signature; this.value = value; } },
    };
    const selection = {
        mimetypes: ['text/plain;charset=utf-8'], bytes: new TextEncoder().encode('hello'),
        connect: () => ++serial, disconnect() {},
        get_mimetypes() { return this.mimetypes; },
        set_owner(type, source) { owners.push([type, source]); },
        unset_owner(type, source) { unsets.push([type, source]); },
        transfer_async(type, mime, limit, stream, cancellable, callback) {
            transfers.push({type, mime, limit}); stream.bytes = this.bytes; callback(this, {});
        }, transfer_finish() {},
    };
    const Gio = {
        IOErrorEnum: Object.assign(IOError, {NOT_FOUND: 1, FAILED: 2, BUSY: 3}),
        DBusError: Object.assign(IOError, {INVALID_ARGS: 4}),
        DBusNodeInfo: {new_for_xml: () => ({lookup_interface: () => ({})})},
        DBus: {own_name: () => ++serial}, BusType: {SESSION: 1}, BusNameOwnerFlags: {NONE: 0},
        bus_unown_name() {}, bus_unwatch_name() {},
        MemoryOutputStream: {new_resizable: () => ({close() {}, steal_as_bytes() { return new Bytes(this.bytes); }})},
    };
    const ClipboardNative = nativeAdapter ?? {
        isAvailable: () => available,
        createSource(id, types, timeout) {
            if (failConstruction)
                throw new Error('Native constructor failed');
            const handlers = new Map();
            const source = {id, types, timeout, closed: 0, resolutions: [],
                connect(name, handler) { handlers.set(name, handler); return handlers.size; },
                emit(name, ...args) { handlers.get(name)?.(this, ...args); },
                resolve(...args) { this.resolutions.push(args); }, close() { this.closed++; }};
            sources.push(source); return source;
        },
    };
    const GObject = {registerClass: (_metadata, type) => type, Object: ObjectBase,
        SignalFlags: {RUN_FIRST: 0}, TYPE_STRING: 's'};
    const source = readFileSync(new URL('../../src/shell/clipboard.js', import.meta.url), 'utf8')
        .replace(/^import .*;\n/gm, '').replace('export const Clipboard', 'const Clipboard')
        .replace(/^export function /gm, 'function ');
    const scope = {Gio, GLib, GObject, ClipboardNative,
        Meta: {SelectionType: {SELECTION_CLIPBOARD: 1},
            SelectionSourceMemory: {new: (mime, bytes) => ({mime, bytes})}},
        DBus: {wrapObject: () => ({export() {}, unexport() {}})}, TextDecoder,
        global: {display: {get_selection: () => selection}}, logError: error => logs.push(error)};
    vm.runInNewContext(`${source}\nthis.Portal = Clipboard; this.setPortal = p => _portal = p; this.unwatch = unwatchService;`, scope);
    const portal = new scope.Portal({experimentalPasteGate: experimental});
    return {portal, sources, signals, owners, unsets, selection, transfers, callbacks, scope,
        failConstruction() { failConstruction = true; }};
}

async function unavailableAdapter(candidate = null) {
    const code = readFileSync(new URL('../../src/shell/clipboardNative.js', import.meta.url), 'utf8')
        .replace(/^import .*;\n/gm, '')
        .replace('import.meta.url', JSON.stringify('file:///extension/shell/clipboardNative.js'))
        .replace("await import('gi://GscClipboard?version=1.0')", "await loadCandidate()")
        .replace(/^export function /gm, 'function ');
    const directory = {get_parent() { return this; }, get_child() { return this; }, get_path: () => '/extension/native'};
    const errors = [];
    const context = {loadCandidate: async () => {
        if (!candidate) throw new Error('typelib missing');
        return {default: candidate};
    }, Gio: {File: {new_for_uri: () => directory}},
        GIRepository: {Repository: {prepend_search_path() {}, prepend_library_path() {}}},
        logError: error => errors.push(error)};
    const adapter = await vm.runInNewContext(`(async () => {${code}\nreturn {isAvailable,createSource};})()`, context);
    return {adapter, errors};
}

test('Offer creates native source with unique MIME types and configured deadline without requesting bytes', () => {
    const r = fixture(); r.portal.Offer('offer-1', ['image/png', 'image/png', 'text/html'], 7200);
    assert.deepEqual(Array.from(r.sources[0].types), ['image/png', 'text/html']);
    assert.equal(r.sources[0].timeout, 7200); assert.equal(r.sources[0].offerId, 'offer-1');
    assert.equal(r.portal.GetOffer(), 'offer-1'); assert.equal(r.signals.length, 0);
    assert.equal(r.owners[0][1], r.sources[0]);
});
test('native request and cancel signals forward original offer identity', () => {
    const r = fixture(); r.portal.Offer('offer-1', ['image/png']);
    r.sources[0].emit('request', 'req-1', 'image/png');
    r.sources[0].emit('cancel-requested', 'req-1');
    assert.deepEqual(r.signals, [['ValueRequested', 'offer-1', 'req-1', 'image/png'],
        ['CancelRequested', 'offer-1', 'req-1']]);
});
test('Resolve forwards bytes or error only to the matching active offer', () => {
    const r = fixture(); r.portal.Offer('offer-1', ['image/png']);
    r.portal.Resolve('wrong', 'req-1', new Uint8Array([7]), '');
    assert.equal(r.sources[0].resolutions.length, 0);
    const bytes = new Uint8Array([0, 255, 1]);
    r.portal.Resolve('offer-1', 'req-1', bytes, '');
    assert.deepEqual(r.sources[0].resolutions[0][1].get_data(), bytes);
    r.portal.Resolve('offer-1', 'req-2', bytes, 'failed');
    assert.deepEqual(r.sources[0].resolutions[1], ['req-2', null, 'failed']);
});
test('replacement closes previous source and stale Resolve cannot reach replacement', () => {
    const r = fixture(); r.portal.Offer('old', ['image/png']); r.portal.Offer('new', ['text/html']);
    assert.equal(r.sources[0].closed, 1); assert.equal(r.sources[1].closed, 0);
    r.portal.Resolve('old', 'req', new Uint8Array([1]), '');
    assert.equal(r.sources[1].resolutions.length, 0); assert.equal(r.portal.GetOffer(), 'new');
});
test('ClearOffer only revokes the matching owner and is idempotent', () => {
    const r = fixture(); r.portal.Offer('offer-1', ['image/png']);
    r.portal.ClearOffer('other'); assert.equal(r.sources[0].closed, 0);
    r.portal.ClearOffer('offer-1'); r.portal.ClearOffer('offer-1');
    assert.equal(r.sources[0].closed, 1); assert.equal(r.unsets.length, 1);
    assert.equal(r.unsets[0][1], r.sources[0]); assert.equal(r.portal.GetOffer(), '');
});
test('invalid offers and deadlines preserve the current owner', () => {
    const r = fixture(); r.portal.Offer('existing', ['image/png']);
    for (const args of [['', ['image/png']], ['id', []], ['id', ['bad\nformat']],
        ...[0, 59, 86401, 1.5, NaN, Infinity, '3600'].map(value => ['id', ['image/png'], value])])
        assert.throws(() => r.portal.Offer(...args), /Invalid/);
    assert.equal(r.portal.GetOffer(), 'existing'); assert.equal(r.sources[0].closed, 0);
    assert.equal(r.owners.length, 1);
});
test('native constructor failure preserves a usable existing source', () => {
    const r = fixture(); r.portal.Offer('existing', ['image/png']); r.failConstruction();
    assert.throws(() => r.portal.Offer('replacement', ['image/png']), /constructor failed/);
    assert.equal(r.portal.GetOffer(), 'existing'); assert.equal(r.sources[0].closed, 0);
    assert.equal(r.owners.length, 1);
});
test('inactive configured gate rejects URI at native request callback without external request', () => {
    const r = fixture({experimental: true}); r.portal.Offer('offer-1', ['text/uri-list', 'image/png']);
    r.sources[0].emit('request', 'file-req', 'text/uri-list');
    assert.equal(r.signals.length, 0);
    assert.deepEqual(r.sources[0].resolutions[0], ['file-req', null, 'Remote files require a local Ctrl+V gesture']);
    r.sources[0].emit('request', 'image-req', 'image/png');
    assert.equal(r.signals[0][0], 'ValueRequested');
});
test('authorized gate permits both file MIME types and replacement invalidates permission', () => {
    const r = fixture({experimental: true});
    let invalidated = 0, authorized = null;
    r.portal._pasteGate = {invalidate() { invalidated++; authorized = null; }, allows: source => source === authorized};
    r.portal.Offer('offer-1', ['text/uri-list', 'x-special/gnome-copied-files']);
    authorized = r.sources[0];
    for (const mime of r.sources[0].types)
        r.sources[0].emit('request', mime, mime);
    assert.equal(r.signals.length, 2);
    r.portal.Offer('offer-2', ['text/uri-list']);
    assert.equal(invalidated, 2);
    r.sources[1].emit('request', 'new-req', 'text/uri-list');
    assert.equal(r.signals.length, 2); assert.equal(r.sources[1].resolutions.length, 1);
});
test('native clipboard owner changes close remote source and invalidate gate', () => {
    const r = fixture(); r.portal.Offer('offer-1', ['image/png']);
    let invalidated = 0; r.portal._pasteGate = {invalidate() { invalidated++; }};
    r.portal._onOwnerChanged(r.selection, 1, {});
    assert.equal(r.sources[0].closed, 1); assert.equal(r.portal.GetOffer(), '');
    assert.equal(invalidated, 1);
});
test('missing typelib is caught by native adapter; portal still constructs with working text methods', async () => {
    const {adapter, errors} = await unavailableAdapter();
    assert.equal(adapter.isAvailable(), false); assert.equal(errors.length, 1);
    const r = fixture({nativeAdapter: adapter});
    assert.throws(() => r.portal.GetOffer(), /unavailable/);
    assert.throws(() => r.portal.Offer('id', ['image/png']), /unavailable/);
    r.portal.SetText('still works');
    assert.equal(new TextDecoder().decode(r.owners[0][1].bytes.get_data()), 'still works');
    let reply;
    await r.portal.GetTextAsync([], {return_value(value) { reply = value; }, return_dbus_error() { assert.fail('text failed'); }});
    assert.equal(reply.signature, '(s)'); assert.equal(reply.value[0], 'hello');
});
test('GetValue uses positional D-Bus MIME argument and bounds read size', async () => {
    const r = fixture(); r.selection.bytes = new Uint8Array([0, 255, 1]);
    let reply;
    await r.portal.GetValueAsync(['image/png'], {return_value(value) { reply = value; }, return_dbus_error() { assert.fail('read failed'); }});
    assert.equal(r.transfers[0].mime, 'image/png'); assert.equal(r.transfers[0].limit, 16 * 1024 * 1024 + 1);
    assert.deepEqual(reply.value[0], r.selection.bytes);
});
test('unwatch destroys existing portal even when watcher already stopped', () => {
    const {scope} = fixture(); let destroyed = 0;
    scope.setPortal({destroy() { destroyed++; }}); scope.unwatch(); scope.unwatch();
    assert.equal(destroyed, 1);
});


test('destroy disconnects before unset owner and cannot queue teardown notifications', () => {
    const r = fixture();
    r.portal.Offer('old', ['image/png']);
    r.portal._onOwnerChanged(r.selection, 1, r.sources[0]);
    assert.equal(r.callbacks.size, 1);
    let disconnected = false;
    r.selection.disconnect = () => { disconnected = true; };
    r.selection.unset_owner = () => {
        assert.equal(disconnected, true);
        // Even a queued/reentrant notification must be harmless.
        r.portal._onOwnerChanged(r.selection, 1, null);
    };
    r.portal.destroy();
    r.portal.destroy();
    assert.equal(r.callbacks.size, 0);
    assert.equal(r.sources[0].closed, 1);
    assert.equal(r.signals.filter(([name]) => name === 'OwnerChange').length, 0);
});

test('namespace import alone does not mark missing shared library available', async () => {
    const candidate = {};
    Object.defineProperty(candidate, 'Source', {get() { throw new Error('shared library missing'); }});
    const {adapter, errors} = await unavailableAdapter(candidate);
    assert.equal(adapter.isAvailable(), false);
    assert.match(errors[0].message, /shared library missing/);
    assert.throws(() => adapter.createSource('x', ['text/plain'], 60), /unavailable/);
});

test('native constructor probe validates required API before availability', async () => {
    const {adapter} = await unavailableAdapter({Source: {new: () => ({close() {}})}});
    assert.equal(adapter.isAvailable(), false);
});

test('availability requires constructed source with signals and working close', async () => {
    let constructions = 0, closed = false;
    const signals = [];
    const {adapter} = await unavailableAdapter({Source: {new(id) {
        constructions++;
        return {resolve() {}, close() { closed = true; },
            get_offer_id: () => id, get_closed: () => closed,
            connect(name) { signals.push(name); return 1; }, disconnect() {}};
    }}});
    assert.equal(adapter.isAvailable(), true);
    assert.equal(constructions, 1);
    assert.equal(closed, true);
    assert.deepEqual(signals, ['request', 'cancel-requested']);
});
