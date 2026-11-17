"""Static package-entry contracts; no GJS/network/certificate execution."""
import ast
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[1]
BASE = ROOT / 'installed-tests/gjs'


class PackagedCoreContract(unittest.TestCase):
    def test_adapter_calls_actual_method_and_pins_modules(self):
        text = (ROOT / 'installed-tests/fixtures/packagedCoreSender.js').read_text()
        self.assertIn('44e874a45f30ff0d41b6bdc9cdd9e1d2928df56798e0190751abf8e1bdfb6977', text)
        self.assertIn('6777fd4ef41813c8b2efedb7ed1f3a91e20534af6de2516de650329f8f2b8752', text)
        self.assertIn("extract('    sendPacket(packet, cancellable = null) {')", text)
        self.assertIn("extract('    serialize() {')", text)
        self.assertIn('return method.call(channel, packet, token)', text)
        self.assertNotIn("import('../core", text)

    def test_new_clients_only_use_adapter_inside_run(self):
        for name in ['testPackagedCoreLoopback.js', 'testPackagedCoreTlsClient.js',
                     'testPackagedCoreTlsSemanticsClient.js']:
            text = (BASE / name).read_text()
            self.assertIn('TEST-ONLY', text)
            self.assertIn('loadPackagedCoreSender', text)
            self.assertNotIn('sendPacketCandidate', text)
            self.assertNotIn('write_all_async', text)
            self.assertIn('new Packet()', text)
            self.assertIn(r'`${JSON.stringify(packet)}\n`', text)
            self.assertNotIn('validation_flags', text)
            self.assertNotIn('accept-certificate', text)

    def test_archive_equality_precedes_every_launch(self):
        contract = (BASE / 'packagedCoreContract.py').read_text()
        self.assertIn('f3cf22d2f8e9af39b68e4cae910edb2d1a011631d9564fc4b28b82c2bc321fe5', contract)
        self.assertIn('file.read_bytes() != data', contract)
        for name in ['runPackagedCoreLoopback.py', 'runPackagedCoreTls.py',
                     'runPackagedCoreTlsSemantics.py']:
            text = (BASE / name).read_text()
            ast.parse(text)
            self.assertIn("'--zip'", text)
            self.assertIn('verify_package(args.zip,', text)
            self.assertNotIn('testPacketSpliceTlsNativeClient.js', text)
            self.assertNotIn('testPackagedPacketTlsNativeClient.js', text)


if __name__ == '__main__':
    unittest.main()
