// SPDX-License-Identifier: GPL-2.0-or-later
// Extracted packaged Core.sendPacket plus packaged helper; memory/file only.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import System from 'system';

const packageRoot = ARGV[0];
if (ARGV.length !== 1 || !GLib.path_is_absolute(packageRoot))
    throw Error('Usage: absolute verified package directory');
const checkout = Gio.File.new_for_uri(import.meta.url).get_parent().get_parent().get_parent();
for (const path of ['service/core.js', 'service/utils/packetBytes.js']) {
    const source = checkout.get_child(`src/${path}`).load_contents(null)[1];
    const packaged = Gio.File.new_for_path(`${packageRoot}/${path}`).load_contents(null)[1];
    if (GLib.compute_checksum_for_data(GLib.ChecksumType.SHA256, source) !==
        GLib.compute_checksum_for_data(GLib.ChecksumType.SHA256, packaged))
        throw Error(`Packaged source mismatch: ${path}`);
}
const packageUri = Gio.File.new_for_path(packageRoot).get_uri();
const {sendPacketBytes} = await import(`${packageUri}/service/utils/packetBytes.js`);
const coreFile = Gio.File.new_for_path(`${packageRoot}/service/core.js`);
const core = new TextDecoder().decode(coreFile.load_contents(null)[1]);
const header = '    sendPacket(packet, cancellable = null) {';
if (core.split(header).length !== 2)
    throw Error('Unique packaged Core.sendPacket required');
const begin = core.indexOf(header);
const end = core.indexOf('\n    /**', begin);
if (end < begin)
    throw Error('Packaged method boundary missing');
const Channel = new Function('sendPacketBytes',
    `return class {${core.slice(begin, end)}}`)(sendPacketBytes);
/**
 * Execute unchanged packaged Core method with an isolated channel facade.
 *
 * @param {object} channel - Owned output and token
 * @param {object} packet - Serialized fixture
 * @param {object|null} token - Caller token
 * @returns {Promise<number[]>} Native write completion
 */
function sendPacketCandidate(channel, packet, token = null) {
    return Channel.prototype.sendPacket.call(channel, packet, token);
}


/**
 * Assert a test invariant.
 *
 * @param {boolean} value - Condition
 * @param {string} message - Failure
 */
function assert(value, message) {
    if (!value)
        throw Error(message);
}
const streams = new Set();
const files = new Set();
let directory = null;

/** Remove only files and directory created by this fixture. */
function removeFiles() {
    for (const file of files) {
        try {
            file.delete(null);
        } catch {
            printerr('FAIL private fixture file cleanup');
            exitCode = 1;
        }
    }
    if (directory) {
        try {
            directory.delete(null);
        } catch {
            printerr('FAIL private fixture directory cleanup');
            exitCode = 1;
        }
    }
}

/**
 * Real GIO splice with observation, not a mocked transfer.
 *
 * @param {string} kind - Memory or private file
 * @param {string} label - Payload/cancellation label
 * @param {string} text - Self-owned serialized fixture string
 * @param {string|null} cancellation - Pre-cancel owner or explicit token
 * @returns {Promise<void>} Completion
 */
async function check(kind, label, text, cancellation = null) {
    const expected = new TextEncoder().encode(text);
    assert(expected.length <= 2 * 1024 * 1024, 'Fixture bound exceeded');
    const file = kind === 'file' ? directory.get_child(`${label}.bin`) : null;
    if (file)
        files.add(file);
    const output = file ? file.replace(null, false, Gio.FileCreateFlags.PRIVATE, null)
        : Gio.MemoryOutputStream.new_resizable();
    streams.add(output);
    let source = null;
    let calls = 0;
    let flags = null;
    let serialized = 0;
    const owner = new Gio.Cancellable();
    const operation = new Gio.Cancellable();
    if (cancellation === 'owner')
        owner.cancel();
    if (cancellation === 'explicit')
        operation.cancel();
    const channel = {cancellable: owner, output_stream: {
        splice_async(input, options, priority, token, callback) {
            calls++;
            source = input;
            flags = options;
            output.splice_async(input, options, priority, token, callback);
        },
        splice_finish(result) {
            return output.splice_finish(result);
        },
    }};
    try {
        let result = null;
        let failure = null;
        try {
            result = await sendPacketCandidate(channel, {serialize() {
                serialized++;
                return text;
            }}, cancellation === 'explicit' ? operation : null);
        } catch (error) {
            failure = error;
        }
        assert(!output.is_closed(), 'Candidate must not close output');
        if (cancellation) {
            assert(failure?.matches(Gio.io_error_quark(), Gio.IOErrorEnum.CANCELLED),
                'Expected real cancellation failure');
            assert(calls <= 1, 'At most one native splice on cancellation');
        } else {
            if (failure)
                throw failure;
            assert(serialized === 1 && calls === 1, 'Exactly one serialize and native splice');
            assert(Array.isArray(result) && result.length === 1 && result[0] === expected.length,
                'Expected promisified-compatible [byteCount] result');
        }
        if (source) {
            assert(flags === Gio.OutputStreamSpliceFlags.CLOSE_SOURCE, 'Only source close flag allowed');
            assert(source.is_closed(), 'Owned memory source must close after settle');
        }
        // The test, not the candidate, closes the destination for readback.
        output.close(null);
        const actual = file ? file.load_contents(null)[1] : output.steal_as_bytes().get_data();
        const wanted = cancellation ? new Uint8Array() : new TextEncoder().encode(text);
        assert(actual.length === wanted.length, 'Readback length mismatch');
        for (let i = 0; i < wanted.length; i++)
            assert(actual[i] === wanted[i], `Readback mismatch at ${i}`);
        if (file) {
            const info = file.query_info('unix::mode', Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, null);
            assert((info.get_attribute_uint32('unix::mode') & 0o077) === 0, 'Private file mode required');
        }
        print(`PASS packaged Core splice/${kind}/${label}: native I/O and exact readback`);
    } finally {
        output.close(null);
        streams.delete(output);
        if (file) {
            file.delete(null);
            files.delete(file);
        }
    }
}

