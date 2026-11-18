// SPDX-FileCopyrightText: 2026 GSConnect fork contributors
// SPDX-License-Identifier: GPL-2.0-or-later
// Real loopback TLS/file test of an extracted packaged production download.
// NOT production upload/authentication, pairing, daemon or two-machine tests.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import System from 'system';

const root = ARGV[0];
const work = GLib.get_current_dir();
if (!/^\.gsconnect-tls-check\.[A-Za-z0-9]+$/.test(GLib.path_get_basename(work)) ||
    GLib.getenv('HOME') !== `${work}/home` ||
    ['DISPLAY', 'WAYLAND_DISPLAY', 'DBUS_SESSION_BUS_ADDRESS'].some(key => GLib.getenv(key)))
    throw new Error('Requires isolated TLS fixture directory and empty desktop environment');
const certPath = `${work}/certs`;
const modes = ['success', 'zero', 'truncated', 'excess',
    'token-cancel', 'channel-cancel', 'pre-cancel'];
if (!root || ARGV.length !== 3 || !modes.includes(ARGV[1]) ||
    !/^[0-9]+$/.test(ARGV[2]) || Number(ARGV[2]) < 1 || Number(ARGV[2]) > 65535)
    throw new Error('Usage: gjs -m testPackagedRichDownloadTls.js VERIFIED_PACKAGE_DIRECTORY MODE LOOPBACK_PORT');
const expected = {
    'service/backends/lan.js': '698ff786fcbd9ba85da8a6e27d1a6816cbee567cabd8539a0feed88fbe24cf99',
    'service/utils/exactTransfer.js': 'df24097b9135b1b373613c44be38d8a9a8ab0d5b669f2820cf156f88ce4ea3d7',
    'service/utils/writeBytes.js': '5d3fcb5fed14cf97191e3347a776d7d01547170731f74184bb8cfeaef2634af4',
    'service/utils/transferCancellation.js': 'de682794319d5df6e8e6dd09f161be7b8890dcc0a9bb0a1d563785758ef5898e',
};
let lan;
for (const [relative, hash] of Object.entries(expected)) {
    const [, bytes] = GLib.file_get_contents(`${root}/${relative}`);
    if (GLib.compute_checksum_for_data(GLib.ChecksumType.SHA256, bytes) !== hash)
        throw new Error(`Package hash mismatch: ${relative}`);
    if (relative.endsWith('/lan.js'))
        lan = new TextDecoder().decode(bytes);
}
const base = Gio.File.new_for_path(root).get_uri();
const {copyExact} = await import(`${base}/service/utils/exactTransfer.js`);
const {writeBytes} = await import(`${base}/service/utils/writeBytes.js`);
const {linkCancellables, closeTransferSocket, closeTransferStreams} =
    await import(`${base}/service/utils/transferCancellation.js`);
const start = '    async download(packet, target, cancellable = null, onProgress = null) {';
const end = '\n    async upload(';
if (lan.split(start).length !== 2 || lan.split(end).length !== 2)
    throw new Error('Production method boundaries changed');
const method = lan.slice(lan.indexOf(start), lan.indexOf(end));
// No production import/init/Device/GSettings. Only the exact packaged method.
const Download = new Function('Gio', 'GLib', 'copyExact', 'writeBytes',
    'linkCancellables', 'closeTransferSocket', 'closeTransferStreams',
    `return class {${method}}`)(Gio, GLib, copyExact, writeBytes,
    linkCancellables, closeTransferSocket, closeTransferStreams);
Gio._promisify(Gio.SocketClient.prototype, 'connect_async');

/**
 * Complete the concrete TLS backend handshake using its callback API.
 *
 * @param {Gio.TlsConnection} tls - Private fixture TLS endpoint
 * @param {Gio.Cancellable} token - Operation cancellation
 * @returns {Promise<void>} Handshake completion
 */
function handshake(tls, token) {
    return new Promise((resolve, reject) => {
        tls.handshake_async(GLib.PRIORITY_DEFAULT, token, (connection, result) => {
            try {
                connection.handshake_finish(result);
                resolve();
            } catch (error) {
                reject(error);
            }
        });
    });
}

let emergencyCleanup = () => {};
let emergencyFile = null;
const totalTimer = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 60, () => {
    emergencyCleanup();
    // Unlink only this process's file/directory, never close a live writer.
    try {
        emergencyFile?.delete(null);
    } catch {
        // Preserve watchdog failure even if unlink fails.
    }
    try {
        directory.delete(null);
    } catch {
        // Do not recurse or remove anything not created by this test.
    }
    printerr('FAIL total watchdog');
    System.exit(1);
    return GLib.SOURCE_REMOVE;
});
const directory = Gio.File.new_for_path(GLib.dir_make_tmp('gsconnect-packaged-download-XXXXXX'));
directory.set_attribute_uint32('unix::mode', 0o700, Gio.FileQueryInfoFlags.NONE, null);

/**
 * Assert without exposing payload contents.
 *
 * @param {boolean} value - Condition
 * @param {string} message - Failure label
 */
function assert(value, message) {
    if (!value)
        throw new Error(message);
}

/**
 * Exercise a production download over our own loopback connection.
 *
 * @param {string} mode - Test scenario
 * @returns {Promise<void>} Fully settled test
 */
