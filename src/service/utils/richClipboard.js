// SPDX-FileCopyrightText: 2026 GSConnect fork contributors
// SPDX-License-Identifier: GPL-2.0-or-later

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import ClipboardHistory from './clipboardHistory.js';
import {getClipboardCacheStorage} from './clipboardCacheStorage.js';

// Deliberately private to this fork. Never send these packets to legacy peers.
export const CAPABILITY = 'gsconnect.clipboard.rich';
const MAX_VALUE = 16 * 1024 * 1024;
const MAX_FILES = 128;
const MAX_FILE_SIZE = 100 * 1024 * 1024 * 1024;
const FILE_TYPES = ['text/uri-list', 'x-special/gnome-copied-files'];

// RFC 1982-style uint32 serial arithmetic keeps rollover ordered. A distance
// of exactly half the range is ambiguous and is rejected at the boundary.
/**
 * Compare bounded serial numbers across rollover.
 *
 * @param {number} a - Candidate uint32 serial
 * @param {number} b - Existing uint32 serial
 * @returns {boolean} Whether a follows b
 */
function newer(a, b) {
    const distance = (a - b) >>> 0;
    return distance > 0 && distance < 0x80000000;
}

/**
 * Compare clipboard priorities.
 *
 * @param {object} a - Existing priority
 * @param {object} b - Incoming priority
 * @returns {boolean} Whether a wins
 */
function outranks(a, b) {
    return newer(a.revision, b.revision) ||
        (a.revision === b.revision && a.origin > b.origin);
}

export default class RichClipboard {
    constructor(plugin, clipboard) {
        this.plugin = plugin;
        this.device = plugin.device;
        this.clipboard = clipboard;
        this.pending = new Map();
        this.cacheWriters = new Map();
        this.local = null;
        this.remote = null;
        this.closed = false;
        this.serving = new Map();
        this.history = new ClipboardHistory({
            maxItems: plugin.settings.get_uint('history-max-items'),
            maxBytes: plugin.settings.get_uint('history-max-bytes'),
            onEvict: entry => {
                for (const transfer of this.serving.values()) {
                    const current = this.local?.id === entry.id &&
                        this.local.generation === this.clipboard.generation;
                    if (transfer.historyKey === entry.key && !current)
                        transfer.cancel();
                }
            },
        });
        this.historyActivation = 0;
        this.publishSerial = 0;
        this.remoteReady = false;
        this.helloSent = false;
        this.clock = 0;
        this.origin = GLib.uuid_string_random();
        this.localVersion = null;
        this.candidate = null;
        this.changedId = 'richAvailable' in clipboard
            ? clipboard.connect('changed', () => {
                this.cancelRevokedTransfers();
                this.clearRemote();
                this.announce();
                this.publish().catch(debug);
            }) : 0;
        this.settingsId = plugin.settings.connect('changed', (_settings, key) => {
            if (key?.startsWith('history-')) {
                this.history.setLimits({
                    maxItems: plugin.settings.get_uint('history-max-items'),
                    maxBytes: plugin.settings.get_uint('history-max-bytes'),
                });
                return;
            }
            if (this.enabled && this.device.connected)
                this.send({op: 'clear'});
            this.reset();
            this.publish().catch(debug);
        });
    }

    get supported() {
        return this.device.settings.get_strv('incoming-capabilities').includes(CAPABILITY) &&
            this.device.settings.get_strv('outgoing-capabilities').includes(CAPABILITY);
    }

    get enabled() {
        return this.supported && this.clipboard.richAvailable && this.remoteReady;
    }

    connected() {
        this.remoteReady = false;
        this.helloSent = false;
        this.announce();
    }

    announce() {
        if (!this.closed && this.device.connected && this.supported) {
            this.helloSent = true;
            this.send({op: 'hello', available: Boolean(this.clipboard.richAvailable)});
        }
    }

    send(body) {
        this.device.sendPacket({type: CAPABILITY, body: {version: 1, ...body}});
    }

