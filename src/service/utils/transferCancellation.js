// SPDX-FileCopyrightText: 2026 GSConnect fork contributors
// SPDX-License-Identifier: GPL-2.0-or-later
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

/**
 * Join cancellation lifetimes without canceling either parent.
 * Dispose only after operations settle, never inside a canceled callback.
 *
 * @param {...Gio.Cancellable} parents - Optional operation/owner tokens
 * @returns {object} Child token and signal cleanup
 */
export function linkCancellables(...parents) {
    const cancellable = new Gio.Cancellable();
    const handlers = [];
    for (const parent of new Set(parents.filter(Boolean))) {
        if (parent.is_cancelled()) {
            cancellable.cancel();
            continue;
        }
        const id = parent.connect(() => cancellable.cancel());
        if (id)
            handlers.push([parent, id]);
    }
    return {cancellable, dispose() {
        for (const [parent, id] of handlers.splice(0))
            parent.disconnect(id);
    }};
}

/**
 * Close the raw socket without waiting for TLS close-notify from a peer.
 *
 * @param {object|null} connection - Owned raw socket connection
 */
export function closeTransferSocket(connection) {
    try {
        connection?.socket?.close();
    } catch {
        // Already closed is harmless; stream cleanup still follows.
    }
}

/**
 * Settle owned stream closes with a fresh, bounded cleanup token. Never reuse
 * the canceled transfer token and never race away from a live writer.
 *
 * @param {object[]} streams - Owned GIO streams
 * @param {object|null} rawConnection - Socket to force closed on deadline
 * @returns {Promise<object[]>} All settled close results
 */
export async function closeTransferStreams(streams, rawConnection) {
    const cleanup = new Gio.Cancellable();
    let timer = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 5, () => {
        timer = 0;
        closeTransferSocket(rawConnection);
        cleanup.cancel();
        return GLib.SOURCE_REMOVE;
    });
    try {
        return await Promise.allSettled([...new Set(streams.filter(Boolean))].map(stream =>
            new Promise((resolve, reject) => {
                stream.close_async(GLib.PRIORITY_DEFAULT, cleanup, (source, result) => {
                    try {
                        source.close_finish(result);
                        resolve();
                    } catch (error) {
                        reject(error);
                    }
                });
            })));
    } finally {
        if (timer)
            GLib.source_remove(timer);
        closeTransferSocket(rawConnection);
    }
}
