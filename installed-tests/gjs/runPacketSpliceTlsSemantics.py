#!/usr/bin/env python3
"""TEST-ONLY candidate TLS semantics. Explicit opt-in, stop on first failure."""
import argparse
import hashlib
import os
from pathlib import Path
import re
import selectors
import stat
import subprocess
import tempfile
import time

# Reuse only certificate creation and owned-process cleanup, never its case/client.
from runPacketSpliceTlsNative import certificates, terminate, CORE_HASH

MODES = ['concurrent', 'pre-cancel', 'closed', 'blocked-cancel']
PREFIX = ['CONNECT_START', 'CONNECTED', 'TLS_VERIFIED']
STAGES = {
    'concurrent': PREFIX + ['WRITE_START', 'SECOND_PENDING', 'WRITE_SETTLED', 'CLOSE_START', 'CLOSED'],
    'pre-cancel': PREFIX + ['WRITE_START', 'EXPECTED_CANCELLED', 'WRITE_SETTLED', 'CLOSE_START', 'CLOSED'],
    'closed': PREFIX + ['CLOSE_START', 'CLOSED', 'WRITE_START', 'EXPECTED_CLOSED', 'WRITE_SETTLED'],
    'blocked-cancel': PREFIX + ['PEER_PAUSED', 'WRITE_START', 'EXPECTED_CANCELLED', 'WRITE_SETTLED', 'FORCED_CLOSED'],
}
READY = re.compile(rb'READY ([1-9][0-9]{0,4})\n')
RESULT = re.compile(rb'RESULT ([0-9]+) ([0-9a-f]{64}) EOF=1\n')
CANCEL_RESULT = re.compile(rb'CANCEL_RESULT ([0-9]+) ([0-9a-f]{64}) EOF=0 REASON=(TLS_EOF|CONNECTION_CLOSED)\n')
EXPECT = re.compile(rb'EXPECT ([0-9]+) ([0-9a-f]{64})\n')
CANCELLED = re.compile(rb'CANCELLED ([0-9]+) ([0-9a-f]{64})\n')
LIMIT = 2 * 1024 * 1024


def line_with_deadline(stream, seconds=5):
    """Bound both line length and elapsed wait; no blocking buffered readline."""
    deadline = time.monotonic() + seconds
    line = b''
    with selectors.DefaultSelector() as selector:
        selector.register(stream, selectors.EVENT_READ)
        while not line.endswith(b'\n'):
            remaining = deadline - time.monotonic()
            if remaining <= 0 or not selector.select(remaining):
                raise RuntimeError('Native control protocol timeout')
            value = os.read(stream.fileno(), 1)
            if not value or len(line) >= 100:
                raise RuntimeError('Native control protocol EOF/line limit')
            line += value
    return line


def last_stage(output, mode):
    """Log recognized sequential enum only, never arbitrary process output."""
    found = 0
    for line in (output or b'').splitlines():
        if found < len(STAGES[mode]) and line == ('STAGE ' + STAGES[mode][found]).encode():
            found += 1
    return STAGES[mode][found - 1] if found else 'none'


def validate(mode, output, server_output, expected_bytes):
    """Distinct complete-transfer and interrupted-prefix contracts."""
    lines = output.splitlines(keepends=True)
    stages = [('STAGE ' + stage + '\n').encode() for stage in STAGES[mode]]
    if len(output) > 2048 or len(lines) != len(stages) + 1 or lines[:-1] != stages:
        raise RuntimeError('Client stage protocol mismatch')
    if mode == 'blocked-cancel':
        client, server = CANCELLED.fullmatch(lines[-1]), CANCEL_RESULT.fullmatch(server_output)
        if not client or not server:
            raise RuntimeError('Expected-cancellation protocol mismatch')
        length = int(server[1])
        if (int(client[1]) != len(expected_bytes) or
                client[2].decode() != hashlib.sha256(expected_bytes).hexdigest() or
                not 0 < length < len(expected_bytes) <= LIMIT or
                server[2].decode() != hashlib.sha256(expected_bytes[:length]).hexdigest()):
            raise RuntimeError('Interrupted-prefix bound/hash mismatch')
        return 'native CANCELLED, authenticated interrupted prefix verified; EOF=0'
    client, server = EXPECT.fullmatch(lines[-1]), RESULT.fullmatch(server_output)
    wanted = expected_bytes if mode == 'concurrent' else b''
    if (not client or not server or client.groups() != server.groups() or
            int(server[1]) != len(wanted) or len(wanted) > LIMIT or
            server[2].decode() != hashlib.sha256(wanted).hexdigest()):
        raise RuntimeError('Complete EOF length/hash mismatch')
    return 'native error/concurrency semantics with exact EOF=1'


