// SPDX-FileCopyrightText: GSConnect Developers https://github.com/GSConnect
// SPDX-License-Identifier: GPL-2.0-or-later
// Supply a source-tree or unpacked-ZIP clipboardNative.js path. No Shell needed.
import Gio from 'gi://Gio';

if (ARGV.length !== 1)
    throw new Error('Expected the clipboardNative.js path');
const loader = await import(Gio.File.new_for_path(ARGV[0]).get_uri());
if (!loader.isAvailable())
    throw new Error('Native loader did not confirm the bridge API');
const source = loader.createSource('loader-smoke', ['text/plain'], 60);
if (source.get_offer_id() !== 'loader-smoke')
    throw new Error('Native loader returned the wrong source');
source.close();
if (!source.get_closed())
    throw new Error('Native source did not close');
print('Actual native loader and source construction passed');
