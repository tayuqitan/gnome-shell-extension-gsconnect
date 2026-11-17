// SPDX-FileCopyrightText: 2026 GSConnect fork contributors
// SPDX-License-Identifier: GPL-2.0-or-later
// Real GIO tokens, memory streams and GLib timers.
// No sockets, services or display.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import System from 'system';
import {linkCancellables, closeTransferStreams} from '../../src/service/utils/transferCancellation.js';

/**
 * Assert a boundary invariant.
 *
 * @param {boolean} condition - Expected truth
 * @param {string} message - Failure description
 */
function assert(condition, message) {
    if (!condition)
        throw new Error(message);
}

/** Run isolated cancellation tests. */
async function run() {
    const already = new Gio.Cancellable();
    already.cancel();
    const early = linkCancellables(already, null, already);
    assert(early.cancellable.is_cancelled(), 'Pre-cancelled parent must cancel child');
    early.dispose();
    early.dispose();
    print('PASS pre-cancelled parent and repeated dispose');

    for (const index of [0, 1]) {
        const parents = [new Gio.Cancellable(), new Gio.Cancellable()];
        const linked = linkCancellables(...parents, parents[0]);
        let notifications = 0;
        const id = linked.cancellable.connect(() => {
            notifications++;
        });
        parents[index].cancel();
        assert(linked.cancellable.is_cancelled(), 'Either parent must cancel child');
        assert(!parents[1 - index].is_cancelled(), 'Cancellation must not reach other parent');
        assert(notifications === 1, 'Child cancellation fires once');
        // Never disconnect a Gio cancellation handler from within its callback.
        linked.cancellable.disconnect(id);
        linked.dispose();
        linked.dispose();
    }
    print('PASS either parent cancellation without reverse propagation');

    const parent = new Gio.Cancellable();
    const detached = linkCancellables(parent);
    detached.dispose();
    detached.dispose();
    parent.cancel();
    assert(!detached.cancellable.is_cancelled(), 'Dispose must disconnect parent handlers');
    const liveParent = new Gio.Cancellable();
    const independent = linkCancellables(liveParent);
    independent.cancellable.cancel();
    assert(!liveParent.is_cancelled(), 'Child cancellation must not cancel parent');
    independent.dispose();
    print('PASS disconnect and child-only cancellation');

    const output = Gio.MemoryOutputStream.new_resizable();
    const input = Gio.MemoryInputStream.new_from_bytes(new GLib.Bytes(new Uint8Array([1, 2, 3])));
    const closed = await closeTransferStreams([output, input, output, null], null);
    assert(closed.length === 2 && closed.every(result => result.status === 'fulfilled'), 'Real memory streams close once');
    assert(output.is_closed() && input.is_closed(), 'Real GIO streams are closed');
    print('PASS real GIO memory stream close');

    // A controlled close adapter holds completion until the REAL cleanup token
    // is cancelled. This tests the production timer, not a real blocked socket.
    const transfer = new Gio.Cancellable();
    transfer.cancel();
    let cleanupToken;
    let cancellationId = 0;
    let invocations = 0;
    let cancellationSeen = false;
    const pending = {
        close_async(_priority, token, callback) {
            invocations++;
            cleanupToken = token;
            assert(token !== transfer && !token.is_cancelled(), 'Cleanup uses a fresh uncancelled token');
            cancellationId = token.connect(() => {
                cancellationSeen = true;
                GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
                    callback(pending, null);
                    return GLib.SOURCE_REMOVE;
                });
            });
        },
        close_finish() {
            throw new Gio.IOErrorEnum({code: Gio.IOErrorEnum.CANCELLED, message: 'Fixture close cancelled'});
        },
    };
    const began = GLib.get_monotonic_time();
    const result = await closeTransferStreams([pending, pending], null);
    const elapsed = (GLib.get_monotonic_time() - began) / 1000000;
    cleanupToken.disconnect(cancellationId);
    assert(invocations === 1, 'Repeated streams must be deduplicated');
    assert(cancellationSeen && cleanupToken.is_cancelled(), 'Real cleanup deadline cancels fresh token');
    // timeout_add_seconds coalesces the first tick; allow rounding.
    assert(elapsed >= 4 && elapsed < 12, 'Five-second cleanup deadline outside tolerated timing');
    assert(result.length === 1 && result[0].status === 'rejected', 'Cancelled close must settle rejected');
    assert(result[0].reason.matches(Gio.io_error_quark(), Gio.IOErrorEnum.CANCELLED), 'Cancellation error preserved');
    assert(transfer.is_cancelled(), 'Original transfer cancellation remains unchanged');
    print('PASS real five-second cleanup timer with controlled pending close adapter');
}

const loop = new GLib.MainLoop(null, false);
let exitCode = 0;
const watchdog = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 15, () => {
    printerr('FAIL cancellation test exceeded 15 seconds');
    System.exit(1);
    return GLib.SOURCE_REMOVE;
});
run().catch(error => {
    printerr(`FAIL transfer cancellation: ${error.message}`);
    exitCode = 1;
}).finally(() => {
    GLib.source_remove(watchdog);
    loop.quit();
});
loop.run();
System.exit(exitCode);
