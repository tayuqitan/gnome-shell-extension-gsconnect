// SPDX-License-Identifier: GPL-2.0-or-later
// Extracted production upload/authentication; no service initialization.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

const work = GLib.get_current_dir();
const [root, mode] = ARGV;
if (!/^\.gsconnect-tls-check\.[A-Za-z0-9]+$/.test(GLib.path_get_basename(work)) ||
    GLib.getenv('HOME') !== `${work}/home` || ARGV.length !== 2 ||
    !['success', 'zero', 'short', 'accept-cancel', 'pre-cancel', 'transfer-cancel'].includes(mode) ||
    ['DISPLAY', 'WAYLAND_DISPLAY', 'DBUS_SESSION_BUS_ADDRESS'].some(key => GLib.getenv(key)))
    throw new Error('Private upload fixture environment required');
const hashes = {
    'service/backends/lan.js': '698ff786fcbd9ba85da8a6e27d1a6816cbee567cabd8539a0feed88fbe24cf99',
    'service/core.js': '44e874a45f30ff0d41b6bdc9cdd9e1d2928df56798e0190751abf8e1bdfb6977',
    'service/utils/transferCancellation.js': 'de682794319d5df6e8e6dd09f161be7b8890dcc0a9bb0a1d563785758ef5898e',
};
const sources = {};
for (const [file, hash] of Object.entries(hashes)) {
    const [, bytes] = GLib.file_get_contents(`${root}/${file}`);
    if (GLib.compute_checksum_for_data(GLib.ChecksumType.SHA256, bytes) !== hash)
        throw new Error(`Package hash mismatch: ${file}`);
    sources[file] = new TextDecoder().decode(bytes);
}
const lan = sources['service/backends/lan.js'];
const core = sources['service/core.js'];
const base = Gio.File.new_for_path(root).get_uri();
const {linkCancellables, closeTransferSocket, closeTransferStreams} =
    await import(`${base}/service/utils/transferCancellation.js`);
/**
 * Extract exactly one method using its class indentation boundary.
 *
 * @param {string} name - Production method name
 * @returns {string} Method source
 */
function method(name) {
    const found = lan.match(new RegExp(`^    (?:async )?${name}\\([^]*?^    }`, 'm'));
    if (!found)
        throw new Error(`Missing method ${name}`);
    return found[0];
}
const packetSource = core.match(/^export class Packet \{[^]*?^}/m)[0].replace('export ', '');
const Packet = new Function(`${packetSource}; return Packet;`)();
const configureSource = lan.match(/^export function _configureSocket\([^]*?^}/m)[0]
    .replace('export ', '');
// Keep socket configuration local; no global service initialization.
const configureSocket = new Function('debug',
    `const _LINUX_SOCKETS = true; ${configureSource}; return _configureSocket;`)(() => {});
const Channel = new Function('Gio', 'GLib', 'Core', '_configureSocket', 'linkCancellables',
    'closeTransferSocket', 'closeTransferStreams', 'logError',
    `const TRANSFER_MIN=1739, TRANSFER_MAX=1764; return class {
        ${['_bindRichTransferListener', '_uploadRich', '_authenticate', '_encryptServer']
        .map(method).join('\n')}
    };`)(Gio, GLib, {Packet}, configureSocket, linkCancellables,
    closeTransferSocket, closeTransferStreams, error => {
        throw error;
    });
Gio._promisify(Gio.SocketListener.prototype, 'accept_async');
Gio._promisify(Gio.OutputStream.prototype, 'splice_async');
Gio._promisify(Gio.TlsConnection.prototype, 'handshake_async');
Gio._promisify(Gio.DtlsConnection.prototype, 'handshake_async');
const channel = new Channel();
channel.cancellable = new Gio.Cancellable();
channel.checksum = 'synthetic-fixture-checksum';
channel.certificate = Gio.TlsCertificate.new_from_files(`${work}/certs/server.pem`, `${work}/certs/server.key`);
const [, pem] = GLib.file_get_contents(`${work}/certs/client.pem`);
let unpaired = false, authenticated = false, bound = false, timer = 0;
channel.device = {settings: {get_string(key) {
    if (key !== 'certificate-pem')
        throw new Error('Unexpected settings access');
    return new TextDecoder().decode(pem);
}}, unpair() {
    unpaired = true;
    throw new Error('Synthetic fixture must never unpair');
}};
channel._bindRichTransferListener = (listener, _port) => {
    const [, address] = listener.add_address(Gio.InetSocketAddress.new_from_string('127.0.0.1', 0),
        Gio.SocketType.STREAM, Gio.SocketProtocol.TCP, null);
    if (address.address.to_string() !== '127.0.0.1' ||
        !Number.isInteger(address.port) || address.port < 1 || address.port > 65535)
        throw new Error('Unsafe listener address');
    bound = true;
    return address.port;
};
const operation = new Gio.Cancellable();
const encrypt = channel._encryptServer;
channel._encryptServer = async (raw, token) => {
    if (raw.get_local_address().address.to_string() !== '127.0.0.1' ||
        raw.get_remote_address().address.to_string() !== '127.0.0.1')
        throw new Error('Non-loopback accepted socket');
    const tls = await encrypt.call(channel, raw, token);
    authenticated = true;
    if (mode === 'transfer-cancel') {
        timer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 20, () => {
            timer = 0;
            operation.cancel();
            return GLib.SOURCE_REMOVE;
        });
    }
    return tls;
};
channel.sendPacket = packet => {
    print(`READY ${packet.payloadTransferInfo.port}`);
    if (mode === 'accept-cancel') {
        timer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 50, () => {
            timer = 0;
            operation.cancel();
            return GLib.SOURCE_REMOVE;
        });
    }
    return Promise.resolve();
};
let size = mode === 'zero' ? 0 : 2 * 1024 * 1024;
if (mode === 'transfer-cancel')
    size = 16 * 1024 * 1024;
const actual = mode === 'short' ? size - 1 : size;
const bytes = new Uint8Array(actual);
for (let i = 0; i < actual; i++)
    bytes[i] = (i * 31 + Math.floor(i / 251)) & 255;
const source = Gio.MemoryInputStream.new_from_bytes(new GLib.Bytes(bytes));
if (mode === 'pre-cancel')
    operation.cancel();
let failure = null;
try {
    await channel._uploadRich({type: 'gsconnect.clipboard.rich', body: {}}, source, size, operation);
} catch (error) {
    failure = error;
} finally {
    if (timer)
        GLib.source_remove(timer);
}
if (unpaired || !source.is_closed())
    throw new Error('Upload cleanup/authentication invariant failed');
const success = mode === 'success' || mode === 'zero';
if (success ? failure !== null : failure === null)
    throw new Error(`Unexpected outcome: ${failure?.message}`);
if (mode === 'short' && !failure.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.PARTIAL_INPUT))
    throw new Error('Short source must produce PARTIAL_INPUT');
if (mode.endsWith('cancel')) {
    if (!operation.is_cancelled())
        throw new Error('Cancellation did not fire');
    if (!failure.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED) &&
        !failure.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CLOSED))
        throw new Error(`Unexpected cancellation error: ${failure.message}`);
}
if (mode === 'pre-cancel' ? bound : !bound)
    throw new Error('Unexpected binding state');
if (!['accept-cancel', 'pre-cancel'].includes(mode) && !authenticated)
    throw new Error('Production authentication not reached');
print(`PASS upload ${mode}: authenticated=${authenticated} unpaired=${unpaired}`);
