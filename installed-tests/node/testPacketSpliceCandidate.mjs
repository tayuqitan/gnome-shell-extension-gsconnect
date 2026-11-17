// SPDX-FileCopyrightText: 2026 GSConnect fork contributors
// SPDX-License-Identifier: GPL-2.0-or-later
// Test-only candidate, native boundaries mocked; no actual socket or TLS.
import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
const candidate = readFileSync(new URL('../../src/service/utils/packetBytes.js', import.meta.url), 'utf8');
const wrapper = readFileSync(new URL('../fixtures/packetSpliceCandidate.js', import.meta.url), 'utf8');
assert.match(wrapper, /export \{sendPacketBytes as sendPacketCandidate\} from '\.\.\/\.\.\/src\/service\/utils\/packetBytes\.js';/);
/**
 * Model one native splice operation and its partial internal writes.
 * @param {object} options - Controlled native outcomes
 * @returns {object} Candidate and fake resources
 */
function fixture(options = {}) {
    const inputs = [], calls = [], data = [];
    let pending = false, release;
    class Bytes {
        constructor(bytes) { this.bytes = new Uint8Array(bytes); }
        get_size() { return this.bytes.length; }
    }
    const token = {cancelled: false};
    class IOError extends Error {
        static PARTIAL_INPUT = 34;
        constructor({code, message}) { super(message); this.code = code; }
        matches(domain, code) { return domain === IOError && code === this.code; }
    }
    const scope = {TextEncoder, GLib: {Bytes, PRIORITY_DEFAULT: 0},
        Gio: {IOErrorEnum: IOError, OutputStreamSpliceFlags: {CLOSE_SOURCE: 1, CLOSE_TARGET: 2},
            MemoryInputStream: {new_from_bytes(bytes) {
                const input = {bytes, closed: false, close(arg) {
                    assert.equal(arg, null);
                    this.closed = true;
                    if (options.closeError) throw Error('close failed');
                }};
                inputs.push(input); return input;
            }}},
    };
    vm.runInNewContext(candidate.replace(/^import .*;$/gm, '').replace('export ', ''), scope);
    const target = {closed: false,
        splice_async(input, flags, priority, cancel, callback) {
            calls.push({input, flags, priority, cancel});
            assert.equal(flags, 1);
            if (options.submitError) throw Error('submit failed');
            if (pending) { queueMicrotask(() => callback(target, {error: Error('G_IO_ERROR_PENDING')})); return; }
            pending = true;
            const finish = () => {
                let error = options.finishError ? Error('write failed') : null;
                if (cancel?.cancelled) error = Error('G_IO_ERROR_CANCELLED');
                if (!error) {
                    // Simulate native partial writes, all within one operation.
                    for (let i = 0; i < input.bytes.bytes.length; i += 17)
                        data.push(...input.bytes.bytes.slice(i, i + 17));
                }
                pending = false;
                callback(target, {error, count: options.count ?? input.bytes.get_size()});
            };
            if (options.hold) release = finish;
            else queueMicrotask(finish);
        },
        splice_finish(result) { if (result.error) throw result.error; return result.count; },
    };
    const channel = {output_stream: target, cancellable: token};
    return {send: packet => scope.sendPacketBytes(channel, packet),
        explicit: (packet, cancel) => scope.sendPacketBytes(channel, packet, cancel),
        channel, token, target, inputs, calls, data, options, IOError, release: () => release()};
}
const packet = text => ({serialize: () => text});
for (const text of ['', '\n', '{"text":""}\n', '中文🙂é\n', 'x'.repeat(150000)]) {
    test(`owned single splice preserves UTF8 and return count (${text.length} code units)`, async () => {
        const f = fixture();
        const expected = new TextEncoder().encode(text);
        assert.deepEqual(Array.from(await f.send(packet(text))), [expected.length]);
        assert.deepEqual(f.data, [...expected]);
        assert.equal(f.calls.length, 1);
        assert.equal(f.calls[0].cancel, f.token);
        assert.equal(f.inputs[0].closed, true);
        assert.equal(f.target.closed, false);
    });
}
test('second overlapping packet gets native PENDING and cannot interleave', async () => {
    const f = fixture({hold: true});
    const first = f.send(packet('first\n'));
    await assert.rejects(f.send(packet('second\n')), /PENDING/);
    assert.equal(f.inputs[0].closed, false);
    assert.equal(f.inputs[1].closed, true);
    f.release(); await first;
    assert.deepEqual(f.data, [...new TextEncoder().encode('first\n')]);
    f.options.hold = false;
    await f.send(packet('third\n'));
    assert.deepEqual(f.data, [...new TextEncoder().encode('first\nthird\n')]);
});
for (const phase of ['pre', 'pending']) {
    test(`${phase} explicit cancellation closes only source, default token untouched`, async () => {
        const f = fixture({hold: phase === 'pending'});
        const explicit = {cancelled: phase === 'pre'};
        const result = f.explicit(packet('cancel\n'), explicit);
        const rejected = assert.rejects(result, /CANCELLED/);
        explicit.cancelled = true;
        if (phase === 'pending') f.release();
        await rejected;
        assert.equal(f.calls[0].cancel, explicit);
        assert.equal(f.token.cancelled, false);
        assert.equal(f.inputs[0].closed, true);
        assert.equal(f.target.closed, false);
    });
}
for (const kind of ['submitError', 'finishError', 'closeError']) {
    test(`${kind} rejects and subsequent packet is not blocked by candidate`, async () => {
        const f = fixture({[kind]: true});
        await assert.rejects(f.send(packet('test')), /failed/);
        assert.equal(f.inputs[0].closed, true);
        f.options[kind] = false;
        await f.send(packet('retry'));
        assert.equal(f.inputs[1].closed, true);
    });
}
for (const count of [-1, 0, 2, 4, 1.5, Infinity]) {
    test(`invalid completion count ${count} fails exact-length check`, async () => {
        const f = fixture({count});
        await assert.rejects(f.send(packet('abc')), error => {
            assert.match(error.message, /byte count mismatch/);
            assert.equal(error.matches(f.IOError, f.IOError.PARTIAL_INPUT), true);
            return true;
        });
        assert.equal(f.inputs[0].closed, true);
    });
}
test('serialization throws synchronously before native resources or writes', () => {
    const f = fixture();
    assert.throws(() => f.send({serialize() { throw Error('serialization failed'); }}), /serialization failed/);
    assert.equal(f.inputs.length, 0);
    assert.equal(f.calls.length, 0);
});

test('null cancellation defaults to channel token, releasing native pending after cancel', async () => {
    const f = fixture({hold: true});
    const result = f.explicit(packet('first'), null);
    const rejected = assert.rejects(result, /CANCELLED/);
    f.token.cancelled = true;
    f.release();
    await rejected;
    assert.equal(f.calls[0].cancel, f.token);
    assert.equal(f.inputs[0].closed, true);
    f.options.hold = false;
    await f.explicit(packet('next'), {cancelled: false});
    assert.deepEqual(f.data, [...new TextEncoder().encode('next')]);
});
