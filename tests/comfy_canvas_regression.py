"""Opt-in local GPU smoke test through the existing canvas task endpoint."""
import io
import time
import uuid

from PIL import Image
import requests

ROOT = 'http://127.0.0.1:3002'
raw = io.BytesIO()
Image.new('RGB', (64, 64), (164, 135, 106)).save(raw, format='PNG')
uploaded = requests.post('http://127.0.0.1:8188/upload/image',
    files={'image': ('regression_' + uuid.uuid4().hex + '.png', raw.getvalue(), 'image/png')}).json()['name']
payload = {'workflow_json': 'seedvr2-official-upscale.json', 'preferred_backend': '127.0.0.1:8188',
           'params': {'1': {'image': uploaded}, '4': {'new_resolution': 256},
                      '5': {'width': 256, 'height': 256}, '6': {'filename_prefix': 'xiaomei_regression_' + uuid.uuid4().hex}},
           'client_id': 'comfy-app-regression', 'type': 'workflow-test', 'record_history': False}
created = requests.post(ROOT + '/api/canvas-comfy-tasks', json=payload).json()
for _ in range(600):
    task = requests.get(ROOT + '/api/canvas-comfy-tasks/' + created['task_id']).json()
    if task['status'] in ('succeeded', 'failed'):
        assert task['status'] == 'succeeded', task.get('error')
        output = requests.get(ROOT + task['result']['images'][0]).content
        assert Image.open(io.BytesIO(output)).size == (256, 256)
        print('PASS: existing canvas workflow endpoint, SeedVR2 3B FP8 GPU inference, 256x256 output')
        break
    time.sleep(1)
else:
    raise RuntimeError('SeedVR2 regression timed out')
