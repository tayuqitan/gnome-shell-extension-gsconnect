// SPDX-FileCopyrightText: GSConnect Developers https://github.com/GSConnect
// SPDX-License-Identifier: GPL-2.0-or-later

// Portable contract tests; these do not substitute for a live Mutter/GJS test.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

function fixture(timeoutSeconds = 3600) {
    let serial = 0;
    const timers = new Map();
    const deadlines = [];
    class ObjectBase {
        constructor(...args) { this._init(...args); }
        _init() {}
    }
    class IOError extends Error {
        constructor({message, code}) { super(message); this.code = code; }
    }
    const GLib = {
        PRIORITY_DEFAULT: 0,
        SOURCE_REMOVE: false,
        uuid_string_random: () => String(++serial),
        timeout_add_seconds: (_priority, seconds, callback) => {
            deadlines.push(seconds);
            const id = ++serial;
            timers.set(id, callback);
            return id;
        },
        source_remove: id => timers.delete(id),
        idle_add: (_priority, callback) => { queueMicrotask(callback); },
        Bytes: class { constructor(value) { this.value = value; } },
    };
    const Gio = {
        IOErrorEnum: Object.assign(IOError, {NOT_FOUND: 1, FAILED: 2, BUSY: 3}),
        DBusError: Object.assign(IOError, {INVALID_ARGS: 4}),
        DBusNodeInfo: {new_for_xml: () => ({lookup_interface: () => ({})})},
        Task: {new: (source, cancellable, callback) => ({
            return_error(error) { this.error = error; callback(source, this); },
            return_error_if_cancelled() {
                if (cancellable?.is_cancelled()) this.return_error(new Error('Cancelled'));
            },
            return_boolean() { callback(source, this); },
            propagate_boolean() { if (this.error) throw this.error; return true; },
        })},
        MemoryInputStream: {new_from_bytes: bytes => ({bytes})},
    };
    const GObject = {
        registerClass: (_metadata, type) => type,
        Object: ObjectBase,
        SignalFlags: {RUN_FIRST: 0},
        TYPE_STRING: 's',
    };
    const source = readFileSync(new URL('../../src/shell/clipboard.js', import.meta.url), 'utf8')
        .replace(/^import .*;\n/gm, '').replace('export const Clipboard', 'const Clipboard')
        .replace(/^export function /gm, 'function ');
    const scope = {Gio, GLib, GObject, Meta: {SelectionSource: ObjectBase}, DBus: {}, TextDecoder};
    vm.runInNewContext(`${source}\nthis.Source = RemoteSelectionSource; this.Portal = Clipboard;`, scope);
    const requests = [];
    const cancellations = [];
    const instance = new scope.Source('offer-1', ['image/png', 'text/html'],
        (...args) => requests.push(args), timeoutSeconds, (...args) => cancellations.push(args));
    return {instance, requests, cancellations, timers, deadlines, Portal: scope.Portal};
}

test('advertises formats without fetching bytes', () => {
    const {instance, requests} = fixture();
    assert.deepEqual(Array.from(instance.vfunc_get_mimetypes()), ['image/png', 'text/html']);
    assert.equal(requests.length, 0);
});

test('fetches only requested format and returns exact binary bytes', () => {
    const {instance, requests, timers} = fixture();
    let result;
    instance.vfunc_read_async('image/png', null, (_source, task) => { result = task; });
    assert.equal(result, undefined);
    assert.equal(requests.length, 1);
    assert.equal(requests[0][2], 'image/png');
    const bytes = new Uint8Array([0, 255, 1]);
    instance.resolve(requests[0][1], bytes, '');
    assert.deepEqual(instance.vfunc_read_finish(result).bytes.value, bytes);
    assert.equal(timers.size, 0);
    assert.equal(instance._pending.size, 0);
});

test('rejects unknown MIME without network request', () => {
    const {instance, requests} = fixture();
    let result;
    instance.vfunc_read_async('application/secret', null, (_source, task) => { result = task; });
    assert.throws(() => instance.vfunc_read_finish(result), /no longer available/);
    assert.equal(requests.length, 0);
});

