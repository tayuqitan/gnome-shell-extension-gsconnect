#!/usr/bin/env python3
"""TEST-ONLY package Core entry. Reviewed isolated methods, not full service validation."""
import argparse
import hashlib
import os
from pathlib import Path
import re
import selectors
import signal
import subprocess
import tempfile
import time

STAGES = [b'STAGE ' + item for item in [b'CONNECT_START', b'CONNECTED', b'TLS_VERIFIED',
    b'WRITE_START', b'WRITE_SETTLED', b'CLOSE_START', b'CLOSED']]

from packagedCoreContract import CORE_HASH, verify_package
READY = re.compile(rb'READY ([1-9][0-9]{0,4})\n')
RESULT = re.compile(rb'RESULT ([0-9]+) ([0-9a-f]{64}) EOF=1\n')
EXPECT = re.compile(rb'EXPECT ([0-9]+) ([0-9a-f]{64})\n')


def stage_summary(output):
    """Only report recognized, ordered stage enums, never arbitrary child output."""
    received = []
    for line in (output or b'').splitlines():
        if len(line) <= 80 and len(received) < len(STAGES) and line == STAGES[len(received)]:
            received.append(line)
    return received[-1].decode() if received else 'none'


def command(args, cwd, env):
    """No shell, bounded execution, only explicit test paths."""
    subprocess.run(args, cwd=cwd, env=env, check=True, timeout=15,
                   stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)


def certificates(root, env):
    """Create disposable CA and distinct role-constrained leaves, never reused."""
    command(['openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
             '-keyout', 'ca.key', '-out', 'ca.pem', '-days', '1', '-subj',
             '/CN=Isolated Fixture CA', '-addext', 'basicConstraints=critical,CA:TRUE',
             '-addext', 'keyUsage=critical,keyCertSign,cRLSign'], root, env)
    for role, usage in [('server', 'serverAuth'), ('client', 'clientAuth')]:
        command(['openssl', 'req', '-new', '-newkey', 'rsa:2048', '-nodes',
                 '-keyout', f'{role}.key', '-out', f'{role}.csr', '-subj',
                 f'/CN=fixture-{role}'], root, env)
        (root / f'{role}.ext').write_text(
            'basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\n'
            f'extendedKeyUsage={usage}\nsubjectAltName=DNS:localhost,IP:127.0.0.1\n')
        command(['openssl', 'x509', '-req', '-in', f'{role}.csr', '-CA', 'ca.pem',
                 '-CAkey', 'ca.key', '-CAcreateserial', '-out', f'{role}.pem',
                 '-days', '1', '-extfile', f'{role}.ext'], root, env)
        command(['openssl', 'verify', '-CAfile', 'ca.pem', '-purpose',
                 'sslserver' if role == 'server' else 'sslclient', f'{role}.pem'], root, env)
    for key in root.glob('*.key'):
        key.chmod(0o600)
        if key.stat().st_mode & 0o777 != 0o600:
            raise RuntimeError('Fixture private key mode mismatch')


