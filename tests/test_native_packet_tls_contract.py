"""Static/protocol tests ONLY: never execute TLS, OpenSSL or native binaries."""
import ast
import importlib.util
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[1]
RUNNER = ROOT / 'installed-tests/gjs/runPackagedPacketTlsNative.py'
CLIENT = ROOT / 'installed-tests/gjs/testPackagedPacketTlsNativeClient.js'


class NativeFixtureContract(unittest.TestCase):
    def test_python_syntax(self):
        ast.parse(RUNNER.read_text())

    def test_strict_protocol(self):
        spec = importlib.util.spec_from_file_location('native_runner', RUNNER)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)  # main is guarded; no subprocess invoked
        self.assertIsNotNone(module.READY.fullmatch(b'READY 12345\n'))
        self.assertIsNone(module.READY.fullmatch(b'INFO READY 12345\n'))
        digest = b'a' * 64
        self.assertIsNotNone(module.RESULT.fullmatch(b'RESULT 12 ' + digest + b' EOF=1\n'))
        self.assertIsNone(module.RESULT.fullmatch(b'RESULT 12 ' + digest + b' EOF=0\n'))
        self.assertIsNone(module.RESULT.fullmatch(b'RESULT 12 ' + digest + b' EOF=1\nextra'))

    def test_explicit_opt_in_before_certificate_generation(self):
        source = RUNNER.read_text()
        self.assertLess(source.index('if not args.run_unvalidated_native_tls:'),
                        source.index('certificates(work, env)'))
        self.assertNotIn("OPENSSL_CONF", source)
        self.assertIn('key.chmod(0o600)', source)
        self.assertIn('start_new_session=True', source)
        self.assertIn('terminate(child)', source)
        self.assertIn('terminate(server)', source)
        self.assertIn('except ProcessLookupError:', source)
        self.assertIn('deadline = time.monotonic() + 5', source)
        self.assertIn('os.read(server.stdout.fileno(), 1)', source)
        self.assertNotIn('.readline(', source)
        self.assertNotIn('shell=True', source)

    def test_client_has_no_server_or_trust_bypass(self):
        source = CLIENT.read_text()
        self.assertIn('UNVALIDATED', source)
        self.assertIn("'127.0.0.1'", source)
        self.assertIn('TlsFileDatabase.new', source)
        self.assertIn("hostname: 'localhost'", source)
        self.assertIn('expectedServer.is_same', source)
        self.assertNotIn('TlsServerConnection', source)
        self.assertNotIn('accept-certificate', source)
        self.assertNotIn('validation_flags', source)
        self.assertIn('source.close_finish(result)', source)
        self.assertIn('channel.sendPacket(packet)', source)
        self.assertIn('pendingWrite = channel.sendPacket(packet).then(', source)
        self.assertIn('operation.cancel()', source)
        self.assertIn('await pendingWrite', source)


if __name__ == '__main__':
    unittest.main()
