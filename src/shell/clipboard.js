// SPDX-FileCopyrightText: GSConnect Developers https://github.com/GSConnect
//
// SPDX-License-Identifier: GPL-2.0-or-later

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';

import Meta from 'gi://Meta';

import * as DBus from '../service/utils/dbus.js';
import {ClipboardPasteGate} from './clipboardPasteGate.js';


/*
 * DBus Interface Info
 */
const DBUS_NAME = 'org.gnome.Shell.Extensions.GSConnect.Clipboard';
const DBUS_PATH = '/org/gnome/Shell/Extensions/GSConnect/Clipboard';
const DBUS_NODE = Gio.DBusNodeInfo.new_for_xml(`
<node>
  <interface name="org.gnome.Shell.Extensions.GSConnect.Clipboard">
    <!-- Methods -->
    <method name="GetMimetypes">
      <arg direction="out" type="as" name="mimetypes"/>
    </method>
    <method name="GetText">
      <arg direction="out" type="s" name="text"/>
    </method>
    <method name="SetText">
      <arg direction="in" type="s" name="text"/>
    </method>
    <method name="GetValue">
      <arg direction="in" type="s" name="mimetype"/>
      <arg direction="out" type="ay" name="value"/>
    </method>
    <method name="SetValue">
      <arg direction="in" type="ay" name="value"/>
      <arg direction="in" type="s" name="mimetype"/>
    </method>

    <method name="Offer">
      <arg direction="in" type="s" name="id"/>
      <arg direction="in" type="as" name="mimetypes"/>
      <arg direction="in" type="u" name="timeoutSeconds"/>
    </method>
    <method name="GetOffer">
      <arg direction="out" type="s" name="id"/>
    </method>
    <method name="Resolve">
      <arg direction="in" type="s" name="id"/>
      <arg direction="in" type="s" name="requestId"/>
      <arg direction="in" type="ay" name="value"/>
      <arg direction="in" type="s" name="error"/>
    </method>
    <method name="ClearOffer">
      <arg direction="in" type="s" name="id"/>
    </method>

    <!-- Signals -->
    <signal name="CancelRequested">
      <arg type="s" name="id"/>
      <arg type="s" name="requestId"/>
    </signal>
    <signal name="ValueRequested">
      <arg type="s" name="id"/>
      <arg type="s" name="requestId"/>
      <arg type="s" name="mimetype"/>
    </signal>
    <signal name="OwnerChange"/>
  </interface>
</node>
`);
const DBUS_INFO = DBUS_NODE.lookup_interface(DBUS_NAME);


/*
 * Text Mimetypes
 */
const TEXT_MIMETYPES = [
    'text/plain;charset=utf-8',
    'UTF8_STRING',
    'text/plain',
    'STRING',
];


// The portal transports bounded clipboard representations, not file bodies.
const MAX_VALUE_BYTES = 16 * 1024 * 1024;
const DEFAULT_TIMEOUT_SECONDS = 3600;

