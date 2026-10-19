"""Run the full model-management API in an isolated source/data directory."""
import io
import json
import os
from pathlib import Path
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import zipfile

import requests


def run():
    source = Path(__file__).resolve().parents[1]
    with tempfile.TemporaryDirectory(prefix='小美模型管理整体验证-') as temporary:
        root = Path(temporary)
        for file in source.glob('*.py'):
            shutil.copyfile(file, root / file.name)
        for relative in ('ComfyUI/integration', 'ComfyUI/web', 'tools/chrome-model-downloader'):
            shutil.copytree(source / relative, root / relative,
                            ignore=shutil.ignore_patterns('__pycache__'))
        (root / 'static').mkdir()
        shutil.copyfile(source / 'static/index.html', root / 'static/index.html')
        env = {key: value for key, value in os.environ.items()
               if not any(word in key.upper() for word in
                          ('API_KEY', 'TOKEN', 'SECRET', 'XIAOMEI', 'COMFY', 'PROVIDER'))}
        env['PYTHONIOENCODING'] = 'utf-8'
        env['XIAOMEI_COMFY_BASE'] = str(root / 'ComfyUI')
        with socket.socket() as probe:
            probe.bind(('127.0.0.1', 0))
            port = probe.getsockname()[1]
        env['XIAOMEI_CANVAS_PORT'] = str(port)
        origin = f'http://127.0.0.1:{port}'
        with (root / 'smoke.log').open('w', encoding='utf-8') as log:
            process = subprocess.Popen([sys.executable, str(root / 'main.py')],
                                       cwd=root, env=env, stdout=log, stderr=subprocess.STDOUT)
            try:
                with requests.Session() as client:
                    client.trust_env = False
                    deadline = time.monotonic() + 45
                    while True:
                        if process.poll() is not None:
                            raise AssertionError('Isolated application exited during startup')
                        try:
                            if client.get(origin + '/api/app-info', timeout=1).status_code == 200:
                                break
                        except requests.RequestException:
                            pass
                        if time.monotonic() >= deadline:
                            raise AssertionError('Isolated application did not start in time')
                        time.sleep(.15)
                    for route in ('/', '/api/app-info', '/api/providers', '/api/history'):
                        response = client.get(origin + route, timeout=10)
                        assert response.status_code == 200, (route, response.status_code, response.text[:200])
                        print('PASS full application:', route)
                    for route, relative in (
                        ('/static/comfyui.html', 'ComfyUI/web/comfyui.html'),
                        ('/static/js/comfy-models.js', 'ComfyUI/web/js/comfy-models.js'),
                        ('/static/css/comfy-models.css', 'ComfyUI/web/css/comfy-models.css'),
                    ):
                        response = client.get(origin + route, timeout=10)
                        assert response.status_code == 200, route
                        assert response.content == (source / relative).read_bytes(), route
                        print('PASS canonical ComfyUI resource:', route)
                    headers = {'Origin': origin, 'Sec-Fetch-Site': 'same-origin'}
                    prefix = origin + '/api/comfy-apps/models'
                    response = client.get(prefix + '/downloads', headers=headers, timeout=10)
                    assert response.status_code == 200, response.text[:200]
                    assert response.json()['tasks'] == []
                    response = client.get(prefix + '/download-settings', headers=headers, timeout=10)
                    assert response.status_code == 200
                    assert response.json() == dict(concurrency=2, has_civitai_key=False, has_hf_token=False,
                                                   has_proxy=False, civitai_from_env=False, hf_from_env=False)
                    response = client.put(prefix + '/download-settings', headers=headers,
                                          json={'concurrency': 1}, timeout=10)
                    assert response.status_code == 200 and response.json()['concurrency'] == 1
                    assert json.loads((root / 'ComfyUI/model_downloads/settings.json').read_text('utf-8')) == {'concurrency': 1}
                    response = client.get(prefix, headers=headers, timeout=10)
                    assert response.status_code == 200 and response.json()['models'] == []
                    print('PASS empty queue, local models and persisted download settings')
                    response = client.get(prefix + '/browser-extension.zip', headers=headers, timeout=10)
                    assert response.status_code == 200
                    with zipfile.ZipFile(io.BytesIO(response.content)) as archive:
                        assert set(archive.namelist()) == {'manifest.json', 'popup.html', 'popup.js',
                                                         'popup.css', 'README.md', 'receiver-default.js'}
                        assert origin in archive.read('receiver-default.js').decode('utf-8')
                        manifest = json.loads(archive.read('manifest.json'))
                        assert manifest['manifest_version'] == 3
                    print('PASS browser extension ZIP uses actual application port')
                    response = client.post(prefix + '/resolve', headers=headers,
                                           json={'url': 'https://invalid.example/model'}, timeout=10)
                    assert response.status_code == 400
                    response = client.post(prefix + '/downloads', headers=headers,
                                           json={'files': []}, timeout=10)
                    assert response.status_code == 400
                    with requests.Session() as anonymous:
                        anonymous.trust_env = False
                        response = anonymous.get(prefix + '/downloads', headers=headers, timeout=10)
                        assert response.status_code == 401, response.status_code
                    response = client.get(prefix + '/downloads',
                                          headers={'Origin': 'https://invalid.example', 'Sec-Fetch-Site': 'cross-site'},
                                          timeout=10)
                    assert response.status_code == 403
                    print('PASS input validation and local origin/session protection')
            except Exception:
                log.flush()
                print((root / 'smoke.log').read_text('utf-8', errors='replace')[-6000:])
                raise
            finally:
                process.terminate()
                try:
                    process.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait(timeout=10)


if __name__ == '__main__':
    run()
