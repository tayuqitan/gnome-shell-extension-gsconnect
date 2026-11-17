"""Static contracts only. This test never launches GJS or opens a socket."""
from pathlib import Path
import unittest

SOURCE = (Path(__file__).resolve().parents[1] /
          'installed-tests/gjs/testPacketSpliceLoopback.js').read_text()


class LoopbackCandidateContract(unittest.TestCase):
    def test_opt_in_and_no_production_transport(self):
        self.assertIn('TEST-ONLY', SOURCE)
        self.assertIn('--run-reviewed-loopback-candidate', SOURCE)
        self.assertIn("from '../fixtures/packetSpliceCandidate.js'", SOURCE)
        self.assertNotIn('write_all_async', SOURCE)
        self.assertNotIn('TlsClientConnection', SOURCE)
        self.assertNotIn('TlsServerConnection', SOURCE)
        self.assertNotIn('service/core', SOURCE)

    def test_loopback_and_bounded_complete_eof(self):
        self.assertIn("new_from_string('127.0.0.1'), port: 0", SOURCE)
        self.assertIn('enable_proxy: false', SOURCE)
        self.assertIn('LIMIT - total + 1', SOURCE)
        self.assertIn('if (bytes.length === 0)', SOURCE)
        self.assertIn('sender.socket.shutdown(false, true)', SOURCE)
        self.assertIn('hash === wanted', SOURCE)
        self.assertIn('EOF=1', SOURCE)

    def test_pending_cancellation_and_cleanup(self):
        self.assertIn('proof = !settled', SOURCE)
        self.assertIn('Gio.IOErrorEnum.CANCELLED', SOURCE)
        self.assertIn('Gio.IOErrorEnum.PENDING', SOURCE)
        self.assertIn('await Promise.allSettled(pending)', SOURCE)
        self.assertIn('lifetime.cancel()', SOURCE)
        self.assertIn('GLib.source_remove(timer)', SOURCE)
        self.assertIn('GLib.PRIORITY_DEFAULT, 15', SOURCE)
        self.assertIn('System.exit(1)', SOURCE)


if __name__ == '__main__':
    unittest.main()
