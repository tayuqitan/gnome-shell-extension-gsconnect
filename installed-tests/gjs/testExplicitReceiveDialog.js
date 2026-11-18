// SPDX-FileCopyrightText: 2026 GSConnect fork contributors
// SPDX-License-Identifier: GPL-2.0-or-later
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk?version=3.0';
import Cairo from 'cairo';

const work = GLib.get_current_dir();
if (!/^\.gsconnect-gui-check\.[A-Za-z0-9]+$/.test(GLib.path_get_basename(work)) ||
    GLib.getenv('HOME') !== `${work}/home` ||
    GLib.getenv('XDG_RUNTIME_DIR') !== `${work}/runtime` ||
    GLib.getenv('WAYLAND_DISPLAY') !== 'gsconnect-fixture' ||
    GLib.getenv('DBUS_SESSION_BUS_ADDRESS') !== `unix:path=${work}/runtime/bus` ||
    GLib.getenv('DBUS_SYSTEM_BUS_ADDRESS') !== `unix:path=${work}/runtime/system-bus`)
    throw new Error('Only the private headless GUI fixture is permitted');
const root = Gio.File.new_for_path(ARGV[0]).get_uri();
const {default: History} = await import(`${root}/service/utils/clipboardHistory.js`);
const {default: Dialog} = await import(`${root}/service/utils/clipboardHistoryDialog.js`);
Gtk.init(null);
const app = new Gtk.Application({application_id: 'org.gnome.GSConnect.SyntheticDialog',
    flags: Gio.ApplicationFlags.NON_UNIQUE});
app.register(null);
app.set_default();

/**
 * Assert a GUI contract.
 *
 * @param {boolean} value - Required condition
 * @param {string} message - Failure description
 */
function assert(value, message) {
    if (!value)
        throw new Error(message);
}
/**
 * Wait for actual GTK layout and Promise callbacks.
 *
 * @returns {Promise<void>} Settled frame delay
 */
function frame() {
    return new Promise(resolve => GLib.timeout_add(GLib.PRIORITY_DEFAULT, 100, () => {
        resolve();
        return GLib.SOURCE_REMOVE;
    }));
}
/**
 * Find a real GTK button by its visible text.
 *
 * @param {Gtk.Widget} widget - Root widget
 * @param {string} label - Button label
 * @returns {Gtk.Button|null} Matching widget
 */
function button(widget, label) {
    if (widget instanceof Gtk.Button && widget.label === label)
        return widget;
    for (const child of widget.get_children?.() || []) {
        const match = button(child, label);
        if (match)
            return match;
    }
    return null;
}
/**
 * Render only the synthetic test window, not any desktop screen.
 *
 * @param {Gtk.Window} window - Isolated test window
 * @param {string} name - Screenshot filename
 */
function snapshot(window, name) {
    window.check_resize();
    const width = window.get_allocated_width();
    const height = window.get_allocated_height();
    assert(width > 100 && height > 100, 'real window is allocated');
    const surface = new Cairo.ImageSurface(Cairo.Format.ARGB32, width, height);
    const context = new Cairo.Context(surface);
    window.draw(context);
    surface.writeToPNG(`${work}/${name}.png`);
}
/**
 * Construct real production history/dialog with only synthetic records.
 *
 * @param {function(object): Promise<void>} receive - Synthetic receiver
 * @returns {object} GUI/model controls
 */
function fixture(receive) {
    const history = new History();
    const entry = history.addRemote({id: GLib.uuid_string_random(), revision: 1,
        origin: 'synthetic-peer', types: ['text/uri-list'],
        files: [{name: '合成报告.pdf', size: 2048}]}, '合成测试设备');
    let restored = 0;
    const dialog = new Dialog(history, {peerName: '合成测试设备', onReceive: receive,
        onActivate: () => {
            restored++;
        }});
    dialog.show();
    return {history, entry, dialog, restored: () => restored};
}

let finish;
let received = 0;
const good = fixture(() => {
    received++;
    return new Promise(resolve => {
        finish = resolve;
    });
});
await frame();
assert(received === 0, 'opening real dialog never receives');
const receiveButton = button(good.dialog.window, '接收并准备粘贴');
assert(receiveButton !== null, 'explicit receive action is visible');
snapshot(good.dialog.window, '01-ready');
receiveButton.emit('clicked');
await frame();
assert(received === 1 && !receiveButton.sensitive, 'action is pending and disabled');
snapshot(good.dialog.window, '02-pending');
finish();
await frame();
assert(good.dialog.status.label.includes('Ctrl+V') && receiveButton.sensitive,
    'successful explicit action restores enabled state with paste guidance');
assert(good.restored() === 0, 'receive never routes through ordinary restore');
snapshot(good.dialog.window, '03-success');
good.dialog.destroy();
print('PASS real GTK ready, pending and success states');

const bad = fixture(() => Promise.reject(new Error('合成错误：接收已取消')));
await frame();
const failedButton = button(bad.dialog.window, '接收并准备粘贴');
failedButton.emit('clicked');
await frame();
assert(bad.dialog.status.label.includes('接收已取消') && failedButton.sensitive,
    'failure is shown and allows retry');
snapshot(bad.dialog.window, '04-error');
bad.dialog.destroy();
print('PASS real GTK failure status and retry');

let staleCalls = 0;
const stale = fixture(() => {
    staleCalls++;
    return Promise.resolve();
});
await frame();
const staleButton = button(stale.dialog.window, '接收并准备粘贴');
// Invalidate without repainting, modeling a stale event.
stale.history.entries.delete(stale.entry.key);
staleButton.emit('clicked');
await frame();
assert(staleCalls === 0 && stale.dialog.status.label.includes('已被清理'),
    'stale GUI action has no receive authority');
stale.dialog.destroy();
print('PASS real GTK stale action rejection');

let settle;
const closing = fixture(() => new Promise(resolve => {
    settle = resolve;
}));
await frame();
button(closing.dialog.window, '接收并准备粘贴').emit('clicked');
await frame();
closing.dialog.destroy();
settle();
await frame();
assert(closing.dialog.destroyed, 'closed window remains destroyed after late completion');
print('PASS real GTK close during pending action');
print('PASS 4/4 real GTK component scenarios; synthetic receiver, no network or real clipboard');
