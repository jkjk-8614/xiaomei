"""Exercise exact file selection, queue recovery, real pause/resume and metadata."""
import copy
import hashlib
import io
import json
import os
from pathlib import Path
import tempfile
import threading
import time
import unittest
from types import SimpleNamespace
from unittest.mock import MagicMock, patch
import zipfile

from fastapi import FastAPI
from fastapi.testclient import TestClient
from PIL import Image

from ComfyUI.integration.comfy_app_runtime import ManagedRuntime
from ComfyUI.integration.comfy_apps import install_comfy_apps
from ComfyUI.integration.comfy_model_downloads import ModelDownloads, atomic_json
from ComfyUI.integration.comfy_model_links import ModelLinkResolver


SHA = hashlib.sha256(b'abc123').hexdigest()
COMMIT = 'b' * 40
NAME = '示例-model-Q4_K_M.gguf'
PLAN = {'name': NAME, 'category': 'diffusion_models', 'size_bytes': 6, 'sha256': SHA,
        'url': f'https://huggingface.co/author/repo/resolve/{COMMIT}/' + NAME,
        'source': 'https://huggingface.co/author/repo',
        'metadata': {'display_name': '示例模型', 'version': 'v2', 'trigger_words': ['sample style']}}


class Response:
    def __init__(self, chunks=(), status=200, headers=None, after_first=None):
        self.chunks = list(chunks)
        self.status_code = status
        self.headers = headers or {'Content-Length': str(sum(len(chunk) for chunk in self.chunks))}
        self.after_first = after_first
    def raise_for_status(self):
        pass
    def iter_content(self, chunk_size):
        for index, chunk in enumerate(self.chunks):
            yield chunk
            if index == 0 and self.after_first:
                self.after_first.wait(4)
    def close(self):
        pass


def eventually(predicate, timeout=5):
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        if predicate():
            return
        time.sleep(.01)
    raise AssertionError('Timed out waiting for download state')


def civitai_model():
    return {'id': 1, 'name': 'Fixture', 'type': 'LORA',
            'modelVersions': [{'id': 11, 'name': 'old'}, {'id': 12, 'name': 'new'}]}


def civitai_version(identity=11):
    return {'id': identity, 'modelId': 1, 'name': 'old' if identity == 11 else 'new',
            'model': {'name': 'Fixture', 'type': 'LORA'}, 'trainedWords': ['sample style'],
            'files': [{'id': 71, 'name': 'fixture-fp16.safetensors', 'sizeKB': 1,
                       'hashes': {'SHA256': 'a' * 64}, 'metadata': {'fp': 'fp16'},
                       'downloadUrl': f'https://civitai.com/api/download/models/{identity}?fp=fp16'},
                      {'id': 72, 'name': 'fixture-q4.gguf', 'sizeKB': 2,
                       'hashes': {'SHA256': 'c' * 64}, 'metadata': {'fp': 'q4'},
                       'downloadUrl': f'https://civitai.com/api/download/models/{identity}?fp=q4'}]}


