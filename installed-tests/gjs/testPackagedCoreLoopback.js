// SPDX-License-Identifier: GPL-2.0-or-later
// TEST-ONLY package entry: locally exercised; not full service validation.
// Plain test-owned loopback TCP only. No TLS, daemon or pairing.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import System from 'system';
import {loadPackagedCoreSender} from '../fixtures/packagedCoreSender.js';
let Packet;
let sendPackaged;

if (ARGV.length !== 2 || ARGV[0] !== '--run-reviewed-packaged-core-loopback')
    throw Error('Test-only loopback candidate requires explicit reviewed opt-in');
const LIMIT = 2 * 1024 * 1024;
const sockets = new Set();
const listeners = new Set();

/**
 * Assert a bounded fixture property.
 *
 * @param {boolean} value - Condition
 * @param {string} message - Failure detail
 */
function assert(value, message) {
    if (!value)
        throw Error(message);
}

/** Close only a socket registered by this test. */
function closeSockets() {
    for (const socket of sockets) {
        try {
            socket.close();
        } catch {
            // Continue cleanup; already closed is harmless.
        }
    }
}

/**
 * Read all the way to EOF, rejecting even one excess byte.
 *
 * @param {Gio.InputStream} input - Peer input
 * @param {Gio.Cancellable} token - Case lifetime
 * @returns {Promise<Uint8Array>} Owned bytes, at most LIMIT
 */
async function drain(input, token) {
    const chunks = [];
    let total = 0;
    while (true) {
        const count = Math.min(65536, LIMIT - total + 1);
        const bytes = await new Promise((resolve, reject) => {
            input.read_bytes_async(count,
                GLib.PRIORITY_DEFAULT, token, (stream, result) => {
                    try {
                        resolve(new Uint8Array(stream.read_bytes_finish(result).get_data()));
                    } catch (error) {
                        reject(error);
                    }
                });
        });
        if (bytes.length === 0)
            break;
        total += bytes.length;
        assert(total <= LIMIT, 'Extra data exceeds fixture bound');
        chunks.push(bytes);
    }
    const value = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
        value.set(chunk, offset);
        offset += chunk.length;
    }
    return value;
}

/**
 * Normalize a promise immediately so no rejection is left unobserved.
 *
 * @param {Promise<unknown>} promise - Owned pending operation
 * @returns {Promise<object>} Settled outcome
 */
function observe(promise) {
    return promise.then(value => ({value}), error => ({error}));
}

/**
 * Run a separate owned TCP pair with full cleanup for each case.
 *
 * @param {string} mode - Normal, concurrency or blocked cancellation case
 * @returns {Promise<void>} Completion
 */
