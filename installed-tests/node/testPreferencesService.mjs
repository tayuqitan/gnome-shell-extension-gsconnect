// SPDX-FileCopyrightText: 2026 GSConnect fork contributors
// SPDX-License-Identifier: GPL-2.0-or-later
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

/**
 * Load production preferences methods with in-memory GTK/Gio/service boundaries.
 * No GI imports, session bus, subprocess, filesystem writes or network exist here.
 * @returns {object} Fixture and captured effects
 */
function fixture() {
    const classes = new Map();
    const timers = new Map();
    const removedTimers = [];
    const errors = [];
    const widgets = [];
    const services = [];
    const calls = [];
    const stores = new Map();
    let nextTimer = 1;
    class Widget {
        constructor(properties = {}) {
            Object.assign(this, properties);
            this.children = [];
            this.signals = new Map();
            this.actions = new Map();
            this.groups = new Map();
            this.pages = new Map();
            widgets.push(this);
        }
        _init(properties) { Object.assign(this, properties); }
        connect(name, callback) { this.signals.set(name, callback); return name; }
        emit(name, ...args) { return this.signals.get(name)?.(this, ...args); }
        destroy() {
            this.destroyed = true;
            if (this.parent) {
                this.parent.children = this.parent.children.filter(child => child !== this);
                for (const [key, value] of this.parent.pages) {
                    if (value === this)
                        this.parent.pages.delete(key);
                }
            }
        }
        add(child) { this.children.push(child); child.parent = this; }
        attach(child) { this.add(child); }
        add_titled(child, key) { this.add(child); this.pages.set(key, child); }
        get_child_by_name(key) { return this.pages.get(key) ?? null; }
        get_visible_child() { return this.visible_child; }
        get_children() { return this.children; }
        set_name(name) { this.name = name; }
        get_name() { return this.name; }
        set_focus_vadjustment() {}
        set_header_func() {}
        add_action(action) { this.actions.set(action.name, action); }
        insert_action_group(key, group) { this.groups.set(key, group); }
        set_menu_model(menu) { this.menu = menu; }
        grab_focus() { this.focused = true; }
        show_all() { this.shown = true; }
        present() { this.presented = (this.presented ?? 0) + 1; }
        hide_on_delete() { this.hidden = true; return true; }
        add_button() {}
        get_window() { return {get_state: () => this.windowState ?? 0}; }
        get_size() { return this.size ?? [640, 480]; }
        set_default_size(...size) { this.size = size; }
        maximize() { this.maximized = true; }
    }
    class Settings {
        constructor({settings_schema}) {
            if (!stores.has(settings_schema))
                stores.set(settings_schema, {name: 'Fixture desktop', 'window-size': [640, 480]});
            this.values = stores.get(settings_schema);
            this.bindings = [];
        }
        get_boolean(key) { return Boolean(this.values[key]); }
        set_boolean(key, value) { this.values[key] = Boolean(value); }
        get_string(key) { return this.values[key] ?? ''; }
        set_string(key, value) { this.values[key] = value; }
        get_value(key) { return {deepUnpack: () => this.values[key]}; }
        set_value(key, value) { this.values[key] = value.value; }
        bind(...args) { this.bindings.push(args); }
        create_action(name) { return {name}; }
    }
    class Service {
        constructor() { this.handlers = new Map(); this.active = false; services.push(this); }
        connect(name, callback) { this.handlers.set(name, callback); return name; }
        disconnect(id) { this.handlers.delete(id); }
        emit(name, ...args) { this.handlers.get(name)?.(this, ...args); }
        reload() { this.reloads = (this.reloads ?? 0) + 1; return Promise.resolve(); }
        activate_action(...args) { calls.push(args); }
        destroy() { this.destroyed = true; }
    }
    class Variant {
        constructor(type, value) { this.type = type; this.value = value; }
        static new_string(value) { return new Variant('s', value); }
    }
    const scope = {
        Gtk: {Dialog: Widget, ApplicationWindow: Widget, MessageDialog: Widget,
            AboutDialog: Widget, ListBoxRow: Widget, Grid: Widget, Image: Widget, Label: Widget,
            ResponseType: {OK: 1, CANCEL: 0}, ButtonsType: {OK: 1}, License: {GPL_2_0: 1},
            IconSize: {BUTTON: 1}, Align: {START: 0, CENTER: 1, END: 2}},
        GObject: {ParamSpec: {string() {}}, ParamFlags: {READWRITE: 1}, BindingFlags: {SYNC_CREATE: 1},
            registerClass(metadata, Klass) {
                const Registered = class extends Klass {
                    constructor(properties = {}) {
                        super();
                        for (const child of metadata.Children ?? [])
                            this[child.replaceAll('-', '_')] = new Widget();
                        this._init(properties);
                    }
                };
                classes.set(metadata.GTypeName, Registered);
                return Registered;
            }},
        Gio: {Settings, SettingsBindFlags: {INVERT_BOOLEAN: 1, DEFAULT: 0},
            SimpleAction: Widget, PropertyAction: Widget, ThemedIcon: Widget,
            Application: {get_default: () => ({activate_action: (...args) => calls.push(args)})}},
        GLib: {Bytes: class {}, Variant, getenv() {}, get_os_info() {},
            PRIORITY_DEFAULT: 0, PRIORITY_DEFAULT_IDLE: 1, SOURCE_CONTINUE: true, SOURCE_REMOVE: false,
            timeout_add_seconds(_priority, _seconds, callback) {
                const id = nextTimer++;
                timers.set(id, callback);
                return id;
            },
            source_remove(id) { removedTimers.push(id); timers.delete(id); },
            DateTime: {new_now_local: () => ({format: () => '12:00'})}},
        Gdk: {WindowState: {MAXIMIZED: 1, FULLSCREEN: 2}},
        GdkPixbuf: {Pixbuf: {new_from_resource_at_scale: () => ({})}},
        Config: {PACKAGE_VERSION: 74, PACKAGE_URL: 'fixture://help', GSCHEMA: {lookup: name => name}},
        system: {version: 'fixture'}, Service, rowSeparators() {},
        Panel: class extends Widget {
            constructor(device) { super(); this.device = device; this.actions = {}; this.menu = {}; }
            dispose() { this.disposed = true; }
        },
        _: value => value, logError: error => errors.push(error),
    };
    const source = readFileSync(new URL('../../src/preferences/service.js', import.meta.url), 'utf8')
        .replace(/^import .*;\n/gm, '')
        .replace('export const Window =', 'globalThis.Window =');
    vm.runInNewContext("String.prototype.format = function(value) { return this.replace('%s', value); };\n" + source, scope);
    const window = new scope.Window();
    return {window, classes, widgets, services, calls, stores, timers, removedTimers, errors,
        open: () => new scope.Window()};
}

