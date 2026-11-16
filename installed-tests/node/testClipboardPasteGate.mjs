// SPDX-FileCopyrightText: GSConnect Developers https://github.com/GSConnect
// SPDX-License-Identifier: GPL-2.0-or-later

import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

function emitter(events, label, fields = {}) {
    const signals = new Map();
    let next = 0;
    return Object.assign(fields, {
        connect(name, fn) { signals.set(++next, {name, fn}); return next; },
        disconnect(id) { events.push(`${label}:disconnect`); signals.delete(id); },
        signal(name) {
            for (const signal of [...signals.values()])
                if (signal.name === name) signal.fn();
        },
    });
}

function fixture({conflict = false, connectFailure = false, notifyFailure = false} = {}) {
    const calls = [];
    let now = 100;
    let source = {};
    const window = emitter(calls, 'window');
    const display = emitter(calls, 'display', {
        focus_window: window,
        grab_accelerator(accel, flags) { calls.push(['grab', accel, flags]); return conflict ? 0 : 42; },
        ungrab_accelerator(action) { calls.push(['ungrab', action]); },
    });
    const wm = emitter(calls, 'wm');
    const stage = emitter(calls, 'stage');
    if (connectFailure) wm.connect = () => { throw new Error('connect unavailable'); };
    const sessionMode = emitter(calls, 'session', {isLocked: false, isGreeter: false});
    const Main = {actionMode: 1, sessionMode,
        wm: {allowKeybinding: (name, mode) => calls.push(['allow', name, mode])},
        notify: (...args) => { if (notifyFailure) throw new Error('notify failed'); calls.push(['notify', ...args]); },
    };
    const device = {get_device_type: () => 1, get_device_mode: () => 1};
    let event = {type: () => 1, get_flags: () => 0, get_state: () => 4,
        get_key_symbol: () => 118, get_source_device: () => device};
    const Clutter = {
        get_current_event: () => event, EventFlags: {FLAG_REPEATED: 4, FLAG_SYNTHETIC: 1},
        EventType: {KEY_PRESS: 1, KEY_RELEASE: 2}, ModifierType: {CONTROL_MASK: 4},
        KEY_v: 118, KEY_V: 86, InputDeviceType: {KEYBOARD_DEVICE: 1}, InputCapabilities: {KEYBOARD: 2},
        InputMode: {PHYSICAL: 1},
    };
    const Meta = {KeyBindingAction: {NONE: 0}, external_binding_name_for_action: id => `external-${id}`};
    const text = readFileSync(new URL('../../src/shell/clipboardPasteGate.js', import.meta.url), 'utf8')
        .replace(/^import .*;\n/gm, '').replace('export class ', 'class ');
    const scope = {Clutter, Meta, Main, Shell: {ActionMode: {NORMAL: 1, NONE: 0}},
        GLib: {get_monotonic_time: () => now}, global: {display, window_manager: wm, stage},
        logError: error => calls.push(['error', error.message])};
    vm.runInNewContext(`${text}\nthis.Gate = ClipboardPasteGate;`, scope);
    const gate = new scope.Gate(() => source);
    return {gate, calls, display, sessionMode, Main, window, device, stage, Clutter,
        source: () => source, own: {get_name: () => 'external-42'},
        event(changes) { event = {...event, ...changes}; },
        advance(us) { now += us; }, replaceSource() { source = {}; }};
}

test('Ctrl+V opens multi-read window, always passes original event, never creates synthetic input', () => {
    const f = fixture();
    assert.equal(f.gate.allows(f.source()), false);
    assert.equal(f.gate._filter(f.own), true);
    assert.equal(f.gate.allows(f.source()), true);
    assert.equal(f.gate.allows(f.source()), true);
    assert.equal(f.gate._filter({get_name: () => 'other-binding'}), false);
    f.gate.destroy();
});

test('authorization expires and a fresh Ctrl+V allows another paste without rebind', () => {
    const f = fixture();
    f.gate._filter(f.own);
    f.advance(1000000);
    assert.equal(f.gate.allows(f.source()), false);
    assert.equal(f.gate._filter(f.own), true);
    assert.equal(f.gate.allows(f.source()), true);
    assert.equal(f.calls.filter(call => call[0] === 'grab').length, 1);
    f.gate.destroy();
});

test('release, repeat, synthetic and missing Ctrl never open a window', () => {
    for (const changes of [{type: () => 2}, {get_flags: () => 4},
        {get_flags: () => 1}, {get_state: () => 0}, {get_source_device: () => null}]) {
        const f = fixture();
        f.event(changes);
        assert.equal(f.gate._filter(f.own), true);
        assert.equal(f.gate.allows(f.source()), false);
        f.gate.destroy();
    }
});

