"""Read-only verification of real SeeThrough artifacts on the local test server."""
import io
import json
import zipfile

from PIL import Image
import requests

ROOT = 'http://127.0.0.1:3002'
apps = requests.get(ROOT + '/api/comfy-apps').json()['apps']
app = next(a for a in apps if a['description'].startswith('SeeThrough'))
tasks = requests.get(ROOT + '/api/comfy-apps/' + app['id']).json()['tasks']
tasks = [t for t in tasks if t['status'] == 'succeeded'][:2]
assert len(tasks) == 2
url_sets = []
for task in tasks:
    result = task['result']
    manifest = result['layers']
    assert manifest['prefix'] == 'xiaomei_app_' + task['task_id']
    assert len(manifest['layers']) == 22
    archive_url = next(i['url'] for i in result['items'] if i['name'].endswith('.zip'))
    blob = requests.get(ROOT + archive_url).content
    with zipfile.ZipFile(io.BytesIO(blob)) as archive:
        assert archive.testzip() is None
        assert len(archive.namelist()) == 23
        source = json.loads(archive.read(next(n for n in archive.namelist() if n.endswith('.json'))))
        assert source['prefix'] == manifest['prefix']
        for layer in manifest['layers']:
            assert task['task_id'] in layer['filename']
            zipped = Image.open(io.BytesIO(archive.read(layer['filename'])))
            direct = Image.open(io.BytesIO(requests.get(ROOT + layer['url']).content))
            assert zipped.mode == 'RGBA' and direct.mode == 'RGBA'
            assert zipped.size == (layer['right'] - layer['left'], layer['bottom'] - layer['top'])
            assert direct.tobytes() == zipped.tobytes()
            assert zipped.getchannel('A').getextrema()[0] < 255
    url_sets.append(set(result['outputs']))
assert not url_sets[0].intersection(url_sets[1])
print('PASS: two task prefixes, separate download URLs, ZIP CRC/content, 22 RGBA layers and crop positions')
