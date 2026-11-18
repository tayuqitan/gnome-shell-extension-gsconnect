// SPDX-FileCopyrightText: 2026 GSConnect fork contributors
// SPDX-License-Identifier: GPL-2.0-or-later
import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';

/**
 * Construct the actual dialog with mocked GTK surfaces.
 * @param {object} options - Optional in-memory backend and callback overrides
 * @returns {object} Isolated UI fixture
 */
function fixture(options = {}) {
    const widgets = [];
    class Widget {
        constructor(properties = {}) {
            Object.assign(this, properties);
            this.children = [];
            this.events = {};
            widgets.push(this);
        }
        add(widget) { this.children.push(widget); }
        connect(name, callback) { this.events[name] = callback; }
        get_content_area() { return new Widget(); }
        add_button() {}
        set_value(value) { this.value = value; }
        get_value_as_int() { return this.value; }
        get_children() { return this.children; }
        show_all() {}
        present() {}
        destroy() { this.events.destroy?.(); }
        static new_with_range() { return new Widget(); }
    }
    const source = readFileSync(new URL('../../src/service/utils/clipboardHistoryDialog.js', import.meta.url), 'utf8')
        .replace(/^import .*;\n/gm, '')
        .replace('export default class ClipboardHistoryDialog', 'this.Dialog = class ClipboardHistoryDialog');
    const scope = {Gio: {Application: {get_default: () => ({})}},
        Gtk: {Dialog: Widget, Label: Widget, CheckButton: Widget, Box: Widget,
            SpinButton: Widget, Button: Widget, ScrolledWindow: Widget,
            ResponseType: {CLOSE: 1}, PolicyType: {NEVER: 1}, Orientation: {VERTICAL: 1}}};
    vm.runInNewContext(source, scope);
    const changes = [];
    let clears = 0;
    let unsubscribed = 0;
    const limits = [];
    const removed = [];
    const entries = options.entries || [];
    const history = {maxItems: 50, maxBytes: 64 * 1048576, bytes: 0, list: () => entries,
        get: key => entries.find(entry => entry.key === key),
        remove: key => removed.push(key),
        subscribe: () => () => { unsubscribed++; }};
    const dialog = new scope.Dialog(history, {onClear: () => { clears++; },
        onReceive: options.onReceive,
        onLimits: value => limits.push(value), onActivate: options.onActivate || (() => {}),
        persistence: options.persistence || {getEnabled: () => false, setEnabled: value => changes.push(value),
            getStatus: () => 'status'}});
    return {dialog, widgets, changes, history, limits, removed,
        unsubscribed: () => unsubscribed, clears: () => clears};
}

test('opening history does not enable persistence and explains plaintext limits', () => {
    const f = fixture();
    assert.deepEqual(f.changes, []);
    const labels = f.widgets.map(w => w.label || '').join('\n');
    assert.match(labels, /明文，默认关闭/);
    assert.match(labels, /总正文最多 8 MiB/);
    assert.match(labels, /文件记录和旧网络租约不保存/);
    const control = f.widgets.find(w => w.label?.startsWith('将字节历史'));
    assert.equal(control.active, false);
    control.active = true;
    control.events.toggled();
    assert.deepEqual(f.changes, [true]);
});

test('clear button delegates even when the in-memory list is already empty', () => {
    const f = fixture();
    f.widgets.find(w => w.label === '清空历史').events.clicked();
    assert.equal(f.clears(), 1);
});


/**
 * Non-sensitive in-memory record; no filesystem or service handles.
 * @returns {object} History entry
 */
function entry() {
    return {key: 'local:fixture', direction: 'local', created: 0,
        offer: {files: [], types: ['application/x-test']}, values: new Map()};
}

test('history limit edits apply only on click and convert MiB to bytes', () => {
    const f = fixture();
    assert.deepEqual(f.limits, []);
    f.dialog.count.set_value(12);
    f.dialog.capacity.set_value(3);
    assert.deepEqual(f.limits, []);
    f.widgets.find(w => w.label === '应用限制').events.clicked();
    assert.equal(f.limits[0].maxItems, 12);
    assert.equal(f.limits[0].maxBytes, 3 * 1048576);
});

