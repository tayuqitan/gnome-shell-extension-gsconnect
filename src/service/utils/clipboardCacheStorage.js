// SPDX-FileCopyrightText: 2026 GSConnect fork contributors
// SPDX-License-Identifier: GPL-2.0-or-later

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import ClipboardCacheLedger from './clipboardCacheLedger.js';

const FLAGS = Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS;
const ATTRS = 'standard::type,standard::size,standard::is-symlink,unix::uid,unix::mode,id::file';

/** Single-service-process storage. Never deletes completed/exposed batches. */
export class ClipboardCacheStorage {
    constructor(root, limit) {
        this.root = Gio.File.new_for_path(root);
        this.failedRollbacks = new Set();
        this.uid = new Gio.Credentials().get_unix_user();
        this.rootIdentity = this._directory(this.root);
        // Restart recovery is deliberately conservative: every existing byte is
        // pinned, including interrupted batches. No recursive startup deletion.
        this.baseline = this._size(this.root, 0);
        this.ledger = new ClipboardCacheLedger({limit: Math.max(0, limit - this.baseline),
            remove: handle => this._remove(handle)});
        this.setLimit(limit);
    }

    _directory(file, create = true) {
        const ancestor = file.get_parent();
        if (ancestor)
            this._directory(ancestor, create);
        let info;
        try {
            info = file.query_info(ATTRS, FLAGS, null);
        } catch (error) {
            if (!create || !error.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND))
                throw error;
            const parent = file.get_parent();
            if (!parent)
                throw new Error('Invalid cache root');
            this._directory(parent);
            file.make_directory(null);
            file.set_attribute_uint32('unix::mode', 0o700, FLAGS, null);
            info = file.query_info(ATTRS, FLAGS, null);
        }
        // A system-owned ancestor may be traversed but not used as our root.
        if (info.get_is_symlink() || info.get_file_type() !== Gio.FileType.DIRECTORY ||
            (info.get_attribute_uint32('unix::mode') & 0o022))
            throw new Error('Unsafe clipboard cache directory');
        return info.get_attribute_string('id::file');
    }

    _size(file, depth) {
        if (depth > 4)
            throw new Error('Unexpected clipboard cache layout');
        const info = file.query_info(ATTRS, FLAGS, null);
        if (info.get_is_symlink() || info.get_attribute_uint32('unix::uid') !== this.uid)
            throw new Error('Unsafe clipboard cache ownership');
        if (info.get_file_type() === Gio.FileType.REGULAR)
            return Math.max(4096, info.get_size());
        if (info.get_file_type() !== Gio.FileType.DIRECTORY)
            throw new Error('Unexpected clipboard cache file type');
        const enumerator = file.enumerate_children('standard::name', FLAGS, null);
        let total = 4096;
        try {
            let child;
            while ((child = enumerator.next_file(null)))
                total += this._size(file.get_child(child.get_name()), depth + 1);
        } finally {
            enumerator.close(null);
        }
        if (!Number.isSafeInteger(total))
            throw new Error('Cache accounting overflow');
        return total;
    }

    _refresh() {
        const total = this._size(this.root, 0);
        let trackedActual = 0;
        for (const item of this.ledger.objects.values()) {
            if (!item.handle?.identity)
                continue;
            let actual = 0;
            try {
                if (this._directory(item.handle.directory, false) !== item.handle.identity)
                    throw new Error('Cache transaction directory was replaced');
                actual = this._size(item.handle.directory, 0);
            } catch (error) {
                if (!error.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND))
                    throw error;
            }
            trackedActual += actual;
            // Apps may append to exposed files. Never trust the original
            // payload length for subsequent admission decisions.
            if (item.state === 'complete')
                item.size = Math.max(item.size, actual);
        }
        this.baseline = Math.max(0, total - trackedActual);
        this.setLimit(this.limit);
    }

    setLimit(limit) {
        if (!Number.isSafeInteger(limit) || limit < 0)
            throw new Error('Invalid cache disk quota');
        this.limit = limit;
        this.ledger.setLimit(Math.max(0, limit - this.baseline));
    }

    begin(files) {
        this._refresh();
        if (!Array.isArray(files) || !files.length || files.length > 128 ||
            !files.every(file => typeof file.name === 'string' && file.name.length > 0 &&
                file.name !== '.' && file.name !== '..' && file.name.length <= 255 &&
                // Reject control characters and path separators in peer names.
                // eslint-disable-next-line no-control-regex
                !/[\x00-\x1f/\\]/.test(file.name) &&
                Number.isSafeInteger(file.size) && file.size >= 0))
            throw new Error('Invalid clipboard file batch');
        if (this._directory(this.root, false) !== this.rootIdentity)
            throw new Error('Cache root was replaced');
        const total = files.reduce((sum, file) => sum + Math.max(4096, file.size) + 4096, 4096);
        const free = this.root.query_filesystem_info('filesystem::free', null)
            .get_attribute_uint64('filesystem::free');
        const token = this.ledger.reserve(total, free);
        const directory = this.root.get_child(GLib.uuid_string_random());
        const handle = {directory, identity: null, children: []};
        this.ledger.bind(token, handle);
        try {
            directory.make_directory(null);
            directory.set_attribute_uint32('unix::mode', 0o700, FLAGS, null);
            handle.identity = this._directory(directory);
            for (let i = 0; i < files.length; i++) {
                const folder = directory.get_child(String(i));
                folder.make_directory(null);
                folder.set_attribute_uint32('unix::mode', 0o700, FLAGS, null);
                handle.children.push({folder, identity: this._directory(folder),
                    file: folder.get_child(files[i].name), size: files[i].size});
            }
        } catch (error) {
            // Caller must await rollback before considering the quota released.
            error.cacheTransaction = {token, handle};
            throw error;
        }
        return {token, handle};
    }

    complete(transaction) {
        for (const child of transaction.handle.children) {
            const info = child.file.query_info(ATTRS, FLAGS, null);
            if (info.get_is_symlink() || info.get_file_type() !== Gio.FileType.REGULAR ||
                info.get_attribute_uint32('unix::uid') !== this.uid || info.get_size() !== child.size)
                throw new Error('Invalid downloaded clipboard file');
        }
        const total = transaction.handle.children.reduce(
            (sum, item) => sum + Math.max(4096, item.size) + 4096, 4096);
        this.ledger.complete(transaction.token, total);
        // Once returned, apps can retain URIs past clipboard/history lifetime.
        this.ledger.expose(transaction.token);
        return transaction.handle.children.map(child => child.file.get_uri());
    }

    async rollback(transaction) {
        try {
            const removed = await this.ledger.discard(transaction.token);
            this.failedRollbacks.delete(transaction);
            return removed;
        } catch (error) {
            this.failedRollbacks.add(transaction);
            throw error;
        }
    }

    snapshot() {
        this._refresh();
        return {limit: this.limit, used: this.baseline + this.ledger.used,
            retainedFromPreviousRuns: this.baseline,
            failedBatches: this.failedRollbacks.size};
    }

    async retryFailedRollbacks() {
        let removed = 0, failed = 0;
        // Only transactions whose writers have already settled and whose prior
        // rollback failed are eligible. Never scan other files for deletion.
        for (const transaction of [...this.failedRollbacks]) {
            try {
                if (await this.rollback(transaction))
                    removed++;
            } catch {
                failed++;
            }
        }
        return {removed, failed};
    }

    _remove(handle) {
        if (!handle.identity)
            throw new Error('Unverified transaction directory; retained for inspection');
        if (this._directory(handle.directory, false) !== handle.identity)
            throw new Error('Clipboard cache directory was replaced');
        for (const child of handle.children) {
            if (this._directory(child.folder, false) !== child.identity)
                throw new Error('Clipboard cache child was replaced');
            try {
                const info = child.file.query_info(ATTRS, FLAGS, null);
                if (info.get_is_symlink() || info.get_file_type() !== Gio.FileType.REGULAR ||
                    info.get_attribute_uint32('unix::uid') !== this.uid)
                    throw new Error('Unexpected transaction file');
                child.file.delete(null);
            } catch (error) {
                if (!error.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND))
                    throw error;
            }
            child.folder.delete(null);
        }
        handle.directory.delete(null);
    }
}

let sharedStorage;
/**
 * All paired devices share one disk allowance.
 *
 * @param {number} limit - Global cache admission allowance in bytes
 * @returns {ClipboardCacheStorage} Shared per-process cache storage
 */
export function getClipboardCacheStorage(limit) {
    if (!sharedStorage) {
        sharedStorage = new ClipboardCacheStorage(GLib.build_filenamev([
            GLib.get_user_cache_dir(), 'gsconnect', 'clipboard-cache-v2',
        ]), limit);
    } else {
        sharedStorage.setLimit(limit);
    }
    return sharedStorage;
}

/**
 * Apply UI changes without creating directories or touching existing data.
 *
 * @param {number} limit - Updated global allowance in bytes
 */
export function setClipboardCacheLimit(limit) {
    sharedStorage?.setLimit(limit);
}
