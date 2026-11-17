"""Offline parser/static checks only. Never run TLS, certificates or binaries."""
import hashlib
import importlib.util
from pathlib import Path
import sys
import unittest

BASE = Path(__file__).resolve().parents[1]
RUNNER = BASE / 'installed-tests/gjs/runPacketSpliceTlsSemantics.py'
CLIENT = BASE / 'installed-tests/gjs/testPacketSpliceTlsSemanticsClient.js'


def load_runner():
    spec = importlib.util.spec_from_file_location('semantics_runner', RUNNER)
    module = importlib.util.module_from_spec(spec)
    sys.path.insert(0, str(RUNNER.parent))
    try:
        spec.loader.exec_module(module)
    finally:
        sys.path.pop(0)
    return module


class SemanticsContract(unittest.TestCase):
    def setUp(self):
        self.runner = load_runner()

    def client(self, mode, final):
        return b''.join(('STAGE ' + stage + '\n').encode()
                        for stage in self.runner.STAGES[mode]) + final

    def test_complete_and_empty_eof(self):
        for mode in ['concurrent', 'pre-cancel', 'closed']:
            expected = b'fixture-data'
            wanted = expected if mode == 'concurrent' else b''
            count, digest = len(wanted), hashlib.sha256(wanted).hexdigest()
            output = self.client(mode, f'EXPECT {count} {digest}\n'.encode())
            result = f'RESULT {count} {digest} EOF=1\n'.encode()
            self.assertIn('EOF=1', self.runner.validate(mode, output, result, expected))
            with self.assertRaises(RuntimeError):
                self.runner.validate(mode, output, result.replace(b'EOF=1', b'EOF=0'), expected)

    def test_cancelled_prefix_is_not_full_success(self):
        expected = b'fixture-data'
        output = self.client('blocked-cancel',
            f'CANCELLED {len(expected)} {hashlib.sha256(expected).hexdigest()}\n'.encode())
        prefix = expected[:4]
        result = f'CANCEL_RESULT 4 {hashlib.sha256(prefix).hexdigest()} EOF=0 REASON=TLS_EOF\n'.encode()
        self.assertIn('EOF=0', self.runner.validate('blocked-cancel', output, result, expected))
        for invalid in [result.replace(b'TLS_EOF', b'TIMED_OUT'),
                        result.replace(b'EOF=0', b'EOF=1'),
                        result.replace(hashlib.sha256(prefix).hexdigest().encode(), b'0' * 64)]:
            with self.assertRaises(RuntimeError):
                self.runner.validate('blocked-cancel', output, invalid, expected)

    def test_candidate_and_pause_gates(self):
        client, runner = CLIENT.read_text(), RUNNER.read_text()
        self.assertIn('TEST-ONLY', client)
        self.assertNotIn('write_all_async', client)
        self.assertNotIn('validation_flags', client)
        self.assertNotIn('accept-certificate', client)
        self.assertIn('expectedServer.is_same', client)
        self.assertIn('!settled', client)
        self.assertIn('condition_check(GLib.IOCondition.OUT)', client)
        self.assertIn('Promise.allSettled([pendingWrite, pendingOther]', client)
        self.assertIn("!= b'PAUSED\\n'", runner)
        self.assertIn("child.stdin.write(b'GO\\n')", runner)
        self.assertIn("input=b'DRAIN\\n'", runner)
        self.assertNotIn('OPENSSL_CONF', runner)
        self.assertIn('terminate(child)', runner)
        self.assertIn('terminate(server)', runner)


if __name__ == '__main__':
    unittest.main()
