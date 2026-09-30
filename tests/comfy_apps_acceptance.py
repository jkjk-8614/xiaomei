"""Opt-in live acceptance. Runs a tiny local SwinIR task; never calls a provider."""
import io
import json
from pathlib import Path
import time

from PIL import Image
import requests

BASE = 'http://127.0.0.1:3002/api/comfy-apps'


def main():
    assert requests.post(BASE + '/import', json={'workflow': {}}).status_code == 400
    info = requests.get('http://127.0.0.1:8188/object_info', timeout=10).json()
    graph = json.loads(Path('ComfyUI/workflows/swinir-upscale.json').read_text(encoding='utf-8'))
    spec = info['UpscaleModelLoader']['input']['required']['model_name']
    available = spec[0] if isinstance(spec[0], list) else spec[1]['options']
    graph['2']['inputs']['model_name'] = next(name for name in available if 'swinir' in name.lower())
    graph['4']['inputs'].update(width=128, height=128)
    app = requests.post(BASE + '/import', json={'name': 'SwinIR 本地修复', 'workflow': graph}).json()
    assert app['state'] == 'ready', app.get('report')
    duplicate = requests.post(BASE + '/import', json={'name': app['title'], 'workflow': graph}).json()
    assert duplicate['id'] != app['id']
    raw = io.BytesIO()
    Image.new('RGB', (32, 32), (180, 120, 80)).save(raw, format='PNG')
    uploaded = requests.post(BASE + '/' + app['id'] + '/upload', files={'image': ('fixture.png', raw.getvalue(), 'image/png')}).json()
    body = {'request_id': 'acceptance-' + app['id'], 'fields': {'1:image': uploaded['name']}}
    result = requests.post(BASE + '/' + app['id'] + '/run', json=body).json()
    repeated = requests.post(BASE + '/' + app['id'] + '/run', json=body).json()
    assert result['task_id'] == repeated['task_id']
    bad = requests.post(BASE + '/' + app['id'] + '/run', json={'request_id': 'bad-' + app['id'], 'fields': {'unconfigured': True}})
    assert bad.status_code == 400
    for _ in range(180):
        task = requests.get(BASE + '/' + app['id']).json()['tasks'][0]
        if task['status'] in ('succeeded', 'failed'):
            assert task['status'] == 'succeeded', task
            assert task['result']['backend'] == '127.0.0.1:8188'
            image = requests.get('http://127.0.0.1:3002' + task['result']['images'][0]).content
            assert Image.open(io.BytesIO(image)).size == (128, 128)
            print('PASS: API import, same-name copy, invalid JSON/fields, upload, dedupe, local SwinIR, persisted result', app['id'])
            return
        time.sleep(1)
    raise RuntimeError('Acceptance timeout')


if __name__ == '__main__':
    main()