    cancelRevokedTransfers() {
        for (const transfer of this.serving.values()) {
            const current = this.local?.id === transfer.clipboardOfferId &&
                this.local.generation === this.clipboard.generation;
            if (!current && !this.history.get(transfer.historyKey))
                transfer.cancel();
        }
    }

    async publish() {
        if (this.closed || !this.clipboard.richAvailable)
            return;

        const canPublish = this.enabled && this.device.connected &&
            this.plugin.settings.get_boolean('send-content');
        const serial = ++this.publishSerial;
        const generation = this.clipboard.generation;
        if (this.localVersion?.generation !== generation) {
            this.clock = (this.clock + 1) >>> 0;
            this.localVersion = {generation, revision: this.clock,
                origin: this.origin, id: GLib.uuid_string_random()};
        }
        const types = this.clipboard.mimetypes.filter(type =>
            typeof type === 'string' && type.length < 256 && type.includes('/')).slice(0, 64);
        const offer = {...this.localVersion, types, files: []};
        this.candidate = offer;
        // Invalidate the previous lease immediately, even if discovery fails.
        this.local = null;
        this.cancelRevokedTransfers();
        if (canPublish)
            this.send({op: 'clear'});
        if (types.some(type => FILE_TYPES.includes(type))) {
            const mime = types.includes('text/uri-list') ? 'text/uri-list' : FILE_TYPES[1];
            const bytes = await this.clipboard.readValue(mime);
            const lines = new TextDecoder().decode(bytes).split(/\r?\n/);
            if (mime === FILE_TYPES[1])
                lines.shift(); // Never propagate cut semantics across machines.
            const uris = lines.filter(line => line && !line.startsWith('#'));
            if (uris.length > MAX_FILES)
                throw new Error('Clipboard has too many files');
            for (const uri of uris) {
                const file = Gio.File.new_for_uri(uri);
                if (!uri.startsWith('file:///') || !file.is_native())
                    throw new Error('Only local regular files can be copied');
                const info = await file.query_info_async(
                    'standard::type,standard::size,time::modified,standard::is-symlink,id::file',
                    Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, GLib.PRIORITY_DEFAULT, null);
                if (info.get_file_type() !== Gio.FileType.REGULAR || info.get_is_symlink() ||
                    info.get_size() > MAX_FILE_SIZE)
                    throw new Error('Folders, symlinks and oversized files are not supported');
                offer.files.push({file, name: file.get_basename(), size: info.get_size(),
                    identity: info.get_attribute_string('id::file'),
                    modified: info.get_attribute_uint64('time::modified')});
            }
            offer.types = FILE_TYPES;
        }
        const snapshots = new Map();
        let remaining = this.history.maxBytes;
        const sensitive = this.clipboard.mimetypes.some(type =>
            /password|secret|sensitive/i.test(type));
        if (this.history.maxItems && !offer.files.length && !sensitive) {
            for (const mime of offer.types) {
                if (remaining <= 0)
                    break;
                try {
                    const value = await this.clipboard.readValue(mime);
                    if (value.length <= remaining) {
                        snapshots.set(mime, value);
                        remaining -= value.length;
                    }
                } catch (error) {
                    debug(error);
                }
            }
        }
        if (this.closed || serial !== this.publishSerial ||
            generation !== this.clipboard.generation)
            return;
        if (!offer.types.length) {
            this.candidate = null;
            return;
        }
        if (!sensitive)
            this.history.addLocal(offer, snapshots);
        this.local = offer;
        if (!canPublish)
            return;
        this.send({op: 'offer', id: offer.id, revision: offer.revision,
            origin: offer.origin, types: offer.types, sensitive,
            files: offer.files.map(({name, size}) => ({name, size}))});
    }

