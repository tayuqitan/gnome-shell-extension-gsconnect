"""Offline safety regressions, not proof of a working GNOME session."""
import pathlib
import subprocess
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[1]
RUNNER = ROOT / 'installed-tests/manual/isolated-shell-smoke.sh'
CLIENT = ROOT / 'installed-tests/gjs/testShellClipboardBridge.js'


class IsolatedRunnerTests(unittest.TestCase):
    def test_shell_syntax(self):
        text = RUNNER.read_text()
        subprocess.run(['bash', '-n', str(RUNNER)], check=True)
        inner = text.split("<<'INNER'\n", 1)[1].split('\nINNER\n', 1)[0]
        subprocess.run(['bash', '-n'], input=inner, text=True, check=True)

    def test_private_environment_and_stub(self):
        text = RUNNER.read_text()
        for required in ['env -i ', 'HOME="$ROOT/home"',
                         'XDG_RUNTIME_DIR="$ROOT/runtime"',
                         'DISPLAY="$HOST_DISPLAY"', 'XAUTHORITY="$HOST_XAUTHORITY"',
                         '210s dbus-run-session', 'exit 77', 'enabled false',
                         'sha256sum "$ZIP"', '180s gnome-shell --nested']:
            self.assertIn(required, text)
        self.assertNotIn('--replace', text)
        self.assertIn('mktemp -d "/tmp/gsconnect-shell-smoke.XXXXXXXX"', text)
        self.assertNotIn('${TMPDIR', text)
        self.assertNotIn('killall', '\n'.join(line for line in text.splitlines()
                                             if not line.startswith('printf')))
        self.assertLess(text.index("<<'XPROBE'"), text.index('ROOT=$(mktemp'))

    def test_status_query_uses_shell_object(self):
        text = RUNNER.read_text()
        self.assertIn('--dest org.gnome.Shell --object-path /org/gnome/Shell --method', text)
        self.assertNotIn('--object-path /org/gnome/Shell/Extensions', text)
        self.assertIn('GetExtensionErrors', text)

    def test_client_explicit_bus_and_identity_before_mutation(self):
        text = CLIENT.read_text()
        self.assertIn('new_for_address_sync(options.address', text)
        self.assertNotIn('Gio.bus_get', text)
        self.assertIn('info.path === options.extension', text)
        self.assertIn('portalOwner === shellOwner', text)
        self.assertIn('assert(!owner', text)
        self.assertLess(text.index('info.path === options.extension'), text.index("'RequestName'"))
        self.assertIn("[SERVICE, 4]", text)  # DO_NOT_QUEUE, never replace
        self.assertIn('NO_AUTO_START', text)
        self.assertIn('is_remote_error', text)
        self.assertIn("includes('Clipboard ownership changed')", text)
        self.assertIn("includes('Clipboard request timed out')", text)
        self.assertIn('get_remote_error(outcome.error) === `${PORTAL}.Error`', text)
        helper = text.split('const portal = async', 1)[1].split('    try {', 1)[0]
        self.assertIn("['org.gnome.Shell', PORTAL]", helper)
        self.assertLess(helper.index('owner === shellOwner'), helper.index('return call(bus, shellOwner'))
        self.assertIn('测试可能覆盖当前剪贴板', RUNNER.read_text())

    def test_runner_requires_explicit_zip(self):
        result = subprocess.run(['bash', str(RUNNER)], capture_output=True, text=True)
        self.assertEqual(result.returncode, 1)
        self.assertIn('Usage:', result.stderr)


if __name__ == '__main__':
    unittest.main()
