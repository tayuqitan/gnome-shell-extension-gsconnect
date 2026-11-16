# SPDX-FileCopyrightText: GSConnect Developers https://github.com/GSConnect
# SPDX-License-Identifier: GPL-2.0-or-later
"""Package integrity tests; mocked ELF metadata is NOT runtime ABI validation."""
import contextlib
import importlib.util
import io
import json
import os
from pathlib import Path
import stat
import shutil
import subprocess
import tempfile
import unittest
from unittest.mock import patch
import warnings
import zipfile

SCRIPT = Path(__file__).resolve().parents[1] / 'build-aux/ego/native-package.py'
SPEC = importlib.util.spec_from_file_location('native_package', SCRIPT)
PACKAGE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(PACKAGE)


class NativePackageTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.build = self.root / 'build'
        self.output = self.root / 'staged'
        self.build.mkdir()
        self.library = b'\x7fELFmocked-native-binary'
        self.typelib = PACKAGE.TYPELIB_MAGIC + b'mocked-typelib'
        (self.build / PACKAGE.TYPELIB).write_bytes(self.typelib)
        self.real_library = self.build / 'libgsc-clipboard-1.so.0.1.0'
        self.real_library.write_bytes(self.library)
        (self.build / PACKAGE.LIBRARY).symlink_to(self.real_library.name)
        self.gir = self.build / 'GscClipboard-1.0.gir'
        self.gir.write_text('''<repository xmlns="http://www.gtk.org/introspection/core/1.0">
  <include name="Meta" version="17"/>
  <namespace name="GscClipboard" version="1.0" shared-library="libgsc-clipboard-1.so.0"/>
</repository>''')
        self.dynamic = (' 0 (SONAME) Library soname: [libgsc-clipboard-1.so.0]\n'
                        ' 1 (NEEDED) Shared library: [libmutter-17.so.0]\n'
                        ' 2 (NEEDED) Shared library: [libgio-2.0.so.0]\n')

    def tearDown(self):
        self.temp.cleanup()

    def stage(self, dynamic=None):
        result = subprocess.CompletedProcess([], 0,
                                             stdout=self.dynamic if dynamic is None else dynamic,
                                             stderr='')
        with patch.object(PACKAGE.subprocess, 'run', return_value=result) as run:
            manifest = PACKAGE.stage(self.build, self.output, '17')
            self.assertEqual(run.call_args.args[0][:3], ['readelf', '-d', '--'])
            self.assertEqual(run.call_args.kwargs['env']['LC_ALL'], 'C')
            return manifest

    def archive(self, entries=None):
        path = self.root / 'extension.zip'
        if entries is None:
            entries = {f'native/{name}': (self.output / name).read_bytes()
                       for name in PACKAGE.REQUIRED}
        with warnings.catch_warnings():
            warnings.simplefilter('ignore', UserWarning)
            with zipfile.ZipFile(path, 'w', compression=zipfile.ZIP_DEFLATED) as archive:
                archive.writestr('metadata.json', '{}')
                pairs = entries.items() if isinstance(entries, dict) else entries
                for name, data in pairs:
                    archive.writestr(name, data)
        return path

    def test_stage_copies_real_bytes_not_build_symlink(self):
        manifest = self.stage()
        self.assertEqual(set(path.name for path in self.output.iterdir()), PACKAGE.REQUIRED)
        self.assertFalse((self.output / PACKAGE.LIBRARY).is_symlink())
        self.assertEqual((self.output / PACKAGE.LIBRARY).read_bytes(), self.library)
        self.assertEqual(manifest['mutter_api'], '17')
        self.assertEqual(PACKAGE.verify(self.archive(), self.output / PACKAGE.MANIFEST), manifest)

    def test_wrong_gir_api(self):
        self.gir.write_text(self.gir.read_text().replace('version="17"', 'version="16"'))
        with self.assertRaisesRegex(PACKAGE.PackageError, 'Meta-17'):
            self.stage()

    def test_wrong_gir_soname(self):
        self.gir.write_text(self.gir.read_text().replace(PACKAGE.LIBRARY, 'evil.so'))
        with self.assertRaisesRegex(PACKAGE.PackageError, 'shared-library'):
            self.stage()

    def test_wrong_elf_api(self):
        with self.assertRaisesRegex(PACKAGE.PackageError, 'libmutter-17'):
            self.stage(self.dynamic.replace('libmutter-17', 'libmutter-16'))

    def test_multiple_mutter_dependencies_rejected(self):
        with self.assertRaisesRegex(PACKAGE.PackageError, 'libmutter-17'):
            self.stage(self.dynamic + ' 3 (NEEDED) Shared library: [libmutter-16.so.0]\n')

    def test_build_rpath_and_runpath_rejected(self):
        for tag in ['RPATH', 'RUNPATH']:
            with self.subTest(tag=tag), self.assertRaisesRegex(PACKAGE.PackageError, 'RPATH/RUNPATH'):
                self.stage(self.dynamic + f' 3 ({tag}) Library path: [/private/build/sysroot]\n')

    def test_empty_rpath_is_allowed(self):
        manifest = self.stage(self.dynamic + ' 3 (RUNPATH) Library runpath: []\n')
        self.assertEqual(manifest['mutter_api'], '17')

    @unittest.skipUnless(shutil.which('gcc') and shutil.which('readelf'), 'requires GCC and readelf')
    def test_real_elf_metadata_without_executing_the_binary(self):
        # Locally built stubs exercise actual readelf output, NOT Mutter ABI.
        dependency = self.build / 'dependency.c'
        dependency.write_text('void stub_dependency(void) {}\n')
        helper = self.build / 'helper.c'
        helper.write_text('extern void stub_dependency(void); void helper(void) { stub_dependency(); }\n')
        subprocess.run(['gcc', '-shared', '-fPIC', str(dependency),
                        '-Wl,-soname,libmutter-17.so.0', '-o', str(self.build / 'libmutter-17.so.0')],
                       check=True, capture_output=True, timeout=30)
        subprocess.run(['gcc', '-shared', '-fPIC', str(helper), '-L', str(self.build),
                        '-Wl,-soname,' + PACKAGE.LIBRARY, '-l:libmutter-17.so.0',
                        '-o', str(self.real_library)], check=True, capture_output=True, timeout=30)
        manifest = PACKAGE.stage(self.build, self.output, '17')
        self.assertEqual(PACKAGE.verify(self.archive()), manifest)

    def test_wrong_elf_soname(self):
        with self.assertRaisesRegex(PACKAGE.PackageError, 'SONAME'):
            self.stage(self.dynamic.replace(PACKAGE.LIBRARY, 'wrong.so'))

    def test_outside_build_symlink_rejected(self):
        (self.build / PACKAGE.LIBRARY).unlink()
        outside = self.root / 'outside.so'
        outside.write_bytes(self.library)
        (self.build / PACKAGE.LIBRARY).symlink_to(outside)
        with self.assertRaisesRegex(PACKAGE.PackageError, 'escapes'):
            self.stage()

    def test_broken_symlink_rejected(self):
        self.real_library.unlink()
        with self.assertRaises(OSError):
            self.stage()

    def test_relative_directories_rejected(self):
        with self.assertRaisesRegex(PACKAGE.PackageError, 'absolute'):
            PACKAGE.stage(Path('relative'), self.output, '17')

    def test_nonregular_output_rejected(self):
        self.output.mkdir()
        (self.output / PACKAGE.TYPELIB).symlink_to(self.build / PACKAGE.TYPELIB)
        with self.assertRaisesRegex(PACKAGE.PackageError, 'non-regular output'):
            self.stage()

    def test_bad_typelib_header(self):
        (self.build / PACKAGE.TYPELIB).write_bytes(b'not a typelib')
        with self.assertRaisesRegex(PACKAGE.PackageError, 'typelib header'):
            self.stage()

    def test_text_only_zip(self):
        self.assertIsNone(PACKAGE.verify(self.archive({})))

    def test_expected_native_not_silently_downgraded(self):
        self.stage()
        with self.assertRaisesRegex(PACKAGE.PackageError, 'missing'):
            PACKAGE.verify(self.archive({}), self.output / PACKAGE.MANIFEST)

    def test_partial_native_package(self):
        with self.assertRaisesRegex(PACKAGE.PackageError, 'Partial'):
            PACKAGE.verify(self.archive({f'native/{PACKAGE.TYPELIB}': self.typelib}))

    def test_empty_native_directory_is_not_text_only(self):
        with self.assertRaisesRegex(PACKAGE.PackageError, 'missing'):
            PACKAGE.verify(self.archive({'native/': b''}))

    def test_native_symlink_rejected(self):
        name = zipfile.ZipInfo(f'native/{PACKAGE.LIBRARY}')
        name.create_system = 3
        name.external_attr = (stat.S_IFLNK | 0o777) << 16
        with self.assertRaisesRegex(PACKAGE.PackageError, 'regular'):
            PACKAGE.verify(self.archive([(name, b'../../elsewhere')]))

    def test_duplicate_entries_rejected(self):
        with self.assertRaisesRegex(PACKAGE.PackageError, 'Duplicate'):
            PACKAGE.verify(self.archive([('other', b'a'), ('other', b'b')]))

    def test_paths_rejected_without_extraction(self):
        for name in ['../escape', '/absolute', 'native/../evil', 'native//evil',
                     'native/./evil', 'C:/evil', 'native\\evil']:
            with self.subTest(name=name), self.assertRaisesRegex(PACKAGE.PackageError, 'path'):
                PACKAGE.verify(self.archive({name: b''}))
        self.assertFalse((self.root.parent / 'escape').exists())

    def test_unexpected_native_file(self):
        with self.assertRaisesRegex(PACKAGE.PackageError, 'Unexpected'):
            PACKAGE.verify(self.archive({'native/extra.so': b''}))

    def test_payload_tamper(self):
        self.stage()
        entries = {f'native/{name}': (self.output / name).read_bytes() for name in PACKAGE.REQUIRED}
        entries[f'native/{PACKAGE.LIBRARY}'] += b'changed'
        with self.assertRaisesRegex(PACKAGE.PackageError, 'hash/size'):
            PACKAGE.verify(self.archive(entries))

    def test_expected_manifest_tamper(self):
        self.stage()
        expected = self.root / 'expected.json'
        document = json.loads((self.output / PACKAGE.MANIFEST).read_text())
        document['mutter_api'] = '16'
        expected.write_text(json.dumps(document))
        with self.assertRaisesRegex(PACKAGE.PackageError, 'differs'):
            PACKAGE.verify(self.archive(), expected)

    def test_duplicate_manifest_json_keys(self):
        with self.assertRaisesRegex(PACKAGE.PackageError, 'Duplicate JSON'):
            PACKAGE.parse_manifest(b'{"format":1,"format":1}')

    def clean_stage_mock(self, project='gsconnect-native-clipboard', destination=None,
                         multiple=False, symlink=False, dynamic=None):
        destination = destination or '/usr/local/lib/libgsc-clipboard-1.so.0.1.0'
        calls = []
        destdirs = []
        mapping = {str(self.real_library): destination,
                   PACKAGE.LIBRARY: '/usr/local/lib/' + PACKAGE.LIBRARY,
                   'libgsc-clipboard-1.so': '/usr/local/lib/libgsc-clipboard-1.so'}
        if multiple:
            mapping[str(self.build / PACKAGE.LIBRARY)] = '/usr/lib/' + PACKAGE.LIBRARY

        def run(command, **kwargs):
            calls.append(command)
            if command[0] == 'readelf':
                return subprocess.CompletedProcess(command, 0, self.dynamic if dynamic is None else dynamic, '')
            self.assertEqual(command[0], '/fake/meson')
            self.assertEqual(kwargs['env']['LC_ALL'], 'C')
            destdir = Path(kwargs['env']['DESTDIR'])
            self.assertTrue(destdir.is_absolute())
            destdirs.append(destdir)
            if '--projectinfo' in command:
                output = json.dumps({'descriptive_name': project})
            elif '--installed' in command:
                output = json.dumps(mapping)
            else:
                self.assertEqual(command[1:5], ['install', '--no-rebuild', '-C', str(self.build)])
                self.assertEqual(command[5:], ['--destdir', str(destdir)])
                target = destdir / destination.lstrip('/')
                target.parent.mkdir(parents=True, exist_ok=True)
                if symlink:
                    target.symlink_to(self.real_library)
                else:
                    target.write_bytes(self.library + b'-installed')
                output = ''
            return subprocess.CompletedProcess(command, 0, output, '')
        with patch.object(PACKAGE.subprocess, 'run', side_effect=run):
            result = PACKAGE.stage(self.build, self.output, '17', clean_install=True, meson='/fake/meson')
        self.assertTrue(all(not path.exists() for path in destdirs))
        return result, calls

    def test_clean_install_uses_only_temporary_destdir_and_installed_library(self):
        result, calls = self.clean_stage_mock()
        self.assertEqual(result['mutter_api'], '17')
        self.assertEqual((self.output / PACKAGE.LIBRARY).read_bytes(), self.library + b'-installed')
        self.assertEqual(self.real_library.read_bytes(), self.library)
        self.assertEqual(sum('install' in call for call in calls), 1)

    def test_clean_install_rejects_wrong_project_before_install(self):
        with self.assertRaisesRegex(PACKAGE.PackageError, 'only the gsconnect'):
            self.clean_stage_mock(project='gsconnect')

    def test_clean_install_rejects_ambiguous_library_mapping(self):
        with self.assertRaisesRegex(PACKAGE.PackageError, 'one real native'):
            self.clean_stage_mock(multiple=True)

    def test_clean_install_rejects_destination_traversal(self):
        with self.assertRaisesRegex(PACKAGE.PackageError, 'Unsafe'):
            self.clean_stage_mock(destination='/usr/../../../libgsc-clipboard-1.so.0.1.0')

    def test_clean_install_rejects_installed_symlink_escape(self):
        with self.assertRaisesRegex(PACKAGE.PackageError, 'local regular'):
            self.clean_stage_mock(symlink=True)

    def test_clean_install_is_not_a_runpath_bypass(self):
        with self.assertRaisesRegex(PACKAGE.PackageError, 'RPATH/RUNPATH'):
            self.clean_stage_mock(dynamic=self.dynamic + ' 3 (RUNPATH) Library runpath: [/bad]\n')

    @unittest.skipUnless(shutil.which('meson') and shutil.which('gcc') and shutil.which('readelf'),
                         'requires Meson, GCC and readelf')
    def test_real_meson_clean_install_removes_build_runpath_without_running_helper(self):
        # Stub project exercises official Meson install/RPATH handling only.
        # Neither the stub helper nor its stub dependency is executed.
        source = self.root / 'meson-source'
        source.mkdir()
        build = self.root / 'meson-build'
        (source / 'dependency.c').write_text('void dep(void) {}\n')
        (source / 'helper.c').write_text('extern void dep(void); void helper(void) { dep(); }\n')
        (source / 'meson.build').write_text("""
project('gsconnect-native-clipboard', 'c')
dep = library('mutter-17', 'dependency.c', soversion: '0', install: false)
library('gsc-clipboard-1', 'helper.c', version: '0.1.0', link_with: dep,
  install: true, install_rpath: '')
""")
        meson = shutil.which('meson')
        environment = os.environ.copy()
        environment['CC'] = 'gcc'
        subprocess.run([meson, 'setup', str(build), str(source)], env=environment,
                       check=True, capture_output=True, timeout=60)
        subprocess.run([meson, 'compile', '-C', str(build)], env=environment,
                       check=True, capture_output=True, timeout=60)
        (build / PACKAGE.TYPELIB).write_bytes(self.typelib)
        (build / 'GscClipboard-1.0.gir').write_bytes(self.gir.read_bytes())
        with self.assertRaisesRegex(PACKAGE.PackageError, 'RPATH/RUNPATH'):
            PACKAGE.stage(build, self.output, '17')
        manifest = PACKAGE.stage(build, self.output, '17', clean_install=True, meson=meson)
        self.assertEqual(PACKAGE.verify(self.archive()), manifest)

    def test_cli_reports_text_only(self):
        stdout = io.StringIO()
        with contextlib.redirect_stdout(stdout):
            self.assertEqual(PACKAGE.main(['verify', '--zip', str(self.archive({}))]), 0)
        self.assertIn('text-only', stdout.getvalue())


if __name__ == '__main__':
    unittest.main()
