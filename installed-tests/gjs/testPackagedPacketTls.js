// SPDX-FileCopyrightText: 2026 GSConnect fork contributors
// SPDX-License-Identifier: GPL-2.0-or-later
// UNSTABLE DIAGNOSTIC: a previous run crashed GJS; not a passing regression.
// Do not rerun until the fixture has been repaired and independently reviewed.
// Isolated TLS sendPacket test. No daemon, pairing, or identity negotiation.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import System from 'system';

if (ARGV.length !== 2 || ARGV[1] !== '--run-unstable-tls-diagnostic')
    throw Error('Disabled unstable TLS diagnostic: repair and review before explicit opt-in');
const [, data] = GLib.file_get_contents(`${ARGV[0]}/service/core.js`);
if (GLib.compute_checksum_for_data(GLib.ChecksumType.SHA256, data) !==
    '0f9e9cd533f305f417d9b357a41254ce230ce2509e2bc4d7b9743bbc75409f0a')
    throw Error('Packaged core hash mismatch');
const core = new TextDecoder().decode(data);
const cleanupPath = `${ARGV[0]}/service/utils/transferCancellation.js`;
const [, cleanupSource] = GLib.file_get_contents(cleanupPath);
if (GLib.compute_checksum_for_data(GLib.ChecksumType.SHA256, cleanupSource) !==
    'de682794319d5df6e8e6dd09f161be7b8890dcc0a9bb0a1d563785758ef5898e')
    throw Error('Packaged cleanup helper hash mismatch');
const {closeTransferStreams} = await import(Gio.File.new_for_path(cleanupPath).get_uri());
/**
 * Extract unchanged production method by unique boundaries.
 *
 * @param {string} begin - Method header
 * @param {string} end - Following section
 * @returns {string} Exact source
 */
function extract(begin, end) {
    if (core.split(begin).length !== 2)
        throw Error('Ambiguous production method');
    const offset = core.indexOf(begin);
    const finish = core.indexOf(end, offset);
    if (finish < 0)
        throw Error('Missing production method end');
    return core.slice(offset, finish);
}
const serialize = extract('    serialize() {', '\n    /**');
const send = extract('    sendPacket(packet, cancellable = null) {', '\n    /**');
const Packet = new Function(`return class {${serialize}}`)();
const Channel = new Function('GLib', `return class {${send}}`)(GLib);
for (const [prototype, method] of [[Gio.SocketClient.prototype, 'connect_async'],
    [Gio.OutputStream.prototype, 'write_all_async'],
    [Gio.Subprocess.prototype, 'wait_check_async']])
    Gio._promisify(prototype, method);
const dir = Gio.File.new_for_path(GLib.dir_make_tmp('gsconnect-packet-tls-XXXXXX'));
dir.set_attribute_uint32('unix::mode', 0o700, Gio.FileQueryInfoFlags.NONE, null);
const names = ['ca.key', 'ca.pem', 'ca.srl', 'server.key', 'server.csr',
    'server.ext', 'server.pem', 'client.key', 'client.csr', 'client.ext', 'client.pem'];
const owned = Object.fromEntries(names.map(name => [name, dir.get_child(name)]));
let stopCurrent = () => {};
let process = null;
/** Unlink only files created by this test; never recurse. */
function unlinkOwned() {
    for (const file of [...Object.values(owned), dir]) {
        try {
            file.delete(null);
        } catch {
            // Preserve original failure, including watchdog failure.
        }
    }
}
const totalTimer = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 90, () => {
    stopCurrent();
    process?.force_exit();
    unlinkOwned();
    printerr('FAIL total watchdog');
    System.exit(1);
    return GLib.SOURCE_REMOVE;
});
/**
 * Assert metadata only, never print payload or credentials.
 *
 * @param {boolean} value - Condition
 * @param {string} message - Diagnostic
 */
function assert(value, message) {
    if (!value)
        throw Error(message);
}
/**
 * Run a TLS scenario with only our own loopback sockets.
 *
 * @param {string} mode - Scenario
 * @param {object} certificates - Independent server and client test identities
 * @returns {Promise<void>} Settled test
 */
