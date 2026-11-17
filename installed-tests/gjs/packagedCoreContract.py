"""Pinned archive/extraction checks only; importing this module performs no IO."""
import hashlib
from pathlib import Path
import stat
import zipfile

ZIP_HASH = 'f3cf22d2f8e9af39b68e4cae910edb2d1a011631d9564fc4b28b82c2bc321fe5'
CORE_HASH = '44e874a45f30ff0d41b6bdc9cdd9e1d2928df56798e0190751abf8e1bdfb6977'
HASHES = {'service/core.js': CORE_HASH,
          'service/utils/packetBytes.js': '6777fd4ef41813c8b2efedb7ed1f3a91e20534af6de2516de650329f8f2b8752'}


def verify_package(archive, package):
    archive, package = Path(archive), Path(package)
    if hashlib.sha256(archive.read_bytes()).hexdigest() != ZIP_HASH:
        raise ValueError('Package ZIP digest mismatch')
    with zipfile.ZipFile(archive) as zipped:
        for name, digest in HASHES.items():
            file = package / name
            if not stat.S_ISREG(file.lstat().st_mode):
                raise ValueError('Extracted package member must be regular, not symlink')
            data = zipped.read(name)
            if file.read_bytes() != data or hashlib.sha256(data).hexdigest() != digest:
                raise ValueError(f'Archive/extracted member mismatch: {name}')
    return package.resolve(strict=True)
