import importlib.util
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch


class BrowserSetupTest(unittest.TestCase):
    def setUp(self):
        spec = importlib.util.spec_from_file_location('browser_setup', Path(__file__).with_name('browser-setup.py'))
        self.module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.module)

    def run_setup(self, install=0):
        calls = []

        def run(command, **options):
            calls.append(command)
            config_path = next(arg.removeprefix('APT_CONFIG=') for arg in command if arg.startswith('APT_CONFIG='))
            self.assertIn(f'Dir::Cache::archives "{home / ".cache" / "playwright-apt"}";', Path(config_path).read_text())
            return subprocess.CompletedProcess(command, install)

        def popen(command, **options):
            calls.append(command)
            child = MagicMock()
            child.__enter__.return_value.wait.return_value = 0
            return child

        with tempfile.TemporaryDirectory() as directory:
            home = Path(directory)
            with (
                patch.object(self.module.subprocess, 'Popen', side_effect=popen),
                patch.object(self.module.subprocess, 'run', side_effect=run),
                patch.object(self.module.sys, 'platform', 'linux'),
                patch.object(Path, 'home', return_value=home),
            ):
                result = self.module.setup(['chromium', 'webkit'])
        return result, calls

    def test_os_dependencies_get_one_bounded_install_before_browsers(self):
        result, calls = self.run_setup()
        self.assertEqual(result, 0)
        self.assertEqual(len(calls), 2)
        self.assertEqual(calls[0][:6], ['sudo', '-n', 'timeout', '--kill-after=5s', '10m', 'env'])
        self.assertIn('APT_CONFIG=', ' '.join(calls[0]))
        self.assertEqual(calls[0][-3:], ['install-deps', 'chromium', 'webkit'])
        self.assertEqual(calls[1][-3:], ['install', 'chromium', 'webkit'])
        self.assertNotIn('--with-deps', calls[1])

    def test_mirror_deadline_and_errors_stop_before_browser_tests(self):
        for status in [100, 124, 137]:
            with self.subTest(status=status):
                result, calls = self.run_setup(status)
                self.assertNotEqual(result, 0)
                self.assertEqual(len(calls), 1)

    def test_browser_download_failure_stops_setup(self):
        child = MagicMock()
        child.__enter__.return_value.wait.return_value = 1
        with patch.object(self.module.sys, 'platform', 'darwin'), patch.object(self.module.subprocess, 'Popen', return_value=child):
            self.assertNotEqual(self.module.setup(['chromium']), 0)

    def test_browser_timeout_kills_and_reaps_the_download_group(self):
        child = MagicMock()
        child.pid = 12345
        child.wait.side_effect = [subprocess.TimeoutExpired('download', 180), 0]
        process = MagicMock()
        process.__enter__.return_value = child
        with patch.object(self.module.sys, 'platform', 'darwin'), patch.object(self.module.subprocess, 'Popen', return_value=process), patch.object(self.module.os, 'killpg') as kill:
            self.assertNotEqual(self.module.setup(['chromium']), 0)
        kill.assert_called_once_with(12345, self.module.signal.SIGKILL)
        self.assertEqual(child.wait.call_count, 2)


if __name__ == '__main__':
    unittest.main()
