// SPDX-FileCopyrightText: GSConnect Developers https://github.com/GSConnect
//
// SPDX-License-Identifier: GPL-2.0-or-later

import GObject from 'gi://GObject';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import * as Components from '../components/index.js';
import Plugin from '../plugin.js';
import RichClipboard, {CAPABILITY} from '../utils/richClipboard.js';
import ClipboardHistoryPersistence from '../utils/clipboardHistoryPersistence.js';
import {historyStorageForDevice} from '../utils/clipboardHistoryStorage.js';
import ClipboardHistoryDialog from '../utils/clipboardHistoryDialog.js';
import {getClipboardCacheStorage, setClipboardCacheLimit} from '../utils/clipboardCacheStorage.js';


export const Metadata = {
    label: _('Clipboard'),
    description: _('Share the clipboard content'),
    id: 'org.gnome.Shell.Extensions.GSConnect.Plugin.Clipboard',
    incomingCapabilities: [
        CAPABILITY,
        'kdeconnect.clipboard',
        'kdeconnect.clipboard.connect',
    ],
    outgoingCapabilities: [
        CAPABILITY,
        'kdeconnect.clipboard',
        'kdeconnect.clipboard.connect',
    ],
    actions: {
        clipboardHistory: {
            label: _('Clipboard History'),
            icon_name: 'document-open-recent-symbolic',
            parameter_type: null,
            incoming: [], outgoing: [],
        },
        clipboardReceiveFiles: {
            label: '接收文件并准备粘贴',
            icon_name: 'folder-download-symbolic',
            parameter_type: 's',
            incoming: [CAPABILITY], outgoing: [],
        },
        clipboardCancel: {
            label: _('Cancel Clipboard Transfer'),
            icon_name: 'process-stop-symbolic',
            parameter_type: 's',
            incoming: [CAPABILITY],
            outgoing: [],
        },
        clipboardPush: {
            label: _('Clipboard Push'),
            icon_name: 'edit-paste-symbolic',

            parameter_type: null,
            incoming: [],
            outgoing: ['kdeconnect.clipboard'],
        },
        clipboardPull: {
            label: _('Clipboard Pull'),
            icon_name: 'edit-copy-symbolic',

            parameter_type: null,
            incoming: ['kdeconnect.clipboard'],
            outgoing: [],
        },
    },
};


/**
 * Clipboard Plugin
 * https://github.com/KDE/kdeconnect-kde/tree/master/plugins/clipboard
 */
