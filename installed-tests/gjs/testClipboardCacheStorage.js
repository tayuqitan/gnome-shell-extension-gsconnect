// SPDX-FileCopyrightText: 2026 GSConnect fork contributors
// SPDX-License-Identifier: GPL-2.0-or-later
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import {ClipboardCacheStorage} from '../../src/service/utils/clipboardCacheStorage.js';

function assert(value, message) {
    if (!value)
        throw Error(message);
}
function fails(callback) {
    let failed = false;
    try { callback(); } catch { failed = true; }
    assert(failed, 'expected rejection');
}
// Tests never use the real cache, clipboard, desktop or user source files.
const root = GLib.build_filenamev([GLib.get_current_dir(), `.cache-test-${GLib.uuid_string_random()}`]);
const storage = new ClipboardCacheStorage(root, 1024 * 1024);
const tx = storage.begin([{name: 'first', size: 3}, {name: 'second', size: 4}]);
GLib.file_set_contents(tx.handle.children[0].file.get_path(), 'abc');
GLib.file_set_contents(tx.handle.children[1].file.get_path(), 'xx');
fails(() => storage.complete(tx));
await storage.rollback(tx);
assert(!tx.handle.directory.query_exists(null), 'rollback removes entire batch');
assert(storage.ledger.used === 0, 'rollback releases quota');
fails(() => storage.begin([{name: '../source', size: 3}]));
fails(() => storage.begin([{name: 'a/b', size: 3}]));
const retry = storage.begin([{name: 'retry', size: 1}]);
const originalRemove = storage._remove;
storage._remove = () => { throw Error('simulated busy filesystem'); };
try { await storage.rollback(retry); } catch {}
assert(storage.snapshot().failedBatches === 1, 'failed batch eligible for retry');
storage._remove = originalRemove;
const retried = await storage.retryFailedRollbacks();
assert(retried.removed === 1 && retried.failed === 0, 'safe retry removes only registered failed batch');
const kept = storage.begin([{name: 'complete', size: 3}]);
GLib.file_set_contents(kept.handle.children[0].file.get_path(), 'abc');
assert(storage.complete(kept).length === 1, 'completed URIs returned');
assert(await storage.rollback(kept) === false, 'exposed files protected');
const restart = new ClipboardCacheStorage(root, 1024 * 1024);
assert(restart.baseline >= 3, 'restart accounts existing bytes');
restart.setLimit(0);
fails(() => restart.begin([{name: 'blocked', size: 0}]));
assert(kept.handle.children[0].file.query_exists(null), 'lowering limit preserves exposed files');
GLib.file_set_contents(kept.handle.children[0].file.get_path(), 'x'.repeat(2 * 1024 * 1024));
fails(() => storage.begin([{name: 'overgrown', size: 1}]));
assert(storage.snapshot().used > 1024 * 1024, 'appended data re-accounted before allocation');
// Cleanup only files/dirs created by this test, not through production eviction.
kept.handle.children[0].file.delete(null);
kept.handle.children[0].folder.delete(null);
kept.handle.directory.delete(null);
Gio.File.new_for_path(root).delete(null);
print('GJS storage: rollback, path validation, exposure, restart and quota passed');