const RemoteSelectionSource = GObject.registerClass({
    GTypeName: 'GSConnectRemoteSelectionSource',
}, class RemoteSelectionSource extends Meta.SelectionSource {
    _init(id, mimetypes, request, timeoutSeconds = DEFAULT_TIMEOUT_SECONDS,
        cancel = null, guardRead = null) {
        super._init();
        if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 60 || timeoutSeconds > 86400)
            throw new Error('Invalid clipboard deadline');
        this._timeoutSeconds = timeoutSeconds;
        this.offerId = id;
        this._mimetypes = mimetypes;
        this._request = request;
        this._cancel = cancel;
        this._guardRead = guardRead;
        this._pending = new Map();
        this._closed = false;
    }

    vfunc_get_mimetypes() {
        return this._mimetypes.slice();
    }

    vfunc_read_async(mimetype, cancellable, callback) {
        const task = Gio.Task.new(this, cancellable, callback);
        if (this._closed || !this._mimetypes.includes(mimetype)) {
            task.return_error(new Gio.IOErrorEnum({
                code: Gio.IOErrorEnum.NOT_FOUND,
                message: 'Clipboard offer is no longer available',
            }));
            return;
        }
        if (cancellable?.is_cancelled()) {
            task.return_error_if_cancelled();
            return;
        }
        if (this._guardRead && !this._guardRead(this, mimetype)) {
            task.return_error(new Gio.IOErrorEnum({
                code: Gio.IOErrorEnum.PERMISSION_DENIED,
                message: 'Remote files require a local Ctrl+V gesture',
            }));
            return;
        }
        if (this._pending.size >= 32) {
            task.return_error(new Gio.IOErrorEnum({
                code: Gio.IOErrorEnum.BUSY,
                message: 'Too many clipboard requests',
            }));
            return;
        }
        const requestId = GLib.uuid_string_random();
        const pending = {task, cancellable, cancelId: 0, timeoutId: 0};
        this._pending.set(requestId, pending);
        pending.timeoutId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT,
            this._timeoutSeconds, () => {
                pending.timeoutId = 0;
                this.resolve(requestId, null, 'Clipboard transfer timed out');
                return GLib.SOURCE_REMOVE;
            });
        if (cancellable) {
            // Gio.Cancellable.disconnect() cannot run inside its callback.
            pending.cancelId = cancellable.connect(() => {
                this._cancelPending(requestId);
                GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
                    this.resolve(requestId, null, 'Clipboard request cancelled');
                    return GLib.SOURCE_REMOVE;
                });
            });
        }
        this._request(this.offerId, requestId, mimetype);
    }

    vfunc_read_finish(result) {
        result.propagate_boolean();
        const stream = result._clipboardStream;
        delete result._clipboardStream;
        return stream;
    }

    _cancelPending(requestId) {
        const pending = this._pending.get(requestId);
        if (pending && !pending.cancelNotified) {
            pending.cancelNotified = true;
            this._cancel?.(this.offerId, requestId);
        }
    }

    resolve(requestId, value, error) {
        const pending = this._pending.get(requestId);
        if (!pending)
            return;
        if (error)
            this._cancelPending(requestId);
        this._pending.delete(requestId);
        if (pending.timeoutId)
            GLib.source_remove(pending.timeoutId);
        if (pending.cancelId)
            pending.cancellable.disconnect(pending.cancelId);
        if (!error && (!value || value.length > MAX_VALUE_BYTES))
            error = 'Clipboard representation exceeds the 16 MiB limit';
        if (error) {
            pending.task.return_error(new Gio.IOErrorEnum({
                code: Gio.IOErrorEnum.FAILED,
                message: error.slice(0, 512),
            }));
        } else {
            // GTask's pointer API is not introspectable. Keep the stream on
            // its GObject wrapper, and let our read_finish return it to Mutter.
            pending.task._clipboardStream = Gio.MemoryInputStream.new_from_bytes(
                new GLib.Bytes(value));
            pending.task.return_boolean(true);
        }
    }

    close() {
        this._closed = true;
        for (const requestId of this._pending.keys())
            this.resolve(requestId, null, 'Clipboard ownership changed');
    }

    vfunc_deactivated() {
        this.close();
    }
});


/* GSConnectClipboardPortal:
 *
 * A simple clipboard portal, especially useful on Wayland where GtkClipboard
 * doesn't work in the background.
 */
