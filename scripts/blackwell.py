"""Run with the bundled venv's python.exe: blackwell.py DESTINATION.

Print one JSON launch configuration. Prepend its non-null overlay to PYTHONPATH
and pass --disable-xformers to ComfyUI when disableXformers is true.
"""
import contextlib
import csv
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import sysconfig
import tempfile
import time
import uuid


PINS = {'torch': '2.7.1+cu128', 'torchvision': '0.22.1+cu128', 'torchaudio': '2.7.1+cu128'}
INDEX = 'https://download.pytorch.org/whl/cu128'
OTHER_GPU, UNKNOWN_GPU, FAILED_SMOKE = 20, 21, 22


def probe(overlay):
    # Run in a child so that a broken CUDA context or loaded DLL cannot affect
    # subsequent validation. Exit codes keep dependency chatter off stdout.
    try:
        import torch
        capability = torch.cuda.get_device_capability()
    except Exception as exc:
        print(f'CUDA device query failed: {exc}', file=sys.stderr)
        return UNKNOWN_GPU
    if capability != (12, 0):
        return OTHER_GPU
    try:
        if overlay:
            import importlib
            for name, version in PINS.items():
                module = importlib.import_module(name)
                if (module.__version__ != version or
                        not Path(module.__file__).resolve().is_relative_to(Path(overlay))):
                    raise RuntimeError(f'{name} did not load {version} from {overlay}')
        x = torch.ones((8, 8), device='cuda')
        value = ((x + 1) @ x)[0, 0].item()
        torch.cuda.synchronize()
        if value != 16:
            raise RuntimeError(f'CUDA smoke test returned {value}, expected 16')
    except Exception as exc:
        print(f'CUDA smoke test failed: {exc}', file=sys.stderr)
        return FAILED_SMOKE
    return 0


def run_probe(overlay=None):
    env = os.environ.copy()
    if overlay:
        env['PYTHONPATH'] = os.pathsep.join(filter(None, (str(overlay), env.get('PYTHONPATH'))))
    return subprocess.run([sys.executable, '-s', str(Path(__file__).resolve()), '--probe', str(overlay or '')],
                          env=env, stdout=sys.stderr, timeout=180).returncode


def smi_blackwell():
    visible = os.environ.get('CUDA_VISIBLE_DEVICES')
    first = visible.split(',')[0].strip() if visible is not None else None
    if first in ('', '-1'):
        return False
    smi = shutil.which('nvidia-smi')
    if smi is None:
        return False
    result = subprocess.run([smi, '--query-gpu=index,uuid,compute_cap', '--format=csv,noheader,nounits'],
                            capture_output=True, text=True, timeout=30)
    if result.returncode:
        raise RuntimeError(f'nvidia-smi device query failed: {result.stderr.strip()}')
    rows = [tuple(field.strip() for field in row) for row in csv.reader(result.stdout.splitlines()) if row]
    if first and first.startswith('GPU-'):
        rows = [row for row in rows if row[1].startswith(first)]
    # CUDA ordinals can differ from nvidia-smi on mixed systems. Only use
    # numeric ordinals when the process explicitly uses PCI bus ordering.
    elif os.environ.get('CUDA_DEVICE_ORDER') == 'PCI_BUS_ID':
        rows = [row for row in rows if row[0] == (first or '0')]
    choices = {row[2] == '12.0' for row in rows}
    if len(choices) > 1:
        raise RuntimeError('Cannot identify the active GPU; set CUDA_VISIBLE_DEVICES to its GPU UUID')
    return True in choices


@contextlib.contextmanager
def install_lock(path):
    # OS releases the lock even if the installer is killed. Keep its inode.
    with path.open('a+b') as stream:
        if os.name == 'nt':
            import msvcrt
            import errno
            while True:
                stream.seek(0)
                try:
                    msvcrt.locking(stream.fileno(), msvcrt.LK_NBLCK, 1)
                    break
                except OSError as exc:
                    if exc.errno not in (errno.EACCES, errno.EAGAIN, errno.EDEADLK):
                        raise
                    time.sleep(1)
        else:
            import fcntl
            fcntl.flock(stream, fcntl.LOCK_EX)
        yield


def prepare(destination):
    base = run_probe()
    if base in (0, OTHER_GPU) or (base != FAILED_SMOKE and not smi_blackwell()):
        return None
    destination.mkdir(parents=True, exist_ok=True)
    prefix = f'blackwell-{PINS["torch"]}-{sys.implementation.cache_tag}-{sysconfig.get_platform()}'
    with install_lock(destination / (prefix + '.lock')):
        for existing in sorted(destination.glob(prefix + '-*')):
            if existing.is_dir() and run_probe(existing) == 0:
                return existing
        # Use a unique sibling so rename is atomic and prior generations stay
        # usable by running servers even if a later probe rejects them.
        with tempfile.TemporaryDirectory(prefix='.blackwell-stage-', dir=destination) as temp:
            stage = Path(temp) / 'packages'
            env = {key: value for key, value in os.environ.items() if not key.upper().startswith('PIP_')}
            env['PIP_CONFIG_FILE'] = os.devnull
            subprocess.run([sys.executable, '-m', 'pip', '--isolated', '--disable-pip-version-check', 'install',
                            '--index-url', INDEX, '--only-binary=:all:', '--no-deps', '--ignore-installed',
                            '--no-compile', '--no-input', '--retries', '3', '--target', str(stage),
                            *(f'{name}=={version}' for name, version in PINS.items())],
                           env=env, stdout=sys.stderr, check=True)
            if run_probe(stage) != 0:
                raise RuntimeError('Staged cu128 wheels failed validation on the active sm_120 device')
            published = destination / (prefix + '-' + uuid.uuid4().hex)
            stage.rename(published)
            return published


def main():
    if len(sys.argv) == 3 and sys.argv[1] == '--probe':
        return probe(sys.argv[2])
    if len(sys.argv) != 2:
        print('Usage: blackwell.py DESTINATION', file=sys.stderr)
        return 2
    overlay = prepare(Path(sys.argv[1]).resolve())
    print(json.dumps({'overlay': str(overlay) if overlay else None, 'disableXformers': bool(overlay)}))
    return 0


if __name__ == '__main__':
    try:
        sys.exit(main())
    except Exception as error:
        print(f'Blackwell runtime setup failed: {error}', file=sys.stderr)
        sys.exit(1)
