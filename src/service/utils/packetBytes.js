// SPDX-FileCopyrightText: 2026 GSConnect fork contributors
// SPDX-License-Identifier: GPL-2.0-or-later
// Owned UTF-8 packet output using one native pending operation.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

/**
 * Send owned UTF-8 storage with one pending native output operation.
 * No packet queue/JS busy flag; GIO owns pending-operation arbitration.
 *
 * @param {object} channel - Channel with output stream and cancellation token
 * @param {object} packet - Object providing the actual serialization method
 * @param {object|null} cancellable - Explicit token or channel default
 * @returns {Promise<number[]>} GJS write_all_async-compatible [byte count]
 */
export function sendPacketBytes(channel, packet, cancellable = null) {
    if (cancellable === null)
        cancellable = channel.cancellable;
    const owned = new GLib.Bytes(new TextEncoder().encode(packet.serialize()));
    const input = Gio.MemoryInputStream.new_from_bytes(owned);
    return new Promise((resolve, reject) => {
        const complete = (output, result) => {
            let failure = null;
            let count;
            try {
                count = output.splice_finish(result);
                if (!Number.isSafeInteger(count) || count !== owned.get_size()) {
                    throw new Gio.IOErrorEnum({
                        code: Gio.IOErrorEnum.PARTIAL_INPUT,
                        message: 'Packet splice byte count mismatch',
                    });
                }
            } catch (error) {
                failure = error;
            }
            // Only the owned memory input is closed, after native completion.
            // The channel output and its parent cancellation token stay owned
            // by their caller. Retain input and GBytes through this callback.
            try {
                input.close(null);
            } catch (error) {
                failure ??= error;
            }
            if (failure)
                reject(failure);
            else
                resolve([count]);
        };
        try {
            channel.output_stream.splice_async(input,
                Gio.OutputStreamSpliceFlags.CLOSE_SOURCE,
                GLib.PRIORITY_DEFAULT, cancellable, complete);
        } catch (error) {
            // Submission did not start; the memory input is safe to close.
            try {
                input.close(null);
            } catch {
                // Preserve the original submission error.
            }
            reject(error);
        }
    });
}