const ClipboardPlugin = GObject.registerClass({
    GTypeName: 'GSConnectClipboardPlugin',
}, class ClipboardPlugin extends Plugin {

    _init(device) {
        super._init(device, 'clipboard');

        this._clipboard = Components.acquire('clipboard');

        // Watch local clipboard for changes
        this._textChangedId = this._clipboard.connect(
            'notify::text',
            this._onLocalClipboardChanged.bind(this)
        );

        // Buffer content to allow selective sync
        this._localBuffer = this._clipboard.text;
        this._localTimestamp = 0;
        this._remoteBuffer = null;
        this._rich = new RichClipboard(this, this._clipboard);
        this._historyPersistence = new ClipboardHistoryPersistence(this._rich.history,
            historyStorageForDevice(this.device.id));
        const updatePersistence = () => {
            try {
                this._historyPersistence.setEnabled(this.settings.get_boolean('history-persist'));
            } catch {
                debug('Clipboard history persistence initialization failed');
            }
        };
        // The default off state must perform no disk I/O.
        if (this.settings.get_boolean('history-persist'))
            updatePersistence();
        this._historyPersistenceId = this.settings.connect('changed::history-persist', updatePersistence);
        this.device.lookup_action('clipboardHistory').set_enabled(true);
    }

    connected() {
        super.connected();
        this._rich.connected();

        if (this._rich.enabled) {
            this._rich.publish().catch(debug);
            return;
        }

        // TODO: if we're not auto-syncing local->remote, but we are doing the
        //       reverse, it's possible older remote content will end up
        //       overwriting newer local content.
        if (!this.settings.get_boolean('send-content'))
            return;

        if (this._localBuffer === null && this._localTimestamp === 0)
            return;

        this.device.sendPacket({
            type: 'kdeconnect.clipboard.connect',
            body: {
                content: this._localBuffer,
                timestamp: this._localTimestamp,
            },
        });
    }

    disconnected() {
        this._rich.reset();
        super.disconnected();
        this.device.lookup_action('clipboardHistory').set_enabled(true);
    }

    handlePacket(packet) {
        if (packet.type === CAPABILITY) {
            this._rich.handle(packet).catch(debug);
            return;
        }
        if (this._rich.enabled)
            return;

        if (!packet.body.hasOwnProperty('content'))
            return;

        switch (packet.type) {
            case 'kdeconnect.clipboard':
                this._handleContent(packet);
                break;

            case 'kdeconnect.clipboard.connect':
                this._handleConnectContent(packet);
                break;
        }
    }

    _handleContent(packet) {
        this._onRemoteClipboardChanged(packet.body.content);
    }

    _handleConnectContent(packet) {
        if (packet.body.hasOwnProperty('timestamp') &&
            packet.body.timestamp > this._localTimestamp)
            this._onRemoteClipboardChanged(packet.body.content);
    }

    /*
     * Store the local clipboard content and forward it if enabled
     */
    _onLocalClipboardChanged(clipboard, pspec) {
        if (this._rich?.enabled)
            return;
        this._localBuffer = clipboard.text;
        this._localTimestamp = Date.now();

        if (this.settings.get_boolean('send-content'))
            this.clipboardPush();
    }

    /*
     * Store the remote clipboard content and apply it if enabled
     */
    _onRemoteClipboardChanged(text) {
        this._remoteBuffer = text;

        if (this.settings.get_boolean('receive-content'))
            this.clipboardPull();
    }

    /**
     * Copy to the remote clipboard; called by _onLocalClipboardChanged()
     */
    clipboardPush() {
        if (this._rich.enabled) {
            this._rich.publish().catch(debug);
            return;
        }
        // Don't sync if the clipboard is empty or not text
        if (this._localTimestamp === 0)
            return;

        if (this._remoteBuffer !== this._localBuffer) {
            this._remoteBuffer = this._localBuffer;

            // If the buffer is %null, the clipboard contains non-text content,
            // so we neither clear the remote clipboard nor pass the content
            if (this._localBuffer !== null) {
                this.device.sendPacket({
                    type: 'kdeconnect.clipboard',
                    body: {
                        content: this._localBuffer,
                    },
                });
            }
        }
    }

    /**
     * Copy from the remote clipboard; called by _onRemoteClipboardChanged()
     */
    clipboardPull() {
        if (this._rich.enabled)
            return;
        if (this._localBuffer !== this._remoteBuffer) {
            this._localBuffer = this._remoteBuffer;
            this._localTimestamp = Date.now();

            this._clipboard.text = this._remoteBuffer;
        }
    }

    clipboardHistory() {
        if (!this._historyDialog || this._historyDialog.destroyed) {
            this._historyDialog = new ClipboardHistoryDialog(this._rich.history, {
                peerName: this.device.name,
                persistence: {
                    getEnabled: () => this.settings.get_boolean('history-persist'),
                    setEnabled: value => {
                        if (!this.settings.set_boolean('history-persist', value))
                            throw new Error('保存设置失败');
                    },
                    getStatus: () => this._historyPersistence.status,
                },
                disk: {
                    getLimit: () => Gio.Application.get_default().settings
                        .get_value('clipboard-cache-max-bytes').deepUnpack(),
                    setLimit: limit => {
                        if (!Gio.Application.get_default().settings.set_value(
                            'clipboard-cache-max-bytes', new GLib.Variant('t', limit)))
                            throw new Error('磁盘配额设置未保存');
                        setClipboardCacheLimit(limit);
                    },
                    inspect: () => getClipboardCacheStorage(Gio.Application.get_default().settings
                        .get_value('clipboard-cache-max-bytes').deepUnpack()).snapshot(),
                    cleanup: () => getClipboardCacheStorage(Gio.Application.get_default().settings
                        .get_value('clipboard-cache-max-bytes').deepUnpack()).retryFailedRollbacks(),
                },
                onActivate: entry => this._rich.activateHistory(entry),
                onReceive: entry => this._rich.receiveHistoryFiles(entry),
                onClear: () => {
                    this._rich.history.clear();
                    // Retry failed removal even if memory was already empty.
                    this._historyPersistence.save();
                },
                onLimits: ({maxItems, maxBytes}) => {
                    this.settings.set_uint('history-max-items', maxItems);
                    this.settings.set_uint('history-max-bytes', maxBytes);
                },
            });
        }
        this._historyDialog.show();
    }

    async clipboardReceiveFiles(token) {
        try {
            await this._rich.receiveFiles(token);
        } catch (error) {
            this.device.showNotification({id: 'clipboard-files-receive-error',
                title: '无法接收文件', body: error.message,
                icon: new Gio.ThemedIcon({name: 'dialog-error-symbolic'})});
        }
    }

    clipboardCancel(id) {
        this._rich.cancelDownload(id);
    }

    destroy() {
        this._historyDialog?.destroy();
        this.settings.disconnect(this._historyPersistenceId);
        this._historyPersistence.close();
        this._rich.destroy();
        if (this._clipboard && this._textChangedId) {
            this._clipboard.disconnect(this._textChangedId);
            this._clipboard = Components.release('clipboard');
        }

        super.destroy();
    }
});

export default ClipboardPlugin;
