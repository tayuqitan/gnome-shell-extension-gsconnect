// SPDX-FileCopyrightText: 2026 GSConnect fork contributors
// SPDX-License-Identifier: GPL-2.0-or-later
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import {MAX_PERSISTED_BYTES} from './clipboardHistory.js';

const FLAGS = Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS;
const ATTRS = 'standard::type,standard::size,standard::is-symlink,unix::uid,unix::mode';

/**
 * Read until EOF without assuming that a successful GIO read fills its buffer.
 *
 * @param {object} stream - GIO input stream
 * @param {number} maximum - Maximum document bytes
 * @returns {Uint8Array} Complete bounded contents
 */
export function readBoundedBytes(stream, maximum) {
    const chunks = [];
    let total = 0;
    while (true) {
        const chunk = stream.read_bytes(Math.min(65536, maximum - total + 1), null).get_data();
        if (!chunk.length)
            break;
        total += chunk.length;
        if (total > maximum)
            throw new Error('History file exceeds bound');
        chunks.push(chunk);
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.length;
    }
    return bytes;
}

/** Private, atomic, bounded storage; never accepts clipboard URI paths. */
export default class ClipboardHistoryStorage {
    constructor(path) {
        this.file = Gio.File.new_for_path(path);
        this.uid = new Gio.Credentials().get_unix_user();
    }

    _directory(file, create) {
        const parent = file.get_parent();
        if (parent)
            this._directory(parent, create);
        let info;
        try {
            info = file.query_info(ATTRS, FLAGS, null);
        } catch (error) {
            if (!create || !error.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND))
                throw error;
            file.make_directory(null);
            file.set_attribute_uint32('unix::mode', 0o700, FLAGS, null);
            info = file.query_info(ATTRS, FLAGS, null);
        }
        if (info.get_is_symlink() || info.get_file_type() !== Gio.FileType.DIRECTORY ||
            (info.get_attribute_uint32('unix::mode') & 0o022))
            throw new Error('Unsafe history directory');
        // Only the dedicated immediate parent must be private and user-owned.
        if (file.equal(this.file.get_parent()) &&
            (info.get_attribute_uint32('unix::uid') !== this.uid ||
             (info.get_attribute_uint32('unix::mode') & 0o077)))
            throw new Error('History directory must be private');
    }

    _file() {
        const info = this.file.query_info(ATTRS, FLAGS, null);
        if (info.get_is_symlink() || info.get_file_type() !== Gio.FileType.REGULAR ||
            info.get_attribute_uint32('unix::uid') !== this.uid ||
            (info.get_attribute_uint32('unix::mode') & 0o077) ||
            info.get_size() > MAX_PERSISTED_BYTES)
            throw new Error('Unsafe or oversized history file');
    }

    read() {
        try {
            this._directory(this.file.get_parent(), false);
            this._file();
        } catch (error) {
            if (error.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND))
                return null;
            throw error;
        }
        const stream = this.file.read(null);
        try {
            const bytes = readBoundedBytes(stream, MAX_PERSISTED_BYTES);
            return new TextDecoder('utf-8', {fatal: true}).decode(bytes);
        } finally {
            stream.close(null);
        }
    }

    write(text) {
        const bytes = new TextEncoder().encode(text);
        if (bytes.length > MAX_PERSISTED_BYTES)
            throw new Error('History file exceeds bound');
        this._directory(this.file.get_parent(), true);
        try {
            this._file();
        } catch (error) {
            if (!error.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND))
                throw error;
        }
        this.file.replace_contents(bytes, null, false,
            Gio.FileCreateFlags.PRIVATE | Gio.FileCreateFlags.REPLACE_DESTINATION, null);
    }

    clear() {
        try {
            this._directory(this.file.get_parent(), false);
            this._file();
            this.file.delete(null);
        } catch (error) {
            if (!error.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND))
                throw error;
        }
    }
}

/**
 *
 * @param id
 */
/**
 * Derive private storage using a path-safe digest of the paired device ID.
 *
 * @param {string} id - Paired device identity
 * @returns {ClipboardHistoryStorage} Local store
 */
export function historyStorageForDevice(id) {
    if (typeof id !== 'string' || id.length === 0 || id.length > 1024)
        throw new Error('Invalid history device identity');
    const key = GLib.compute_checksum_for_string(GLib.ChecksumType.SHA256, id, -1);
    return new ClipboardHistoryStorage(GLib.build_filenamev([
        GLib.get_user_data_dir(), 'gsconnect', 'clipboard-history-v1', key, 'history.json',
    ]));
}
