# SPDX-FileCopyrightText: GSConnect Developers https://github.com/GSConnect
# SPDX-License-Identifier: GPL-2.0-or-later
"""Real ZIP/shell integration with a fake DESTDIR installer, never a desktop."""
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
import zipfile

ROOT = Path(__file__).resolve().parents[1]


class PackageShellTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='gsconnect package test ')
        self.addCleanup(self.temp.cleanup)
        self.path = Path(self.temp.name)
        self.build = self.path / 'build with spaces'
        self.build.mkdir()
        self.fixture = self.path / 'fixture'
        self.ext = self.fixture / 'share/gnome-shell/extensions/test@example'
        self.ext.mkdir(parents=True)
        (self.ext / 'metadata.json').write_text('{"uuid":"test@example"}')
        schemas = self.fixture / 'share/glib-2.0/schemas'
        schemas.mkdir(parents=True)
        (schemas / 'schema.xml').write_text('<schemalist/>')
        commands = self.path / 'bin'
        commands.mkdir()
        for name, text in {
            'ninja': '#!/bin/sh\nmkdir -p "$DESTDIR"\ncp -R "$FIXTURE/." "$DESTDIR/"\n',
            'gnome-extensions': '#!/bin/sh\ntouch "$INSTALL_MARKER"\n',
        }.items():
            command = commands / name
            command.write_text(text)
            command.chmod(0o700)
        self.environment = os.environ.copy()
        self.environment.update({
            'PATH': str(commands) + os.pathsep + self.environment.get('PATH', ''),
            'MESON_BUILD_ROOT': str(self.build), 'UUID': 'test@example',
            'DATADIR': 'share', 'LOCALEDIR': 'share/locale',
            'GSCHEMADIR': 'share/glib-2.0/schemas',
            'PYTHON': os.sys.executable,
            'NATIVE_PACKAGE_TOOL': str(ROOT / 'build-aux/ego/native-package.py'),
            'NATIVE_MANIFEST': '', 'FIXTURE': str(self.fixture),
            'INSTALL_MARKER': str(self.path / 'desktop-was-called'),
            'INSTALL': 'false', 'NOZIP': 'false',
        })

    def run_package(self):
        return subprocess.run(['sh', str(ROOT / 'build-aux/ego/mkzip.sh')],
                              env=self.environment, capture_output=True, text=True)

    def test_text_only_zip_with_spaces_and_optional_nautilus(self):
        result = self.run_package()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        with zipfile.ZipFile(self.build / 'test@example.zip') as archive:
            self.assertIn('metadata.json', archive.namelist())
            self.assertIn('schemas/schema.xml', archive.namelist())
        self.assertFalse(Path(self.environment['INSTALL_MARKER']).exists())

    def test_partial_native_is_rejected_and_never_installed(self):
        native = self.ext / 'native'
        native.mkdir()
        (native / 'GscClipboard-1.0.typelib').write_bytes(b'incomplete')
        self.environment['INSTALL'] = 'true'  # Controlled spy, not real installer.
        result = self.run_package()
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse((self.build / 'test@example.zip').exists())
        self.assertFalse(Path(self.environment['INSTALL_MARKER']).exists())

    def test_required_native_manifest_cannot_silently_make_text_only_package(self):
        self.environment['NATIVE_MANIFEST'] = str(self.path / 'missing-manifest.json')
        result = self.run_package()
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse((self.build / 'test@example.zip').exists())


if __name__ == '__main__':
    unittest.main()
