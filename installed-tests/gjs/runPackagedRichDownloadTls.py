#!/usr/bin/env python3
"""Private-fixture only: isolated Python TLS server for packaged GJS download.

Run inside .gsconnect-tls-check.<random>, HOME=$PWD/home, with disposable
CA/server/client PEM+key files in certs/. No certificate or host settings changed.
"""
import os
from pathlib import Path
import re
import resource
import socket
import ssl
import subprocess
import sys
import threading


def main():
    root = Path.cwd()
    if not re.fullmatch(r'\.gsconnect-tls-check\.[A-Za-z0-9]+', root.name):
        raise RuntimeError('Private fixture directory required')
    if os.environ.get('HOME') != str(root / 'home') or any(
            os.environ.get(key) for key in ['DISPLAY', 'WAYLAND_DISPLAY', 'DBUS_SESSION_BUS_ADDRESS']):
        raise RuntimeError('Empty private HOME and no desktop/session bus required')
    if len(sys.argv) != 2:
        raise RuntimeError('Expected verified package directory')
    resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
    os.umask(0o077)
    cert = root / 'certs'
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    context.minimum_version = ssl.TLSVersion.TLSv1_2
    context.load_cert_chain(cert / 'server.pem', cert / 'server.key')
    context.load_verify_locations(cert / 'ca.pem')
    context.verify_mode = ssl.CERT_REQUIRED
    leaf = (cert / 'client.pem').read_text().split('-----END CERTIFICATE-----')[0]
    expected = ssl.PEM_cert_to_DER_cert(leaf + '-----END CERTIFICATE-----\n')
    client = Path(__file__).with_name('testPackagedRichDownloadTls.js')
    for mode in ['success', 'zero', 'truncated', 'excess',
                 'token-cancel', 'channel-cancel', 'pre-cancel']:
        failures = []
        listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        listener.settimeout(8)
        listener.bind(('127.0.0.1', 0))
        listener.listen(1)
        address, port = listener.getsockname()
        assert address == '127.0.0.1'
        print(f'BOUND {address}:{port}', flush=True)

        def serve():
            try:
                raw, peer = listener.accept()
                with raw:
                    assert peer[0] == '127.0.0.1' and raw.getsockname()[0] == '127.0.0.1'
                    raw.settimeout(8)
                    with context.wrap_socket(raw, server_side=True) as tls:
                        assert tls.getpeercert(binary_form=True) == expected
                        if mode in ['token-cancel', 'channel-cancel']:
                            try:
                                assert tls.recv(1) == b''
                            except ssl.SSLEOFError:
                                pass  # Raw socket cancellation intentionally omits close-notify.
                            return
                        size = 2 * 1024 * 1024 if mode == 'success' else 65536
                        if mode == 'zero':
                            size = 0
                        elif mode == 'truncated':
                            size -= 1
                        elif mode == 'excess':
                            size += 1
                        payload = bytes((i * 31 + i // 251) & 255 for i in range(size))
                        tls.sendall(payload)
                        try:
                            tls.unwrap().close()
                        except (ssl.SSLError, OSError):
                            if mode not in ['excess', 'truncated']:
                                raise
            except Exception as error:
                failures.append(error)

        thread = None
        try:
            if mode != 'pre-cancel':
                thread = threading.Thread(target=serve, daemon=True)
                thread.start()
            result = subprocess.run(['timeout', '--kill-after=3s', '20s', 'gjs', '-m',
                                     str(client), sys.argv[1], mode, str(port)],
                                    cwd=root, env=dict(os.environ), text=True,
                                    capture_output=True, timeout=25)
            print(result.stdout, end='')
            print(result.stderr, end='', file=sys.stderr)
            if thread:
                thread.join(timeout=10)
                assert not thread.is_alive(), 'server did not stop'
            assert not failures, f'{mode}: server failure {failures}'
            assert result.returncode == 0, f'{mode}: client exit {result.returncode}'
        finally:
            listener.close()
            if thread:
                thread.join(timeout=10)
                assert not thread.is_alive(), 'server cleanup incomplete'
    print('PASS separate-process loopback TLS download: 7/7')


if __name__ == '__main__':
    main()
