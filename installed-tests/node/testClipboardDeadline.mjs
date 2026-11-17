// SPDX-FileCopyrightText: GSConnect Developers https://github.com/GSConnect
// SPDX-License-Identifier: GPL-2.0-or-later

// Tests the component deadline contract without a desktop or real waits.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

/**
 * Build an isolated clipboard deadline fixture.
 * @returns {object} Component and captured timer behavior
 */
function fixture() {
    const deadlines = [];
    const timers = new Map();
    let serial = 0;
    const GLib = {
        Variant: class {
            constructor(signature, values) { this.signature = signature; this.values = values; }
        },
        timeout_add_seconds: (_priority, seconds, callback) => {
            deadlines.push(seconds);
            timers.set(++serial, callback);
            return serial;
        },
        source_remove: id => timers.delete(id),
        PRIORITY_DEFAULT: 0,
        SOURCE_REMOVE: false,
    };
    const GObject = {
        registerClass: (_meta, type) => type,
        Object: class {},
        ParamSpec: {string() {}},
        ParamFlags: {READWRITE: 0},
    };
    const source = readFileSync(new URL('../../src/service/components/clipboard.js', import.meta.url), 'utf8')
        .replace(/^import .*;\n/gm, '').replace('export default Clipboard;', 'this.Component = Clipboard;');
    const Gio = {Cancellable: class {
        cancel() { this.cancelled = true; }
        is_cancelled() { return Boolean(this.cancelled); }
    }};
    const scope = {GLib, GObject, Gio, Uint8Array, debug() {}};
    vm.runInNewContext(source, scope);
    const component = Object.create(scope.Component.prototype);
    Object.assign(component, {
        _available: true, _generation: 0, _offer: null,
        _requests: new Set(), _pendingRejects: new Set(),
        _cancellable: {is_cancelled: () => false}, _clipboard: {},
    });
    const calls = [];
    component._call = async (method, parameters) => { calls.push({method, parameters}); };
    return {component, calls, deadlines, timers};
}

test('offer defaults to a one-hour total deadline and serializes uint', async () => {
    const {component, calls} = fixture();
    await component.offer('offer', ['image/png'], async () => new Uint8Array());
    assert.equal(component._offer.timeoutSeconds, 3600);
    assert.equal(calls[0].parameters.signature, '(sasu)');
    assert.equal(calls[0].parameters.values[2], 3600);
});

test('configured long transfer deadline reaches callback timer unchanged', async () => {
    const {component, calls, deadlines, timers} = fixture();
    await component.offer('offer', ['image/png'], async () => new Uint8Array([4]), 7200);
    await component._onValueRequested(component._clipboard, ['offer', 'request', 'image/png']);
    assert.deepEqual(deadlines, [7200]);
    assert.equal(timers.size, 0);
    assert.equal(calls[1].method, 'Resolve');
    assert.equal(calls[1].parameters.values[2][0], 4);
    assert.equal(calls[1].parameters.values[3], '');
});

test('invalid deadlines cannot replace an existing offer', async () => {
    const {component, calls} = fixture();
    await component.offer('old', ['image/png'], async () => new Uint8Array(), 60);
    for (const timeout of [0, 59, 86401, 1.5, NaN, Infinity, '3600']) {
        await assert.rejects(component.offer('new', ['image/png'], () => {}, timeout), /Invalid/);
        assert.equal(component._offer.id, 'old');
    }
    assert.equal(calls.length, 1);
});

test('configured deadline expiry completes pending request without a real wait', async () => {
    const {component, calls, deadlines, timers} = fixture();
    await component.offer('offer', ['image/png'], () => new Promise(() => {}), 86400);
    const pending = component._onValueRequested(component._clipboard, ['offer', 'request', 'image/png']);
    assert.deepEqual(deadlines, [86400]);
    Array.from(timers.values())[0]();
    await pending;
    assert.equal(component._pendingRejects.size, 0);
    assert.equal(component._requests.size, 0);
    assert.equal(calls[1].parameters.values[3], 'Clipboard data unavailable');
});

test('whole-paste deadline cancels the provider token, not just its outer promise', async () => {
    const {component, timers} = fixture();
    let token;
    await component.offer('offer', ['text/uri-list'], (_mime, cancellable) => {
        token = cancellable;
        return new Promise(() => {});
    }, 60);
    const pending = component._onValueRequested(component._clipboard,
        ['offer', 'request', 'text/uri-list']);
    await Promise.resolve();
    assert.equal(token.is_cancelled(), false);
    Array.from(timers.values())[0]();
    await pending;
    assert.equal(token.is_cancelled(), true);
});


test('Shell cancellation signal cancels matching provider token immediately', async () => {
    const {component} = fixture();
    let token;
    await component.offer('offer', ['image/png'], (_mime, cancellable) => {
        token = cancellable; return new Promise(() => {});
    });
    const pending = component._onValueRequested(component._clipboard, ['offer', 'req', 'image/png']);
    await Promise.resolve();
    component._onProxySignal(component._clipboard, '', 'CancelRequested',
        {deepUnpack: () => ['wrong-offer', 'req']});
    assert.equal(token.is_cancelled(), false);
    component._onProxySignal(component._clipboard, '', 'CancelRequested',
        {deepUnpack: () => ['offer', 'req']});
    assert.equal(token.is_cancelled(), true);
    await pending;
    assert.equal(component._requestRejects.size, 0);
});