async function runCase(mode) {
    const lifetime = new Gio.Cancellable();
    const operation = new Gio.Cancellable();
    const pending = [];
    let timer = 0;
    let sender = null;
    let peer = null;
    const socket = Gio.Socket.new(Gio.SocketFamily.IPV4,
        Gio.SocketType.STREAM, Gio.SocketProtocol.TCP);
    sockets.add(socket);
    const listener = new Gio.SocketListener();
    listeners.add(listener);
    try {
        // Permission failure aborts; no elevation, alternative host or retry.
        socket.bind(new Gio.InetSocketAddress({
            address: Gio.InetAddress.new_from_string('127.0.0.1'), port: 0,
        }), false);
        socket.listen();
        listener.add_socket(socket, null);
        const port = socket.get_local_address().get_port();
        const accepted = observe(new Promise((resolve, reject) => {
            listener.accept_async(lifetime, (source, result) => {
                try {
                    [peer] = source.accept_finish(result);
                    sockets.add(peer.socket);
                    resolve(peer);
                } catch (error) {
                    reject(error);
                }
            });
        }));
        pending.push(accepted);
        const client = new Gio.SocketClient({enable_proxy: false, timeout: 3});
        const connected = observe(new Promise((resolve, reject) => {
            client.connect_to_host_async('127.0.0.1', port, lifetime, (source, result) => {
                try {
                    sender = source.connect_to_host_finish(result);
                    sockets.add(sender.socket);
                    resolve(sender);
                } catch (error) {
                    reject(error);
                }
            });
        }));
        pending.push(connected);
        // On connection failure, finally cancels and reaps the other operation.
        const connection = await connected;
        if (connection.error)
            throw connection.error;
        const acceptance = await accepted;
        if (acceptance.error)
            throw acceptance.error;
        listener.close();
        socket.close();
        const blocked = mode === 'blocked-cancel';
        if (blocked) {
            // Linux constants, restricted to these test-owned sockets.
            sender.socket.set_option(1, 7, 4096);
            peer.socket.set_option(1, 8, 4096);
        }
        let text = 'small test packet\n';
        if (mode === 'unicode')
            text = '中文🙂é\n'.repeat(2048);
        if (['large', 'concurrent', 'blocked-cancel'].includes(mode))
            text = '0123456789abcdef'.repeat((LIMIT - 1024) / 16);
        const packet = Object.assign(new Packet(), {id: 0, type: 'fixture', body: {text}});
        const channel = {output_stream: sender.output_stream, cancellable: lifetime};
        let reading = null;
        const receive = () => {
            const task = observe(drain(peer.input_stream, lifetime));
            task.then(outcome => {
                if (outcome.error) {
                    operation.cancel();
                    lifetime.cancel();
                    closeSockets();
                }
            });
            pending.push(task);
            return task;
        };
        if (!blocked)
            reading = receive();

        let settled = false;
        const writing = observe(sendPackaged(channel, packet, operation));
        pending.push(writing);
        const expected = new TextEncoder().encode(`${JSON.stringify(packet)}\n`);
        assert(expected.length <= LIMIT, 'Payload exceeds bound');
        writing.then(() => {
            settled = true;
        });
        let second = null;
        if (mode === 'concurrent') {
            second = observe(sendPackaged(channel, Object.assign(new Packet(), {id: 0, type: 'second', body: {text: 'second'}})));
            pending.push(second);
        }
        let proof = false;
        let proofError = null;
        if (blocked) {
            timer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 200, () => {
                timer = 0;
                try {
                    const writable = sender.socket.condition_check(GLib.IOCondition.OUT);
                    const readable = peer.socket.condition_check(GLib.IOCondition.IN);
                    proof = !settled && !(writable & GLib.IOCondition.OUT) &&
                        Boolean(readable & GLib.IOCondition.IN);
                } catch (error) {
                    proofError = error;
                } finally {
                    operation.cancel();
                }
                return GLib.SOURCE_REMOVE;
            });
        }
        const result = await writing;
        if (blocked) {
            if (proofError)
                throw proofError;
            assert(proof, 'Pending non-writable sender/readable peer was not demonstrated');
            assert(result.error?.matches(Gio.io_error_quark(), Gio.IOErrorEnum.CANCELLED),
                'Expected native cancellation');
        } else {
            if (result.error)
                throw result.error;
            assert(result.value.length === 1 && result.value[0] === expected.length,
                'Candidate byte count mismatch');
        }
        if (second) {
            const outcome = await second;
            assert(outcome.error?.matches(Gio.io_error_quark(), Gio.IOErrorEnum.PENDING),
                'Concurrent call must fail native PENDING');
        }
        // Only close after all writes settled. TCP EOF, not a prefix match.
        sender.socket.shutdown(false, true);
        if (blocked)
            reading = receive();

        const received = await reading;
        if (received.error)
            throw received.error;
        const bytes = received.value;
        if (blocked)
            assert(bytes.length > 0 && bytes.length < expected.length, 'Expected partial cancelled transfer');
        else
            assert(bytes.length === expected.length, 'Full TCP EOF length mismatch');
        for (let i = 0; i < bytes.length; i++)
            assert(bytes[i] === expected[i], `Received bytes differ at offset ${i}`);
        const hash = GLib.compute_checksum_for_data(GLib.ChecksumType.SHA256, bytes);
        const wanted = GLib.compute_checksum_for_data(GLib.ChecksumType.SHA256,
            blocked ? expected.subarray(0, bytes.length) : expected);
        assert(hash === wanted, 'TCP hash mismatch');
        print(`PASS packaged Core TCP ${mode}: ${bytes.length} bytes SHA256=${hash} EOF=1`);
    } finally {
        if (timer)
            GLib.source_remove(timer);
        operation.cancel();
        lifetime.cancel();
        try {
            listener.close();
        } finally {
            closeSockets();
            // Do not abandon native accept/connect/read/splice callbacks.
            await Promise.allSettled(pending);
            // Reclaim a late connection added during cancellation completion.
            closeSockets();
        }
        for (const connection of [sender, peer]) {
            try {
                connection?.close(null);
            } catch {
                // Raw sockets have already been closed and verified below.
            }
        }
        assert([...sockets].every(item => item.is_closed()), 'Owned socket cleanup incomplete');
        sockets.clear();
        listeners.delete(listener);
    }
}

const loop = new GLib.MainLoop(null, false);
let exitCode = 0;
const watchdog = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 15, () => {
    try {
        for (const listener of listeners)
            listener.close();
        closeSockets();
        printerr('FAIL test-only loopback watchdog');
    } finally {
        System.exit(1);
    }
    return GLib.SOURCE_REMOVE;
});
(async () => {
    ({Packet, send: sendPackaged} = await loadPackagedCoreSender(ARGV[1]));
    for (const mode of ['small', 'unicode', 'large', 'concurrent', 'blocked-cancel'])
        await runCase(mode);
})().catch(error => {
    printerr(`FAIL candidate loopback: ${error.message}`);
    exitCode = 1;
}).finally(() => {
    GLib.source_remove(watchdog);
    loop.quit();
});
loop.run();
System.exit(exitCode);
