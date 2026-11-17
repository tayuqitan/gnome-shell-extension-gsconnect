// SPDX-FileCopyrightText: 2026 GSConnect fork contributors
// SPDX-License-Identifier: GPL-2.0-or-later

// Persistence is deliberately smaller than the in-memory history budget. The
// Storage must enforce the byte bound before reading a file into memory.
export const MAX_PERSISTED_BYTES = 16 * 1024 * 1024;
export const MAX_PERSISTED_VALUE_BYTES = 8 * 1024 * 1024;
const MAX_TIMESTAMP = 8640000000000000;
const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const encoder = new TextEncoder();

/**
 * Check an exact JSON record shape.
 *
 * @param {unknown} value - Candidate parsed record
 * @param {string[]} keys - Required field names
 * @returns {boolean} Whether the record has exactly these fields
 */
function plainObject(value, keys) {
    return value !== null && typeof value === 'object' && !Array.isArray(value) &&
        Object.keys(value).length === keys.length && keys.every(key =>
        Object.prototype.hasOwnProperty.call(value, key));
}

/**
 * Bound metadata and reject control characters.
 *
 * @param {unknown} value - Candidate metadata
 * @param {number} maximum - Maximum string length
 * @returns {boolean} Whether the string is safe metadata
 */
function safeString(value, maximum) {
    return typeof value === 'string' && value.length <= maximum &&
        ![...value].some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127);
}

/**
 * Admit only ordinary byte MIME formats, not file or sensitive markers.
 *
 * @param {unknown} mime - Candidate format
 * @returns {boolean} Whether the format can be persisted
 */
function safeMime(mime) {
    return safeString(mime, 255) &&
        /^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+(?:;.*)?$/.test(mime) &&
        !/(password|secret|sensitive|file|uri|url)/i.test(mime);
}

/**
 * Encode bytes without Node or browser-specific globals.
 *
 * @param {Uint8Array} bytes - Snapshot bytes
 * @returns {string} Canonical base64
 */
function encodeBytes(bytes) {
    // Chunking avoids a single enormous argument list or a quadratic string.
    const parts = [];
    for (let offset = 0; offset < bytes.length; offset += 12288) {
        let part = '';
        const end = Math.min(bytes.length, offset + 12288);
        for (let i = offset; i < end; i += 3) {
            const a = bytes[i], b = bytes[i + 1], c = bytes[i + 2];
            part += BASE64[a >> 2] + BASE64[((a & 3) << 4) | ((b || 0) >> 4)] +
                (i + 1 < end ? BASE64[((b & 15) << 2) | ((c || 0) >> 6)] : '=') +
                (i + 2 < end ? BASE64[c & 63] : '=');
        }
        parts.push(part);
    }
    return parts.join('');
}

/**
 * Decode canonical base64 within the remaining byte allowance.
 *
 * @param {unknown} text - Candidate encoded bytes
 * @param {number} remaining - Unused document content budget
 * @returns {Uint8Array} Decoded snapshot
 */
function decodeBytes(text, remaining) {
    if (typeof text !== 'string' || text.length % 4 ||
        text.length > 4 * Math.ceil(remaining / 3) ||
        !/^[A-Za-z0-9+/]*={0,2}$/.test(text))
        throw new Error('Invalid persistent clipboard bytes');
    let padding = 0;
    if (text.endsWith('='))
        padding = text.endsWith('==') ? 2 : 1;
    const size = text.length / 4 * 3 - padding;
    if (size > remaining)
        throw new Error('Persistent clipboard content exceeds limit');
    const bytes = new Uint8Array(size);
    for (let i = 0, out = 0; i < text.length; i += 4) {
        const a = BASE64.indexOf(text[i]), b = BASE64.indexOf(text[i + 1]);
        const c = text[i + 2] === '=' ? 0 : BASE64.indexOf(text[i + 2]);
        const d = text[i + 3] === '=' ? 0 : BASE64.indexOf(text[i + 3]);
        bytes[out++] = (a << 2) | (b >> 4);
        if (out < size)
            bytes[out++] = ((b & 15) << 4) | (c >> 2);
        if (out < size)
            bytes[out++] = ((c & 3) << 6) | d;
        if ((text[i + 2] === '=' && (b & 15)) ||
            (text[i + 3] === '=' && text[i + 2] !== '=' && (c & 3)))
            throw new Error('Noncanonical persistent clipboard bytes');
    }
    return bytes;
}

/** Bounded live leases, with an explicit opt-in snapshot codec. */
export default class ClipboardHistory {
    constructor({maxItems = 50, maxBytes = 64 * 1024 * 1024,
        onChange = () => {}, onEvict = () => {}} = {}) {
        this.entries = new Map();
        this.listeners = new Set([onChange]);
        this.onEvict = onEvict;
        this.setLimits({maxItems, maxBytes});
    }