export const Clipboard = GObject.registerClass({
    GTypeName: 'GSConnectShellClipboard',
    Signals: {
        'CancelRequested': {
            flags: GObject.SignalFlags.RUN_FIRST,
            param_types: [GObject.TYPE_STRING, GObject.TYPE_STRING],
        },
        'ValueRequested': {
            flags: GObject.SignalFlags.RUN_FIRST,
            param_types: [GObject.TYPE_STRING, GObject.TYPE_STRING, GObject.TYPE_STRING],
        },
        'OwnerChange': {
            flags: GObject.SignalFlags.RUN_FIRST,
            param_types: [],
        },
    },
}, class GSConnectShellClipboard extends GObject.Object {

    _init(params = {}) {
        super._init();

        this._experimentalPasteGate = Boolean(params.experimentalPasteGate);
        this._pasteGate = null;
        this._transferring = false;
        this._remoteSource = null;
        this._ownerIdleId = 0;

        // Watch global selection
        this._selection = global.display.get_selection();
        this._ownerChangedId = this._selection.connect(
            'owner-changed',
            this._onOwnerChanged.bind(this)
        );

        // Prepare DBus interface
        this._dbus = DBus.wrapObject(DBUS_INFO, this);

        this._nameId = Gio.DBus.own_name(
            Gio.BusType.SESSION,
            DBUS_NAME,
            Gio.BusNameOwnerFlags.NONE,
            this._onBusAcquired.bind(this),
            null,
            this._onNameLost.bind(this)
        );
        this.setPasteGateEnabled(Boolean(params.pasteGateEnabled));
    }

    setPasteGateEnabled(enabled) {
        this._pasteGate?.destroy();
        this._pasteGate = null;
        if (enabled && this._experimentalPasteGate)
            this._pasteGate = new ClipboardPasteGate(() => this._remoteSource);
    }

    _onOwnerChanged(selection, type, source) {
        /* We're only interested in the standard clipboard */
        if (type !== Meta.SelectionType.SELECTION_CLIPBOARD)
            return;

        if (this._remoteSource && source !== this._remoteSource) {
            this._pasteGate?.invalidate();
            this._remoteSource.close();
            this._remoteSource = null;
        }

        /* In Wayland an intermediate GMemoryOutputStream is used which triggers
         * a second ::owner-changed emission, so we need to ensure we ignore
         * that while the transfer is resolving.
         */
        if (this._transferring)
            return;

        this._transferring = true;

        /* We need to put our signal emission in an idle callback to ensure that
         * Mutter's internal calls have finished resolving in the loop, or else
         * we'll end up with the previous selection's content.
         */
        this._ownerIdleId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            this._ownerIdleId = 0;
            this.emit('OwnerChange');
            this._transferring = false;

            return GLib.SOURCE_REMOVE;
        });
    }

    _onBusAcquired(connection, name) {
        try {
            this._dbus.export(connection, DBUS_PATH);
        } catch (e) {
            logError(e);
        }
    }

    _onNameLost(connection, name) {
        try {
            this._dbus.unexport();
        } catch (e) {
            logError(e);
        }
    }

    /**
     * Get the available mimetypes of the current clipboard content
     *
     * @returns {string[]} A list of mime-types
     */
    GetMimetypes() {
        const mimetypes = this._selection.get_mimetypes(
            Meta.SelectionType.SELECTION_CLIPBOARD
        );

        return mimetypes;
    }

    /**
     * Get the text content of the clipboard
     *
     * @param {Array} params - empty
     * @param {Gio.DBusMethodInvocation} invocation - Text content of the
     *  clipboard is returned via. invocation
     * @returns {Promise<void>}
     */
    GetTextAsync(params, invocation) {
        return new Promise((resolve, reject) => {
            const mimetypes = this._selection.get_mimetypes(
                Meta.SelectionType.SELECTION_CLIPBOARD);

            const mimetype = TEXT_MIMETYPES.find(type => mimetypes.includes(type));

            if (mimetype !== undefined) {
                const stream = Gio.MemoryOutputStream.new_resizable();

                this._selection.transfer_async(
                    Meta.SelectionType.SELECTION_CLIPBOARD,
                    mimetype, MAX_VALUE_BYTES + 1,
                    stream, null,
                    (selection, res) => {
                        try {
                            selection.transfer_finish(res);

                            stream.close(null);
                            const bytes = stream.steal_as_bytes();
                            if (bytes.get_size() > MAX_VALUE_BYTES)
                                throw new Error('Clipboard exceeds the 16 MiB limit');
                            const bytearray = bytes.get_data();

                            resolve(new TextDecoder().decode(bytearray));
                        } catch (e) {
                            reject(e);
                        }
                    }
                );
            } else {
                reject(new Error('text not available'));
            }
        })
        .then(value => invocation.return_value(new GLib.Variant('(s)', [value])))
        .catch(error => invocation.return_dbus_error(
            `${DBUS_NAME}.Error`, error.message));
    }

    /**
     * Set the text content of the clipboard
     *
     * @param {string} text - text content to set
     * @returns {void}
     */
    SetText(text) {
        if (typeof text !== 'string') {
            throw new Gio.DBusError({
                code: Gio.DBusError.INVALID_ARGS,
                message: 'expected string',
            });
        }

        const source = Meta.SelectionSourceMemory.new(
            'text/plain;charset=utf-8', GLib.Bytes.new(text));

        this._selection.set_owner(
            Meta.SelectionType.SELECTION_CLIPBOARD, source);
    }

    /**
     * Get the content of the clipboard with the type {@link params}.
     *
     * @param {Array} params - [mimetype]
     * @param {Gio.DBusMethodInvocation} invocation - The content of the
     *  clipboard is returned via. invocation
     * @returns {Promise<void>}
     */
    GetValueAsync(params, invocation) {
        const [mimetype] = params;
        return new Promise((resolve, reject) => {
            const stream = Gio.MemoryOutputStream.new_resizable();

            this._selection.transfer_async(
                Meta.SelectionType.SELECTION_CLIPBOARD,
                mimetype, MAX_VALUE_BYTES + 1,
                stream, null,
                (selection, res) => {
                    try {
                        selection.transfer_finish(res);

                        stream.close(null);
                        const bytes = stream.steal_as_bytes();

                        if (bytes.get_size() > MAX_VALUE_BYTES)
                            throw new Error('Clipboard exceeds the 16 MiB limit');
                        resolve(bytes.get_data());
                    } catch (e) {
                        reject(e);
                    }
                }
            );
        })
        .then(value => invocation.return_value(new GLib.Variant('(ay)', [value])))
        .catch(error => invocation.return_dbus_error(
            `${DBUS_NAME}.Error`, error.message));
    }

    /**
     * Set the content of the clipboard to {@link value} with the type
     * {@link mimetype}.
     *
     * @param {Uint8Array} value - the value to set
     * @param {string} mimetype - the mimetype of the value
     * @returns {void}
     */
    SetValue(value, mimetype) {
        const source = Meta.SelectionSourceMemory.new(mimetype,
            GLib.Bytes.new(value));

        this._selection.set_owner(
            Meta.SelectionType.SELECTION_CLIPBOARD, source);
    }

    Offer(id, mimetypes, timeoutSeconds = DEFAULT_TIMEOUT_SECONDS) {
        if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 60 || timeoutSeconds > 86400 ||
            !id || id.length > 256 || !Array.isArray(mimetypes) ||
            mimetypes.length === 0 || mimetypes.length > 64 ||
            mimetypes.some(type => !type || type.length > 256 ||
                [...type].some(char => char.charCodeAt(0) < 32))) {
            throw new Gio.DBusError({
                code: Gio.DBusError.INVALID_ARGS,
                message: 'Invalid clipboard offer',
            });
        }
        this._pasteGate?.invalidate();
        if (this._remoteSource)
            this._remoteSource.close();
        this._remoteSource = new RemoteSelectionSource(id, [...new Set(mimetypes)],
            (...args) => this.emit('ValueRequested', ...args), timeoutSeconds,
            (...args) => this.emit('CancelRequested', ...args),
            this._experimentalPasteGate ? (source, mimetype) => {
                if (mimetype !== 'text/uri-list' && mimetype !== 'x-special/gnome-copied-files')
                    return true;
                return this._pasteGate?.allows(source) ?? false;
            } : null);
        this._selection.set_owner(Meta.SelectionType.SELECTION_CLIPBOARD,
            this._remoteSource);
    }

    GetOffer() {
        return this._remoteSource?.offerId ?? '';
    }

    Resolve(id, requestId, value, error) {
        if (id === this._remoteSource?.offerId)
            this._remoteSource.resolve(requestId, value, error);
    }

    ClearOffer(id) {
        if (id !== this._remoteSource?.offerId)
            return;
        const source = this._remoteSource;
        this._pasteGate?.invalidate();
        this._remoteSource = null;
        source.close();
        this._selection.unset_owner(Meta.SelectionType.SELECTION_CLIPBOARD, source);
    }

    destroy() {
        this.setPasteGateEnabled(false);
        if (this._ownerIdleId) {
            GLib.source_remove(this._ownerIdleId);
            this._ownerIdleId = 0;
        }
        if (this._remoteSource)
            this.ClearOffer(this._remoteSource.offerId);
        if (this._selection && this._ownerChangedId > 0) {
            this._selection.disconnect(this._ownerChangedId);
            this._ownerChangedId = 0;
        }

        if (this._nameId > 0) {
            Gio.bus_unown_name(this._nameId);
            this._nameId = 0;
        }

        try {
            this._dbus.unexport();
        } catch (e) {
            logError(e);
        }
    }
});


