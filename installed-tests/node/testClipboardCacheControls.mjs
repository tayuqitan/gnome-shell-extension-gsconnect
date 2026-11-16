// SPDX-FileCopyrightText: 2026 GSConnect fork contributors
// SPDX-License-Identifier: GPL-2.0-or-later
import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
function fixture() {
    const widgets = [];
    class Widget {
        constructor(options = {}) { Object.assign(this, options); this.events = {}; widgets.push(this); }
        connect(signal, callback) { this.events[signal] = callback; }
        add() {}
        set_value(value) { this.value = value; }
        get_value_as_int() { return this.value; }
        static new_with_range() { return new Widget(); }
    }
    const source = readFileSync(new URL('../../src/service/utils/clipboardCacheControls.js', import.meta.url), 'utf8')
        .replace(/^import .*;\n/gm, '').replace('export default class ClipboardCacheControls', 'this.Controls = class ClipboardCacheControls');
    const scope = {Gtk: {Box: Widget, Label: Widget, SpinButton: Widget, Button: Widget,
        Orientation: {VERTICAL: 1}}};
    vm.runInNewContext(source, scope);
    let saved, cleaned = 0;
    const controls = new scope.Controls({getLimit: () => 10 * 1073741824,
        setLimit: value => { saved = value; },
        inspect: () => ({used: 123, limit: 1000, failedBatches: 2}),
        cleanup: async () => { cleaned++; return {removed: 1, failed: 1}; }});
    return {controls, click: label => widgets.find(w => w.label === label).events.clicked(),
        saved: () => saved, cleaned: () => cleaned};
}
test('quota UI persists GiB conversion and distinguishes no-delete policy', () => {
    const f = fixture();
    f.controls.capacity.value = 0;
    f.click('保存磁盘配额');
    assert.equal(f.saved(), 0);
    assert.match(f.controls.status.label, /不删除文件/);
    f.click('检查磁盘用量');
    assert.match(f.controls.status.label, /待重试清理 2/);
});
test('cleanup button delegates only safe failed-batch retry and reports result', async () => {
    const f = fixture();
    await f.click('重试清理失败下载');
    assert.equal(f.cleaned(), 1);
    assert.match(f.controls.status.label, /已清理 1 批，仍失败 1 批/);
});