    async handle(packet) {
        if (!this.supported || this.closed || packet.body.version !== 1)
            return;
        const body = packet.body;
        if (body.op === 'hello' && typeof body.available === 'boolean') {
            const changed = this.remoteReady !== body.available;
            this.remoteReady = body.available;
            if (!this.helloSent)
                this.announce();
            if (changed) {
                this.reset();
                await this.publish();
            }
            return;
        }
        if (!this.enabled)
            return;
        try {
            if (body.op === 'offer')
                await this.accept(body);
            else if (body.op === 'request')
                await this.serve(body);
            else if (body.op === 'value' || body.op === 'error')
                await this.receive(packet);
            else if (body.op === 'clear')
                this.clearRemote();
        } catch (e) {
            debug(e, this.device.name);
            if (body.op === 'request' && typeof body.request === 'string')
                this.send({op: 'error', id: body.id, request: body.request});
        }
    }

    async accept(body, selectedFromHistory = false) {
        if (!this.plugin.settings.get_boolean('receive-content') ||
            typeof body.id !== 'string' || body.id.length > 64 ||
            !Number.isSafeInteger(body.revision) || body.revision < 0 ||
            body.revision > 0xffffffff ||
            ((body.revision - this.clock) >>> 0) === 0x80000000 ||
            typeof body.origin !== 'string' || !body.origin || body.origin.length > 64 ||
            !Array.isArray(body.types) || body.types.length > 64 ||
            !body.types.every(type => typeof type === 'string' && type.length < 256 && type.includes('/')) ||
            !Array.isArray(body.files) || body.files.length > MAX_FILES ||
            !body.files.every(file => file && typeof file.name === 'string' && file.name.length <= 255 &&
                file.name !== '.' && file.name !== '..' && file.name.length > 0 &&
                ![...file.name].some(char => char.charCodeAt(0) < 32 || '/\\'.includes(char)) && Number.isSafeInteger(file.size) &&
                file.size >= 0 && file.size <= MAX_FILE_SIZE))
            return;
        if (body.types.some(type => FILE_TYPES.includes(type)) && !body.files.length)
            return;
        if (body.sensitive)
            this.history.remove(`remote:${body.id}`);
        else
            this.history.addRemote(body, this.device.name);
        if (!selectedFromHistory && this.remote?.id === body.id &&
            this.remote.revision === body.revision &&
            this.remote.origin === body.origin)
            return;
        if (newer(body.revision, this.clock))
            this.clock = body.revision;
        const competing = this.candidate || this.local;
        // Bounded serial revision plus stable origin chooses one
        // winner for concurrent copies/connection handshakes. Never revoke
        // both senders merely because offers crossed on the wire.
        if (!selectedFromHistory && competing && outranks(competing, body))
            return;
        if (!selectedFromHistory && this.remote && outranks(this.remote, body))
            return;
        this.publishSerial++;
        this.candidate = null;
        this.clearRemote();
        this.local = null; // Receiving remote content revokes our old local lease.
        this.cancelRevokedTransfers();
        const remote = {id: body.id, revision: body.revision, origin: body.origin,
            types: body.types, files: body.files, sensitive: Boolean(body.sensitive),
            download: null, fileCache: null};
        this.remote = remote;
        await this.clipboard.offer(remote.id, remote.types, async (mime, cancellable) => {
            if (this.remote !== remote)
                throw new Error('Clipboard offer expired');
            if (FILE_TYPES.includes(mime)) {
                const uris = await this.getFiles(remote, cancellable);
                return new TextEncoder().encode(mime === FILE_TYPES[1]
                    ? `copy\n${uris.join('\n')}` : `${uris.join('\r\n')}\r\n`);
            }
            return this.request(remote, {mime}, null, cancellable);
        }, this.timeoutSeconds);
        return true;
    }

