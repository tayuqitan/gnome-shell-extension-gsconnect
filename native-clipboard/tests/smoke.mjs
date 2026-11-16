// SPDX-FileCopyrightText: GSConnect Developers https://github.com/GSConnect
// SPDX-License-Identifier: GPL-2.0-or-later
// Run through `meson test`; no Shell instance or desktop installation required.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GscClipboard from 'gi://GscClipboard?version=1.0';

const loop = new GLib.MainLoop(null, false);
const source = GscClipboard.Source.new('smoke', ['image/png'], 60);
let failure = null;
source.connect('request', (_source, id, mime) => {
    if (mime !== 'image/png')
        throw new Error('Wrong MIME');
    source.resolve(id, new GLib.Bytes(new Uint8Array([0, 255, 42])), '');
});
source.read_async('image/png', null, (_source, result) => {
    try {
        const stream = source.read_finish(result);
        if (!(stream instanceof Gio.InputStream))
            throw new Error('Native read_finish did not return a Gio.InputStream');
        const bytes = stream.read_bytes(3, null).get_data();
        if (bytes.length !== 3 || bytes[0] !== 0 || bytes[1] !== 255 || bytes[2] !== 42)
            throw new Error('Native clipboard bytes changed');
        stream.close(null);
    } catch (error) {
        failure = error;
    } finally {
        source.close();
        loop.quit();
    }
});
loop.run();
if (failure)
    throw failure;
print('Native clipboard GJS smoke passed');