test('persistence backend failure is reported without leaking its error detail', () => {
    const f = fixture({persistence: {getEnabled: () => false,
        getStatus: () => 'disabled', setEnabled: () => { throw Error('private detail'); }}});
    const control = f.widgets.find(w => w.label?.startsWith('将字节历史'));
    control.active = true;
    control.events.toggled();
    assert.equal(f.dialog.persistenceStatus.label, '更改磁盘历史设置失败');
    assert.doesNotMatch(f.dialog.persistenceStatus.label, /private detail/);
});

test('closing each independent history window releases its subscription', () => {
    const a = fixture();
    const b = fixture();
    a.dialog.window.events.response();
    assert.equal(a.unsubscribed(), 1);
    assert.equal(b.unsubscribed(), 0);
    b.dialog.destroy();
    assert.equal(b.unsubscribed(), 1);
});

test('cleared history record cannot activate through a stale restore button', async () => {
    let activated = 0;
    const f = fixture({entries: [entry()], onActivate: () => { activated++; }});
    const button = f.widgets.find(w => w.label === '恢复');
    f.history.get = () => undefined;
    await button.events.clicked();
    assert.equal(activated, 0);
    assert.match(f.dialog.status.label, /此记录已被清理/);
    assert.equal(button.sensitive, true);
});

test('pending activation does not update a destroyed window', async () => {
    let finish;
    const f = fixture({entries: [entry()], onActivate: () => new Promise(resolve => { finish = resolve; })});
    const button = f.widgets.find(w => w.label === '恢复');
    const pending = button.events.clicked();
    assert.equal(button.sensitive, false);
    f.dialog.destroy();
    const before = f.dialog.status.label;
    finish();
    await pending;
    assert.equal(f.dialog.status.label, before);
    assert.equal(f.unsubscribed(), 1);
    assert.equal(button.sensitive, false);
});

test('pending activation does not re-enable a superseded row after render', async () => {
    let finish;
    const f = fixture({entries: [entry()], onActivate: () => new Promise(resolve => { finish = resolve; })});
    const oldButton = f.widgets.find(w => w.label === '恢复');
    const pending = oldButton.events.clicked();
    f.dialog.render();
    finish();
    await pending;
    assert.equal(oldButton.sensitive, false);
});

test('deleting a row delegates only the selected record key', () => {
    const f = fixture({entries: [entry()]});
    f.widgets.find(w => w.label === '删除').events.clicked();
    assert.deepEqual(f.removed, ['local:fixture']);
});


test('uncached remote files require a clearly labeled explicit receive click', async () => {
    const file = {...entry(), direction: 'remote', uris: null,
        offer: {types: ['text/uri-list'], files: [{name: 'report.pdf', size: 3}]}};
    let received = 0, restored = 0;
    const f = fixture({entries: [file], onActivate: () => { restored++; },
        onReceive: async selected => { assert.equal(selected, file); received++; }});
    assert.equal(received, 0);
    f.dialog.render();
    assert.equal(received, 0);
    await f.widgets.find(w => w.label === '接收并准备粘贴').events.clicked();
    assert.equal(received, 1);
    assert.equal(restored, 0);
    assert.match(f.dialog.status.label, /Ctrl\+V/);
});

test('explicit receive failure leaves a useful history status without restoring clipboard', async () => {
    const file = {...entry(), direction: 'remote', uris: null,
        offer: {types: ['text/uri-list'], files: [{name: 'report.pdf', size: 3}]}};
    const f = fixture({entries: [file], onReceive: async () => { throw new Error('接收已取消'); }});
    await f.widgets.find(w => w.label === '接收并准备粘贴').events.clicked();
    assert.match(f.dialog.status.label, /接收已取消/);
});
