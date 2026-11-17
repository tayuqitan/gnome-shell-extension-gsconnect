// SPDX-License-Identifier: GPL-2.0-or-later
// Package method adapter only. Never imports full Core, Device or a backend.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

/**
 * Load pinned package bytes and expose the actual Core send method.
 * Runners also verify archive digest and extracted-byte equality.
 *
 * @param {string} directory - Explicit package directory
 * @returns {Promise<object>} Packet serializer and actual Core send entry
 */
export async function loadPackagedCoreSender(directory) {
    if (!GLib.path_is_absolute(directory))
        throw Error('Absolute verified package path required');
    const paths = [
        ['service/core.js', '44e874a45f30ff0d41b6bdc9cdd9e1d2928df56798e0190751abf8e1bdfb6977'],
        ['service/utils/packetBytes.js', '6777fd4ef41813c8b2efedb7ed1f3a91e20534af6de2516de650329f8f2b8752'],
    ];
    let core;
    for (const [path, expected] of paths) {
        const file = Gio.File.new_for_path(`${directory}/${path}`);
        const info = file.query_info('standard::type', Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, null);
        if (info.get_file_type() !== Gio.FileType.REGULAR)
            throw Error('Package input must be a regular non-symlink file');
        const bytes = file.load_contents(null)[1];
        if (GLib.compute_checksum_for_data(GLib.ChecksumType.SHA256, bytes) !== expected)
            throw Error(`Package hash mismatch: ${path}`);
        if (path === 'service/core.js')
            core = new TextDecoder().decode(bytes);
    }
    const extract = signature => {
        if (core.split(signature).length !== 2)
            throw Error('Ambiguous packaged method');
        const start = core.indexOf(signature);
        const end = core.indexOf('\n    /**', start);
        if (end < 0)
            throw Error('Missing packaged method boundary');
        return core.slice(start, end);
    };
    const {sendPacketBytes} = await import(Gio.File.new_for_path(
        `${directory}/service/utils/packetBytes.js`).get_uri());
    const Packet = new Function(`return class {${extract('    serialize() {')}}`)();
    const method = new Function('sendPacketBytes',
        `return ({${extract('    sendPacket(packet, cancellable = null) {')}}).sendPacket;`)(sendPacketBytes);
    return {Packet, send(channel, packet, token = null) {
        return method.call(channel, packet, token);
    }};
}
