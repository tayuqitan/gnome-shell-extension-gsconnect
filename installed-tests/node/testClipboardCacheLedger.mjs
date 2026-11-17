// SPDX-FileCopyrightText: 2026 GSConnect fork contributors
// SPDX-License-Identifier: GPL-2.0-or-later
import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
const source = readFileSync(new URL('../../src/service/utils/clipboardCacheLedger.js', import.meta.url));
const {default: Ledger} = await import(`data:text/javascript;base64,${source.toString('base64')}`);
/**
 * Build an isolated quota ledger.
 * @param {number} limit - Admission allowance in fixture bytes
 * @returns {object} Ledger and observed removed handles
 */
function setup(limit = 100) {
    const removed = [];
    const ledger = new Ledger({limit, remove: async handle => removed.push(handle)});
    return {ledger, removed};
}
test('reservations charge full batch before concurrent work starts', () => {
    const {ledger} = setup();
    ledger.reserve(60, 1000);
    assert.throws(() => ledger.reserve(60, 1000), /quota/);
    assert.equal(ledger.used, 60);
});
test('free disk and invalid sizes fail closed', () => {
    const {ledger} = setup();
    for (const value of [-1, Infinity, NaN, 1.5])
        assert.throws(() => ledger.reserve(value, 1000));
    assert.throws(() => ledger.reserve(80, 79));
    assert.equal(ledger.used, 0);
});
test('rollback cleans exactly owned transaction handle', async () => {
    const {ledger, removed} = setup();
    const token = ledger.reserve(80, 1000);
    const handle = Object.freeze({owned: true});
    ledger.bind(token, handle);
    assert.equal(await ledger.discard(token), true);
    assert.deepEqual(removed, [handle]);
    assert.equal(ledger.used, 0);
    await assert.rejects(ledger.discard('file:///user/source'), /Unknown/);
});
test('refcounts protect all independent readers, release is idempotent', async () => {
    const {ledger} = setup();
    const token = ledger.reserve(80, 1000);
    ledger.bind(token, {});
    ledger.complete(token, 80);
    const a = ledger.retain(token), b = ledger.retain(token);
    a(); a();
    assert.equal(await ledger.discard(token), false);
    b();
    assert.equal(await ledger.discard(token), true);
});
test('exposed URIs remain pinned even after provider and history release', async () => {
    const {ledger, removed} = setup();
    const token = ledger.reserve(80, 1000);
    ledger.bind(token, {});
    ledger.complete(token, 80);
    const release = ledger.retain(token);
    ledger.expose(token);
    release();
    await ledger.collect(0);
    assert.equal(await ledger.discard(token), false);
    assert.equal(ledger.used, 80);
    assert.deepEqual(removed, []);
});
test('lowering quota never deletes active objects', () => {
    const {ledger} = setup();
    ledger.reserve(80, 1000);
    ledger.setLimit(0);
    assert.equal(ledger.used, 80);
    assert.throws(() => ledger.reserve(1, 1000));
});
test('failed cleanup continues charging quota', async () => {
    const ledger = new Ledger({limit: 100, remove: async () => { throw Error('denied'); }});
    const token = ledger.reserve(80, 1000);
    ledger.bind(token, {});
    await assert.rejects(ledger.discard(token), /denied/);
    assert.equal(ledger.used, 80);
});
test('completion rejects overrun and duplicate transition', () => {
    const {ledger} = setup();
    const token = ledger.reserve(80, 1000);
    ledger.bind(token, {});
    assert.throws(() => ledger.complete(token, 81));
    ledger.complete(token, 70);
    assert.equal(ledger.used, 70);
    assert.throws(() => ledger.complete(token, 70));
});
test('concurrent deletion cannot race a new retain or duplicate deletion', async () => {
    let resolve;
    const ledger = new Ledger({limit: 100, remove: () => new Promise(r => { resolve = r; })});
    const token = ledger.reserve(80, 1000);
    ledger.bind(token, {});
    const pending = ledger.discard(token);
    assert.throws(() => ledger.retain(token));
    assert.equal(await ledger.discard(token), false);
    assert.equal(ledger.used, 80);
    resolve();
    await pending;
    assert.equal(ledger.used, 0);
});

test('concurrent reservations cannot overbook reported free disk', () => {
    const {ledger} = setup(1000);
    ledger.reserve(60, 100);
    assert.throws(() => ledger.reserve(60, 100), /disk space/);
});
