// SPDX-FileCopyrightText: 2026 GSConnect fork contributors
// SPDX-License-Identifier: GPL-2.0-or-later

/**
 * Copy exactly the declared byte count without ever writing excess input.
 *
 * @param {number} size - The declared payload length
 * @param {function(number): Promise<Uint8Array>} read - Async bounded read
 * @param {function(Uint8Array): Promise<void>} write - Async write-all
 * @param {function(number, number): void} [onProgress] - Bytes and total
 *   final count follows EOF validation, not transfer success
 * @returns {Promise<number>} The copied byte count
 */
export async function copyExact(size, read, write, onProgress = null) {
    if (!Number.isSafeInteger(size) || size < 0)
        throw new Error('Invalid payload size');

    if (onProgress !== null && typeof onProgress !== 'function')
        throw new Error('Invalid progress callback');

    let copied = 0;
    onProgress?.(0, size);
    while (copied < size) {
        const requested = Math.min(64 * 1024, size - copied);
        const bytes = await read(requested);
        if (!(bytes instanceof Uint8Array) || bytes.length > requested)
            throw new Error('Invalid bounded read');
        if (bytes.length === 0)
            throw new Error(`Incomplete: ${copied}/${size}`);
        await write(bytes);
        copied += bytes.length;
        if (copied < size)
            onProgress?.(copied, size);
    }

    // EOF is part of the contract, including zero-byte files. A malicious
    // sender cannot make the receiving stream grow beyond the declared size.
    const extra = await read(1);
    if (!(extra instanceof Uint8Array) || extra.length !== 0)
        throw new Error('Extra clipboard payload data');
    if (size > 0)
        onProgress?.(copied, size);
    return copied;
}