    async activateHistory(entry) {
        if (this.history.get(entry.key) !== entry || !this.clipboard.richAvailable)
            throw new Error('历史记录不可用，或 GNOME 剪贴板桥未连接');
        if (entry.persisted && (entry.offer.files.length || !entry.values.size))
            throw new Error('持久化记录没有可用字节快照，请重新复制');
        const activation = ++this.historyActivation;
        const generation = this.clipboard.generation;
        const files = entry.offer.files;
        if (entry.direction === 'remote' && !entry.uris && entry.values.size === 0) {
            if (!this.plugin.settings.get_boolean('receive-content'))
                throw new Error('已关闭接收剪贴板，请先启用接收后再恢复此未缓存记录');
            if (!this.enabled || !this.device.connected)
                throw new Error('记录尚未缓存，需要源设备在线且仍保留此记录');
            const restored = await this.accept(entry.offer, true);
            if (!restored)
                throw new Error('恢复失败：历史记录或接收权限已失效');
            return;
        }
        let types, provider;
        if (files.length) {
            const uris = [];
            for (let index = 0; index < files.length; index++) {
                const expected = files[index];
                const file = entry.uris ? Gio.File.new_for_uri(entry.uris[index]) : expected.file;
                if (!file || !file.is_native())
                    throw new Error('源文件或缓存文件已经失效');
                const info = await file.query_info_async(
                    'standard::type,standard::size,standard::is-symlink,id::file,time::modified',
                    Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, GLib.PRIORITY_DEFAULT, null);
                if (info.get_file_type() !== Gio.FileType.REGULAR || info.get_is_symlink() ||
                    info.get_size() !== expected.size || (!entry.uris &&
                    (info.get_attribute_string('id::file') !== expected.identity ||
                    info.get_attribute_uint64('time::modified') !== expected.modified)))
                    throw new Error('历史文件已修改或被替换，请重新复制');
                uris.push(file.get_uri());
            }
            types = FILE_TYPES;
            provider = mime => new TextEncoder().encode(mime === FILE_TYPES[1]
                ? `copy\n${uris.join('\n')}` : `${uris.join('\r\n')}\r\n`);
        } else {
            types = [...entry.values.keys()];
            if (!types.length)
                throw new Error('此记录没有可用快照，源剪贴板已失效');
            provider = mime => entry.values.get(mime).slice();
        }
        if (this.closed || activation !== this.historyActivation ||
            generation !== this.clipboard.generation ||
            this.history.get(entry.key) !== entry)
            throw new Error('历史恢复已取消或记录已清理');
        this.reset();
        await this.clipboard.offer(`history-${GLib.uuid_string_random()}`,
            types, provider, this.timeoutSeconds);
    }

    get timeoutSeconds() {
        return this.plugin.settings.get_uint('rich-transfer-timeout');
    }

