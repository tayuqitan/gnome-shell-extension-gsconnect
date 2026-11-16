// SPDX-FileCopyrightText: 2026 GSConnect fork contributors
// SPDX-License-Identifier: GPL-2.0-or-later

/** Session-only, bounded leases. File bodies are never read by this store. */
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
        return this.get(`local:${id}`);
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

    remove(key) {
        const entry = this.entries.get(key);
        if (!entry)
            return;
        this.entries.delete(key);
        this.onEvict(entry);
        this._changed();
    }

    clear() {
        for (const key of [...this.entries.keys()])
            this.remove(key);
    }
}