async function check(mode) {
    const file = directory.get_child(`${mode}.bin`);
    let target = null;
    const operation = new Gio.Cancellable();
    const channel = new Download();
    channel.cancellable = new Gio.Cancellable();
    channel.host = '127.0.0.1';
    let client = null, cancelTimer = 0, timedOut = false;
    channel._encryptClient = async (connection, cancellable) => {
        client = connection;
        assert(connection.get_remote_address().address.to_string() === '127.0.0.1',
            'client must connect only to loopback');
        const tls = Gio.TlsClientConnection.new(connection,
            new Gio.NetworkAddress({hostname: 'localhost', port: connection.get_remote_address().port}));
        tls.database = Gio.TlsFileDatabase.new(`${certPath}/ca.pem`);
        tls.set_certificate(Gio.TlsCertificate.new_from_files(`${certPath}/client.pem`, `${certPath}/client.key`));
        await handshake(tls, cancellable);
        assert(Gio.TlsCertificate.new_from_file(`${certPath}/server.pem`).is_same(tls.peer_certificate),
            'fixture server pin mismatch');
        if (mode === 'token-cancel' || mode === 'channel-cancel') {
            cancelTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 50, () => {
                cancelTimer = 0;
                (mode === 'token-cancel' ? operation : channel.cancellable).cancel();
                return GLib.SOURCE_REMOVE;
            });
        }
        return tls;
    };
    const cleanup = () => {
        operation.cancel();
        for (const connection of [client]) {
            try {
                connection?.socket.close();
            } catch {
                // Already closed.
            }
        }
    };
    emergencyCleanup = cleanup;
    emergencyFile = file;
    let timer = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 10, () => {
        timer = 0;
        timedOut = true;
        cleanup();
        return GLib.SOURCE_REMOVE;
    });
    try {
        target = file.create(Gio.FileCreateFlags.PRIVATE, null);
        let declared = 65536;
        if (mode === 'zero')
            declared = 0;
        else if (mode === 'success')
            declared = 2 * 1024 * 1024;
        let actual = declared;
        if (mode === 'truncated')
            actual--;
        else if (mode === 'excess')
            actual++;
        if (mode === 'pre-cancel')
            operation.cancel();
        let failure = null;
        try {
            await channel.download({type: 'gsconnect.clipboard.rich', payloadSize: declared,
                payloadTransferInfo: {port: Number(ARGV[2])}}, target, operation);
        } catch (error) {
            failure = error;
        }
        assert(!timedOut, `${mode}: watchdog`);
        const success = mode === 'success' || mode === 'zero';
        assert(success ? failure === null : failure !== null, `${mode}: unexpected outcome ${failure?.message}`);
        if (mode === 'truncated')
            assert(failure.message.includes('Incomplete'), 'missing truncated rejection');
        if (mode === 'excess')
            assert(failure.message.includes('Extra'), 'missing excess rejection');
        if (mode === 'token-cancel' || mode === 'channel-cancel' || mode === 'pre-cancel') {
            const canceled = mode === 'channel-cancel' ? channel.cancellable : operation;
            assert(canceled.is_cancelled(), `${mode}: cancellation did not fire`);
            assert(failure.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED) ||
                failure.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CLOSED),
            `${mode}: unexpected cancellation error ${failure.message}`);
            const reason = failure.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED)
                ? 'CANCELLED' : 'CLOSED';
            print(`INFO ${mode}: native ${reason}`);
            if (mode !== 'pre-cancel')
                assert(client !== null, `${mode}: connection not reached`);
        }
        assert(target.is_closed(), `${mode}: target not closed`);
        if (client)
            assert(client.is_closed() || client.socket.is_closed(), `${mode}: connection not closed`);
        const [, output] = file.load_contents(null);
        let length = 0;
        if (success || mode === 'excess')
            length = declared;
        else if (mode === 'truncated')
            length = actual;
        assert(output.length === length, `${mode}: unexpected file size`);
        for (let i = 0; i < output.length; i++)
            assert(output[i] === ((i * 31 + Math.floor(i / 251)) & 255), `${mode}: byte mismatch`);
        cleanup();
        const [, settledOutput] = file.load_contents(null);
        assert(settledOutput.length === output.length, `${mode}: late file growth`);
        for (let i = 0; i < output.length; i++)
            assert(settledOutput[i] === output[i], `${mode}: late file mutation`);
        if (mode === 'success') {
            assert(GLib.compute_checksum_for_data(GLib.ChecksumType.SHA256, output) ===
                '7e879fcd2433cef4a0888eee46fbbb05240f594b89e5052faf491c44888cb0ed',
            'known synthetic payload SHA-256 mismatch');
        }
        if (mode === 'pre-cancel')
            assert(client === null, 'pre-canceled connection started');
        print(`PASS ${mode}: production download / loopback TLS / SHA256=${GLib.compute_checksum_for_data(GLib.ChecksumType.SHA256, output)}`);
    } finally {
        cleanup();
        if (timer)
            GLib.source_remove(timer);
        if (cancelTimer)
            GLib.source_remove(cancelTimer);
        try {
            target?.close(null);
        } catch {
            // Already closed.
        }
        if (file.query_exists(null))
            file.delete(null);
        emergencyFile = null;
        emergencyCleanup = () => {};
    }
}
try {
    await check(ARGV[1]);
} finally {
    GLib.source_remove(totalTimer);
    directory.delete(null);
}
