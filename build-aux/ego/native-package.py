#!/usr/bin/env python3
# SPDX-FileCopyrightText: GSConnect Developers https://github.com/GSConnect
# SPDX-License-Identifier: GPL-2.0-or-later
"""Stage and verify the optional ABI-matched native clipboard package.

Reads ELF metadata with readelf; never executes native code or extracts a ZIP.
An embedded manifest proves consistency, not authenticity or runtime ABI safety.
Use --manifest with a trusted staged manifest to pin the expected artifact.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import stat
import subprocess
import sys
import tempfile
import xml.etree.ElementTree as ET
import zipfile

TYPELIB = 'GscClipboard-1.0.typelib'
LIBRARY = 'libgsc-clipboard-1.so.0'
MANIFEST = 'native-clipboard-manifest.json'
PAYLOADS = {TYPELIB, LIBRARY}
REQUIRED = PAYLOADS | {MANIFEST}
CORE = '{http://www.gtk.org/introspection/core/1.0}'
MAX_MANIFEST = 64 * 1024
MAX_PAYLOAD = 128 * 1024 * 1024
TYPELIB_MAGIC = b'GOBJ\nMETADATA\r\n\x1a'


class PackageError(ValueError):
    """An invalid or inconsistent native package."""


def api_number(value):
    value = str(value)
    if not re.fullmatch(r'[1-9][0-9]{0,2}', value):
        raise PackageError('Mutter API must be a positive 1–3 digit number')
    return value


def read_regular(path, limit):
    """Read a bounded regular file; reject final-component symlink races."""
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(fd, 'rb') as stream:
        info = os.fstat(stream.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_size > limit:
            raise PackageError(f'Not a bounded regular file: {path}')
        data = stream.read(limit + 1)
        if len(data) > limit:
            raise PackageError(f'File grew past size limit: {path}')
        return data


def build_file(root, name, limit):
    path = (root / name).resolve(strict=True)
    if not path.is_relative_to(root):
        raise PackageError(f'Build symlink escapes its directory: {name}')
    return path, read_regular(path, limit)


def inspect_gir(data, api):
    if b'<!DOCTYPE' in data.upper() or b'<!ENTITY' in data.upper():
        raise PackageError('GIR declarations/entities are not accepted')
    root = ET.fromstring(data)
    namespaces = root.findall(f'{CORE}namespace')
    if len(namespaces) != 1:
        raise PackageError('Expected one GIR namespace')
    namespace = namespaces[0]
    if (namespace.get('name') != 'GscClipboard' or namespace.get('version') != '1.0' or
            namespace.get('shared-library') != LIBRARY):
        raise PackageError('Unexpected GIR namespace/version/shared-library')
    metas = [node.get('version') for node in root.findall(f'{CORE}include')
             if node.get('name') == 'Meta']
    if metas != [api]:
        raise PackageError(f'GIR must depend on exactly Meta-{api}')


def inspect_elf(path, data, api):
    if not data.startswith(b'\x7fELF'):
        raise PackageError('Native library is not an ELF file')
    environment = os.environ.copy()
    environment['LC_ALL'] = 'C'
    result = subprocess.run(['readelf', '-d', '--', str(path)], env=environment,
                            capture_output=True, text=True, check=True, timeout=30)
    sonames = re.findall(r'\(SONAME\)[^\n]*\[([^\]]+)\]', result.stdout)
    needed = re.findall(r'\(NEEDED\)[^\n]*\[([^\]]+)\]', result.stdout)
    search_paths = re.findall(r'\((?:RPATH|RUNPATH)\)[^\n]*\[([^\]]*)\]', result.stdout)
    if any(search_paths):
        raise PackageError('ELF has nonempty RPATH/RUNPATH; use a clean staged install, not raw build output')
    if sonames != [LIBRARY]:
        raise PackageError(f'ELF SONAME must be exactly {LIBRARY}')
    mutter_libraries = [name for name in needed if name.startswith('libmutter-')]
    if mutter_libraries != [f'libmutter-{api}.so.0']:
        raise PackageError(f'ELF must depend on exactly libmutter-{api}.so.0')


def make_manifest(api, payloads):
    return {'format': 1, 'mutter_api': api, 'namespace': 'GscClipboard',
            'namespace_version': '1.0', 'files': {
                name: {'sha256': hashlib.sha256(data).hexdigest(), 'size': len(data)}
                for name, data in sorted(payloads.items())}}


def reject_duplicate_keys(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise PackageError(f'Duplicate JSON manifest key: {key}')
        result[key] = value
    return result


def parse_manifest(data):
    if len(data) > MAX_MANIFEST:
        raise PackageError('Manifest exceeds size limit')
    value = json.loads(data, object_pairs_hook=reject_duplicate_keys)
    if (not isinstance(value, dict) or set(value) != {
            'format', 'mutter_api', 'namespace', 'namespace_version', 'files'} or
            type(value['format']) is not int or value['format'] != 1 or
            value['namespace'] != 'GscClipboard' or value['namespace_version'] != '1.0'):
        raise PackageError('Unsupported native manifest schema')
    if not isinstance(value['mutter_api'], str):
        raise PackageError('Manifest Mutter API must be a string')
    api_number(value['mutter_api'])
    if not isinstance(value['files'], dict) or set(value['files']) != PAYLOADS:
        raise PackageError('Manifest must name exactly both native payloads')
    for entry in value['files'].values():
        if (not isinstance(entry, dict) or set(entry) != {'sha256', 'size'} or
                not isinstance(entry['sha256'], str) or
                not re.fullmatch(r'[0-9a-f]{64}', entry['sha256']) or
                type(entry['size']) is not int or not 0 < entry['size'] <= MAX_PAYLOAD):
            raise PackageError('Invalid manifest digest or size')
    return value


def clean_install_stage(build_dir, output_dir, mutter_api, meson):
    """Use this helper project's official install logic in an isolated DESTDIR."""
    root = Path(build_dir).resolve(strict=True)
    with tempfile.TemporaryDirectory(prefix='gsconnect-native-install-') as directory:
        temporary = Path(directory)
        destdir = temporary / 'destdir'
        artifact = temporary / 'artifact-input'
        destdir.mkdir()
        artifact.mkdir()
        environment = os.environ.copy()
        environment['LC_ALL'] = 'C'
        environment['DESTDIR'] = str(destdir)

        def run(arguments):
            return subprocess.run([str(meson), *arguments], env=environment,
                                  capture_output=True, text=True, check=True, timeout=120)

        project = json.loads(run(['introspect', '--projectinfo', str(root)]).stdout)
        if not isinstance(project, dict) or project.get('descriptive_name') != 'gsconnect-native-clipboard':
            raise PackageError('Clean install accepts only the gsconnect-native-clipboard Meson project')
        installed = json.loads(run(['introspect', '--installed', str(root)]).stdout)
        if not isinstance(installed, dict):
            raise PackageError('Invalid Meson installed-file mapping')
        candidates = [(source, destination) for source, destination in installed.items()
                      if isinstance(source, str) and Path(source).is_absolute() and
                      Path(source).name.startswith('libgsc-clipboard-1.so')]
        if len(candidates) != 1:
            raise PackageError('Expected one real native library in the Meson install mapping')
        source, destination = candidates[0]
        source_path = Path(source)
        if source_path.is_symlink() or not source_path.resolve(strict=True).is_relative_to(root):
            raise PackageError('Mapped native library is outside the selected build directory')
        if (not isinstance(destination, str) or '\\' in destination or '\x00' in destination or
                not destination.startswith('/') or '..' in PurePosixPath(destination).parts or
                not Path(destination).name.startswith('libgsc-clipboard-1.so')):
            raise PackageError('Unsafe native library install destination')
        # These original inputs must also stay within the selected build tree.
        _, gir = build_file(root, 'GscClipboard-1.0.gir', 8 * 1024 * 1024)
        _, typelib = build_file(root, TYPELIB, MAX_PAYLOAD)
        run(['install', '--no-rebuild', '-C', str(root), '--destdir', str(destdir)])
        installed_library = destdir / destination.lstrip('/')
        resolved = installed_library.resolve(strict=True)
        if installed_library.is_symlink() or not resolved.is_relative_to(destdir):
            raise PackageError('Installed native library is not a local regular artifact')
        library = read_regular(resolved, MAX_PAYLOAD)
        (artifact / 'GscClipboard-1.0.gir').write_bytes(gir)
        (artifact / TYPELIB).write_bytes(typelib)
        (artifact / LIBRARY).write_bytes(library)
        # Reuse all GIR/ELF/hash checks; clean install is not a bypass for RPATH.
        return stage(artifact, output_dir, mutter_api)


