// SPDX-FileCopyrightText: 2026 GSConnect fork contributors
// SPDX-License-Identifier: GPL-2.0-or-later
import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';

/**
 * Construct the actual dialog with mocked GTK surfaces.
 * @returns {object} Isolated UI fixture
 */
function fixture() {
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
    const history = {maxItems: 50, maxBytes: 64 * 1048576, bytes: 0, list: () => [],
        subscribe: () => () => {}};
    const dialog = new scope.Dialog(history, {onClear: () => { clears++; },
        persistence: {getEnabled: () => false, setEnabled: value => changes.push(value),
            getStatus: () => 'status'}});
    return {dialog, widgets, changes, clears: () => clears};
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