async function check(mode, certificates) {
    const lifetime = new Gio.Cancellable();
    const operation = new Gio.Cancellable();
    const channel = new Channel();
    channel.cancellable = new Gio.Cancellable();
    const listener = new Gio.SocketListener();
    let clientRaw = null, serverRaw = null, client = null, server = null;
    let timer = 0, cancelTimer = 0, timedOut = false;
    let accept = Promise.resolve(), writing = Promise.resolve(), reading = Promise.resolve();
    const handshakes = [];
    const handshakeResults = [];
    let certificateHandler = 0;
    let caseError = null;
    const stop = () => {
        lifetime.cancel();
        operation.cancel();
        channel.cancellable.cancel();
        listener.close();
        for (const raw of [clientRaw, serverRaw]) {
            try {
                raw?.socket.close();
            } catch {
                // Already closed.
            }
        }
    };
    stopCurrent = stop;
    timer = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 15, () => {
        timer = 0;
        timedOut = true;
        stop();
        return GLib.SOURCE_REMOVE;
    });
    try {
        const [, address] = listener.add_address(
            Gio.InetSocketAddress.new_from_string('127.0.0.1', 0),
            Gio.SocketType.STREAM, Gio.SocketProtocol.TCP, null);
        assert(address.address.to_string() === '127.0.0.1', 'Non-loopback address');
        accept = new Promise((resolve, reject) => {
            listener.accept_async(lifetime, (source, result) => {
                try {
                    [serverRaw] = source.accept_finish(result);
                    resolve();
                } catch (error) {
                    reject(error);
                }
            });
        });
        accept.catch(() => {});
        clientRaw = await new Gio.SocketClient({enable_proxy: false})
            .connect_async(address, lifetime);
        await accept;
        listener.close();
        const blocked = mode === 'operation-cancel' || mode === 'channel-cancel';
        if (blocked) {
            // Linux socket-local buffer limits, never global system settings.
            clientRaw.socket.set_option(1, 7, 4096);
            serverRaw.socket.set_option(1, 8, 4096);
        }
        client = Gio.TlsClientConnection.new(clientRaw, address);
        server = Gio.TlsServerConnection.new(serverRaw, certificates.server);
        client.set_certificate(certificates.client);
        server.authentication_mode = Gio.TlsAuthenticationMode.REQUIRED;
        for (const tls of [client, server])
            tls.database = Gio.TlsFileDatabase.new(owned['ca.pem'].get_path());
        // GIO servers always emit this signal for client authentication,
        // even when normal CA verification reports no errors.
        const expectedClientPem = certificates.client.certificate_pem;
        certificateHandler = server.connect('accept-certificate', (_connection, peer, errors) =>
            errors === 0 && peer.certificate_pem === expectedClientPem);
        for (const [side, tls] of [['client', client], ['server', server]]) {
            handshakes.push(new Promise((resolve, reject) => {
                tls.handshake_async(GLib.PRIORITY_DEFAULT, lifetime, (source, result) => {
                    try {
                        source.handshake_finish(result);
                        handshakeResults.push(`${side}: success`);
                        resolve();
                    } catch (error) {
                        handshakeResults.push(`${side}: domain=${error.domain} code=${error.code} ` +
                            `message=${error.message}`);
                        reject(error);
                    }
                });
            }));
        }
        try {
            await Promise.all(handshakes);
        } catch (error) {
            stop();
            await Promise.allSettled(handshakes);
            for (const result of handshakeResults)
                printerr(`TLS handshake ${result}`);
            printerr(`TLS peer present client=${Boolean(client.peer_certificate)} ` +
                `server=${Boolean(server.peer_certificate)}`);
            throw error;
        }
        assert(certificates.server.certificate_pem === client.peer_certificate.certificate_pem &&
            certificates.client.certificate_pem === server.peer_certificate.certificate_pem, 'Test peer certificate mismatch');
        channel.output_stream = client.output_stream;
        const packet = new Packet();
        packet.id = 0;
        packet.type = 'test.isolated.packet';
        let text = 'small test';
        if (mode === 'unicode')
            text = '中文🙂é\n'.repeat(2048);
        if (mode === 'large' || blocked)
            text = 'x'.repeat(2 * 1024 * 1024 - 1024);
        packet.body = {text};
        if (mode === 'pre-cancel')
            operation.cancel();
        let settled = false, cancelFired = false;
        writing = channel.sendPacket(packet,
            mode === 'channel-cancel' ? null : operation);
        writing.then(() => {
            settled = true;
        }, () => {
            settled = true;
        });
        // serialize() set the actual timestamp; do not call it again.
        const expected = new TextEncoder().encode(`${JSON.stringify(packet)}\n`);
        assert(expected.length <= 2 * 1024 * 1024, 'Payload bound exceeded');
        if (blocked) {
            cancelTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 200, () => {
                cancelTimer = 0;
                if (!settled) {
                    const writable = clientRaw.socket.condition_check(GLib.IOCondition.OUT);
                    const readable = serverRaw.socket.condition_check(GLib.IOCondition.IN);
                    print(`INFO ${mode}: pending; raw writable=${Boolean(writable)} peer readable=${Boolean(readable)}`);
                    cancelFired = true;
                    (mode === 'channel-cancel' ? channel.cancellable : operation).cancel();
                }
                return GLib.SOURCE_REMOVE;
            });
        } else if (mode !== 'pre-cancel') {
            reading = (async () => {
                let offset = 0;
                while (offset < expected.length) {
                    const request = Math.min(65536, expected.length - offset);
                    const bytes = await new Promise((resolve, reject) => {
                        server.input_stream.read_bytes_async(
                            request,
                            GLib.PRIORITY_DEFAULT, lifetime, (source, result) => {
                                try {
                                    const owned = new Uint8Array(
                                        source.read_bytes_finish(result).get_data());
                                    resolve(owned);
                                } catch (error) {
                                    reject(error);
                                }
                            });
                    });
                    assert(bytes.length > 0, 'Premature TLS EOF');
                    for (const byte of bytes) {
                        assert(byte === expected[offset], `TLS byte mismatch at ${offset}`);
                        offset++;
                    }
                }
            })();
            reading.catch(() => {});
        }
        let failure = null;
        try {
            await writing;
        } catch (error) {
            failure = error;
        }
        assert(!timedOut, 'Per-case watchdog');
        if (blocked || mode === 'pre-cancel') {
            assert(!blocked || cancelFired, 'Pending write not reached: cancellation untested');
            const canceled = mode === 'channel-cancel' ? channel.cancellable : operation;
            assert(canceled.is_cancelled(), 'Cancellation did not fire');
            assert(failure?.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED),
                'Expected native CANCELLED');
            print(`PASS ${mode}: real TLS pending write / native CANCELLED`);
        } else {
            if (failure)
                throw failure;
            await reading;
            print(`PASS ${mode}: real TLS expected-length prefix matches (EOF not checked)`);
        }
    } catch (error) {
        caseError = error;
    } finally {
        stop();
        try {
            // Never detach the callback inside signal emission, or close TLS
            // while a native handshake/read/write still owns the streams.
            await Promise.allSettled([accept, writing, reading, ...handshakes]);
            const cleanupErrors = [];
            if (certificateHandler) {
                try {
                    server.disconnect(certificateHandler);
                    certificateHandler = 0;
                } catch (error) {
                    cleanupErrors.push(`signal disconnect: ${error.message}`);
                }
            }
            const streams = [client, server].filter(Boolean);
            const results = await closeTransferStreams(streams, null);
            for (let i = 0; i < results.length; i++) {
                const result = results[i];
                if (result.status === 'fulfilled')
                    continue;
                const error = result.reason;
                // Raw sockets were intentionally force-closed by stop().
                // These two errors are expected shutdown outcomes, not proof
                // of successful TLS close-notify. Other failures stay fatal.
                const forcedClose = error.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CLOSED) ||
                    error.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.BROKEN_PIPE);
                if (forcedClose) {
                    printerr(`INFO ${mode}: TLS stream ${i} close failed after raw shutdown; ` +
                        'close-notify not verified');
                } else {
                    cleanupErrors.push(`TLS close ${i}: ${error.message}`);
                }
            }
            for (const raw of [clientRaw, serverRaw]) {
                if (raw && !raw.socket.is_closed())
                    cleanupErrors.push('Raw socket cleanup failed');
            }
            if (cleanupErrors.length) {
                const prior = caseError ? `; original failure: ${caseError.message}` : '';
                caseError = Error(`Cleanup failed: ${cleanupErrors.join('; ')}${prior}`);
            }
        } finally {
            if (timer)
                GLib.source_remove(timer);
            if (cancelTimer)
                GLib.source_remove(cancelTimer);
            stopCurrent = () => {};
        }
    }
    if (caseError)
        throw caseError;
}
/**
 * Run the installed OpenSSL executable with explicit test-only paths.
 *
 * @param {string[]} args - Arguments, no shell interpolation
 * @returns {Promise<void>} Successful completion
 */
