// SPDX-FileCopyrightText: 2026 GSConnect fork contributors
// SPDX-License-Identifier: GPL-2.0-or-later
// Isolated GJS write_all diagnostics: no service, network or user files.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import System from 'system';
import {copyExact} from '../../src/service/utils/exactTransfer.js';
import {writeBytes} from '../../src/service/utils/writeBytes.js';

const retained = new Set();
const openStreams = new Set();
const files = new Set();
let directory = null;
const failures = [];

/**
 * Assert a property without printing buffer contents.
 *
 * @param {boolean} value - Condition
 * @param {string} message - Failure
 */
function assert(value, message) {
    if (!value)
        throw new Error(message);
}

/** Clean up only resources created by this process. */
function cleanup() {
    for (const stream of openStreams) {
        try {
            stream.close(null);
        } catch {
            // Continue reclaiming the remaining test resources.
        }
    }
    openStreams.clear();
    for (const file of files) {
        try {
            file.delete(null);
        } catch {
            // Main failure report is preserved.
        }
    }
    files.clear();
    if (directory) {
        try {
            directory.delete(null);
        } catch {
            printerr('WARNING unable to remove private test directory');
        }
        directory = null;
    }
}

/**
 * Separate synchronous invocation errors from callback finish errors.
 *
 * @param {object} stream - GIO output
 * @param {Uint8Array} bytes - Strongly retained input
 * @param {Gio.Cancellable} token - Fresh test token
 * @returns {Promise<void>} Completion
 */
function callbackWrite(stream, bytes, token) {
    return new Promise((resolve, reject) => {
        try {
            stream.write_all_async(bytes, GLib.PRIORITY_DEFAULT, token, (source, result) => {
                try {
                    source.write_all_finish(result);
                    resolve();
                } catch (error) {
                    reject(new Error(`callback finish: ${error.message}`));
                }
            });
        } catch (error) {
            reject(new Error(`callback invocation: ${error.message}`));
        }
    });
}

/**
 * Execute one real write and validate every output byte.
 *
 * @param {string} mode - Callback before/after wrapper or production Promise
 * @param {string} kind - Memory or private file output
 * @param {number} size - Bounded byte length
 * @returns {Promise<void>} Completion
 */
async function check(mode, kind, size) {
    const label = `${mode}/${kind}/${size}`;
    const bytes = new Uint8Array(size);
    for (let i = 0; i < size; i++)
        bytes[i] = (i * 31 + Math.floor(i / 251)) & 255;
    // Explicit strong root survives callback delivery, readback and comparison.
    retained.add(bytes);
    const file = kind === 'file' ? directory.get_child(`${mode}-${size}.bin`) : null;
    let stream = null;
    let input = null;
    const chunks = [];
    try {
        if (file)
            files.add(file);
        stream = file
            ? file.replace(null, false, Gio.FileCreateFlags.PRIVATE, null)
            : Gio.MemoryOutputStream.new_resizable();
        openStreams.add(stream);
        const token = new Gio.Cancellable();
        if (mode === 'production-chunks' || mode === 'owned-chunks') {
            input = Gio.MemoryInputStream.new_from_bytes(new GLib.Bytes(bytes));
            openStreams.add(input);
            const read = count => new Promise((resolve, reject) => {
                input.read_bytes_async(count, GLib.PRIORITY_DEFAULT, token, (source, result) => {
                    try {
                        const chunk = source.read_bytes_finish(result).get_data();
                        chunks.push(chunk);
                        retained.add(chunk);
                        resolve(chunk);
                    } catch (error) {
                        reject(error);
                    }
                });
            });
            await copyExact(size, read, chunk => mode === 'owned-chunks'
                ? writeBytes(stream, chunk, token)
                : stream.write_all_async(chunk, GLib.PRIORITY_DEFAULT, token));
        } else if (mode === 'owned-direct') {
            await writeBytes(stream, bytes, token);
        } else if (mode === 'promise') {
            let promise;
            try {
                promise = stream.write_all_async(bytes, GLib.PRIORITY_DEFAULT, token);
            } catch (error) {
                throw new Error(`promisified invocation: ${error.message}`);
            }
            try {
                await promise;
            } catch (error) {
                throw new Error(`promisified rejection (wrapper finish): ${error.message}`);
            }
        } else {
            await callbackWrite(stream, bytes, token);
        }
        stream.close(null);
        const actual = file ? file.load_contents(null)[1] : stream.steal_as_bytes().get_data();
        assert(actual.length === bytes.length, 'Output byte length mismatch');
        for (let i = 0; i < bytes.length; i++) {
            const expected = (i * 31 + Math.floor(i / 251)) & 255;
            assert(bytes[i] === expected, `Original input differs at byte ${i}`);
        }
        let offset = 0;
        for (const chunk of chunks) {
            for (const byte of chunk) {
                const expected = (offset * 31 + Math.floor(offset / 251)) & 255;
                assert(byte === expected, `Retained chunk differs at byte ${offset}`);
                offset++;
            }
        }
        if (chunks.length)
            assert(offset === size, 'Retained chunks must cover the full input');
        for (let i = 0; i < bytes.length; i++) {
            const expected = (i * 31 + Math.floor(i / 251)) & 255;
            assert(actual[i] === expected, `Output differs at byte ${i}`);
        }
        print(`PASS ${label}: every byte matched`);
    } catch (error) {
        failures.push(`${label}: ${error.message}`);
        printerr(`FAIL ${label}: ${error.message}`);
    } finally {
        if (input) {
            input.close(null);
            openStreams.delete(input);
        }
        for (const chunk of chunks)
            retained.delete(chunk);
        if (stream) {
            stream.close(null);
            openStreams.delete(stream);
        }
        if (file) {
            file.delete(null);
            files.delete(file);
        }
        retained.delete(bytes);
    }
}

