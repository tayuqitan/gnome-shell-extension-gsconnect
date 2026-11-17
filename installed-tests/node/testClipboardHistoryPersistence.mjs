// SPDX-FileCopyrightText: 2026 GSConnect fork contributors
// SPDX-License-Identifier: GPL-2.0-or-later
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
const source = await readFile(new URL('../../src/service/utils/clipboardHistoryPersistence.js', import.meta.url), 'utf8');
const {default: Persistence} = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
/**
 *
 */
/**
 * Build a controller fixture without disk I/O.
 * @returns {object} Fixture
 */
function fixture() {
    let listener;
    const operations = [];
    const history = {entries: new Map([['entry', {}]]),
        subscribe(fn) { listener = fn; return () => { listener = null; }; },
        serializePersistent: () => 'snapshot',
        restorePersistent(text) { operations.push(`restore:${text}`); listener?.(); }};
    const storage = {read() { operations.push('read'); return 'previous'; },
        write(text) { operations.push(`write:${text}`); }, clear() { operations.push('clear'); }};
    const persistence = new Persistence(history, storage);
    return {history, storage, persistence, operations, changed: () => listener?.()};
}
test('persistence is opt-in and does not touch storage while off', () => {
    const f = fixture(); f.changed(); f.persistence.close();
    assert.deepEqual(f.operations, []);
});
test('enable restores before saving and avoids restore-triggered writes', () => {
    const f = fixture(); f.persistence.setEnabled(true);
    assert.deepEqual(f.operations, ['read', 'restore:previous', 'write:snapshot']);
});
test('clear and disable remove disk snapshot; later changes cannot recreate it', () => {
    const f = fixture(); f.persistence.setEnabled(true); f.operations.length = 0;
    f.history.entries.clear(); f.changed();
    assert.deepEqual(f.operations, ['clear']);
    f.persistence.setEnabled(false); f.operations.length = 0; f.changed();
    assert.deepEqual(f.operations, []);
});
test('shutdown unsubscribes before memory cleanup without clearing saved history', () => {
    const f = fixture(); f.persistence.setEnabled(true); f.operations.length = 0;
    f.persistence.close(); f.history.entries.clear(); f.changed();
    assert.deepEqual(f.operations, ['write:snapshot']);
});
test('corrupt storage load fails closed and cannot be silently overwritten', () => {
    const f = fixture(); f.storage.read = () => { throw Error('bad data'); };
    assert.throws(() => f.persistence.setEnabled(true)); f.changed();
    assert.equal(f.persistence.enabled, false); assert.deepEqual(f.operations, []);
});
test('save failure reports stale disk risk without throwing into history callbacks', () => {
    const f = fixture(); f.persistence.setEnabled(true);
    f.storage.write = () => { throw Error('disk full'); }; f.changed();
    assert.match(f.persistence.status, /磁盘可能保留旧记录/);
});
