#!/usr/bin/env python3
"""TEST-ONLY package Core TCP fixture; explicit opt-in after independent review."""
import argparse
from pathlib import Path
import subprocess
from packagedCoreContract import verify_package
from runPacketSpliceTlsNative import terminate


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--run-reviewed-packaged-core-loopback', action='store_true')
    parser.add_argument('--zip', type=Path, required=True)
    parser.add_argument('--package', type=Path, required=True)
    args = parser.parse_args()
    if not args.run_reviewed_packaged_core_loopback:
        parser.error('TEST-ONLY package fixture requires explicit opt-in')
    package = verify_package(args.zip, args.package)
    script = Path(__file__).with_name('testPackagedCoreLoopback.js').resolve(strict=True)
    process = None
    try:
        process = subprocess.Popen(['gjs', '-m', str(script),
            '--run-reviewed-packaged-core-loopback', str(package)],
            env={'PATH': '/usr/bin:/bin', 'LANG': 'C.UTF-8'}, start_new_session=True)
        if process.wait(timeout=20) != 0:
            raise RuntimeError('Packaged Core TCP regression failed; stop')
    finally:
        terminate(process)


if __name__ == '__main__':
    main()
