// SPDX-FileCopyrightText: 2026 GSConnect fork contributors
// SPDX-License-Identifier: GPL-2.0-or-later
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
/**
 * Build an isolated test fixture.
 * @returns {object} Test controls and observed state
 */
function setup() {
    const source = readFileSync(new URL('../../src/service/utils/richClipboard.js', import.meta.url), 'utf8')
        .replace(/^import .*;\n/gm, '').replace('export const CAPABILITY', 'const CAPABILITY')
        .replace('export default class RichClipboard', 'this.RichClipboard = class RichClipboard');
    const events = [];
    const transaction = {handle: {children: [0, 1].map(i => ({file: {get_uri: () => `test:${i}`}}))}};
    const storage = {begin: () => { events.push('reserve'); return transaction; },
        complete: () => { events.push('expose'); return ['test:0', 'test:1']; },
        rollback: async () => { events.push('rollback'); }};
    const scope = {getClipboardCacheStorage: () => storage, debug() {}, _: s => s,
        Gio: {Application: {get_default: () => ({settings: {get_value: () => ({deepUnpack: () => 100})}})}},
        GLib: {uuid_string_random: () => 'test'}, Promise};
    vm.runInNewContext(source, scope);
    const rich = Object.create(scope.RichClipboard.prototype);
    rich.cacheWriters = new Map();
    rich.notifyProgress = () => {};
    rich.request = async (_remote, {index}) => events.push(`write:${index}`);
    const remote = {files: [{name: 'a', size: 1}, {name: 'b', size: 1}]};
    return {rich, remote, events};
}
test('transfer reserves batch before writes and exposes only after complete', async () => {
    const {rich, remote, events} = setup();
    await rich.fetchFiles(remote);
    assert.deepEqual(events, ['reserve', 'write:0', 'write:1', 'expose']);
});
test('later file failure rolls back entire unexposed batch', async () => {
    const {rich, remote, events} = setup();
    rich.request = async (_remote, {index}) => { if (index === 1) throw Error('failed'); };
    await assert.rejects(rich.fetchFiles(remote), /failed/);
    assert.deepEqual(events, ['reserve', 'rollback']);
});
test('rollback waits for cancelled writer settlement', async () => {
    const {rich, remote, events} = setup();
    let settle;
    rich.cacheWriters.set('test:0', new Promise(resolve => { settle = resolve; }));
    rich.request = async () => { throw Error('cancelled'); };
    const result = rich.fetchFiles(remote);
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(events, ['reserve']);
    settle();
    await assert.rejects(result, /cancelled/);
    assert.deepEqual(events, ['reserve', 'rollback']);
});