    subscribe(callback) {
        this.listeners.add(callback);
        return () => this.listeners.delete(callback);
    }

    _changed() {
        for (const callback of this.listeners)
            callback();
    }

    setLimits({maxItems = this.maxItems, maxBytes = this.maxBytes}) {
        if (!Number.isSafeInteger(maxItems) || maxItems < 0 || maxItems > 1000 ||
            !Number.isSafeInteger(maxBytes) || maxBytes < 0 || maxBytes > 1073741824)
            throw new Error('Invalid clipboard history limits');
        this.maxItems = maxItems;
        this.maxBytes = maxBytes;
        this._trim();
        this._changed();
    }

    get bytes() {
        return [...this.entries.values()].reduce((sum, entry) => sum + entry.bytes, 0);
    }

    _trim() {
        while (this.entries.size > this.maxItems || this.bytes > this.maxBytes) {
            const key = this.entries.keys().next().value;
            const entry = this.entries.get(key);
            this.entries.delete(key);
            this.onEvict(entry);
        }
    }

    _add(direction, offer, snapshots, peerName) {
        const key = `${direction}:${offer.id}`;
        if (this.entries.has(key))
            return this.entries.get(key);
        // Copy containers so subsequent offer updates cannot rewrite history.
        const values = new Map([...snapshots].map(([mime, bytes]) => [mime, bytes.slice()]));
        const saved = {...offer, types: [...offer.types],
            files: offer.files.map(file => ({...file}))};
        const metadata = JSON.stringify({id: saved.id, origin: saved.origin,
            types: saved.types, files: saved.files.map(({name, size}) => ({name, size})),
            peerName});
        const entry = {key, id: offer.id, direction, peerName,
            created: Date.now(), offer: saved, values, uris: null,
            bytes: new TextEncoder().encode(metadata).length +
                [...values.values()].reduce((sum, value) => sum + value.byteLength, 0),
            cachedFileBytes: 0};
        Object.defineProperty(entry, 'availableTypes', {
            get: () => [...entry.values.keys()],
        });
        this.entries.set(key, entry);
        this._trim();
        this._changed();
        return this.entries.get(key) || null;
    }

    addLocal(offer, snapshots = new Map()) {
        return this._add('local', offer, snapshots, '');
    }

    addRemote(offer, peerName = '') {
        return this._add('remote', offer, new Map(), peerName);
    }

    get(key) {
        return this.entries.get(key) || null;
    }

    getLocalLease(id) {
        const entry = this.get(`local:${id}`);
        return entry?.persisted ? null : entry;
    }

    list() {
        return [...this.entries.values()].reverse();
    }

    attachValue(id, mime, bytes, direction = 'remote') {
        const entry = this.get(`${direction}:${id}`);
        if (!entry || !entry.offer.types.includes(mime))
            return false;
        const value = bytes.slice();
        entry.bytes += value.byteLength - (entry.values.get(mime)?.byteLength || 0);
        entry.values.set(mime, value);
        this._trim();
        this._changed();
        return this.entries.has(entry.key);
    }

    attachFiles(id, uris, direction = 'remote') {
        const entry = this.get(`${direction}:${id}`);
        if (!entry || uris.length !== entry.offer.files.length ||
            !uris.every(uri => typeof uri === 'string' && uri.startsWith('file:///')))
            return false;
        // Account downloaded bodies, not advertised source-file sizes. The
        // transfer owner must release cache references in its onEvict handler.
        const size = entry.offer.files.reduce((sum, file) => sum + file.size, 0);
        if (size + entry.bytes - entry.cachedFileBytes > this.maxBytes)
            return false;
        entry.bytes += size - entry.cachedFileBytes;
        entry.cachedFileBytes = size;
        entry.uris = [...uris];
        this._trim();
        this._changed();
        return this.entries.has(entry.key);
    }

