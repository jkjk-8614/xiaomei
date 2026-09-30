"""Boot a clean application copy; never load user keys, tasks, or canvases."""
import os
from pathlib import Path
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import urllib.request

source = Path(__file__).resolve().parents[1]
with tempfile.TemporaryDirectory(prefix='xiaomei-layers-smoke-') as temporary:
    root = Path(temporary).resolve()
    assert root.parent == Path(tempfile.gettempdir()).resolve()
    for file in source.glob('*.py'):
        shutil.copyfile(file, root / file.name)
    (root / 'static').mkdir()
    shutil.copyfile(source / 'static/index.html', root / 'static/index.html')
    shutil.copytree(source / 'ComfyUI/integration', root / 'ComfyUI/integration', ignore=shutil.ignore_patterns('__pycache__'))
    (root / 'ComfyUI/web').mkdir()
    if (source / 'VERSION').exists():
        shutil.copyfile(source / 'VERSION', root / 'VERSION')
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0))
        port = sock.getsockname()[1]
    env = {k:v for k,v in os.environ.items() if not any(term in k.upper() for term in ('API_KEY','TOKEN','SECRET','XIAOMEI','COMFY','PROVIDER'))}
    env.update(XIAOMEI_CANVAS_PORT=str(port), PYTHONIOENCODING='utf-8')
    with (root/'smoke.log').open('w',encoding='utf-8') as log:
        proc = subprocess.Popen([sys.executable, str(root/'main.py')], cwd=root, env=env, stdout=log, stderr=log, creationflags=getattr(subprocess,'CREATE_NO_WINDOW',0))
        try:
            base = f'http://127.0.0.1:{port}'
            for _ in range(150):
                if proc.poll() is not None:
                    raise RuntimeError((root/'smoke.log').read_text(encoding='utf-8')[-5000:])
                try:
                    with urllib.request.urlopen(base+'/api/app-info', timeout=1) as response:
                        if response.status == 200:
                            break
                except OSError:
                    time.sleep(.2)
            else:
                raise RuntimeError('Clean application startup timed out')
            for route in ['/', '/api/app-info', '/api/providers', '/api/history', '/api/image-layers?project_id=smoke']:
                with urllib.request.urlopen(base+route,timeout=5) as response:
                    assert response.status == 200
                    print('200',route)
        finally:
            proc.terminate()
            try:
                proc.wait(timeout=10)
            except subprocess.TimeoutExpired:
                proc.kill();proc.wait()