let _portal = null;
let _portalId = 0;
let _pasteGateConfigured = false;
let _pasteGateEnabled = false;

/**
 * Activate the shortcut observer; opted-in sources stay guarded on disable.
 *
 * @param {boolean} enabled - Whether the extension is currently enabled
 */
export function setPasteGateEnabled(enabled) {
    _pasteGateEnabled = Boolean(enabled);
    _portal?.setPasteGateEnabled(_pasteGateEnabled);
}

/**
 * Watch for the service to start and export the clipboard portal when it does.
 *
 * @param {boolean} experimentalPasteGate - Opt into the experimental URI gate
 */
export function watchService(experimentalPasteGate = false) {
    _pasteGateConfigured = Boolean(experimentalPasteGate);
    if (GLib.getenv('XDG_SESSION_TYPE') !== 'wayland')
        return;

    if (_portalId > 0)
        return;

    _portalId = Gio.bus_watch_name(
        Gio.BusType.SESSION,
        'org.gnome.Shell.Extensions.GSConnect',
        Gio.BusNameWatcherFlags.NONE,
        () => {
            if (_portal === null) {
                _portal = new Clipboard({
                    experimentalPasteGate: _pasteGateConfigured,
                    pasteGateEnabled: _pasteGateEnabled,
                });
            }
        },
        () => {
            if (_portal !== null) {
                _portal.destroy();
                _portal = null;
            }
        }
    );
}

/**
 * Stop watching the service and export the portal if currently running.
 */
export function unwatchService() {
    if (_portalId > 0) {
        Gio.bus_unwatch_name(_portalId);
        _portalId = 0;
    }
    if (_portal) {
        _portal.destroy();
        _portal = null;
    }
}
