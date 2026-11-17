// SPDX-FileCopyrightText: 2026 GSConnect fork contributors
// SPDX-License-Identifier: GPL-2.0-or-later
import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
const source = readFileSync(new URL('../../src/service/utils/writeBytes.js', import.meta.url), 'utf8');
class Bytes {
    constructor(bytes) { this.bytes = new Uint8Array(bytes); }
    get_size() { return this.bytes.length; }
    new_from_bytes(offset, count) { return new Bytes(this.bytes.slice(offset, offset + count)); }
}
const scope = {GLib: {Bytes, PRIORITY_DEFAULT: 0}, Uint8Array};
vm.runInNewContext(source.replace(/^import .*;$/gm, '').replace('export ', ''), scope);
const {writeBytes} = scope;
const token = () => ({canceled: false, set_error_if_cancelled() { if (this.canceled) throw Error('canceled'); }});
/**
 * Controlled native callback stream; no filesystem or network.
 * @param {number[]} counts - Native partial-write results
 * @param {function(object): void|null} cancel - Hook before native completion
 * @returns {object} Mock stream and observed bytes
 */
function stream(counts, cancel = null) {
    const output = [], submitted = [];
    let active = false;
    return {output, submitted,
        write_bytes_async(bytes, _priority, cancellable, callback) {
            assert.equal(active, false, 'never overlap writes');
            active = true;
            submitted.push([...bytes.bytes]);
            queueMicrotask(() => {
                const count = counts.length ? counts.shift() : bytes.get_size();
                output.push(...bytes.bytes.slice(0, Math.max(0, count)));
                active = false;
                if (cancel) cancel(cancellable);
                callback(this, count);
            });
        }, write_bytes_finish(result) { return result; }};
}
test('production helper writes partial results serially with exact offsets', async () => {
    const target = stream([1, 2, 1]);
    await writeBytes(target, new Uint8Array([4, 5, 6, 7]), token());
    assert.deepEqual(target.output, [4, 5, 6, 7]);
    assert.deepEqual(target.submitted, [[4, 5, 6, 7], [5, 6, 7], [7]]);
});
for (const count of [0, -1, 1.5, NaN, Infinity, 4]) {
    test(`production helper rejects invalid native count ${count}`, async () => {
        const target = stream([count]);
        await assert.rejects(writeBytes(target, new Uint8Array([1, 2, 3]), token()), /Invalid partial write count/);
        assert.equal(target.submitted.length, 1);
    });
}
test('pre-canceled and empty writes check cancellation without submitting', async () => {
    const target = stream([]), canceled = token(); canceled.canceled = true;
    await assert.rejects(writeBytes(target, new Uint8Array([1]), canceled), /canceled/);
    await assert.rejects(writeBytes(target, new Uint8Array(), canceled), /canceled/);
    await writeBytes(target, new Uint8Array(), token());
    assert.equal(target.submitted.length, 0);
});
for (const count of [1, 3]) {
    test(`cancellation after ${count} bytes prevents further writes or success`, async () => {
        const target = stream([count], cancellable => { cancellable.canceled = true; });
        await assert.rejects(writeBytes(target, new Uint8Array([1, 2, 3]), token()), /canceled/);
        assert.equal(target.submitted.length, 1);
    });
}
test('native finish failure settles before helper rejects', async () => {
    const target = stream([]);
    target.write_bytes_finish = () => { throw Error('native write canceled'); };
    await assert.rejects(writeBytes(target, new Uint8Array([1]), token()), /native write canceled/);
    assert.equal(target.submitted.length, 1);
});
test('owned bytes survive caller mutation while native write is pending', async () => {
    const target = stream([1]);
    const input = new Uint8Array([1, 2, 3]);
    const writing = writeBytes(target, input, token());
    input.fill(9);
    await writing;
    assert.deepEqual(target.output, [1, 2, 3]);
});