def stage(build_dir, output_dir, mutter_api, clean_install=False, meson='meson'):
    build_dir, output_dir = Path(build_dir), Path(output_dir)
    if not build_dir.is_absolute() or not output_dir.is_absolute():
        raise PackageError('Build and output directories must be absolute')
    if clean_install:
        return clean_install_stage(build_dir, output_dir, mutter_api, meson)
    root = build_dir.resolve(strict=True)
    if not root.is_dir():
        raise PackageError('Build directory is not a directory')
    api = api_number(mutter_api)
    _, gir = build_file(root, 'GscClipboard-1.0.gir', 8 * 1024 * 1024)
    _, typelib = build_file(root, TYPELIB, MAX_PAYLOAD)
    library_path, library = build_file(root, LIBRARY, MAX_PAYLOAD)
    if not typelib.startswith(TYPELIB_MAGIC):
        raise PackageError('Invalid typelib header')
    inspect_gir(gir, api)
    inspect_elf(library_path, library, api)
    # Re-read after readelf to catch ordinary build output replacement races.
    if read_regular(library_path, MAX_PAYLOAD) != library:
        raise PackageError('Native library changed while checking metadata')
    payloads = {TYPELIB: typelib, LIBRARY: library}
    manifest = make_manifest(api, payloads)
    payloads[MANIFEST] = (json.dumps(manifest, sort_keys=True, indent=2) + '\n').encode()
    output_dir.mkdir(parents=True, exist_ok=True)
    output = output_dir.resolve(strict=True)
    for name in REQUIRED:
        target = output / name
        if target.is_symlink() or (target.exists() and not target.is_file()):
            raise PackageError(f'Refusing non-regular output: {target}')
    # The manifest is written last. Interrupted staging cannot verify as a
    # consistent package; installation must use only successfully verified data.
    for name in [TYPELIB, LIBRARY, MANIFEST]:
        with tempfile.NamedTemporaryFile(dir=output, prefix=f'.{name}.', delete=False) as stream:
            temporary = Path(stream.name)
            try:
                stream.write(payloads[name])
                stream.flush()
                os.fsync(stream.fileno())
            except BaseException:
                temporary.unlink(missing_ok=True)
                raise
        try:
            temporary.chmod(0o644)
            temporary.replace(output / name)
        finally:
            temporary.unlink(missing_ok=True)
    return manifest