    /**
     * Serialize cached ordinary bytes, never paths or live leases.
     *
     * @returns {string} Bounded versioned JSON snapshot
     */
    serializePersistent() {
        const records = [];
        let jsonBytes = encoder.encode('{"version":1,"entries":[]}').length;
        let used = 0;
        // Prefer the newest eligible snapshots when the disk cap is smaller.
        for (const entry of this.list()) {
            if (!['local', 'remote'].includes(entry.direction) ||
                !safeString(entry.id, 128) || !entry.id ||
                !safeString(entry.peerName, 256) ||
                !Number.isSafeInteger(entry.created) || entry.created < 0 ||
                entry.created > MAX_TIMESTAMP ||
                entry.offer.sensitive || entry.offer.files.length || entry.uris ||
                !entry.offer.types.length || entry.offer.types.some(mime => !safeMime(mime)) ||
                !entry.values.size || entry.values.size > 64)
                continue;
            const values = [...entry.values];
            if (values.some(([mime, value]) => !safeMime(mime) ||
                !entry.offer.types.includes(mime) || !(value instanceof Uint8Array)))
                continue;
            const size = values.reduce((sum, [, value]) => sum + value.byteLength, 0);
            if (size > MAX_PERSISTED_VALUE_BYTES - used)
                continue;
            const record = {id: entry.id, direction: entry.direction,
                peerName: entry.peerName, created: entry.created,
                values: values.map(([mime, value]) => ({mime, data: encodeBytes(value)}))};
            // Bound metadata as well as content; a new candidate is never huge.
            const json = JSON.stringify(record);
            const sizeOnDisk = encoder.encode(json).length + (records.length ? 1 : 0);
            if (jsonBytes + sizeOnDisk > MAX_PERSISTED_BYTES)
                continue;
            records.unshift(json);
            jsonBytes += sizeOnDisk;
            used += size;
        }
        return `{"version":1,"entries":[${records.join(',')}]}`;
    }

    /**
     * Validate the whole document before adding any restored snapshots.
     *
     * @param {string} text - Versioned JSON snapshot
     * @returns {number} Number retained after applying the current limits
     */
    restorePersistent(text) {
        if (typeof text !== 'string' || text.length > MAX_PERSISTED_BYTES ||
            encoder.encode(text).length > MAX_PERSISTED_BYTES)
            throw new Error('Persistent clipboard document exceeds limit');
        const document = JSON.parse(text);
        if (!plainObject(document, ['version', 'entries']) || document.version !== 1 ||
            !Array.isArray(document.entries) || document.entries.length > 1000)
            throw new Error('Invalid persistent clipboard document');
        const restored = new Map();
        let used = 0;
        for (const record of document.entries) {
            if (!plainObject(record, ['id', 'direction', 'peerName', 'created', 'values']) ||
                !safeString(record.id, 128) || !record.id ||
                !['local', 'remote'].includes(record.direction) ||
                !safeString(record.peerName, 256) ||
                !Number.isSafeInteger(record.created) || record.created < 0 ||
                record.created > MAX_TIMESTAMP ||
                !Array.isArray(record.values) || !record.values.length || record.values.length > 64)
                throw new Error('Invalid persistent clipboard entry');
            const key = `${record.direction}:${record.id}`;
            if (restored.has(key))
                throw new Error('Duplicate persistent clipboard entry');
            const values = new Map();
            for (const value of record.values) {
                if (!plainObject(value, ['mime', 'data']) || !safeMime(value.mime) || values.has(value.mime))
                    throw new Error('Invalid persistent clipboard format');
                const bytes = decodeBytes(value.data, MAX_PERSISTED_VALUE_BYTES - used);
                used += bytes.byteLength;
                values.set(value.mime, bytes);
            }
            const offer = {id: record.id, origin: 'persistent-local-snapshot',
                types: [...values.keys()], files: []};
            const metadata = JSON.stringify({id: offer.id, origin: offer.origin,
                types: offer.types, files: [], peerName: record.peerName});
            const entry = {key, id: record.id, direction: record.direction,
                peerName: record.peerName, created: record.created, offer, values,
                uris: null, cachedFileBytes: 0, persisted: true,
                bytes: encoder.encode(metadata).length +
                    [...values.values()].reduce((sum, value) => sum + value.byteLength, 0)};
            Object.defineProperty(entry, 'availableTypes', {get: () => [...entry.values.keys()]});
            restored.set(key, entry);
        }
        // Live-session entries stay newer and are never replaced by disk data.
        const current = this.entries;
        this.entries = new Map([...restored].filter(([key]) => !current.has(key)));
        for (const [key, entry] of current)
            this.entries.set(key, entry);
        this._trim();
        this._changed();
        return [...restored.values()].filter(entry => this.entries.get(entry.key) === entry).length;
    }

    remove(key) {
        const entry = this.entries.get(key);
        if (!entry)
            return;
        this.entries.delete(key);
        this.onEvict(entry);
        this._changed();
    }

    clear() {
        if (!this.entries.size)
            return;
        const removed = [...this.entries.values()];
        this.entries.clear();
        // Batch one change event so persistence never rewrites every prefix.
        for (const entry of removed)
            this.onEvict(entry);
        this._changed();
    }
}
