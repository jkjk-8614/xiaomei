"""Run real main.py route/storage wiring with an isolated data directory."""
from pathlib import Path
import os
import shutil
import subprocess
import sys
import tempfile
import time


def worker(root):
    sys.path.insert(0, str(root))
    import main
    import numpy as np
    from PIL import Image
    from fastapi.testclient import TestClient
    rng = np.random.default_rng(193)
    original = rng.integers(40, 190, (240, 320, 4), dtype=np.uint8)
    original[:, :, 3] = 255
    source_url = main.save_product_fidelity_asset(Image.fromarray(original), 'fixture_source.png')
    patch = original[50:170, 80:240].copy()
    patch[40:70, 60:100, :3] = [250, 250, 250]
    edited_url = main.save_product_fidelity_asset(Image.fromarray(patch).resize((480, 360)), 'fixture_edit.png')
    with TestClient(main.app, base_url='http://127.0.0.1:3000', client=('127.0.0.1',50000)) as client:
        for route in ['/', '/api/app-info', '/api/providers', '/api/history']:
            response = client.get(route)
            assert response.status_code == 200, (route, response.text[:200])
            print('200', route)
        response = client.post('/api/local-fusion/jobs', json={
            'sourceUrl': source_url, 'patches': [{'url': edited_url, 'region': {
                'sourceUrl': source_url, 'sourceWidth': 320, 'sourceHeight': 240,
                'x': 80, 'y': 50, 'width': 160, 'height': 120}}]})
        assert response.status_code == 202, response.text
        job_id = response.json()['id']
        for _ in range(250):
            response = client.get('/api/local-fusion/jobs/'+job_id)
            job = response.json()
            if job['status'] in ['completed', 'failed']: break
            time.sleep(.02)
        assert job['status'] == 'completed', job
        result = job['result']
        assert result['report']['outsideUnchanged'] is True
        output = Path(main.output_file_from_url(result['url']))
        mask = np.array(Image.open(main.output_file_from_url(result['maskUrl']))) > 0
        actual = np.array(Image.open(output))
        np.testing.assert_array_equal(actual[~mask], original[~mask])
        assert Image.open(output).size == (320, 240)
        assert output.with_suffix('.json').is_file()
        response = client.get(result['url'])
        assert response.status_code == 200, response.text[:100]
        response = client.get('/api/download-output', params={'url': result['url'], 'name': '局部融合结果.png'})
        assert response.status_code == 200 and response.content.startswith(b'\x89PNG\r\n\x1a\n'), response.text[:100]
        print('PASS real main router + cancellable job + managed PNG/mask/JSON + exact outside pixels')


def isolated_run():
    source = Path(__file__).resolve().parents[1]
    with tempfile.TemporaryDirectory(prefix='xiaomei-local-fusion-app-') as temporary:
        root = Path(temporary)
        for file in source.glob('*.py'): shutil.copyfile(file, root/file.name)
        (root/'static').mkdir()
        shutil.copyfile(source/'static/index.html', root/'static/index.html')
        shutil.copytree(source/'ComfyUI/integration', root/'ComfyUI/integration', ignore=shutil.ignore_patterns('__pycache__'))
        (root/'ComfyUI/web').mkdir()
        env = {k: v for k, v in os.environ.items() if not any(word in k.upper() for word in ('API_KEY', 'TOKEN', 'SECRET', 'XIAOMEI', 'COMFY', 'PROVIDER'))}
        env['PYTHONIOENCODING'] = 'utf-8'
        result = subprocess.run([sys.executable, str(Path(__file__).resolve()), '--worker', str(root)], cwd=root, env=env)
        if result.returncode: raise SystemExit(result.returncode)


if __name__ == '__main__':
    if len(sys.argv) > 1 and sys.argv[1] == '--worker': worker(Path(sys.argv[2]))
    else: isolated_run()
