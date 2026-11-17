// SPDX-FileCopyrightText: 2026 GSConnect fork contributors
// SPDX-License-Identifier: GPL-2.0-or-later
import GLib from 'gi://GLib';

/**
 * Write an owned byte buffer serially, including native partial writes.
 * Keep each GBytes alive until its native asynchronous write finishes.
 *
 * @param {object} target - Destination stream
 * @param {Uint8Array} bytes - Bytes to copy into owned native storage
 * @param {object|null} cancellable - Operation cancellation
 * @returns {Promise<void>} Completion after every byte has been written
 */
export async function writeBytes(target, bytes, cancellable = null) {
    if (!(bytes instanceof Uint8Array))
        throw new Error('Invalid write buffer');
    cancellable?.set_error_if_cancelled();
    const owned = new GLib.Bytes(bytes);
    let offset = 0;
    while (offset < owned.get_size()) {
        cancellable?.set_error_if_cancelled();
        const remaining = owned.get_size() - offset;
        const chunk = owned.new_from_bytes(offset, remaining);
        const written = await new Promise((resolve, reject) => {
            target.write_bytes_async(chunk, GLib.PRIORITY_DEFAULT, cancellable,
                (stream, result) => {
                    try {
                        const count = stream.write_bytes_finish(result);
                        // Reference native storage through completion, not just
                        // submission; do not depend on a borrowed JS view.
                        if (!Number.isSafeInteger(count) || count <= 0 ||
                            count > chunk.get_size())
                            throw new Error('Invalid partial write count');
                        resolve(count);
                    } catch (error) {
                        reject(error);
                    }
                });
        });
        offset += written;
        cancellable?.set_error_if_cancelled();
    }
    cancellable?.set_error_if_cancelled();
}