/**
 * Probe native pending-operation arbitration without any JS busy flag.
 *
 * @param {string} kind - Memory or private file
 * @returns {Promise<void>} Completion
 */
async function concurrent(kind) {
    const file = kind === 'file' ? directory.get_child('concurrent.bin') : null;
    if (file)
        files.add(file);
    const output = file ? file.replace(null, false, Gio.FileCreateFlags.PRIVATE, null)
        : Gio.MemoryOutputStream.new_resizable();
    streams.add(output);
    const inputs = [];
    const channel = {cancellable: new Gio.Cancellable(), output_stream: {
        splice_async(input, flags, priority, token, callback) {
            inputs.push(input);
            output.splice_async(input, flags, priority, token, callback);
        },
    }};
    const text = 'first-packet\n'.repeat(131072);
    try {
        const first = sendPacketCandidate(channel, {serialize: () => text});
        const second = sendPacketCandidate(channel, {serialize: () => 'second-packet\n'});
        // Observe both immediately and wait for BOTH native callbacks.
        const [a, b] = await Promise.allSettled([first, second]);
        assert(a.status === 'fulfilled', 'First native splice must remain successful');
        assert(b.status === 'rejected' &&
            b.reason.matches(Gio.io_error_quark(), Gio.IOErrorEnum.PENDING),
        'Second native splice must reject PENDING, not silently interleave');
        const wanted = new TextEncoder().encode(text);
        assert(a.value.length === 1 && a.value[0] === wanted.length, 'First result shape/count');
        assert(inputs.length === 2 && inputs.every(input => input.is_closed()),
            'Both independent input streams must be closed after completion');
        assert(!output.is_closed(), 'Concurrent rejection must not close destination');
        assert(!channel.cancellable.is_cancelled(), 'Candidate must not cancel caller token');
        output.close(null);
        const actual = file ? file.load_contents(null)[1] : output.steal_as_bytes().get_data();
        assert(actual.length === wanted.length, 'Concurrent output length must equal first packet only');
        for (let i = 0; i < wanted.length; i++)
            assert(actual[i] === wanted[i], `Concurrent output mismatch at ${i}`);
        print(`PASS packaged Core splice/${kind}/concurrent: native PENDING and first packet intact`);
    } finally {
        output.close(null);
        streams.delete(output);
        if (file) {
            file.delete(null);
            files.delete(file);
        }
    }
}

/**
 * Validate sequential reuse and recovery after a genuinely closed destination.
 *
 * @param {string} kind - Memory or private file
 * @returns {Promise<void>} Completion
 */
