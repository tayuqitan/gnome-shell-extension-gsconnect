#!/usr/bin/env python3
# SPDX-FileCopyrightText: GSConnect Developers https://github.com/GSConnect
# SPDX-License-Identifier: GPL-2.0-or-later
"""Exercise the real loader with a valid typelib whose native library is absent.

Everything lives in TemporaryDirectory; no system files or extension installation
are changed. Each run uses a fresh GJS process and a unique nonexistent SONAME.
"""
import argparse
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import uuid
import xml.etree.ElementTree as ET


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--gir', type=Path, required=True)
    parser.add_argument('--compiler', required=True)
    parser.add_argument('--gjs', required=True)
    parser.add_argument('--loader', type=Path, required=True)
    parser.add_argument('--include-dir', action='append', default=[])
    args = parser.parse_args()

    with tempfile.TemporaryDirectory(prefix='gsconnect-missing-native-') as directory:
        root = Path(directory)
        native = root / 'native'
        shell = root / 'shell'
        native.mkdir()
        shell.mkdir()
        loader = shell / 'clipboardNative.js'
        shutil.copyfile(args.loader, loader)

        ET.register_namespace('', 'http://www.gtk.org/introspection/core/1.0')
        ET.register_namespace('c', 'http://www.gtk.org/introspection/c/1.0')
        ET.register_namespace('glib', 'http://www.gtk.org/introspection/glib/1.0')
        tree = ET.parse(args.gir)
        namespace = tree.getroot().find('{http://www.gtk.org/introspection/core/1.0}namespace')
        if namespace is None or namespace.attrib.get('name') != 'GscClipboard':
            raise RuntimeError('Expected the generated GscClipboard GIR')
        missing = f'libgsconnect-test-absent-{uuid.uuid4().hex}.so'
        namespace.set('shared-library', missing)
        changed_gir = native / 'GscClipboard-1.0.gir'
        tree.write(changed_gir, encoding='utf-8', xml_declaration=True)
        typelib = native / 'GscClipboard-1.0.typelib'
        command = [args.compiler, str(changed_gir), '--output', str(typelib)]
        command += [f'--includedir={path}' for path in args.include_dir if path]
        subprocess.run(command, check=True, timeout=30)
        if not typelib.is_file() or typelib.stat().st_size == 0:
            raise RuntimeError('Fixture typelib was not generated')

        # The compiler and file check establish a valid typelib fixture. GJS
        # versions may resolve its library eagerly or lazily at Source access.
        runner = root / 'missing-library.mjs'
        runner.write_text("""// Generated test-only harness; no installed files are touched.
import Gio from 'gi://Gio';
if (!Gio.File.new_for_path(ARGV[1]).query_exists(null))
    throw new Error('Generated valid fixture typelib is missing');
let missingLibraryObserved = false;
let phase = 'namespace import (eager library resolution)';
try {
    const native = (await import('gi://GscClipboard?version=1.0')).default;
    phase = 'class resolution (lazy library resolution)';
    const sourceClass = native.Source;
    if (!sourceClass)
        throw new Error('Native class unavailable from the valid fixture typelib');
    sourceClass.new('probe', ['text/plain'], 60);
} catch (error) {
    missingLibraryObserved = true;
}
if (!missingLibraryObserved)
    throw new Error('Absent shared library unexpectedly resolved');
print(`Missing native library rejected during ${phase}`);
const loader = await import(Gio.File.new_for_path(ARGV[0]).get_uri());
if (loader.isAvailable())
    throw new Error('Loader incorrectly reports missing native library as available');
let rejected = false;
try {
    loader.createSource('probe', ['text/plain'], 60);
} catch (error) {
    rejected = true;
}
if (!rejected)
    throw new Error('createSource did not reject the unavailable helper');
print('Missing-library loader fallback passed (valid typelib, absent native SONAME)');
""", encoding='utf-8')
        environment = os.environ.copy()
        environment['GI_TYPELIB_PATH'] = os.pathsep.join(filter(None, [
            str(native), environment.get('GI_TYPELIB_PATH', '')]))
        # The random SONAME cannot resolve to a valid helper in any library path.
        # Retain the ordinary paths for real Gio/Meta runtime dependencies.
        subprocess.run([args.gjs, '-m', str(runner), str(loader), str(typelib)],
                       env=environment, check=True, timeout=30)


if __name__ == '__main__':
    main()
