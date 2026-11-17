// SPDX-FileCopyrightText: 2026 GSConnect fork contributors
// SPDX-License-Identifier: GPL-2.0-or-later
// Local GIO cancellation regression, not GSConnect LAN or two-machine testing.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import System from 'system';
import {linkCancellables, closeTransferSocket, closeTransferStreams} from '../../src/service/utils/transferCancellation.js';

/**
 * Check an invariant.
 *
 * @param {boolean} value - Condition
 * @param {string} message - Failure detail
 */
function assert(value, message) {
    if (!value)
        throw new Error(message);
}

/**
 * Bind exclusively to IPv4 loopback, with an OS-assigned port.
 *
 * @returns {object} Listener and port
 */
function listener() {
    const socket = Gio.Socket.new(
        Gio.SocketFamily.IPV4, Gio.SocketType.STREAM, Gio.SocketProtocol.TCP);
    try {
        socket.bind(new Gio.InetSocketAddress({
            address: Gio.InetAddress.new_from_string('127.0.0.1'), port: 0,
        }), false);
        socket.listen();
        const server = new Gio.SocketListener();
        server.add_socket(socket, null);
        return {server, socket, port: socket.get_local_address().get_port()};
    } catch (error) {
        socket.close();
        throw error;
    }
}

/**
 * Verify a real asynchronous operation rejects after parent cancellation.
 *
 * @param {function(Gio.Cancellable): Promise<void>} start - Async operation
 * @returns {Promise<void>} Completion
 */
async function cancelled(start) {
    const parent = new Gio.Cancellable();
    const linked = linkCancellables(parent);
    let timer = 0;
    let fired = false;
    try {
        const pending = start(linked.cancellable).then(
            () => ({success: true}), error => ({error}));
        timer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 200, () => {
            timer = 0;
            fired = true;
            parent.cancel();
            return GLib.SOURCE_REMOVE;
        });
        const outcome = await pending;
        assert(fired, 'Operation settled before cancellation');
        assert(!outcome.success &&
            outcome.error.matches(Gio.io_error_quark(), Gio.IOErrorEnum.CANCELLED),
        'Expected real G_IO_ERROR_CANCELLED');
    } finally {
        if (timer)
            GLib.source_remove(timer);
        linked.dispose();
    }
}

/**
 * Make a real loopback connection pair.
 *
 * @param {object} endpoint - Bound listener
 * @param {object[]} owned - Connections to close even on partial failure
 * @returns {Promise<object[]>} Client and silent peer
 */
async function pair(endpoint, owned) {
    const token = new Gio.Cancellable();
    const accept = new Promise((resolve, reject) => {
        endpoint.server.accept_async(token, (source, result) => {
            try {
                const [connection] = source.accept_finish(result);
                owned.push(connection);
                resolve(connection);
            } catch (error) {
                reject(error);
            }
        });
    });
    const connect = new Promise((resolve, reject) => {
        const client = new Gio.SocketClient({enable_proxy: false, timeout: 3});
        client.connect_to_host_async('127.0.0.1', endpoint.port, token, (source, result) => {
            try {
                const connection = source.connect_to_host_finish(result);
                owned.push(connection);
                resolve(connection);
            } catch (error) {
                reject(error);
            }
        });
    });
    try {
        return await Promise.all([connect, accept]);
    } catch (error) {
        token.cancel();
        try {
            endpoint.server.close();
        } finally {
            await Promise.allSettled([connect, accept]);
        }
        throw error;
    }
}

/** Run only local GIO operations; no certificates or paired data are needed. */
async function run() {
    // Permission failure is fatal; no alternate address or elevated retry.
    const endpoint = listener();
    const owned = [];
    let tls = null;
    try {
        await cancelled(token => new Promise((resolve, reject) => {
            endpoint.server.accept_async(token, (source, result) => {
                try {
                    const [connection] = source.accept_finish(result);
                    owned.push(connection);
                    resolve();
                } catch (error) {
                    reject(error);
                }
            });
        }));
        print('PASS real loopback accept cancellation');
        const [client] = await pair(endpoint, owned);
        await cancelled(token => new Promise((resolve, reject) => {
            const input = client.get_input_stream();
            input.read_bytes_async(1, GLib.PRIORITY_DEFAULT, token, (source, result) => {
                try {
                    source.read_bytes_finish(result);
                    resolve();
                } catch (error) {
                    reject(error);
                }
            });
        }));
        print('PASS real loopback socket read cancellation');
        // Silent peer never speaks TLS: no certificates or trust changes.
        // No validation bypass. Handshake stays pending until cancelled.
        tls = Gio.TlsClientConnection.new(client, new Gio.NetworkAddress({hostname: 'localhost', port: endpoint.port}));
        await cancelled(token => new Promise((resolve, reject) => {
            tls.handshake_async(GLib.PRIORITY_DEFAULT, token, (source, result) => {
                try {
                    source.handshake_finish(result);
                    resolve();
                } catch (error) {
                    reject(error);
                }
            });
        }));
        print('PASS real TLS handshake cancellation against silent loopback peer');
    } finally {
        try {
            endpoint.server.close();
        } catch {
            // Still reclaim connections if listener cleanup fails.
        }
        try {
            endpoint.socket.close();
        } catch {
            // Listener may already have closed its owned socket.
        }
        for (const connection of owned)
            closeTransferSocket(connection);
        const results = await closeTransferStreams([tls, ...owned], null);
        assert(owned.every(connection => connection.socket.is_closed()), 'Owned sockets must be closed');
        print(`Cleanup settled ${results.length} stream closes; all owned sockets closed`);
    }
}

const loop = new GLib.MainLoop(null, false);
let exitCode = 0;
const watchdog = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 12, () => {
    printerr('FAIL local socket cancellation watchdog; process exit closes owned descriptors');
    System.exit(1);
    return GLib.SOURCE_REMOVE;
});
run().catch(error => {
    printerr(`FAIL local socket cancellation: ${error.message}`);
    exitCode = 1;
}).finally(() => {
    GLib.source_remove(watchdog);
    loop.quit();
});
loop.run();
System.exit(exitCode);
