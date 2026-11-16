// SPDX-FileCopyrightText: 2026 GSConnect fork contributors
// SPDX-License-Identifier: GPL-2.0-or-later

/**
 * Shared reservation/refcount ledger. No source paths or clipboard URIs enter
 * this API. Backend remove() accepts only an opaque owned-object handle.
 * One instance must be shared by all peer plugins in a service process.
 */
export default class ClipboardCacheLedger {
    constructor({limit, remove, now = () => Date.now()}) {
        this.objects = new Map();
        this.remove = remove;
        this.now = now;
        this.setLimit(limit);
    }

    setLimit(limit) {
        if (!Number.isSafeInteger(limit) || limit < 0)
            throw new Error('Invalid cache limit');
        // Lowering a limit never deletes pinned objects. New reservations fail
        // until usage falls below the new limit.
        this.limit = limit;
    }

    get used() {
        return [...this.objects.values()].reduce((sum, item) => sum + item.size, 0);
    }

    reserve(size, freeBytes) {
        if (!Number.isSafeInteger(size) || size < 0 ||
            !Number.isSafeInteger(freeBytes) || freeBytes < 0)
            throw new Error('Invalid cache reservation');
        const outstanding = [...this.objects.values()]
            .filter(item => item.state === 'reserved')
            .reduce((sum, item) => sum + item.size, 0);
        if (size > this.limit - this.used || size > freeBytes - outstanding)
            throw new Error('Clipboard cache quota or disk space exhausted');
        // Synchronous: a second caller cannot race through a pre-await check.
        const token = Object.freeze({});
        this.objects.set(token, {size, state: 'reserved', handle: null,
            refs: new Set(), exposed: false, idleSince: this.now()});
        return token;
    }

    bind(token, ownedHandle) {
        const item = this._get(token);
        if (item.state !== 'reserved' || item.handle !== null || !ownedHandle)
            throw new Error('Invalid cache binding');
        item.handle = ownedHandle;
    }

    complete(token, actualBytes) {
        const item = this._get(token);
        if (item.state !== 'reserved' || !item.handle ||
            !Number.isSafeInteger(actualBytes) || actualBytes < 0 || actualBytes > item.size)
            throw new Error('Invalid completed cache size');
        item.size = actualBytes;
        item.state = 'complete';
        item.idleSince = this.now();
    }

    retain(token) {
        const item = this._get(token);
        if (item.state === 'deleting')
            throw new Error('Cache object is being deleted');
        const reference = Object.freeze({});
        item.refs.add(reference);
        let released = false;
        return () => {
            if (released)
                return;
            released = true;
            item.refs.delete(reference);
            if (!item.refs.size)
                item.idleSince = this.now();
        };
    }

    expose(token) {
        const item = this._get(token);
        if (item.state !== 'complete')
            throw new Error('Incomplete cache cannot be exposed');
        // File URIs can outlive our clipboard provider. There is no reliable
        // "file manager finished pasting" acknowledgement. Never auto-delete.
        item.exposed = true;
    }

    async discard(token) {
        const item = this._get(token);
        if (item.refs.size || item.exposed || item.state === 'deleting')
            return false;
        const previous = item.state;
        item.state = 'deleting';
        try {
            if (item.handle)
                await this.remove(item.handle);
            this.objects.delete(token);
            return true;
        } catch (error) {
            // Retain quota after failed deletion; never claim space was freed.
            item.state = previous;
            throw error;
        }
    }

    async collect(idleMilliseconds) {
        if (!Number.isSafeInteger(idleMilliseconds) || idleMilliseconds < 0)
            throw new Error('Invalid cache retention period');
        for (const [token, item] of this.objects) {
            if (item.state === 'complete' && !item.exposed && !item.refs.size &&
                this.now() - item.idleSince >= idleMilliseconds)
                await this.discard(token);
        }
    }

    _get(token) {
        const item = this.objects.get(token);
        if (!item)
            throw new Error('Unknown cache object');
        return item;
    }
}