test('rejects oversized representation and does not truncate it', () => {
    const {instance, requests} = fixture();
    let result;
    instance.vfunc_read_async('image/png', null, (_source, task) => { result = task; });
    instance.resolve(requests[0][1], {length: 16 * 1024 * 1024 + 1}, '');
    assert.throws(() => instance.vfunc_read_finish(result), /16 MiB/);
});

test('ownership replacement completes all outstanding requests with error', () => {
    const {instance, requests, timers} = fixture();
    const results = [];
    for (let i = 0; i < 2; i++)
        instance.vfunc_read_async('image/png', null, (_source, task) => results.push(task));
    instance.close();
    assert.equal(results.length, 2);
    assert.equal(timers.size, 0);
    for (const result of results)
        assert.throws(() => instance.vfunc_read_finish(result), /ownership changed/);
    instance.resolve(requests[0][1], new Uint8Array([1]), '');
    assert.equal(results.length, 2);
});

test('timeout releases task and rejects late results', () => {
    const {instance, requests, timers} = fixture();
    let completions = 0;
    let result;
    instance.vfunc_read_async('text/html', null, (_source, task) => {
        result = task;
        completions++;
    });
    Array.from(timers.values())[0]();
    assert.throws(() => instance.vfunc_read_finish(result), /timed out/);
    instance.resolve(requests[0][1], new Uint8Array(), '');
    assert.equal(completions, 1);
});

test('request flood is bounded at 32 pending tasks', () => {
    const {instance, requests} = fixture();
    let overflow;
    for (let i = 0; i < 33; i++)
        instance.vfunc_read_async('image/png', null, (_source, task) => { overflow = task; });
    assert.equal(requests.length, 32);
    assert.throws(() => instance.vfunc_read_finish(overflow), /Too many/);
    instance.close();
});

test('validates empty and malformed offers before replacing clipboard', () => {
    const {Portal} = fixture();
    const portal = Object.create(Portal.prototype);
    assert.throws(() => portal.Offer('', ['image/png']), /Invalid/);
    assert.throws(() => portal.Offer('id', []), /Invalid/);
    assert.throws(() => portal.Offer('id', ['bad\nformat']), /Invalid/);
});


test('large transfer uses configured total deadline rather than five minutes', () => {
    const {instance, requests, deadlines} = fixture(7200);
    let result;
    instance.vfunc_read_async('text/html', null, (_source, task) => { result = task; });
    assert.deepEqual(deadlines, [7200]);
    assert.equal(result, undefined);
    instance.resolve(requests[0][1], new Uint8Array([1]), '');
    assert.equal(instance.vfunc_read_finish(result).bytes.value[0], 1);
});

test('default and invalid deadlines are bounded', () => {
    const {instance, deadlines, Portal} = fixture();
    instance.vfunc_read_async('image/png', null, () => {});
    assert.deepEqual(deadlines, [3600]);
    instance.close();
    const portal = Object.create(Portal.prototype);
    for (const timeout of [0, 59, 86401, 1.5, NaN, Infinity, '3600']) {
        assert.throws(() => fixture(timeout), /Invalid clipboard deadline/);
        assert.throws(() => portal.Offer('id', ['image/png'], timeout), /Invalid/);
    }
});


test('reader cancellation notifies service before deferred task cleanup and only once', async () => {
    const {instance, requests, cancellations} = fixture();
    let cancelled = false, handler, result;
    const token = {is_cancelled: () => cancelled, connect(fn) { handler = fn; return 1; },
        disconnect() {}, cancel() { cancelled = true; handler(); }};
    instance.vfunc_read_async('image/png', token, (_source, task) => { result = task; });
    token.cancel();
    assert.deepEqual(cancellations, [['offer-1', requests[0][1]]]);
    assert.equal(result, undefined);
    await Promise.resolve();
    assert.match(result.error.message, /cancelled/);
    assert.equal(cancellations.length, 1);
});
