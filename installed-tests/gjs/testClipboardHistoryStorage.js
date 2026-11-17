// SPDX-FileCopyrightText: 2026 GSConnect fork contributors
// SPDX-License-Identifier: GPL-2.0-or-later
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import History from '../../src/service/utils/clipboardHistory.js';
import Storage from '../../src/service/utils/clipboardHistoryStorage.js';
import Persistence from '../../src/service/utils/clipboardHistoryPersistence.js';
/**
 *
 * @param value
 * @param message
 */
/**
 * Assert an isolated storage property.
 *
 * @param {boolean} value - Predicate
 * @param {string} message - Failure description
 */
function assert(value, message) {
    if (!value)
        throw Error(message);
}
const directory = Gio.File.new_for_path(GLib.build_filenamev([
    GLib.get_current_dir(), `.history-test-${GLib.uuid_string_random()}`,
]));
const file = directory.get_child('history.json');
const storage = new Storage(file.get_path());
assert(storage.read() === null, 'missing store is empty');
assert(!directory.query_exists(null), 'read does not create directories');
const history = new History();
const persistence = new Persistence(history, storage);
history.addLocal({id: 'test', origin: 'source', revision: 1,
    types: ['text/plain'], files: []}, new Map([['text/plain', new TextEncoder().encode('fixture only')]]));
assert(!directory.query_exists(null), 'default off never writes content');
persistence.setEnabled(true);
assert(file.query_exists(null), 'enabled writes snapshot');
const info = file.query_info('unix::mode', Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, null);
assert((info.get_attribute_uint32('unix::mode') & 0o077) === 0, 'snapshot private');
persistence.close();
history.clear();
const restored = new History();
const restarted = new Persistence(restored, storage, true);
assert(restored.list().length === 1, 'restart restores bytes');
assert(restored.list()[0].persisted, 'restore has no live lease');
assert(restored.getLocalLease('test') === null, 'old lease cannot be served');
restored.clear();
assert(!file.query_exists(null), 'clear removes snapshot synchronously');
restarted.close();
// Symlink refusal must not touch its target.
const target = directory.get_child('target');
GLib.file_set_contents(target.get_path(), 'not history');
file.make_symbolic_link(target.get_path(), null);
let rejected = false;
try {
    storage.write('{}');
} catch {
    rejected = true;
}
assert(rejected, 'symlink rejected');
for (const operation of [() => storage.read(), () => storage.clear()]) {
    let refused = false;
    try {
        operation();
    } catch {
        refused = true;
    }
    assert(refused, 'symlink read/delete rejected');
}
assert(new TextDecoder().decode(GLib.file_get_contents(target.get_path())[1]) === 'not history', 'target unchanged');
file.delete(null);
target.delete(null);
directory.delete(null);
print('GJS history storage: opt-in, atomic snapshot, permissions, restart, clear and symlink refusal passed');