def case(binary, package, client, mode, root, env):
    server = child = None
    output = b''
    try:
        server = subprocess.Popen([str(binary), '--isolated-test', str(root / 'server.pem'),
            str(root / 'server.key'), str(root / 'ca.pem'), str(root / 'client.pem'),
            'controlled-pause' if mode == 'blocked-cancel' else 'receive'],
            cwd=root, env=env, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
            stderr=subprocess.PIPE, bufsize=0, start_new_session=True)
        ready = READY.fullmatch(line_with_deadline(server.stdout))
        if not ready or not 1 <= int(ready[1]) <= 65535:
            raise RuntimeError('Invalid loopback port')
        child = subprocess.Popen(['gjs', '-m', str(client), '--run-reviewed-candidate-tls-semantics',
            str(package), str(root), ready[1].decode(), mode], cwd=root, env=env,
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            start_new_session=True)
        if mode == 'blocked-cancel':
            if line_with_deadline(server.stdout) != b'PAUSED\n':
                raise RuntimeError('Authenticated peer pause not confirmed')
            # Server cannot read application bytes until our later DRAIN command.
            child.stdin.write(b'GO\n')
            child.stdin.flush()
        try:
            output, errors = child.communicate(timeout=18)
        except subprocess.TimeoutExpired as error:
            raise RuntimeError(f'Client timeout last_stage={last_stage(error.output, mode)}') from None
        if child.returncode != 0 or errors:
            raise RuntimeError(f'Client failure exit={child.returncode} last_stage={last_stage(output, mode)}')
        # Verify expected local fixture before permitting peer drain.
        expected_file = root / 'expected.bin'
        info = expected_file.lstat()
        if (not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or
                info.st_mode & 0o777 != 0o600 or not 0 < info.st_size <= LIMIT):
            raise RuntimeError('Unsafe expected fixture file')
        expected_bytes = expected_file.read_bytes()
        if mode == 'blocked-cancel':
            # A malformed client cannot release the peer or pass as cancellation.
            lines = output.splitlines(keepends=True)
            stages = [('STAGE ' + stage + '\n').encode() for stage in STAGES[mode]]
            if lines[:-1] != stages or not CANCELLED.fullmatch(lines[-1]):
                raise RuntimeError('Client did not confirm settled cancellation')
        try:
            server_output, server_errors = server.communicate(
                input=b'DRAIN\n' if mode == 'blocked-cancel' else b'', timeout=5)
        except subprocess.TimeoutExpired:
            raise RuntimeError(f'Peer drain timeout last_stage={last_stage(output, mode)}') from None
        if server.returncode != 0 or server_errors:
            raise RuntimeError(f'Peer failure exit={server.returncode} last_stage={last_stage(output, mode)}')
        description = validate(mode, output, server_output, expected_bytes)
        print(f'PASS candidate semantics {mode}: {description}')
    finally:
        try:
            terminate(child)
        finally:
            terminate(server)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--run-reviewed-candidate-tls-semantics', action='store_true')
    parser.add_argument('--server-binary', required=True, type=Path)
    parser.add_argument('--package', required=True, type=Path)
    parser.add_argument('--case', choices=MODES)
    args = parser.parse_args()
    if not args.run_reviewed_candidate_tls_semantics:
        parser.error('TEST-ONLY: explicit reviewed opt-in required')
    binary, package = args.server_binary.resolve(strict=True), args.package.resolve(strict=True)
    if not binary.is_file() or not os.access(binary, os.X_OK):
        parser.error('Explicit precompiled semantics server required')
    if hashlib.sha256((package / 'service/core.js').read_bytes()).hexdigest() != CORE_HASH:
        parser.error('Package core hash mismatch')
    client = Path(__file__).with_name('testPacketSpliceTlsSemanticsClient.js').resolve(strict=True)
    os.umask(0o077)
    with tempfile.TemporaryDirectory(prefix='gsconnect-tls-semantics-') as temp:
        root = Path(temp)
        assert root.stat().st_mode & 0o777 == 0o700
        for mode in [args.case] if args.case else MODES:
            work = root / mode
            work.mkdir(mode=0o700)
            env = {'PATH': '/usr/bin:/bin', 'LANG': 'C.UTF-8', 'HOME': str(work), 'TMPDIR': str(work)}
            certificates(work, env)
            case(binary, package, client, mode, work, env)


if __name__ == '__main__':
    main()
