// SPDX-FileCopyrightText: 2026 GSConnect fork contributors
// SPDX-License-Identifier: GPL-2.0-or-later
import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
const source = readFileSync(new URL('../../src/service/utils/clipboardHistoryStorage.js', import.meta.url), 'utf8');
const start = source.indexOf('export function readBoundedBytes');
const end = source.indexOf('/** Private, atomic');
const scope = {Uint8Array};
vm.runInNewContext(source.slice(start, end).replace('export function', 'function'), scope);

/**
 * Create short reads, including empty EOF.
 * @param {number[][]} chunks - Ordered chunks
 * @returns {object} Input stream fixture
 */
function stream(chunks) {
    let index = 0;
    return {read_bytes: () => ({get_data: () => new Uint8Array(chunks[index++] || [])})};
}

test('bounded read handles short successful reads until EOF', () => {
    assert.deepEqual([...scope.readBoundedBytes(stream([[1], [2], [3]]), 3)], [1, 2, 3]);
    assert.deepEqual([...scope.readBoundedBytes(stream([]), 3)], []);
});
test('bounded read rejects overflow after several short chunks', () => {
    assert.throws(() => scope.readBoundedBytes(stream([[1], [2], [3], [4]]), 3), /exceeds bound/);
});