def terminate(process):
    """Reap only an owned child process group, including on timeout."""
    if process is None:
        return
    if process.poll() is None:
        try:
            os.killpg(process.pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
        try:
            process.wait(timeout=2)
        except subprocess.TimeoutExpired:
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
    process.wait(timeout=2)


def case(binary, package, client, mode, root, env):
    server = child = None
    try:
        server = subprocess.Popen([str(binary), '--isolated-test', str(root / 'server.pem'),
            str(root / 'server.key'), str(root / 'ca.pem'), str(root / 'client.pem'), 'receive'],
            cwd=root, env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            start_new_session=True, bufsize=0)
        with selectors.DefaultSelector() as selector:
            selector.register(server.stdout, selectors.EVENT_READ)
            deadline = time.monotonic() + 5
            line = b''
            while not line.endswith(b'\n'):
                remaining = deadline - time.monotonic()
                if remaining <= 0 or not selector.select(remaining):
                    raise RuntimeError('Native READY timeout')
                byte = os.read(server.stdout.fileno(), 1)
                if not byte or len(line) >= 80:
                    raise RuntimeError('Invalid native READY length/EOF')
                line += byte
        match = READY.fullmatch(line)
        if not match or not 1 <= int(match[1]) <= 65535:
            raise RuntimeError('Invalid native READY protocol')
        child = subprocess.Popen(['gjs', '-m', str(client), '--run-reviewed-packaged-core-tls',
            str(package), str(root), match[1].decode(), mode], cwd=root, env=env,
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, start_new_session=True)
        try:
            output, errors = child.communicate(timeout=18)
        except subprocess.TimeoutExpired as error:
            raise RuntimeError(f'{mode}: client timeout last_stage={stage_summary(error.output)}') from None
        try:
            remainder, server_errors = server.communicate(timeout=5)
        except subprocess.TimeoutExpired:
            raise RuntimeError(f'{mode}: server timeout last_stage={stage_summary(output)}') from None
        # READY was consumed above, communicate returns the remaining RESULT.
        lines = output.splitlines(keepends=True)
        stages_valid = len(output) <= 2048 and all(len(line) <= 100 for line in lines) and len(lines) == len(STAGES) + 1 and [
            line.rstrip(b'\n') for line in lines[:-1]] == STAGES
        expected = EXPECT.fullmatch(lines[-1]) if stages_valid else None
        actual = RESULT.fullmatch(remainder)
        if (child.returncode != 0 or server.returncode != 0 or errors or server_errors or
                expected is None or actual is None or expected.groups() != actual.groups() or
                not 0 < int(actual[1]) <= 2 * 1024 * 1024):
            length_match = bool(expected and actual and expected[1] == actual[1])
            hash_match = bool(expected and actual and expected[2] == actual[2])
            raise RuntimeError(
                f'{mode}: protocol failure last_stage='
                f'{stage_summary(output)} '
                f'client_exit={child.returncode} '
                f'server_exit={server.returncode} client_stderr={bool(errors)} '
                f'server_stderr={bool(server_errors)} expected_valid={expected is not None} '
                f'result_valid={actual is not None} length_match={length_match} '
                f'hash_match={hash_match}')
        print(f'STAGE {mode} EOF_VERIFIED')
        print(f'PASS packaged Core {mode}: separate-process TLS bytes and EOF verified')
    finally:
        try:
            terminate(child)
        finally:
            terminate(server)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--run-reviewed-packaged-core-tls', action='store_true')
    parser.add_argument('--server-binary', type=Path, required=True)
    parser.add_argument('--package', type=Path, required=True)
    parser.add_argument('--zip', required=True, type=Path)
    args = parser.parse_args()
    if not args.run_reviewed_packaged_core_tls:
        parser.error('TEST-ONLY: explicit opt-in required; no certificate or socket action performed')
    binary, package = args.server_binary.resolve(strict=True), args.package.resolve(strict=True)
    if not binary.is_file() or not os.access(binary, os.X_OK):
        parser.error('Explicit precompiled native fixture required')
    if hashlib.sha256((package / 'service/core.js').read_bytes()).hexdigest() != CORE_HASH:
        parser.error('Package core hash mismatch')
    verify_package(args.zip, package)
    client = Path(__file__).with_name('testPackagedCoreTlsClient.js').resolve(strict=True)
    os.umask(0o077)
    with tempfile.TemporaryDirectory(prefix='gsconnect-candidate-tls-') as temp:
        root = Path(temp)
        assert root.stat().st_mode & 0o777 == 0o700
        for mode in ['small', 'unicode', 'large']:
            work = root / mode
            work.mkdir(mode=0o700)
            env = {'PATH': '/usr/bin:/bin', 'LANG': 'C.UTF-8', 'HOME': str(work),
                   'TMPDIR': str(work)}
            certificates(work, env)
            case(binary, package, client, mode, work, env)


if __name__ == '__main__':
    main()
