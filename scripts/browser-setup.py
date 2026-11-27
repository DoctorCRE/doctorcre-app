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


def ubuntu_sources(apt, directory):
    # The runner's packages.microsoft.com source answers 403, which fails apt-get update; Playwright needs only Ubuntu packages.
    parts = directory / 'sources.list.d'
    parts.mkdir()
    for source in (apt / 'sources.list.d').glob('*'):
        text = source.read_text()
        if 'packages.microsoft.com' not in text:
            (parts / source.name).write_text(text)
    main = directory / 'sources.list'
    legacy = apt / 'sources.list'
    lines = legacy.read_text().splitlines() if legacy.exists() else []
    main.write_text(''.join(f'{line}\n' for line in lines if 'packages.microsoft.com' not in line))
    return f'Dir::Etc::SourceParts "{parts}";\nDir::Etc::SourceList "{main}";\n'


def setup(browsers):
    if sys.platform == 'linux':
        archives = Path.home() / '.cache' / 'playwright-apt'
        archives.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(prefix='playwright-apt-') as directory:
            config = Path(directory, 'apt.conf')
            config.write_text(
                f'Dir::Cache::archives "{archives}";\n'
                'Acquire::Retries "1";\n'
                'Acquire::http::Timeout "10";\n'
                'Acquire::https::Timeout "10";\n'
                'APT::Update::Error-Mode "any";\n'
                + ubuntu_sources(Path('/etc/apt'), Path(directory))
            )
            result = subprocess.run([
                'sudo', '-n', 'timeout', '--kill-after=5s', '10m',
                'env', f'APT_CONFIG={config}', 'DEBIAN_FRONTEND=noninteractive',
                'node', CLI, 'install-deps', *browsers,
            ], check=False)
        if result.returncode:
            print('::error::Playwright OS dependencies unavailable. Ubuntu package installation failed or reached its 10-minute deadline.', flush=True)
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
