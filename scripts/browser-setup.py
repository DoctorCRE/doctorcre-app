import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile


CLI = str(Path('node_modules/playwright/cli.js').resolve())


def run_group(command, timeout):
    with subprocess.Popen(command, start_new_session=True) as child:
        try:
            return child.wait(timeout=timeout)
        except subprocess.TimeoutExpired:
            os.killpg(child.pid, signal.SIGKILL)
            child.wait()
            raise


def setup(browsers):
    # No `install-deps --dry-run` probe: hosted runners always lack some of these packages, and its cold apt read sometimes took over 15 seconds.
    if sys.platform == 'linux':
        with tempfile.TemporaryDirectory(prefix='playwright-apt-') as directory:
            config = Path(directory, 'apt.conf')
            config.write_text('Acquire::Retries "1";\nAcquire::http::Timeout "10";\nAcquire::https::Timeout "10";\nAPT::Update::Error-Mode "any";\n')
            result = subprocess.run([
                'sudo', '-n', 'timeout', '--kill-after=5s', '115s',
                'env', f'APT_CONFIG={config}', 'DEBIAN_FRONTEND=noninteractive',
                'node', CLI, 'install-deps', *browsers,
            ], check=False)
        if result.returncode:
            print('::error::Playwright OS dependencies unavailable. Ubuntu mirror install failed or reached its 120-second limit. Browser tests cannot run.', flush=True)
            return 1
    try:
        return run_group(['node', CLI, 'install', *browsers], timeout=180)
    except subprocess.TimeoutExpired:
        print('::error::Playwright browser download reached its 180-second limit.', flush=True)
        return 1


if __name__ == '__main__':
    browsers = sys.argv[1:]
    if not browsers or any(browser not in ('chromium', 'webkit') for browser in browsers):
        sys.exit('Expected chromium, webkit, or both.')
    sys.exit(setup(browsers))