/**
 * A device boundary with in-memory property notifications.
 * @param {object} properties - Fixture overrides
 * @returns {object} Fake device, no transport
 */
function device(properties = {}) {
    return {id: 'fixture-device', name: 'Test laptop', type: 'laptop', paired: false, connected: false,
        action_group: {}, handlers: new Map(),
        bind_property(source, target, key) { target[key] = this[source]; },
        connect(name, callback) { this.handlers.set(name, callback); },
        notify(name) { this.handlers.get(`notify::${name}`)?.(this); }, ...properties};
}

test('opening subscribes once, reloads and shows service availability without connecting', () => {
    const f = fixture();
    assert.equal(f.services[0].handlers.size, 3);
    assert.equal(f.services[0].reloads, 1);
    assert.equal(f.window.device_list_placeholder.label, 'Waiting for service…');
    assert.deepEqual(f.calls, []);
    f.services[0].active = true;
    f.services[0].emit('notify::active');
    assert.equal(f.window.device_list_placeholder.label, 'Searching for devices…');
    f.services[0].active = false;
    f.services[0].emit('notify::active');
    assert.equal(f.window.device_list_placeholder.label, 'Waiting for service…');
});

test('reload rejection is reported without escaping the async init method', async () => {
    const f = fixture();
    const error = Error('offline fixture');
    f.services[0].reload = () => Promise.reject(error);
    await f.window._initService();
    assert.deepEqual(f.errors, [error]);
    assert.equal(f.window.device_list_placeholder.label, 'Waiting for service…');
});