def safe_zip_name(info):
    name = info.filename
    if ('\x00' in info.orig_filename or '\\' in name or name.startswith('/') or
            not name or any(part in {'', '.', '..'} for part in name.rstrip('/').split('/')) or
            ':' in name.split('/')[0]):
        raise PackageError(f'Unsafe ZIP path: {name!r}')
    if str(PurePosixPath(name.rstrip('/'))) != name.rstrip('/'):
        raise PackageError(f'Noncanonical ZIP path: {name!r}')
    return name


def verify(zip_path, expected_manifest=None):
    expected = None
    if expected_manifest is not None:
        expected = parse_manifest(read_regular(Path(expected_manifest), MAX_MANIFEST))
    with zipfile.ZipFile(zip_path) as archive:
        seen = set()
        native = {}
        for info in archive.infolist():
            name = safe_zip_name(info)
            canonical = name.rstrip('/')
            if canonical in seen:
                raise PackageError(f'Duplicate ZIP entry: {name}')
            seen.add(canonical)
            if canonical == 'native' and name.endswith('/'):
                mode = (info.external_attr >> 16) & 0xFFFF
                if stat.S_IFMT(mode) not in {0, stat.S_IFDIR}:
                    raise PackageError('Native directory entry is not a directory')
                continue
            if canonical == 'native' or name.startswith('native/'):
                relative = name.removeprefix('native/')
                if relative not in REQUIRED or info.is_dir():
                    raise PackageError(f'Unexpected native ZIP entry: {name}')
                mode = (info.external_attr >> 16) & 0xFFFF
                if stat.S_IFMT(mode) not in {0, stat.S_IFREG} or info.flag_bits & 1:
                    raise PackageError(f'Native ZIP entry is not a plain regular file: {name}')
                limit = MAX_MANIFEST if relative == MANIFEST else MAX_PAYLOAD
                if info.file_size > limit:
                    raise PackageError(f'Native ZIP entry exceeds size limit: {name}')
                native[relative] = info
        if not native:
            if 'native' in seen or expected is not None:
                raise PackageError('Native package is missing its required files')
            return None  # Explicitly supported text-only extension ZIP.
        if set(native) != REQUIRED:
            raise PackageError('Partial native package: all three native files are required')
        manifest = parse_manifest(archive.read(native[MANIFEST]))
        if expected is not None and manifest != expected:
            raise PackageError('ZIP manifest differs from the expected staged manifest')
        for name in PAYLOADS:
            digest = hashlib.sha256()
            total = 0
            prefix = b''
            with archive.open(native[name]) as stream:
                while chunk := stream.read(1024 * 1024):
                    if not prefix:
                        prefix = chunk[:16]
                    total += len(chunk)
                    if total > MAX_PAYLOAD:
                        raise PackageError('Expanded native payload exceeds size limit')
                    digest.update(chunk)
            entry = manifest['files'][name]
            if total != entry['size'] or digest.hexdigest() != entry['sha256']:
                raise PackageError(f'ZIP payload hash/size mismatch: {name}')
            magic = TYPELIB_MAGIC if name == TYPELIB else b'\x7fELF'
            if not prefix.startswith(magic):
                raise PackageError(f'Invalid native payload header: {name}')
        return manifest


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest='command', required=True)
    staging = commands.add_parser('stage')
    staging.add_argument('--build-dir', required=True)
    staging.add_argument('--output-dir', required=True)
    staging.add_argument('--mutter-api', required=True)
    staging.add_argument('--clean-install', action='store_true',
                         help='Use the native helper project install logic in a temporary DESTDIR')
    staging.add_argument('--meson', default='meson', help='Meson executable for --clean-install')
    checking = commands.add_parser('verify')
    checking.add_argument('--zip', required=True)
    checking.add_argument('--manifest')
    args = parser.parse_args(argv)
    try:
        if args.command == 'stage':
            result = stage(args.build_dir, args.output_dir, args.mutter_api,
                           clean_install=args.clean_install, meson=args.meson)
            print(f"Staged native clipboard for Meta-{result['mutter_api']}")
        else:
            result = verify(args.zip, args.manifest)
            print('Verified text-only ZIP' if result is None else
                  f"Verified native ZIP for Meta-{result['mutter_api']} (hashes, not runtime ABI)")
        return 0
    except (OSError, ValueError, ET.ParseError, zipfile.BadZipFile,
            subprocess.SubprocessError) as error:
        print(f'native-package: {error}', file=sys.stderr)
        return 1


if __name__ == '__main__':
    sys.exit(main())
