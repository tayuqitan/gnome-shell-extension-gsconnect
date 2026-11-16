// SPDX-FileCopyrightText: GSConnect Developers https://github.com/GSConnect
// SPDX-License-Identifier: GPL-2.0-or-later

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const AUTHORIZATION_WINDOW_US = 1000000;

/**
 * EXPERIMENTAL GNOME-only permission gate, never a synthetic-input controller.
 *
 * GNOME 48 sources: shell-wm.c uses true_handled for filter-keybinding;
 * windowManager.js permits our binding in NORMAL; Mutter keybindings.c treats
 * a filtered binding as absent and propagates the ORIGINAL event. Clutter sets
 * current_event before processing filters. This is not a stable public promise
 * across all Shell versions and requires real desktop validation.
 *
 * Clipboard readers are NOT authenticated by this mechanism. A clipboard
 * manager can race the target within the short window; a slow target can miss
 * it. Rejected pre-reads may disable Paste in a file manager. No queued reads,
 * replay, automatic retry or silent downgrade hides those limitations.
 */
export class ClipboardPasteGate {
    constructor(getSource) {
        this._getSource = getSource;
        this._action = 0;
        this._name = null;
        this._filterId = 0;
        this._focusId = 0;
        this._sessionId = 0;
        this._stageId = 0;
        this._windowId = 0;
        this._focus = null;
        this._source = null;
        this._deadline = 0;
        this._destroyed = false;
        try {
            if (typeof Clutter.get_current_event !== 'function' ||
                Clutter.EventFlags.FLAG_REPEATED === undefined ||
                Clutter.EventFlags.FLAG_SYNTHETIC === undefined)
                throw new Error('Current key event APIs are unavailable');
            this._action = global.display.grab_accelerator('<Control>v', 0);
            if (!this._action || this._action === Meta.KeyBindingAction.NONE)
                throw new Error('Ctrl+V is already owned by another shortcut');
            this._name = Meta.external_binding_name_for_action(this._action);
            Main.wm.allowKeybinding(this._name, Shell.ActionMode.NORMAL);
            this._filterId = global.window_manager.connect('filter-keybinding',
                (_wm, binding) => this._filter(binding));
            this._focusId = global.display.connect('notify::focus-window', () => this.invalidate());
            this._sessionId = Main.sessionMode.connect('updated', () => this.invalidate());
            this._stageId = global.stage.connect('notify::key-focus', () => this.invalidate());
        } catch (error) {
            this.destroy();
            try {
                Main.notify('GSConnect experimental clipboard gate',
                    `${error.message}. Remote file reads remain blocked. ` +
                    'Resolve the shortcut conflict or disable the experiment and restart the extension.');
            } catch (notificationError) {
                logError(notificationError);
            }
        }
    }

    _filter(binding) {
        if (binding.get_name() !== this._name)
            return false;
        // TRUE means filter OUT our grab, not consume the application event.
        // Always pass it through, even when there is no remote clipboard offer.
        try {
            const event = Clutter.get_current_event();
            const device = event?.get_source_device();
            const source = this._getSource();
            const window = global.display.focus_window;
            const flags = event?.get_flags() ?? 0;
            if (!this._destroyed && source && window && this._normalMode() &&
                event?.type() === Clutter.EventType.KEY_PRESS &&
                (flags & (Clutter.EventFlags.FLAG_REPEATED |
                    Clutter.EventFlags.FLAG_SYNTHETIC)) === 0 &&
                (event.get_state() & Clutter.ModifierType.CONTROL_MASK) !== 0 &&
                [Clutter.KEY_v, Clutter.KEY_V].includes(event.get_key_symbol()) &&
                this._keyboardCapable(device)) {
                this.invalidate();
                this._source = source;
                this._focus = window;
                this._deadline = GLib.get_monotonic_time() + AUTHORIZATION_WINDOW_US;
                this._windowId = window.connect('unmanaged', () => this.invalidate());
            }
        } catch {
            // A version/API mismatch must never silently allow a file read.
            this.invalidate();
        }
        return true;
    }

    _keyboardCapable(device) {
        // Composite keyboard/pointer devices may report POINTER_DEVICE.
        // This does not authenticate hardware: virtual keyboards can expose
        // the same capabilities and unmarked event flags. Device mode is not
        // consulted (it is unavailable on newer GNOME versions).
        if (typeof device?.get_capabilities === 'function' &&
            Clutter.InputCapabilities?.KEYBOARD !== undefined) {
            return (device.get_capabilities() &
                Clutter.InputCapabilities.KEYBOARD) !== 0;
        }
        return typeof device?.get_device_type === 'function' &&
            device.get_device_type() === Clutter.InputDeviceType.KEYBOARD_DEVICE;
    }

    _normalMode() {
        return Main.actionMode === Shell.ActionMode.NORMAL &&
            !Main.sessionMode.isLocked && !Main.sessionMode.isGreeter;
    }

    allows(source) {
        return !this._destroyed && this._action !== 0 && this._normalMode() &&
            source === this._source && source === this._getSource() &&
            this._focus !== null && global.display.focus_window === this._focus &&
            GLib.get_monotonic_time() < this._deadline;
    }

    invalidate() {
        this._deadline = 0;
        this._source = null;
        if (this._windowId) {
            this._focus.disconnect(this._windowId);
            this._windowId = 0;
        }
        this._focus = null;
    }

    destroy() {
        this._destroyed = true;
        this.invalidate();
        // Release the grab before removing its pass-through filter.
        if (this._action) {
            global.display.ungrab_accelerator(this._action);
            Main.wm.allowKeybinding(this._name, Shell.ActionMode.NONE);
            this._action = 0;
        }
        if (this._filterId) {
            global.window_manager.disconnect(this._filterId);
            this._filterId = 0;
        }
        if (this._focusId) {
            global.display.disconnect(this._focusId);
            this._focusId = 0;
        }
        if (this._stageId) {
            global.stage.disconnect(this._stageId);
            this._stageId = 0;
        }
        if (this._sessionId) {
            Main.sessionMode.disconnect(this._sessionId);
            this._sessionId = 0;
        }
    }
}
