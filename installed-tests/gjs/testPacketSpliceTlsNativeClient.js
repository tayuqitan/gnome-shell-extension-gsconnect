// SPDX-License-Identifier: GPL-2.0-or-later
// TEST-ONLY candidate fixture, exercised with an isolated strict-auth peer.
// Separate entry point: never calls the older packet writer.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import System from 'system';
import {sendPacketCandidate} from '../fixtures/packetSpliceCandidate.js';

if (ARGV.length !== 5 || ARGV[0] !== '--run-reviewed-candidate-tls')
    throw Error('Test-only fixture requires explicit opt-in, package, cert directory, port and mode');
const [, packagePath, certPath, portText, mode] = ARGV;
if (!GLib.path_is_absolute(packagePath) || !GLib.path_is_absolute(certPath) ||
    !/^[0-9]+$/.test(portText) || Number(portText) < 1 || Number(portText) > 65535 ||
    !['small', 'unicode', 'large'].includes(mode))
    throw Error('Invalid fixture arguments');
const [, data] = GLib.file_get_contents(`${packagePath}/service/core.js`);
if (GLib.compute_checksum_for_data(GLib.ChecksumType.SHA256, data) !==
    '0f9e9cd533f305f417d9b357a41254ce230ce2509e2bc4d7b9743bbc75409f0a')
    throw Error('Packaged core hash mismatch');
const core = new TextDecoder().decode(data);
/**
 * Extract unchanged method text without loading service imports.
 *
 * @param {string} header - Unique method signature
 * @returns {string} Original method
 */
function extract(header) {
    if (core.split(header).length !== 2)
        throw Error('Ambiguous method boundary');
    const start = core.indexOf(header);
    const end = core.indexOf('\n    /**', start);
    if (end < 0)
        throw Error('Missing method end');
    return core.slice(start, end);
}
const Packet = new Function(`return class {${extract('    serialize() {')}}`)();
let raw = null;
let tls = null;
let pendingWrite = null;
const operation = new Gio.Cancellable();
const loop = new GLib.MainLoop(null, false);
let exitCode = 0;
const watchdog = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 15, () => {
    try {
        raw?.socket.close();
    } catch {
        // Process exit still reclaims descriptors.
    }
    try {
        printerr('FAIL client watchdog');
    } finally {
        System.exit(1);
    }
    return GLib.SOURCE_REMOVE;
});
/** Run one client with fixture certificates and a native peer process. */
async function run() {
    print('STAGE CONNECT_START');
    const client = new Gio.SocketClient({enable_proxy: false, timeout: 10});
    raw = await new Promise((resolve, reject) => {
        client.connect_to_host_async('127.0.0.1', Number(portText), operation, (source, result) => {
            try {
                resolve(source.connect_to_host_finish(result));
            } catch (error) {
                reject(error);
            }
        });
    });
    print('STAGE CONNECTED');
    tls = Gio.TlsClientConnection.new(raw,
        new Gio.NetworkAddress({hostname: 'localhost', port: Number(portText)}));
    tls.database = Gio.TlsFileDatabase.new(`${certPath}/ca.pem`);
    tls.set_certificate(Gio.TlsCertificate.new_from_files(`${certPath}/client.pem`, `${certPath}/client.key`));
    await new Promise((resolve, reject) => {
        tls.handshake_async(GLib.PRIORITY_DEFAULT, operation, (source, result) => {
            try {
                source.handshake_finish(result);
                resolve();
            } catch (error) {
                reject(error);
            }
        });
    });
    const expectedServer = Gio.TlsCertificate.new_from_file(`${certPath}/server.pem`);
    if (!expectedServer.is_same(tls.peer_certificate))
        throw Error('Fixture server certificate mismatch');
    print('STAGE TLS_VERIFIED');
    const packet = new Packet();
    packet.id = 0;
    packet.type = 'test.isolated.packet';
    let text = 'fixture only';
    if (mode === 'unicode')
        text = '中文🙂é\n'.repeat(2048);
    if (mode === 'large')
        text = 'x'.repeat(2 * 1024 * 1024 - 1024);
    packet.body = {text};
    const channel = {};
    channel.cancellable = operation;
    channel.output_stream = tls.output_stream;
    // Observe rejection immediately, including during expected-data validation.
    print('STAGE WRITE_START');
    pendingWrite = sendPacketCandidate(channel, packet).then(
        () => ({success: true}), error => ({error}));
    // serialize set the timestamp. Do not serialize again.
    const expected = new TextEncoder().encode(`${JSON.stringify(packet)}\n`);
    if (expected.length > 2 * 1024 * 1024)
        throw Error('Payload bound exceeded');
    const written = await pendingWrite;
    if (written.error)
        throw written.error;
    print('STAGE WRITE_SETTLED');
    print('STAGE CLOSE_START');
    // Graceful TLS close is mandatory; raw close alone cannot prove peer EOF.
    await new Promise((resolve, reject) => {
        tls.close_async(GLib.PRIORITY_DEFAULT, new Gio.Cancellable(), (source, result) => {
            try {
                source.close_finish(result);
                resolve();
            } catch (error) {
                reject(error);
            }
        });
    });
    print('STAGE CLOSED');
    print(`EXPECT ${expected.length} ${GLib.compute_checksum_for_data(GLib.ChecksumType.SHA256, expected)}`);
}
run().catch(async error => {
    operation.cancel();
    try {
        raw?.socket.close();
    } catch {
        // Already closed; still wait for the owned writer callback.
    }
    if (pendingWrite)
        await pendingWrite;
    printerr(`FAIL client domain=${error.domain ?? 0} code=${error.code ?? 0}`);
    exitCode = 1;
}).finally(() => {
    try {
        raw?.socket.close();
    } catch {
        // Already closed after successful graceful shutdown.
    }
    GLib.source_remove(watchdog);
    loop.quit();
});
loop.run();
System.exit(exitCode);