test('refresh requests only on the production no-device or missing-openssl conditions', () => {
    const f = fixture();
    f.window._refresh();
    assert.equal(f.calls.length, 0);
    f.services[0].active = true;
    f.window._refresh();
    assert.equal(f.window.device_list_spinner.active, true);
    assert.deepEqual(f.calls, [['refresh', null]]);
    f.window.device_list.add({});
    f.window._refresh();
    assert.equal(f.window.device_list_spinner.active, false);
    f.window.settings.set_boolean('missing-openssl', true);
    f.window._refresh();
    assert.equal(f.calls.length, 2);
});

test('display-mode reads and writes only the in-memory show-indicators setting', () => {
    const f = fixture();
    assert.equal(f.window.display_mode, 'user-menu');
    f.window.display_mode = 'panel';
    assert.equal(f.window.settings.get_boolean('show-indicators'), true);
    assert.equal(f.window.display_mode, 'panel');
    f.window.display_mode = 'user-menu';
    assert.equal(f.window.settings.get_boolean('show-indicators'), false);
    assert.equal(f.calls.length, 0);
});

test('valid rename commits; invalid or blank rename leaves previous name unchanged', () => {
    const f = fixture();
    f.window.rename_entry.text = 'Office workstation';
    f.window._onSetServiceName();
    assert.equal(f.window.settings.get_string('name'), 'Office workstation');
    for (const name of [' ', 'x'.repeat(33), 'bad:name']) {
        f.window.rename_entry.text = name;
        f.window._onSetServiceName();
        assert.equal(f.window.settings.get_string('name'), 'Office workstation');
    }
    assert.equal(f.widgets.filter(w => w.text === 'Invalid Device Name').length, 3);
    assert.equal(f.window.service_edit.active, false);
    assert.equal(f.window.service_edit.focused, true);
});

test('device add is idempotent and status notifications reflect pairing and connectivity', () => {
    const f = fixture();
    const d = device();
    f.services[0].emit('device-added', d);
    f.services[0].emit('device-added', d);
    assert.equal(f.window.device_list.children.length, 1);
    const status = f.window.device_list.children[0].children[0].children[2];
    assert.equal(status.label, 'Unpaired');
    d.paired = true;
    d.notify('paired');
    assert.equal(status.label, 'Disconnected');
    d.connected = true;
    d.notify('connected');
    assert.equal(status.label, 'Connected');
});

test('selected-device removal returns to service and disposes panel; repeated removal is harmless', () => {
    const f = fixture();
    const d = device();
    f.services[0].emit('device-added', d);
    const panel = f.window.stack.get_child_by_name(d.id);
    f.window._onDeviceSelected(null, panel.row);
    assert.equal(f.window.headerbar.title, d.name);
    assert.equal(f.window.device_menu.groups.get('device'), d.action_group);
    f.services[0].emit('device-removed', d);
    f.services[0].emit('device-removed', d);
    assert.equal(f.window.stack.visible_child_name, 'service');
    assert.equal(f.window.headerbar.title, 'Fixture desktop');
    assert.equal(f.window.device_menu.groups.get('device'), null);
    assert.equal(panel.disposed, true);
    assert.equal(panel.destroyed, true);
    assert.equal(f.window.device_list.children.length, 0);
    assert.equal(f.errors.length, 0);
});

test('closing and reopening creates fresh service listeners and removes old refresh timer', () => {
    const f = fixture();
    const source = f.window._refreshSource;
    assert.equal(f.window.vfunc_delete_event(), false);
    assert.equal(f.services[0].handlers.size, 0);
    assert.equal(f.services[0].destroyed, true);
    assert.equal(f.window.service, null);
    assert.equal(f.timers.has(source), false);
    const second = f.open();
    assert.notEqual(second.service, f.services[0]);
    assert.equal(second.service.handlers.size, 3);
    assert.equal(f.timers.size, 1);
    second.vfunc_delete_event();
    assert.equal(f.timers.size, 0);
});