/**
 * Pre-cancel the real production helper and verify no bytes were written.
 *
 * @param {string} kind - Memory or private file output
 * @returns {Promise<void>} Completion
 */
async function checkCancelled(kind) {
    const file = kind === 'file' ? directory.get_child('cancelled.bin') : null;
    if (file)
        files.add(file);
    const stream = file ? file.replace(null, false, Gio.FileCreateFlags.PRIVATE, null)
        : Gio.MemoryOutputStream.new_resizable();
    openStreams.add(stream);
    try {
        const token = new Gio.Cancellable();
        token.cancel();
        let failure = null;
        try {
            await writeBytes(stream, new Uint8Array(65536), token);
        } catch (error) {
            failure = error;
        }
        assert(failure?.matches(Gio.io_error_quark(), Gio.IOErrorEnum.CANCELLED),
            'Pre-cancelled helper must return G_IO_ERROR_CANCELLED');
        stream.close(null);
        const actual = file ? file.load_contents(null)[1] : stream.steal_as_bytes().get_data();
        assert(actual.length === 0, 'Pre-cancelled write must leave empty output');
        print(`PASS owned-cancelled/${kind}: no output bytes`);
    } finally {
        stream.close(null);
        openStreams.delete(stream);
        if (file) {
            file.delete(null);
            files.delete(file);
        }
    }
}

/** Run safe production tests, or explicitly probe the older unsafe API path. */
async function run() {
    assert(ARGV.length === 0 || (ARGV.length === 1 && ARGV[0] === '--legacy-probe'),
        'Usage: gjs -m testWriteAllBoundaries.js [--legacy-probe]');
    directory = Gio.File.new_for_path(GLib.dir_make_tmp('gsconnect-write-boundary-XXXXXX'));
    const info = directory.query_info('unix::mode', Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, null);
    assert((info.get_attribute_uint32('unix::mode') & 0o777) === 0o700, 'Test directory must be 0700');
    if (ARGV.length) {
        print('DIAGNOSTIC legacy write_all probe: corruption remains a failure, not an expected pass');
        for (const kind of ['memory', 'file']) {
            for (const size of [65536, 2097152])
                await check('raw-callback', kind, size);
        }
        // Production service/init.js registration; no other init code.
        Gio._promisify(Gio.OutputStream.prototype, 'write_all_async');
        for (const mode of ['promise', 'wrapped-callback']) {
            for (const kind of ['memory', 'file']) {
                for (const size of [65536, 2097152])
                    await check(mode, kind, size);
            }
        }
        for (const kind of ['memory', 'file'])
            await check('production-chunks', kind, 2097152);
    } else {
        for (const kind of ['memory', 'file']) {
            for (const size of [65536, 2097152])
                await check('owned-direct', kind, size);
            await check('owned-chunks', kind, 2097152);
            await checkCancelled(kind);
        }
    }
    assert(retained.size === 0, 'Retained input roots must be released');
    assert(failures.length === 0, `${failures.length} write boundary cases failed`);
}

const loop = new GLib.MainLoop(null, false);
let exitCode = 0;
const watchdog = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 15, () => {
    printerr('FAIL write boundary watchdog');
    // Do not close a stream with an unfinished async operation. Process exit
    // releases descriptors; remove only our private files and directory.
    openStreams.clear();
    cleanup();
    System.exit(1);
    return GLib.SOURCE_REMOVE;
});
run().catch(error => {
    printerr(`FAIL write boundaries: ${error.message}`);
    exitCode = 1;
}).finally(() => {
    GLib.source_remove(watchdog);
    cleanup();
    loop.quit();
});
loop.run();
System.exit(exitCode);