class LinkSelectionTests(unittest.TestCase):
    def test_explicit_version_and_file_do_not_fall_back_to_primary(self):
        resolver = ModelLinkResolver()
        def get(url, **kwargs):
            return civitai_model() if '/models/1' in url else civitai_version(int(url.rsplit('/', 1)[-1]))
        with patch.object(resolver, 'json', side_effect=get):
            result = resolver.resolve('https://civitai.red/models/1/demo?modelVersionId=11&fileId=72&token=do-not-store')
        self.assertEqual(result['version'], '11')
        self.assertEqual([file['preferred'] for file in result['files']], [False, True])
        self.assertIn('fileId=72', result['files'][1]['url'])
        self.assertNotIn('do-not-store', json.dumps(result))
        self.assertEqual(result['files'][1]['metadata']['trigger_words'], ['sample style'])
        with patch.object(resolver, 'json', side_effect=get):
            with self.assertRaisesRegex(ValueError, '不属于'):
                resolver.resolve('https://civitai.com/api/download/models/11?fileId=999')
            changed = resolver.resolve('https://civitai.com/models/1?modelVersionId=11&fileId=72', version='12')
            self.assertEqual(changed['version'], '12')

    def test_hf_file_is_pinned_and_hashless_file_is_unavailable(self):
        resolver = ModelLinkResolver()
        model = {'sha': COMMIT, 'siblings': [
            {'rfilename': 'loras/' + NAME, 'size': 6, 'lfs': {'sha256': SHA}},
            {'rfilename': 'unknown.bin', 'size': 1}, {'rfilename': '../bad.gguf', 'size': 6}]}
        with patch.object(resolver, 'json', side_effect=[model, {'branches': [{'name': 'dev'}], 'tags': []}]):
            result = resolver.resolve('https://huggingface.co/author/repo')
        self.assertEqual(len(result['files']), 2)
        self.assertIn('/resolve/' + COMMIT + '/', result['files'][0]['url'])
        self.assertEqual(result['files'][0]['category'], 'loras')
        self.assertFalse(result['files'][1]['eligible'])
        with patch.object(resolver, 'json') as get:
            for url in ('http://127.0.0.1/models/1', 'https://civitai.com.evil.test/models/1', 'https://user:pass@huggingface.co/a/b'):
                with self.assertRaises(ValueError):
                    resolver.resolve(url)
            get.assert_not_called()

    def test_credentials_only_go_to_the_corresponding_platform(self):
        resolver = ModelLinkResolver(lambda: {'civitai_key': 'private-c-key', 'hf_token': 'private-hf-key'})
        with patch('ComfyUI.integration.comfy_model_links.requests.request') as request:
            for url, token in [('https://civitai.com/api/v1/models/1', 'private-c-key'),
                               ('https://huggingface.co/api/models/a/b', 'private-hf-key'),
                               ('https://image.civitai.com/cover.jpg', None)]:
                resolver.request('GET', url)
                auth = request.call_args.kwargs['headers'].get('Authorization')
                self.assertEqual(auth, 'Bearer ' + token if token else None)


class QueueTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='小美模型下载测试-')
        self.addCleanup(self.temp.cleanup)
        self.runtime = ManagedRuntime(self.temp.name)
        self.runtime.base = Path(self.temp.name) / 'base'
        self.downloads = ModelDownloads(self.runtime)

    def wait(self, identity, status):
        eventually(lambda: self.downloads.tasks[identity]['status'] == status and identity not in self.downloads.workers)

    def test_pause_resume_preserves_range_and_records_metadata(self):
        release = threading.Event()
        def get(url, **kwargs):
            if kwargs['headers'].get('Range') == 'bytes=3-':
                return Response([b'123'], 206, {'Content-Length': '3', 'Content-Range': 'bytes 3-5/6'})
            return Response([b'abc', b'123'], after_first=release)
        with patch('ComfyUI.integration.comfy_app_runtime.requests.get', side_effect=get) as request:
            task, created = self.downloads.enqueue(PLAN)
            self.assertTrue(created)
            eventually(lambda: self.downloads.tasks[task['id']]['downloaded'] == 3)
            self.downloads.action(task['id'], 'pause'); release.set(); self.wait(task['id'], 'paused')
            destination = self.downloads.validate_plan(PLAN)
            self.assertFalse(destination.exists())
            self.assertEqual(self.runtime.model_download_partial(PLAN).read_bytes(), b'abc')
            self.downloads.action(task['id'], 'resume'); self.wait(task['id'], 'succeeded')
            self.assertEqual(destination.read_bytes(), b'abc123')
            self.assertEqual(request.call_count, 2)
            metadata = self.downloads.read_metadata(destination)
            self.assertEqual(metadata['sha256'], SHA)
            self.assertEqual(metadata['version'], 'v2')
            self.assertEqual(self.downloads.snapshot()['tasks'][0]['verification'], 'sha256')
            recovered = ModelDownloads(self.runtime)
            self.assertEqual(recovered.snapshot()['tasks'][0]['status'], 'succeeded')

    def test_checksum_failure_and_explicit_restart_never_overwrite_existing_model(self):
        with patch('ComfyUI.integration.comfy_app_runtime.requests.get', return_value=Response([b'broken'])):
            task, _ = self.downloads.enqueue(PLAN); self.wait(task['id'], 'failed')
        destination = self.downloads.validate_plan(PLAN)
        self.assertFalse(destination.exists())
        self.assertIn('校验失败', self.downloads.tasks[task['id']]['error'])
        with patch('ComfyUI.integration.comfy_app_runtime.requests.get', return_value=Response([b'abc123'])):
            self.downloads.action(task['id'], 'retry', restart=True); self.wait(task['id'], 'succeeded')
        destination.write_bytes(b'user-existing-model')
        with patch('ComfyUI.integration.comfy_app_runtime.requests.get') as request:
            other, _ = self.downloads.enqueue({**PLAN, 'url': PLAN['url'] + '?version=other', 'sha256': 'f' * 64})
            self.wait(other['id'], 'failed')
            request.assert_not_called()
        self.assertEqual(destination.read_bytes(), b'user-existing-model')

    def test_interrupted_queue_recovers_paused_and_duplicate_targets_are_rejected(self):
        with patch.object(self.downloads, '_dispatch'):
            task, _ = self.downloads.enqueue(PLAN)
            duplicate, created = self.downloads.enqueue(PLAN)
            self.assertFalse(created); self.assertEqual(task['id'], duplicate['id'])
            with self.assertRaisesRegex(ValueError, '其他版本'):
                self.downloads.enqueue({**PLAN, 'url': PLAN['url'] + '?other=1', 'sha256': 'f' * 64})
        recovered = ModelDownloads(self.runtime)
        self.assertEqual(recovered.snapshot()['tasks'][0]['status'], 'paused')
        self.assertFalse(recovered.workers)
        for name in ('../escape.gguf', 'CON.gguf', 'bad:stream.gguf'):
            with self.assertRaises(ValueError):
                self.downloads.enqueue({**PLAN, 'name': name})

    def test_retry_conflicts_preserve_partials_and_versions_resume_independently(self):
        other_plan = {**PLAN, 'url': PLAN['url'] + '?other=1',
                      'sha256': hashlib.sha256(b'xyz789').hexdigest()}
        old_partial = self.runtime.model_download_partial(PLAN)
        old_partial.parent.mkdir(parents=True)
        old_partial.write_bytes(b'abc')
        with patch.object(self.downloads, '_dispatch'):
            old, _ = self.downloads.enqueue(PLAN)
            self.downloads._update(old['id'], status='failed')
            newer, _ = self.downloads.enqueue(other_plan)
            with self.assertRaisesRegex(ValueError, '其他下载任务'):
                self.downloads.action(old['id'], 'retry', restart=True)
            self.assertEqual(old_partial.read_bytes(), b'abc')
            self.assertEqual(self.downloads.tasks[old['id']]['status'], 'failed')
        self.downloads.action(newer['id'], 'pause')
        with patch('ComfyUI.integration.comfy_app_runtime.requests.get', return_value=Response([b'xyz789'])) as request:
            self.downloads.action(newer['id'], 'resume'); self.wait(newer['id'], 'succeeded')
            self.assertNotIn('Range', request.call_args.kwargs['headers'])
        destination = self.downloads.validate_plan(PLAN)
        self.assertEqual(destination.read_bytes(), b'xyz789')
        self.assertEqual(old_partial.read_bytes(), b'abc')
        destination.unlink()
        with patch('ComfyUI.integration.comfy_app_runtime.requests.get',
                   return_value=Response([b'123'], 206, {'Content-Length': '3', 'Content-Range': 'bytes 3-5/6'})) as request:
            self.downloads.action(old['id'], 'retry'); self.wait(old['id'], 'succeeded')
            self.assertEqual(request.call_args.kwargs['headers']['Range'], 'bytes=3-')
        self.assertEqual(destination.read_bytes(), b'abc123')

    def test_legacy_partial_is_adopted_for_range_resume(self):
        destination = self.downloads.validate_plan(PLAN)
        destination.parent.mkdir(parents=True)
        legacy = destination.with_name(destination.name + '.xiaomei.download')
        legacy.write_bytes(b'abc')
        with patch('ComfyUI.integration.comfy_app_runtime.requests.get',
                   return_value=Response([b'123'], 206, {'Content-Length': '3', 'Content-Range': 'bytes 3-5/6'})) as request:
            task, _ = self.downloads.enqueue(PLAN); self.wait(task['id'], 'succeeded')
            self.assertEqual(request.call_args.kwargs['headers']['Range'], 'bytes=3-')
        self.assertFalse(legacy.exists())
        self.assertEqual(destination.read_bytes(), b'abc123')

    def test_settings_do_not_expose_or_erase_credentials(self):
        data = self.downloads.save_settings({'civitai_key': 'private-c-key', 'hf_token': 'private-hf-key', 'proxy_url': 'http://127.0.0.1:7890', 'concurrency': 1})
        self.assertNotIn('private', json.dumps(data))
        self.downloads.save_settings({'concurrency': 2})
        self.assertEqual(self.downloads.effective_settings()['civitai_key'], 'private-c-key')
        with patch.dict(os.environ, {'XIAOMEI_CIVITAI_API_KEY': 'env-secret'}):
            self.assertTrue(self.downloads.public_settings()['civitai_from_env'])
            self.assertEqual(self.downloads.effective_settings()['civitai_key'], 'env-secret')
        with self.assertRaises(ValueError):
            self.downloads.save_settings({'proxy_url': 'file:///private'})

    def test_workflow_download_uses_the_same_queue(self):
        self.runtime.download_manager = self.downloads
        with patch('ComfyUI.integration.comfy_app_runtime.requests.get', return_value=Response([b'abc123'])):
            self.runtime._download_model(PLAN, Path(self.temp.name) / 'prepare.log')
        self.assertEqual(len(self.downloads.snapshot()['tasks']), 1)
        self.assertEqual(self.downloads.snapshot()['tasks'][0]['origin'], '工作流自动补齐')

    def test_saved_selection_cannot_be_replaced_with_a_client_download_url(self):
        result = {'files': [{**copy.deepcopy(PLAN), 'eligible': True}], 'versions': []}
        with patch.object(self.downloads.remote, 'resolve', return_value=result):
            selected = self.downloads.resolve('https://huggingface.co/a/b')['files'][0]
        self.assertNotIn('url', selected)
        with patch.object(self.downloads, '_dispatch'):
            response = self.downloads.enqueue_selected([{'selection_id': selected['selection_id'], 'category': 'loras', 'url': 'http://127.0.0.1/private'}])
        actual = self.downloads.tasks[response['tasks'][0]['id']]['plan']
        self.assertEqual(actual['url'], PLAN['url'])
        self.assertEqual(actual['category'], 'loras')

    def test_hash_identification_and_cover_are_saved_without_modifying_weights(self):
        path = Path(self.temp.name) / NAME; path.write_bytes(b'abc123')
        version = civitai_version(); version['files'][0]['hashes']['SHA256'] = SHA
        image = io.BytesIO(); Image.new('RGB', (80, 120), 'navy').save(image, format='PNG')
        version['images'] = [{'url': 'https://image.civitai.com/fixture/cover.png'}]
        with patch.object(self.downloads.remote, 'json', return_value=version), patch.object(self.downloads.remote, 'request', return_value=Response([image.getvalue()])):
            result = self.downloads.identify(path)
        self.assertEqual(result['trigger_words'], ['sample style'])
        self.assertTrue(self.downloads.cover_path(path).is_file())
        self.assertEqual(path.read_bytes(), b'abc123')
        with self.assertRaises(ValueError):
            self.downloads.edit_metadata(path, {'source_url': 'https://civitai.com/models/1?token=private'})


