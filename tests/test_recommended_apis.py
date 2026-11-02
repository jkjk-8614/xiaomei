"""推荐卡片在隔离运行目录中的持久化、校验与并发写入。"""
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]


def worker():
    sys.path.insert(0, str(ROOT))
    static = Path(os.environ['XIAOMEI_CANVAS_PROJECT_ROOT']) / 'static'
    static.mkdir(parents=True, exist_ok=True)
    (static / 'index.html').write_bytes((ROOT / 'static/index.html').read_bytes())
    import main
    from fastapi.testclient import TestClient
    from concurrent.futures import ThreadPoolExecutor
    from unittest.mock import patch
    client = TestClient(main.app, base_url='http://127.0.0.1', client=('127.0.0.1', 50000))
    client.get('/')
    url = '/api/recommended-apis'
    payload = dict(name='我的平台', base_url='https://api.fixture.example/v1', register_url='',
                   summary='<b>原样显示</b>', protocol='openai', kinds=['image', 'chat'])
    assert client.get(url).json() == {'items': []}
    result = client.post(url, json=payload)
    assert result.status_code == 200, result.text
    item = result.json()['items'][0]
    assert item['register_url'] == payload['base_url']
    target = url + '/' + item['id']
    assert client.get(url).json()['items'] == [item]
    original = Path(main.RECOMMENDED_APIS_FILE).read_bytes()
    for invalid in [dict(base_url='javascript:alert(1)'), dict(register_url='https://u:p@fixture.example'),
                    dict(name='  '), dict(protocol='codex'), dict(kinds=[]), dict(kinds=['invalid']),
                    dict(api_key='must-not-save'), dict(image_request_mode='unknown')]:
        response = client.post(url, json={**payload, **invalid})
        assert response.status_code in (400, 422), response.text
        assert Path(main.RECOMMENDED_APIS_FILE).read_bytes() == original
    assert client.post(url, json=payload).status_code == 409
    assert client.put(url + '/api-6789', json=payload).status_code == 404
    with patch.object(main, '_atomic_write_json_file', side_effect=OSError('fixture disk failure')):
        failed = TestClient(main.app, base_url='http://127.0.0.1', client=('127.0.0.1', 50000), raise_server_exceptions=False)
        failed.get('/')
        assert failed.put(target, json={**payload, 'name':'不应保存'}).status_code == 503
    assert Path(main.RECOMMENDED_APIS_FILE).read_bytes() == original
    edited = client.put(target, json={**payload, 'name':'修改后的平台', 'protocol':'apimart', 'image_request_mode':'openai-video-proxy'})
    assert edited.status_code == 200 and edited.json()['items'][0]['name'] == '修改后的平台'
    with ThreadPoolExecutor(max_workers=6) as pool:
        list(pool.map(lambda i: main.add_recommended_api(main.RecommendedApiPayload(
            name=f'平台 {i}', base_url=f'https://{i}.fixture.example')), range(12)))
    assert len(client.get(url).json()['items']) == 13
    assert client.delete(target).status_code == 200
    assert client.delete(target).status_code == 404
    path = Path(main.RECOMMENDED_APIS_FILE)
    path.write_text('{broken', encoding='utf-8')
    assert client.get(url).status_code == 503
    assert client.post(url, json=payload).status_code == 503
    assert path.read_text(encoding='utf-8') == '{broken'
    assert not Path(main.API_PROVIDERS_FILE).exists(), '推荐管理不应改写实际平台配置'
    print('recommendation persistence, validation, concurrent writes and data protection: passed')


class RecommendedApisTest(unittest.TestCase):
    def test_isolated_application(self):
        with tempfile.TemporaryDirectory(prefix='xiaomei-recommend-test-') as directory:
            env = {**os.environ, 'XIAOMEI_CANVAS_PROJECT_ROOT':directory,
                   'XIAOMEI_CANVAS_DATA_ROOT':directory, 'PYTHONIOENCODING':'utf-8'}
            result = subprocess.run([sys.executable, str(Path(__file__).resolve()), '--worker'],
                                    cwd=ROOT, env=env, capture_output=True, text=True, encoding='utf-8', timeout=90)
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)


if __name__ == '__main__':
    worker() if '--worker' in sys.argv else unittest.main()