    request(remote, detail, file = null, cancellable = null) {
        return new Promise((resolve, reject) => {
            if (this.remote !== remote || cancellable?.is_cancelled())
                return reject(new Error('Clipboard offer expired'));
            const request = GLib.uuid_string_random();
            const pending = {remote, detail, file, resolve, reject, transfer: null,
                cancellable, cancelId: 0};
            pending.timer = GLib.timeout_add_seconds(
                GLib.PRIORITY_DEFAULT, this.timeoutSeconds, () => {
                    pending.timer = 0;
                    pending.transfer?.cancel();
                    this.finish(request, new Error('Clipboard transfer timed out'));
                    return GLib.SOURCE_REMOVE;
                });
            this.pending.set(request, pending);
            if (cancellable) {
                pending.cancelId = cancellable.connect(() => {
                    pending.cancelled = true;
                    pending.transfer?.cancel();
                    // Never disconnect a Gio.Cancellable handler inside itself.
                    GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
                        this.finish(request, new Error('Clipboard request cancelled'));
                        return GLib.SOURCE_REMOVE;
                    });
                });
            }
            if (!cancellable?.is_cancelled())
                this.send({op: 'request', id: remote.id, request, ...detail});
        });
    }

    getFiles(remote, cancellable = null) {
        if (this.remote !== remote || cancellable?.is_cancelled())
            return Promise.reject(new Error('Clipboard request cancelled'));
        if (remote.fileCache)
            return Promise.resolve(remote.fileCache);
        let download = remote.download;
        if (!download || download.cancellable.is_cancelled()) {
            download = {cancellable: new Gio.Cancellable(), readers: new Set(), completed: false};
            remote.download = download;
            download.promise = Promise.resolve().then(() =>
                this.fetchFiles(remote, download.cancellable)).then(uris => {
                if (!download.cancellable.is_cancelled() && this.remote === remote)
                    remote.fileCache = uris;
                if (!remote.sensitive)
                    this.history.attachFiles(remote.id, uris);
                return uris;
            }).finally(() => {
                download.completed = true;
                if (remote.download === download)
                    remote.download = null;
            });
        }
        return new Promise((resolve, reject) => {
            const reader = {};
            download.readers.add(reader);
            let settled = false;
            let cancelId = 0;
            const disconnect = () => {
                if (cancelId) {
                    cancellable.disconnect(cancelId);
                    cancelId = 0;
                }
            };
            const release = () => {
                download.readers.delete(reader);
                if (!download.completed && download.readers.size === 0)
                    download.cancellable.cancel();
            };
            const finish = (error, uris) => {
                if (settled)
                    return;
                settled = true;
                disconnect();
                release();
                if (error)
                    reject(error);
                else
                    resolve(uris);
            };
            if (cancellable) {
                cancelId = cancellable.connect(() => {
                    if (settled)
                        return;
                    settled = true;
                    release();
                    reject(new Error('Clipboard reader cancelled'));
                    // Disconnect only after leaving Gio.Cancellable's callback.
                    GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
                        disconnect();
                        return GLib.SOURCE_REMOVE;
                    });
                });
            }
            download.promise.then(uris => finish(null, uris), error => finish(error));
        });
    }

    cancelDownload(id) {
        if (this.remote?.progress?.id === id)
            this.remote.download?.cancellable.cancel();
    }

    notifyProgress(progress, status, error = null, force = false) {
        const now = Date.now();
        if (!force && now - progress.lastUpdate < 500)
            return;
        progress.lastUpdate = now;
        const amount = `${GLib.format_size(progress.written)} / ${GLib.format_size(progress.total)}`;
        const percent = progress.total ? Math.floor(100 * progress.written / progress.total) : 0;
        this.device.showNotification?.({
            id: `clipboard-transfer-${progress.id}`,
            title: _('Clipboard transfer'),
            body: `${status}: ${amount} (${percent}%) · ${progress.completed}/${progress.count}` +
                (error ? `\n${error.message}` : ''),
            icon: new Gio.ThemedIcon({name: 'edit-paste-symbolic'}),
            buttons: status === _('Transferring') ? [{
                label: _('Cancel'), action: 'clipboardCancel',
                parameter: new GLib.Variant('s', progress.id),
            }] : [],
        });
    }

    async fetchFiles(remote, cancellable = null) {
        const progress = {id: GLib.uuid_string_random(), lastUpdate: 0, written: 0,
            total: remote.files.reduce((sum, file) => sum + file.size, 0),
            completed: 0, count: remote.files.length, base: 0};
        remote.progress = progress;
        this.notifyProgress(progress, _('Transferring'), null, true);
        let storage, transaction;
        try {
            const settings = Gio.Application.get_default().settings;
            const limit = settings.get_value('clipboard-cache-max-bytes').deepUnpack();
            storage = getClipboardCacheStorage(limit);
            transaction = storage.begin(remote.files);
            for (let index = 0; index < remote.files.length; index++) {
                if (cancellable?.is_cancelled())
                    throw new Error('Clipboard request cancelled');
                const file = transaction.handle.children[index].file;
                await this.request(remote, {index}, file, cancellable);
                progress.base += remote.files[index].size;
                progress.written = progress.base;
                progress.completed++;
                this.notifyProgress(progress, _('Transferring'), null, true);
            }
            if (cancellable?.is_cancelled())
                throw new Error('Clipboard request cancelled');
            const uris = storage.complete(transaction);
            this.notifyProgress(progress, _('Completed'), null, true);
            return uris;
        } catch (error) {
            const rollback = transaction || error.cacheTransaction;
            if (rollback) {
                try {
                    // Cancellation can reject request() before streams
                    // settle. Never remove paths while writers live.
                    await Promise.allSettled(rollback.handle.children.map(child =>
                        this.cacheWriters.get(child.file.get_uri())).filter(Boolean));
                    await storage.rollback(rollback);
                } catch (cleanupError) {
                    debug(cleanupError); // Retain quota on failed cleanup.
                }
            }
            const cancelled = cancellable?.is_cancelled() ||
                error.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED);
            this.notifyProgress(progress, cancelled ? _('Cancelled') : _('Failed'), error, true);
            throw error;
        }
    }

    async serve(body) {
        const archive = this.history.getLocalLease(body.id);
        const offer = this.local?.id === body.id ? this.local : archive?.offer;
        const retained = () => archive && this.history.getLocalLease(body.id) === archive;
        const current = () => offer === this.local &&
            offer?.generation === this.clipboard.generation;
        if (!this.plugin.settings.get_boolean('send-content') || !offer || body.id !== offer.id ||
            (!current() && !retained()) || typeof body.request !== 'string' ||
            body.request.length > 64)
            throw new Error('Clipboard lease expired');
        if (this.serving.size >= 8 || this.serving.has(body.request))
            throw new Error('Too many clipboard transfers');
        const transfer = this.device.createTransfer();
        transfer.historyKey = `local:${offer.id}`;
        transfer.clipboardOfferId = offer.id;
        this.serving.set(body.request, transfer);
        let fileStream = null;
        let started = false;
        const cancellable = transfer.cancellable;
        let deadline = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT,
            this.timeoutSeconds, () => {
                deadline = 0;
                transfer.cancel();
                return GLib.SOURCE_REMOVE;
            });
        try {
            const packet = {type: CAPABILITY, body: {version: 1, op: 'value',
                id: offer.id, request: body.request}};
            if (Number.isInteger(body.index) && body.index >= 0 &&
                body.index < offer.files.length) {
                const item = offer.files[body.index];
                const info = await item.file.query_info_async(
                    'standard::size,time::modified,standard::type,standard::is-symlink',
                    Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, GLib.PRIORITY_DEFAULT, cancellable);
                if (info.get_size() !== item.size ||
                    info.get_attribute_uint64('time::modified') !== item.modified ||
                info.get_is_symlink() || info.get_file_type() !== Gio.FileType.REGULAR)
                    throw new Error('Source file changed; copy it again');
                const stream = await item.file.read_async(GLib.PRIORITY_DEFAULT, cancellable);
                fileStream = stream;
                const opened = await stream.query_info_async('standard::size,time::modified,id::file',
                    GLib.PRIORITY_DEFAULT, cancellable);
                if (!item.identity || opened.get_attribute_string('id::file') !== item.identity ||
                opened.get_size() !== item.size ||
                opened.get_attribute_uint64('time::modified') !== item.modified) {
                    stream.close(null);
                    throw new Error('Source file identity changed');
                }
                transfer.addStream(packet, stream, item.size);
            } else {
                if (offer.files.length || !offer.types.includes(body.mime))
                    throw new Error('Invalid clipboard format');
                let bytes = null;
                if (retained() && archive.values.has(body.mime))
                    bytes = archive.values.get(body.mime);
                else if (current())
                    bytes = await this.clipboard.readValue(body.mime, cancellable);
                if (!bytes || bytes.length > MAX_VALUE || (!current() && !retained()))
                    throw new Error('Clipboard value changed or is too large');
                transfer.addStream(packet, Gio.MemoryInputStream.new_from_bytes(
                    new GLib.Bytes(bytes)), bytes.length);
            }
            if (cancellable.is_cancelled() || this.closed || (!current() && !retained()) ||
            !this.plugin.settings.get_boolean('send-content'))
                throw new Error('Clipboard lease expired');
            started = true;
            await transfer.start();
        } finally {
            if (deadline)
                GLib.source_remove(deadline);
            if (fileStream) {
                try {
                    fileStream.close(null);
                } catch (error) {
                    debug(error);
                }
            }
            if (!started)
                transfer.abandon();
            this.serving.delete(body.request);
        }
    }

    async receive(packet) {
        const body = packet.body;
        const pending = this.pending.get(body.request);
        if (!pending || body.id !== pending.remote.id ||
            pending.remote !== this.remote || pending.transfer) {
            if (packet.hasPayload())
                this.device.rejectTransfer(packet);
            return;
        }
        if (pending.cancelled || pending.cancellable?.is_cancelled()) {
            if (packet.hasPayload())
                this.device.rejectTransfer(packet);
            this.finish(body.request, new Error('Clipboard request cancelled'));
            return;
        }
        if (body.op === 'error') {
            this.finish(body.request, new Error('Remote clipboard unavailable'));
            return;
        }
        const expected = pending.file ? pending.remote.files[pending.detail.index].size : MAX_VALUE;
        if (!Number.isSafeInteger(packet.payloadSize) || packet.payloadSize < 0 ||
            packet.payloadSize > expected || (pending.file && packet.payloadSize !== expected)) {
            this.device.rejectTransfer(packet);
            this.finish(body.request, new Error('Invalid clipboard payload size'));
            return;
        }
        try {
            const transfer = this.device.createTransfer();
            pending.transfer = transfer;
            if (pending.file && pending.remote.progress) {
                const progress = pending.remote.progress;
                transfer.onProgress = written => {
                    if (pending.remote.progress !== progress)
                        return;
                    progress.written = progress.base + written;
                    this.notifyProgress(progress, _('Transferring'));
                };
            }
            if (pending.cancelled || pending.cancellable?.is_cancelled())
                throw new Error('Clipboard request cancelled');
            const stream = pending.file ? null : Gio.MemoryOutputStream.new_resizable();
            if (pending.file)
                transfer.addFile(packet, pending.file);
            else
                transfer.addStream(packet, stream);
            const writing = transfer.start(pending.cancellable);
            const fileKey = pending.file?.get_uri();
            if (fileKey)
                this.cacheWriters.set(fileKey, writing);
            try {
                await writing;
            } finally {
                if (fileKey && this.cacheWriters.get(fileKey) === writing)
                    this.cacheWriters.delete(fileKey);
            }
            const value = pending.file ? null : stream.steal_as_bytes().get_data();
            if (value && pending.detail.mime && !pending.remote.sensitive)
                this.history.attachValue(pending.remote.id, pending.detail.mime, value);
            this.finish(body.request, null, value);
        } catch (e) {
            if (pending.file) {
                try {
                    pending.file.delete(null);
                } catch {
                    // Partial file may not have been created.
                }
            }
            this.finish(body.request, e);
        }
    }

    finish(request, error, value = null) {
        const pending = this.pending.get(request);
        if (!pending)
            return;
        if (pending.cancelled || pending.cancellable?.is_cancelled())
            error ??= new Error('Clipboard request cancelled');
        if (error)
            pending.transfer?.cancel();
        this.pending.delete(request);
        if (pending.timer)
            GLib.source_remove(pending.timer);
        if (pending.cancelId)
            pending.cancellable.disconnect(pending.cancelId);
        if (error)
            pending.reject(error);
        else
            pending.resolve(value);
    }

    clearRemote() {
        this.remote?.download?.cancellable.cancel();
        if (this.remote)
            this.clipboard.clearOffer(this.remote.id).catch(debug);
        this.remote = null;
        for (const [request, pending] of this.pending) {
            pending.transfer?.cancel();
            this.finish(request, new Error('Clipboard offer expired'));
        }
    }

    reset() {
        this.publishSerial++;
        this.candidate = null;
        for (const transfer of this.serving.values())
            transfer.cancel();
        this.serving.clear();
        this.local = null;
        this.clearRemote();
    }

    destroy() {
        this.closed = true;
        this.history.clear();
        this.reset();
        if (this.changedId)
            this.clipboard.disconnect(this.changedId);
        this.plugin.settings.disconnect(this.settingsId);
    }
}