class DownloadRouteTests(unittest.TestCase):
    def test_routes_keep_credentials_private_and_bundle_only_extension_sources(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            host = SimpleNamespace(BASE_DIR=temporary)
            app = FastAPI(); service = install_comfy_apps(app, host); client = TestClient(app)
            service.runtime.base = root / 'base'
            response = client.put('/api/comfy-apps/models/download-settings', json={'civitai_key': 'test-only-secret'})
            self.assertEqual(response.status_code, 200)
            self.assertNotIn('test-only-secret', response.text)
            self.assertEqual(client.post('/api/comfy-apps/models/downloads', json={'files': [{'selection_id': 'made-up', 'category': 'loras'}]}).status_code, 400)
            self.assertEqual(client.post('/api/comfy-apps/models/resolve', json=['bad']).status_code, 400)
            source = Path(__file__).resolve().parents[1] / 'tools/chrome-model-downloader'
            target = root / 'tools/chrome-model-downloader'; target.mkdir(parents=True)
            for name in ('manifest.json', 'popup.html', 'popup.js', 'popup.css', 'README.md'):
                (target / name).write_bytes((source / name).read_bytes())
            response = client.get('/api/comfy-apps/models/browser-extension.zip')
            self.assertEqual(response.status_code, 200)
            with zipfile.ZipFile(io.BytesIO(response.content)) as archive:
                self.assertEqual(len(archive.namelist()), 6)
                self.assertIn('http://testserver', archive.read('receiver-default.js').decode())
                self.assertFalse(any('settings' in name or 'queue' in name for name in archive.namelist()))


if __name__ == '__main__':
    unittest.main()