async function reuse(kind) {
    const file = kind === 'file' ? directory.get_child('reuse.bin') : null;
    if (file)
        files.add(file);
    const create = () => file ? file.replace(null, false, Gio.FileCreateFlags.PRIVATE, null)
        : Gio.MemoryOutputStream.new_resizable();
    let output = create();
    streams.add(output);
    let rejectedSource = null;
    const channel = {cancellable: new Gio.Cancellable(), output_stream: {
        splice_async(input, flags, priority, token, callback) {
            rejectedSource = input;
            output.splice_async(input, flags, priority, token, callback);
        },
    }};
    try {
        output.close(null);
        let failure = null;
        try {
            await sendPacketCandidate(channel, {serialize: () => 'closed-test\n'});
        } catch (error) {
            failure = error;
        }
        assert(failure?.matches(Gio.io_error_quark(), Gio.IOErrorEnum.CLOSED),
            'Closed output must return native CLOSED');
        assert(rejectedSource?.is_closed(), 'Rejected splice source must be reclaimed');
        streams.delete(output);
        output = create();
        streams.add(output);
        channel.output_stream = output;
        const first = 'first ASCII packet\n';
        const second = '第二包🙂é\n';
        for (const text of [first, second]) {
            const result = await sendPacketCandidate(channel, {serialize: () => text});
            assert(result.length === 1 && result[0] === new TextEncoder().encode(text).length,
                'Sequential packet count mismatch');
            assert(!output.is_closed(), 'Destination must remain open between packets');
        }
        output.close(null);
        const actual = file ? file.load_contents(null)[1] : output.steal_as_bytes().get_data();
        const wanted = new TextEncoder().encode(first + second);
        assert(actual.length === wanted.length, 'Sequential concatenation length mismatch');
        for (let i = 0; i < wanted.length; i++)
            assert(actual[i] === wanted[i], `Sequential order mismatch at ${i}`);
        print(`PASS packaged Core splice/${kind}/closed-recovery: native CLOSED and reclaimed source`);
        print(`PASS packaged Core splice/${kind}/sequential: ASCII then Unicode exact concatenation`);
    } finally {
        output.close(null);
        streams.delete(output);
        if (file) {
            file.delete(null);
            files.delete(file);
        }
    }
}

/** Exercise packaged serialization and sendPacket together. */
async function productionSerialize() {
    const file = coreFile;
    const source = new TextDecoder().decode(file.load_contents(null)[1]);
    const signature = '    serialize() {';
    assert(source.split(signature).length === 2, 'Unique production serialize method required');
    const start = source.indexOf(signature);
    const end = source.indexOf('\n    /**', start);
    assert(end > start, 'Serialize boundary required');
    const Packet = new Function(`return class {${source.slice(start, end)}}`)();
    const packet = new Packet();
    packet.id = 0;
    packet.type = 'test.fixture';
    packet.body = {text: '真实序列化🙂\n'};
    const output = Gio.MemoryOutputStream.new_resizable();
    streams.add(output);
    try {
        const result = await sendPacketCandidate({output_stream: output,
            cancellable: new Gio.Cancellable()}, packet);
        assert(Number.isSafeInteger(packet.id) && packet.id > 0, 'Production timestamp assigned');
        const expected = new TextEncoder().encode(`${JSON.stringify(packet)}\n`);
        assert(result.length === 1 && result[0] === expected.length, 'Serialized byte count');
        assert(!output.is_closed(), 'Serialization test output remains open');
        output.close(null);
        const actual = output.steal_as_bytes().get_data();
        assert(actual.length === expected.length, 'Production serialized length');
        for (let i = 0; i < expected.length; i++)
            assert(actual[i] === expected[i], `Production serialized mismatch at ${i}`);
        print('PASS packaged Core splice/production-serialize: Unicode JSON timestamp and newline');
    } finally {
        output.close(null);
        streams.delete(output);
    }
}

/** Run bounded memory/file fixtures only. */
async function run() {
    directory = Gio.File.new_for_path(GLib.dir_make_tmp('gsconnect-splice-candidate-XXXXXX'));
    const info = directory.query_info('unix::mode', Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, null);
    assert((info.get_attribute_uint32('unix::mode') & 0o777) === 0o700, 'Private directory required');
    // Formula-derived nonuniform ASCII avoids a zero-filled false match.
    const pattern = Array.from({length: 4096}, (_, i) => String.fromCharCode(33 + i % 90)).join('');
    for (const kind of ['memory', 'file']) {
        for (const [label, text] of [['empty', ''], ['ascii', 'fixture\n'],
            ['unicode', '中文🙂é\n'.repeat(1024)], ['large', pattern.repeat(512)]])
            await check(kind, label, text);
        await check(kind, 'cancel-owner', pattern, 'owner');
        await check(kind, 'cancel-explicit', pattern, 'explicit');
        await concurrent(kind);
        await reuse(kind);
    }
    await productionSerialize();
}
let exitCode = 0;
const watchdog = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 12, () => {
    printerr('FAIL splice candidate watchdog');
    // Never synchronously close streams with a live async operation.
    removeFiles();
    System.exit(1);
    return GLib.SOURCE_REMOVE;
});
try {
    await run();
} catch (error) {
    printerr(`FAIL splice candidate: ${error.message}`);
    exitCode = 1;
} finally {
    for (const output of streams)
        output.close(null);
    removeFiles();
    GLib.source_remove(watchdog);
}
System.exit(exitCode);