test('focus departure and return cannot resurrect an old authorization', () => {
    const f = fixture();
    f.gate._filter(f.own);
    f.display.focus_window = {};
    f.display.signal('notify::focus-window');
    f.display.focus_window = f.window;
    f.display.signal('notify::focus-window');
    assert.equal(f.gate.allows(f.source()), false);
    f.gate.destroy();
});

test('offer identity and target destruction invalidate permission', () => {
    const f = fixture();
    f.gate._filter(f.own);
    f.replaceSource();
    assert.equal(f.gate.allows(f.source()), false);
    f.gate._filter(f.own);
    f.window.signal('unmanaged');
    assert.equal(f.gate.allows(f.source()), false);
    f.gate.destroy();
});

test('lock and non-normal Shell modes cannot authorize or retain access', () => {
    const f = fixture();
    f.gate._filter(f.own);
    f.sessionMode.isLocked = true;
    f.sessionMode.signal('updated');
    assert.equal(f.gate._filter(f.own), true);
    assert.equal(f.gate.allows(f.source()), false);
    f.sessionMode.isLocked = false;
    f.Main.actionMode = 2;
    f.gate._filter(f.own);
    assert.equal(f.gate.allows(f.source()), false);
    f.gate.destroy();
});

test('shortcut conflict is fail-closed and never ungrabs another owner', () => {
    const f = fixture({conflict: true});
    assert.equal(f.gate.allows(f.source()), false);
    assert.equal(f.calls.some(call => call[0] === 'notify'), true);
    assert.equal(f.calls.some(call => call[0] === 'ungrab'), false);
    f.gate.destroy();
});

test('setup failure cleans only its own grab; notification failure cannot break extension', () => {
    const f = fixture({connectFailure: true, notifyFailure: true});
    assert.equal(f.gate.allows(f.source()), false);
    assert.deepEqual(f.calls.filter(call => call[0] === 'ungrab'), [['ungrab', 42]]);
    assert.equal(f.calls.some(call => call[0] === 'error'), true);
});

test('teardown ungrabs before disconnecting pass-through filter and is idempotent', () => {
    const f = fixture();
    f.gate._filter(f.own);
    f.gate.destroy();
    f.gate.destroy();
    assert.equal(f.gate.allows(f.source()), false);
    const ungrab = f.calls.findIndex(call => call[0] === 'ungrab');
    assert.ok(ungrab < f.calls.indexOf('wm:disconnect'));
    assert.equal(f.calls.filter(call => call[0] === 'ungrab').length, 1);
});

test('own Ctrl+V passes through even when no offer exists', () => {
    const f = fixture();
    f.gate._getSource = () => null;
    assert.equal(f.gate._filter(f.own), true);
    assert.equal(f.gate.allows(f.source()), false);
    f.gate.destroy();
});


test('Shell keyboard focus change revokes authorization even if client focus stays', () => {
    const f = fixture();
    f.gate._filter(f.own);
    f.stage.signal('notify::key-focus');
    assert.equal(f.gate.allows(f.source()), false);
    f.gate.destroy();
});

test('composite keyboard capability is accepted without claiming hardware authenticity', () => {
    const f = fixture();
    f.device.get_device_type = () => 99;
    f.device.get_capabilities = () => 3;
    assert.equal(f.gate._filter(f.own), true);
    assert.equal(f.gate.allows(f.source()), true);
    f.gate.destroy();
});


test('keyboard-capable source without legacy get_device_mode remains accepted', () => {
    const f = fixture();
    delete f.device.get_device_mode;
    f.device.get_capabilities = () => 2;
    assert.equal(f.gate._filter(f.own), true);
    assert.equal(f.gate.allows(f.source()), true);
    f.gate.destroy();
});

test('source missing both keyboard capability APIs fails closed without throwing', () => {
    const f = fixture();
    delete f.device.get_device_type;
    delete f.device.get_capabilities;
    assert.equal(f.gate._keyboardCapable(f.device), false);
    assert.equal(f.gate._filter(f.own), true);
    assert.equal(f.gate.allows(f.source()), false);
    f.gate.destroy();
});


test('GI InputCapabilities name handles composite device without legacy type fallback', () => {
    const f = fixture();
    assert.equal(f.Clutter.InputDeviceCapabilities, undefined);
    assert.equal(f.Clutter.InputCapabilities.KEYBOARD, 2);
    f.device.get_capabilities = () => 3;
    f.device.get_device_type = () => { throw new Error('must use real capabilities enum'); };
    assert.equal(f.gate._keyboardCapable(f.device), true);
    assert.equal(f.gate._filter(f.own), true);
    assert.equal(f.gate.allows(f.source()), true);
    f.gate.destroy();
});