async function openssl(args) {
    process = Gio.Subprocess.new(['openssl', ...args],
        Gio.SubprocessFlags.STDOUT_SILENCE | Gio.SubprocessFlags.STDERR_SILENCE);
    await process.wait_check_async(null);
    process = null;
}

try {
    const path = name => owned[name].get_path();
    await openssl(['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
        '-subj', '/CN=GSConnect-Isolated-Test-CA',
        '-addext', 'basicConstraints=critical,CA:TRUE',
        '-addext', 'keyUsage=critical,keyCertSign,cRLSign',
        '-keyout', path('ca.key'), '-out', path('ca.pem')]);
    const certificates = {};
    for (const role of ['server', 'client']) {
        await openssl(['req', '-new', '-newkey', 'rsa:2048', '-nodes',
            '-subj', `/CN=gsconnect-isolated-${role}`,
            '-keyout', path(`${role}.key`), '-out', path(`${role}.csr`)]);
        GLib.file_set_contents(path(`${role}.ext`),
            'basicConstraints=critical,CA:FALSE\n' +
            'keyUsage=critical,digitalSignature,keyEncipherment\n' +
            `extendedKeyUsage=${role}Auth\n` +
            'subjectAltName=IP:127.0.0.1,DNS:localhost\n');
        await openssl(['x509', '-req', '-in', path(`${role}.csr`),
            '-CA', path('ca.pem'), '-CAkey', path('ca.key'), '-CAcreateserial',
            '-days', '1', '-extfile', path(`${role}.ext`), '-out', path(`${role}.pem`)]);
        owned[`${role}.key`].set_attribute_uint32('unix::mode', 0o600,
            Gio.FileQueryInfoFlags.NONE, null);
        certificates[role] = Gio.TlsCertificate.new_from_files(
            path(`${role}.pem`), path(`${role}.key`));
    }
    owned['ca.key'].set_attribute_uint32('unix::mode', 0o600, Gio.FileQueryInfoFlags.NONE, null);
    await openssl(['verify', '-CAfile', path('ca.pem'), '-purpose', 'sslserver',
        '-verify_ip', '127.0.0.1', path('server.pem')]);
    await openssl(['verify', '-CAfile', path('ca.pem'), '-purpose', 'sslclient', path('client.pem')]);
    const failures = [];
    for (const mode of ['small', 'unicode', 'large', 'operation-cancel',
        'channel-cancel', 'pre-cancel']) {
        try {
            await check(mode, certificates);
        } catch (error) {
            failures.push(mode);
            printerr(`FAIL ${mode}: ${error.message}`);
        }
    }
    if (failures.length)
        throw Error(`Failed cases: ${failures.join(', ')}`);
} finally {
    GLib.source_remove(totalTimer);
    unlinkOwned();
}
