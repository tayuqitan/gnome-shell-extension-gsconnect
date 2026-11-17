// SPDX-FileCopyrightText: 2026 GSConnect fork contributors
// SPDX-License-Identifier: GPL-2.0-or-later
import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';

/** In-memory token; no sockets or service. */
class Token {
    constructor() { this.handlers = new Map(); this.serial = 0; this.cancelled = false; }
    is_cancelled() { return this.cancelled; }
    connect(fn) { if (this.cancelled) { fn(); return 0; } this.handlers.set(++this.serial, fn); return this.serial; }
    disconnect(id) { this.handlers.delete(id); }
    cancel() { if (this.cancelled) return; this.cancelled = true; for (const fn of this.handlers.values()) fn(); }
}
/**
 * Load real Transfer and Device tracking methods with no I/O backend.
 * @returns {object} Device with real tracking and lifecycle
 */
function lifecycle() {
    const core = readFileSync(new URL('../../src/service/core.js', import.meta.url), 'utf8');
    const device = readFileSync(new URL('../../src/service/device.js', import.meta.url), 'utf8');
    let serial = 0;
    class Base {
        constructor(params) { this.handlers = new Map(); Object.assign(this, params); this._init(params); }
        _init() {}
        connect(name, callback) { this.handlers.set(name, callback); }
        notify(name) { this.handlers.get(`notify::${name}`)?.(this); }
    }
    const scope = {GObject: {Object: Base}, Gio: {Cancellable: Token},
        GLib: {uuid_string_random: () => `transfer-${++serial}`}};
    const body = core.slice(core.indexOf('class Transfer extends'), core.lastIndexOf('});'));
    vm.runInNewContext(`this.Transfer = ${body}};`, scope);
    const start = device.indexOf('    createTransfer() {');
    scope.Core = {Transfer: scope.Transfer};
    vm.runInNewContext(`this.Device = class {${device.slice(start, device.indexOf('\n    /**', start))}}`, scope);
    const result = new scope.Device(); result._transfers = new Map();
    return result;
}
test('eight prepared transfers abandon without I/O and release real Device tracking', async () => {
    const device = lifecycle();
    const transfers = Array.from({length: 8}, () => device.createTransfer());
    assert.equal(device._transfers.size, 8);
    for (const transfer of transfers) {
        transfer.cancel();
        assert.equal(transfer.completed, false, 'cancel alone must not claim I/O settled');
        transfer.abandon();
        transfer.abandon();
        assert.equal(transfer.completed, true);
        await assert.rejects(transfer.start(), /completed/);
    }
    assert.equal(device._transfers.size, 0);
});
test('started transfer cannot be abandoned until its pending I/O actually settles', async () => {
    const device = lifecycle(); const transfer = device.createTransfer();
    let release;
    device.channel = {closed: false, upload: () => new Promise(resolve => { release = resolve; })};
    transfer._items = [{packet: {hasPayload: () => false}}];
    transfer._ensureStream = async () => {};
    const running = transfer.start();
    for (let i = 0; i < 50 && !release; i++) await Promise.resolve();
    assert.equal(typeof release, 'function', 'reached pending upload');
    transfer.cancel();
    assert.throws(() => transfer.abandon(), /started/);
    assert.equal(device._transfers.size, 1);
    release(); await running;
    assert.equal(device._transfers.size, 0);
});
for (const parent of ['read', 'component']) {
    test(`MIME pre-read receives ${parent} cancellation and releases joined handlers`, async () => {
        const source = readFileSync(new URL('../../src/service/components/clipboard.js', import.meta.url), 'utf8');
        const helper = readFileSync(new URL('../../src/service/utils/transferCancellation.js', import.meta.url), 'utf8');
        const scope = {Gio: {Cancellable: Token, DBusCallFlags: {NO_AUTO_START: 1}},
            GLib: {Variant: class {}}, Uint8Array};
        vm.runInNewContext(helper.replace(/^import .*;\n/gm, '').replace(/export /g, ''), scope);
        const method = source.slice(source.indexOf('    async readValue('), source.indexOf('    async offer('));
        vm.runInNewContext(`this.Clipboard = class {${method}}`, scope);
        const clipboard = new scope.Clipboard();
        const component = clipboard._cancellable = new Token();
        const read = new Token();
        Object.assign(clipboard, {available: true, _mimetypes: ['test/mime'], _generation: 1, _offer: null,
            _clipboard: {call(_method, _params, _flags, _timeout, token) {
                return new Promise((resolve, reject) => token.connect(() => reject(Error('cancelled pre-read'))));
            }}});
        const result = clipboard.readValue('test/mime', read);
        const rejected = assert.rejects(result, /cancelled pre-read/);
        (parent === 'read' ? read : component).cancel();
        await rejected;
        assert.equal(read.handlers.size, 0);
        assert.equal(component.handlers.size, 0);
    });
}
