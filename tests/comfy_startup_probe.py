"""Compare full/filtered startup on disposable ports without running workflows."""
import json
from contextlib import contextmanager
import os
from pathlib import Path
import socket
import subprocess
import sys
import tempfile
import time

import requests

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from ComfyUI.integration.comfy_app_runtime import ManagedRuntime


@contextmanager
def test_directory():
    temporary = tempfile.TemporaryDirectory(prefix='xiaomei-comfy-startup-')
    try:
        yield temporary.name
    finally:
        # Windows may release a terminated child's SQLite handles after its
        # venv launcher has exited.
        for attempt in range(20):
            try:
                temporary.cleanup()
                break
            except OSError:
                if attempt == 19:
                    raise
                time.sleep(.25)


def main():
    runtime = ManagedRuntime(Path(__file__).resolve().parents[1])
    profile = runtime.audit_startup_nodes(runtime.info(), [
        'ComfyUI-Easy-Use', 'comfyui-mixlab-nodes', 'was-node-suite-comfyui'])
    required = {node for nodes in profile['workflows'].values() for node in nodes}
    keep = [name for name in profile['packages'] if name not in profile['skipped']]
    results = {}
    with test_directory() as temporary:
        root = Path(temporary)
        config = runtime._shared_model_config()
        config['runtime'] = {'base_path': str(runtime.root), 'custom_nodes': 'custom_nodes'}
        paths = root / 'paths.json'
        paths.write_text(json.dumps(config), encoding='utf-8')
        for mode in ('full', 'filtered'):
            with socket.socket() as listener:
                listener.bind(('127.0.0.1', 0))
                port = listener.getsockname()[1]
            base = root / mode
            base.mkdir()
            (base / 'custom_nodes').mkdir()
            log = root / (mode + '.log')
            command = [str(runtime.root / '.venv/Scripts/python.exe'),
                       str(runtime.base / 'core/main.py'), '--base-directory', str(base),
                       '--extra-model-paths-config', str(paths), '--listen', '127.0.0.1',
                       '--port', str(port), '--disable-auto-launch']
            if mode == 'filtered':
                command += ['--disable-all-custom-nodes', '--whitelist-custom-nodes', *keep]
            env = {**os.environ, 'PYTHONUTF8': '1', 'PYTHONIOENCODING': 'utf-8',
                   'HF_HUB_OFFLINE': '1', 'TRANSFORMERS_OFFLINE': '1',
                   'TORCH_HOME': str(runtime.root / 'torch')}
            print('Starting ' + mode + ' probe on port ' + str(port), flush=True)
            started = time.monotonic()
            with log.open('w', encoding='utf-8') as output:
                child = subprocess.Popen(command, stdout=output, stderr=subprocess.STDOUT, env=env,
                    creationflags=subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0)
            try:
                while time.monotonic() - started < 180:
                    if child.poll() is not None:
                        raise RuntimeError(log.read_text(encoding='utf-8', errors='replace')[-8000:])
                    try:
                        response = requests.get(f'http://127.0.0.1:{port}/object_info', timeout=2)
                        response.raise_for_status()
                        info = response.json()
                        break
                    except requests.RequestException:
                        time.sleep(.25)
                else:
                    raise RuntimeError('Startup timed out: ' + log.read_text(encoding='utf-8', errors='replace')[-4000:])
                results[mode] = {'seconds': round(time.monotonic() - started, 2),
                                 'nodes': len(info), 'required': {n: info[n] for n in required if n in info}}
                print(json.dumps({'mode': mode, 'seconds': results[mode]['seconds'], 'nodes': len(info)}), flush=True)
            finally:
                if os.name == 'nt':
                    subprocess.run(['taskkill.exe', '/PID', str(child.pid), '/T', '/F'],
                        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, creationflags=subprocess.CREATE_NO_WINDOW)
                else:
                    child.terminate()
                child.wait(timeout=30)
        full = results['full']['required']
        filtered = results['filtered']['required']
        missing = sorted(set(full) - set(filtered))
        changed = sorted(node for node in full.keys() & filtered.keys()
                         if full[node] != filtered[node])
        summary = {'full_seconds': results['full']['seconds'],
                   'filtered_seconds': results['filtered']['seconds'],
                   'referenced_backend_nodes': len(full), 'new_missing': missing,
                   'changed_schemas': changed, 'skipped': profile['skipped']}
        print(json.dumps(summary, ensure_ascii=True), flush=True)
        if missing or changed:
            raise RuntimeError('Referenced node availability/schema changed')


if __name__ == '__main__':
    main()
