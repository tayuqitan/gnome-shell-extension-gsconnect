// SPDX-FileCopyrightText: GSConnect Developers https://github.com/GSConnect
//
// SPDX-License-Identifier: GPL-2.0-or-later

import Gdk from 'gi://Gdk';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';
import Gio from 'gi://Gio';
import {linkCancellables} from '../utils/transferCancellation.js';
import GObject from 'gi://GObject';


const DBUS_NAME = 'org.gnome.Shell.Extensions.GSConnect.Clipboard';
const DBUS_PATH = '/org/gnome/Shell/Extensions/GSConnect/Clipboard';


/**
 * The service class for this component
 */
const Clipboard = GObject.registerClass({
    GTypeName: 'GSConnectClipboard',
    Signals: {
        'changed': {},
    },
    Properties: {
        'text': GObject.ParamSpec.string(
            'text',
            'Text Content',
            'The current text content of the clipboard',
            GObject.ParamFlags.READWRITE,
            ''
        ),
    },
}, class Clipboard extends GObject.Object {

    _init() {
        super._init();

        this._cancellable = new Gio.Cancellable();
        this._clipboard = null;
        this._mimetypes = [];
        this._generation = 0;
        this._available = false;
        this._offer = null;
        this._requests = new Set();
        this._pendingRejects = new Set();

        this._ownerChangeId = 0;
        this._nameWatcherId = Gio.bus_watch_name(
            Gio.BusType.SESSION,
            DBUS_NAME,
            Gio.BusNameWatcherFlags.NONE,
            this._onNameAppeared.bind(this),
            this._onNameVanished.bind(this)
        );
    }

    // Rich clipboard operations require the versioned GNOME Shell portal.
    get available() {
        return this._available;
    }

    get richAvailable() {
        return this.available;
    }

    get mimetypes() {
        return this._mimetypes.slice();
    }

    get generation() {
        return this._generation;
    }

    _call(method, parameters = null, proxy = this._clipboard) {
        return proxy.call(method, parameters, Gio.DBusCallFlags.NO_AUTO_START,
            300000, this._cancellable);
    }

    async readValue(mimetype, cancellable = null) {
        if (!this.available || !this._mimetypes.includes(mimetype))
            throw new Error('Clipboard format is unavailable');

        const generation = this._generation;
        const lifetime = linkCancellables(this._cancellable, cancellable);
        let reply;
        try {
            reply = await this._clipboard.call('GetValue',
                new GLib.Variant('(s)', [mimetype]), Gio.DBusCallFlags.NO_AUTO_START,
                300000, lifetime.cancellable);
        } finally {
            lifetime.dispose();
        }
        if (generation !== this._generation || this._offer !== null)
            throw new Error('Clipboard changed while reading');

        const value = reply.deepUnpack()[0];
        if (value.length > 16 * 1024 * 1024)
            throw new Error('Clipboard value exceeds 16 MiB');
        return new Uint8Array(value);
    }

    async offer(id, mimetypes, callback, timeoutSeconds = 3600) {
        if (!this.available)
            throw new Error('Rich clipboard requires the GNOME Shell portal');
        if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 60 || timeoutSeconds > 86400 ||
            typeof id !== 'string' || !id || id.length > 256 ||
            !Array.isArray(mimetypes) || mimetypes.length === 0 ||
            mimetypes.length > 64 || mimetypes.some(type =>
            typeof type !== 'string' || !type || type.length > 256) ||
            typeof callback !== 'function')
            throw new Error('Invalid clipboard offer');

        this._cancelRequests();
        const offer = {id, mimetypes: mimetypes.slice(), callback, timeoutSeconds};
        this._offer = offer;
        this._generation++;
        this._mimetypes = [];
        try {
            await this._call('Offer',
                new GLib.Variant('(sasu)', [id, mimetypes, timeoutSeconds]));
        } catch (e) {
            if (this._offer === offer)
                this._offer = null;
            throw e;
        }
    }

    async clearOffer(id) {
        if (this._offer?.id !== id)
            return;
        this._cancelRequests();
        this._offer = null;
        if (this.available)
            await this._call('ClearOffer', new GLib.Variant('(s)', [id]));
    }

    _cancelRequests() {
        for (const reject of this._pendingRejects)
            reject(new Error('Clipboard offer expired'));
        this._pendingRejects.clear();
    }

    _onProxySignal(proxy, sender, signal, parameters) {
        if (proxy !== this._clipboard)
            return;
        if (signal === 'CancelRequested') {
            const [id, requestId] = parameters.deepUnpack();
            this._requestRejects?.get(`${id}:${requestId}`)?.(
                new Error('Clipboard reader cancelled'));
        } else if (signal === 'OwnerChange') {
            this._onOwnerChange();
        } else if (signal === 'ValueRequested') {
            this._onValueRequested(proxy, parameters.deepUnpack()).catch(debug);
        }
    }

    async _onValueRequested(proxy, [id, requestId, mimetype]) {
        const offer = this._offer;
        const key = `${id}:${requestId}`;
        this._requestRejects ??= new Map();
        if (!offer || offer.id !== id || !offer.mimetypes.includes(mimetype) ||
            this._requests.has(key))
            return;

        let value = new Uint8Array();
        let error = '';
        let timeout = 0;
        let rejectRequest;
        const requestCancellable = new Gio.Cancellable();
        try {
            if (this._requests.size >= 32)
                throw new Error('Too many clipboard requests');
            this._requests.add(key);
            value = await Promise.race([
                Promise.resolve().then(() => offer.callback(mimetype, requestCancellable)),
                new Promise((resolve, reject) => {
                    rejectRequest = reason => {
                        requestCancellable.cancel();
                        reject(reason);
                    };
                    this._pendingRejects.add(rejectRequest);
                    this._requestRejects.set(key, rejectRequest);
                    timeout = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT,
                        offer.timeoutSeconds, () => {
                            timeout = 0;
                            rejectRequest(new Error('Clipboard request timed out'));
                            return GLib.SOURCE_REMOVE;
                        });
                }),
            ]);
            if (offer !== this._offer)
                throw new Error('Clipboard offer expired');
            if (!(value instanceof Uint8Array) || value.length > 16 * 1024 * 1024)
                throw new Error('Invalid or oversized clipboard data');
        } catch (e) {
            value = new Uint8Array();
            error = 'Clipboard data unavailable';
            debug(e);
        } finally {
            requestCancellable.cancel();
            this._pendingRejects.delete(rejectRequest);
            this._requestRejects.delete(key);
            if (timeout)
                GLib.source_remove(timeout);
            this._requests.delete(key);
        }
        if (proxy === this._clipboard && !this._cancellable.is_cancelled()) {
            await this._call('Resolve',
                new GLib.Variant('(ssays)', [id, requestId, value, error]), proxy);
        }
    }

    get text() {
        if (this._text === undefined)
            this._text = '';

        return this._text;
    }

    set text(content) {
        if (this.text === content)
            return;

        this._text = content;
        this.notify('text');

        if (typeof content !== 'string')
            return;

        if (this._clipboard instanceof Gtk.Clipboard)
            this._clipboard.set_text(content, -1);

        if (this._clipboard instanceof Gio.DBusProxy) {
            this._clipboard.call('SetText', new GLib.Variant('(s)', [content]),
                Gio.DBusCallFlags.NO_AUTO_START, -1, this._cancellable)
                .catch(debug);
        }
    }

    async _onNameAppeared(connection, name, name_owner) {
        try {
            // Cleanup the GtkClipboard
            if (this._clipboard && this._ownerChangeId > 0) {
                this._clipboard.disconnect(this._ownerChangeId);
                this._ownerChangeId = 0;
            }

            // Create a proxy for the remote clipboard
            this._clipboard = new Gio.DBusProxy({
                g_bus_type: Gio.BusType.SESSION,
                g_name: DBUS_NAME,
                g_object_path: DBUS_PATH,
                g_interface_name: DBUS_NAME,
                g_flags: Gio.DBusProxyFlags.DO_NOT_LOAD_PROPERTIES,
            });

            await this._clipboard.init_async(GLib.PRIORITY_DEFAULT,
                this._cancellable);

            this._ownerChangeId = this._clipboard.connect('g-signal',
                this._onProxySignal.bind(this));

            this._onOwnerChange();
            // wl-paste's dbus-send emits from its own unique bus sender.
            if (!globalThis.HAVE_GNOME && !this.signalHandler) {
                this.signalHandler = Gio.DBus.session.signal_subscribe(
                    null, DBUS_NAME, 'OwnerChange', DBUS_PATH, null,
                    Gio.DBusSignalFlags.NONE, this._onOwnerChange.bind(this));
            }
        } catch (e) {
            if (!e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED)) {
                debug(e);
                this._onNameVanished(null, null);
            }
        }
    }

    _onNameVanished(connection, name) {
        if (this.signalHandler) {
            Gio.DBus.session.signal_unsubscribe(this.signalHandler);
            this.signalHandler = 0;
        }
        if (this._clipboard && this._ownerChangeId > 0) {
            this._clipboard.disconnect(this._ownerChangeId);
            this._ownerChangeId = 0;
        }

        this._available = false;
        this._cancelRequests();
        this._offer = null;
        this._mimetypes = [];
        const display = Gdk.Display.get_default();
        this._clipboard = Gtk.Clipboard.get_default(display);

        this._ownerChangeId = this._clipboard.connect('owner-change',
            this._onOwnerChange.bind(this));

        this._onOwnerChange();
    }

    async _onOwnerChange() {
        const generation = ++this._generation;
        try {
            if (this._clipboard instanceof Gtk.Clipboard)
                await this._gtkUpdateText(generation);

            else if (this._clipboard instanceof Gio.DBusProxy)
                await this._proxyUpdateText(generation);
        } catch (e) {
            if (!e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                debug(e);
        }
    }

    _applyUpdate(text) {
        if (typeof text !== 'string' || this.text === text)
            return;

        this._text = text;
        this.notify('text');
    }

    /*
     * Proxy Clipboard
     */
    async _proxyUpdateText(generation) {
        const proxy = this._clipboard;
        let remoteId = '';
        let available = false;
        try {
            const reply = await this._call('GetOffer', null, proxy);
            remoteId = reply.deepUnpack()[0];
            available = true;
        } catch {
            // Older extensions have the text-only portal.
            available = false;
        }
        if (generation !== this._generation || proxy !== this._clipboard)
            return;
        this._available = available;
        if (remoteId)
            return;
        this._cancelRequests();
        this._offer = null;

        let reply = await this._call('GetMimetypes', null, proxy);
        const mimetypes = reply.deepUnpack()[0];
        if (generation !== this._generation || proxy !== this._clipboard)
            return;
        this._mimetypes = mimetypes;
        this.emit('changed');

        if (mimetypes.length === 0)
            return this._applyUpdate('');
        if (mimetypes.includes('text/uri-list') ||
            !mimetypes.some(type => type.startsWith('text/plain') ||
                type === 'UTF8_STRING' || type === 'STRING'))
            return;

        reply = await this._call('GetText', null, proxy);
        if (generation === this._generation && proxy === this._clipboard)
            this._applyUpdate(reply.deepUnpack()[0]);
    }

    /*
     * GtkClipboard
     */
    async _gtkUpdateText(generation) {
        const mimetypes = await new Promise((resolve, reject) => {
            this._clipboard.request_targets((clipboard, atoms) => resolve(atoms));
        });

        if (generation !== this._generation)
            return;

        // Special case for a cleared clipboard
        if (mimetypes.length === 0)
            return this._applyUpdate('');

        // Special case to ignore copied files
        if (mimetypes.includes('text/uri-list'))
            return;

        const text = await new Promise((resolve, reject) => {
            this._clipboard.request_text((clipboard, text) => resolve(text));
        });

        if (generation === this._generation)
            this._applyUpdate(text);
    }

    destroy() {
        if (this._cancellable.is_cancelled())
            return;

        const offer = this._offer;
        if (offer && this.available) {
            this._clipboard.call('ClearOffer', new GLib.Variant('(s)', [offer.id]),
                Gio.DBusCallFlags.NO_AUTO_START, 5000, null).catch(debug);
        }
        this._cancelRequests();
        this._offer = null;
        this._available = false;
        this._generation++;
        this._cancellable.cancel();
        if (this.signalHandler) {
            Gio.DBus.session.signal_unsubscribe(this.signalHandler);
            this.signalHandler = 0;
        }

        if (this._clipboard && this._ownerChangeId > 0) {
            this._clipboard.disconnect(this._ownerChangeId);
            this._ownerChangeId = 0;
        }

        if (this._nameWatcherId > 0) {
            Gio.bus_unwatch_name(this._nameWatcherId);
            this._nameWatcherId = 0;
        }

    }
});

export default Clipboard;

// vim:tabstop=2:shiftwidth=2:expandtab
