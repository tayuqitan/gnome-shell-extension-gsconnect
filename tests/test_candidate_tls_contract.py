"""Static candidate TLS contracts; never execute certificates, socket or TLS."""
import ast
import importlib.util
from pathlib import Path
import unittest

BASE = Path(__file__).resolve().parents[1] / 'installed-tests/gjs'
RUNNER = BASE / 'runPacketSpliceTlsNative.py'
CLIENT = BASE / 'testPacketSpliceTlsNativeClient.js'


class CandidateTlsContract(unittest.TestCase):
    def test_candidate_only(self):
        text = CLIENT.read_text()
        self.assertIn('TEST-ONLY', text)
        self.assertIn("from '../fixtures/packetSpliceCandidate.js'", text)
        self.assertIn('sendPacketCandidate(channel, packet)', text)
        self.assertNotIn('write_all_async', text)
        self.assertNotIn('sendPacket(packet', text)
        self.assertIn("print('STAGE WRITE_START');\n    pendingWrite =", text)
        self.assertIn('TlsFileDatabase.new', text)
        self.assertIn('expectedServer.is_same', text)
        self.assertNotIn('accept-certificate', text)
        self.assertNotIn('validation_flags', text)
        self.assertIn('Number(portText), operation,', text)
        self.assertIn('handshake_async(GLib.PRIORITY_DEFAULT, operation,', text)

    def test_separate_entry_and_strict_protocol(self):
        text = RUNNER.read_text()
        ast.parse(text)
        self.assertIn('testPacketSpliceTlsNativeClient.js', text)
        self.assertNotIn('testPackagedPacketTlsNativeClient.js', text)
        self.assertIn('--run-reviewed-candidate-tls', text)
        self.assertIn('stages_valid', text)
        self.assertIn('expected.groups() != actual.groups()', text)
        self.assertIn('EOF=1', text)
        self.assertIn('terminate(child)', text)
        self.assertIn('terminate(server)', text)
        self.assertNotIn('OPENSSL_CONF', text)

    def test_bounded_stage_reporting(self):
        spec = importlib.util.spec_from_file_location('candidate_runner', RUNNER)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        self.assertEqual(module.stage_summary(b'private data\n'), 'none')
        self.assertEqual(module.stage_summary(b'STAGE CLOSED\n'), 'none')
        self.assertEqual(module.stage_summary(b'STAGE CONNECT_START\nSTAGE CONNECTED\n'),
                         'STAGE CONNECTED')
        self.assertEqual(module.stage_summary(b'STAGE CONNECT_START\nsecret\n'),
                         'STAGE CONNECT_START')


if __name__ == '__main__':
    unittest.main()