test('geometry preserves normal size when closing maximized or fullscreen windows', () => {
    const f = fixture();
    f.window.size = [800, 600];
    f.window._saveGeometry();
    assert.deepEqual(Array.from(f.window._windowState.values['window-size']), [800, 600]);
    f.window.size = [1600, 1200];
    f.window.windowState = 1;
    f.window._saveGeometry();
    assert.equal(f.window._windowState.get_boolean('window-maximized'), true);
    assert.deepEqual(Array.from(f.window._windowState.values['window-size']), [800, 600]);
    f.window.windowState = 2;
    f.window._saveGeometry();
    assert.deepEqual(Array.from(f.window._windowState.values['window-size']), [800, 600]);
});

test('about dialog is reused after dismissal rather than accumulating windows', () => {
    const f = fixture();
    f.window._aboutDialog();
    const about = f.window._about;
    about.emit('response');
    assert.equal(about.hidden, true);
    f.window._aboutDialog();
    assert.equal(f.window._about, about);
    assert.equal(about.presented, 2);
});

test('connect dialog cancel and empty input send nothing; explicit fixture input delegates once', () => {
    const f = fixture();
    const Dialog = f.classes.get('GSConnectConnectDialog');
    const app = {activate_action: (...args) => f.calls.push(args)};
    const cancel = new Dialog({application: app});
    cancel.vfunc_response(0);
    assert.equal(cancel.destroyed, true);
    const dialog = new Dialog({application: app});
    dialog.lan_ip.text = '';
    dialog.vfunc_response(1);
    assert.equal(dialog.destroyed, undefined);
    assert.equal(f.calls.length, 0);
    dialog.lan_ip.text = '192.0.2.1';
    dialog.lan_port.value = 1716;
    dialog.vfunc_response(1);
    assert.equal(f.calls[0][0], 'connect');
    assert.equal(f.calls[0][1].value, 'lan://192.0.2.1:1716');
    assert.equal(dialog.destroyed, true);
});

test('connect action failure is logged and the dialog closes without retry', () => {
    const f = fixture();
    const error = Error('mock action rejected');
    const Dialog = f.classes.get('GSConnectConnectDialog');
    const dialog = new Dialog({application: {activate_action() { throw error; }}});
    dialog.lan_ip.text = '192.0.2.1';
    dialog.lan_port.value = 1716;
    dialog.vfunc_response(1);
    assert.deepEqual(f.errors, [error]);
    assert.equal(dialog.destroyed, true);
});

test('canceling support-log dialog restores debug=false and never invokes file/subprocess APIs', () => {
    const f = fixture();
    f.window._generateSupportLog();
    assert.equal(f.window.settings.get_boolean('debug'), true);
    const dialog = f.widgets.find(w => w.text === 'Generate Support Log');
    dialog.emit('response', 0);
    assert.equal(f.window.settings.get_boolean('debug'), false);
    assert.equal(dialog.destroyed, true);
    assert.equal(f.errors.length, 0);
});

test('late reload rejection after close is caught without recreating service or timers', async () => {
    const f = fixture();
    let rejectReload;
    f.services[0].reload = () => new Promise((_resolve, reject) => { rejectReload = reject; });
    const pending = f.window._initService();
    f.window.vfunc_delete_event();
    rejectReload(Error('late fixture failure'));
    await pending;
    assert.equal(f.errors.length, 1);
    assert.equal(f.window.service, null);
    assert.equal(f.timers.size, 0);
});

test('retry OpenSSL sequences disable then delayed enable using only fake settings and timer', () => {
    const f = fixture();
    f.window.settings.set_boolean('enabled', true);
    f.window._onRetryOpenssl();
    assert.equal(f.window.settings.get_boolean('enabled'), false);
    const retry = [...f.timers.entries()].find(([id]) => id !== f.window._refreshSource)[1];
    assert.equal(retry(), false);
    assert.equal(f.window.settings.get_boolean('enabled'), true);
    assert.equal(f.calls.length, 0);
});
