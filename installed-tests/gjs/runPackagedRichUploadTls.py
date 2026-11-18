#!/usr/bin/env python3
"""Run upload with a private CA and loopback-only independent TLS client."""
import hashlib
import os
from pathlib import Path
import re
import resource
import selectors
import signal
import socket
import ssl
import subprocess
import sys
import time


def main():
    root = Path.cwd()
    if not re.fullmatch(r'\.gsconnect-tls-check\.[A-Za-z0-9]+', root.name) or \
            os.environ.get('HOME') != str(root / 'home') or any(
                os.environ.get(key) for key in ['DISPLAY', 'WAYLAND_DISPLAY', 'DBUS_SESSION_BUS_ADDRESS']):
        raise RuntimeError('Private fixture environment required')
    if len(sys.argv) != 2:
        raise RuntimeError('Expected verified package directory')
    resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
    cert = root / 'certs'
    context = ssl.create_default_context(ssl.Purpose.SERVER_AUTH, cafile=cert / 'ca.pem')
    context.load_cert_chain(cert / 'client.pem', cert / 'client.key')
    leaf = (cert / 'server.pem').read_text().split('-----END CERTIFICATE-----')[0]
    expected = ssl.PEM_cert_to_DER_cert(leaf + '-----END CERTIFICATE-----\n')
    for mode in ['success', 'zero', 'short', 'accept-cancel', 'pre-cancel', 'transfer-cancel']:
        child = subprocess.Popen(['timeout', '--kill-after=3s', '20s', 'gjs', '-m',
                                  str(Path(__file__).with_name('testPackagedRichUploadTls.js')),
                                  sys.argv[1], mode], env=dict(os.environ), cwd=root,
                                 stdout=subprocess.PIPE, stderr=subprocess.PIPE, start_new_session=True)
        try:
            with selectors.DefaultSelector() as selector:
                selector.register(child.stdout, selectors.EVENT_READ)
                if not selector.select(timeout=10):
                    raise RuntimeError('No upload readiness')
                line = child.stdout.readline()
            if mode == 'pre-cancel':
                assert line.startswith(b'PASS upload pre-cancel:'), line
            else:
                match = re.fullmatch(rb'READY ([0-9]+)\n', line)
                assert match, line
                port = int(match[1])
                assert 1 <= port <= 65535
                if mode != 'accept-cancel':
                    with socket.create_connection(('127.0.0.1', port), timeout=8) as raw:
                        assert raw.getpeername()[0] == '127.0.0.1'
                        with context.wrap_socket(raw, server_hostname='localhost') as tls:
                            assert tls.getpeercert(binary_form=True) == expected
                            if mode == 'transfer-cancel':
                                time.sleep(0.2)  # Hold reads so the sender's bounded cancel fires.
                            data = bytearray()
                            try:
                                while True:
                                    chunk = tls.recv(65536)
                                    if not chunk:
                                        break
                                    data.extend(chunk)
                                    assert len(data) <= 16 * 1024 * 1024
                            except (ssl.SSLEOFError, ConnectionResetError):
                                if mode != 'transfer-cancel':
                                    raise
                            if mode == 'transfer-cancel':
                                assert len(data) < 16 * 1024 * 1024
                            else:
                                size = 0 if mode == 'zero' else 2 * 1024 * 1024
                                if mode == 'short':
                                    size -= 1
                                assert len(data) == size
                                expected_data = bytes((i * 31 + i // 251) & 255 for i in range(size))
                                assert hashlib.sha256(data).digest() == hashlib.sha256(expected_data).digest()
                                print(f'HASH {mode}: {hashlib.sha256(data).hexdigest()}', flush=True)
                                tls.unwrap().close()
            output, errors = child.communicate(timeout=12)
            print(line.decode() + output.decode(), end='')
            print(errors.decode(), end='', file=sys.stderr)
            assert child.returncode == 0, f'{mode}: client exit {child.returncode}'
            assert f'PASS upload {mode}:'.encode() in line + output, 'missing result marker'
            assert not errors, f'{mode}: unexpected runtime diagnostics'
        finally:
            if child.poll() is None:
                os.killpg(child.pid, signal.SIGTERM)
                try:
                    child.wait(timeout=4)
                except subprocess.TimeoutExpired:
                    os.killpg(child.pid, signal.SIGKILL)
                    child.wait()
    print('PASS production upload with private loopback seam: 6/6')


if __name__ == '__main__':
    main()
