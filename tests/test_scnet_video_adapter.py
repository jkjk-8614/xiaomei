"""Run SCNet discovery and video routing with isolated runtime data."""
import asyncio
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import AsyncMock, patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from scnet_api import SEEDANCE_DOC_URL, VIDEO_DOC_URLS

DOC = '<code>{<span>"model"</span>: <span>"Seedance2.0"</span>}</code>'
VIDEO_MODELS = ['HappyHorse-1.0-T2V','MiniMax-H3','Seedance2.0','Seedance2.5','Wan2.7-T2V']
PROVIDER = dict(id='scnet-test', name='SCNet', base_url='https://api.scnet.cn/api/llm/v1', protocol='openai')


class Client:
    def __init__(self, status='succeeded', code=200):
        self.gets, self.posts = [], []
        self.status, self.code = status, code
        self.docs_fail = False
        self.models = [{'id': 'chat-a'}]

    async def __aenter__(self):
        return self

    async def __aexit__(self, *_):
        return False

    async def get(self, url, **kwargs):
        import httpx
        self.gets.append((url, kwargs))
        request = httpx.Request('GET', url)
        if url in VIDEO_DOC_URLS:
            name = {VIDEO_DOC_URLS[1]:'MiniMax-H3',VIDEO_DOC_URLS[2]:'Wan2.7-T2V',VIDEO_DOC_URLS[3]:'HappyHorse-1.0-T2V'}.get(url,'Seedance2.0')
            return httpx.Response(503 if self.docs_fail else 200, text='<code>{"model":"'+name+'"}</code>', request=request)
        if url.endswith('/models'):
            return httpx.Response(200, json={'data': self.models}, request=request)
        output = dict(task_id='task-123', task_status=self.status, error_message='quota exhausted')
        if self.status == 'succeeded':
            output['results'] = ['https://cdn.example/result.mp4']
        return httpx.Response(200, json={'output': output}, request=request)

    async def post(self, url, **kwargs):
        import httpx
        self.posts.append((url, kwargs))
        return httpx.Response(self.code, json={'output': {'task_id': 'task-123', 'task_status': 'pending'}},
                              request=httpx.Request('POST', url))


class ScnetTests(unittest.TestCase):
    def payload(self, **kwargs):
        return main.CanvasVideoRequest(**dict(prompt='Product turning', provider_id=PROVIDER['id'],
                                              model='Seedance2.0', duration=5, **kwargs))

    def test_official_host_and_base_paths(self):
        self.assertTrue(main.is_scnet_provider(PROVIDER))
        self.assertFalse(main.is_scnet_provider({'base_url': 'https://api.scnet.cn.example/v1'}))
        self.assertFalse(main.is_scnet_provider({'base_url': 'https://www.scnet.cn/ui/console'}))
        for url in ['https://api.scnet.cn', 'https://api.scnet.cn/v1', PROVIDER['base_url']]:
            self.assertEqual(main.upstream_models_url(url, 'openai'), PROVIDER['base_url'] + '/models')
            self.assertEqual(main.video_api_root({**PROVIDER, 'base_url': url}), PROVIDER['base_url'])
        self.assertEqual(main.video_task_url_candidates(PROVIDER, PROVIDER['base_url'], 'a/b'),
                         [PROVIDER['base_url'] + '/tasks/a%2Fb'])

    def test_document_parser_reads_ids_from_examples(self):
        import scnet_api
        self.assertEqual(scnet_api.documented_video_models('Seedance3.0' + DOC + DOC), ['Seedance2.0'])

    def test_fetch_and_connection_include_dynamic_document_model(self):
        for operation in ('fetch', 'connection', 'probe'):
            client = Client()
            async def run():
                with patch.object(main.httpx, 'AsyncClient', return_value=client), \
                        patch.object(main, 'api_key_from_payload', return_value='private-test-key'):
                    if operation == 'fetch':
                        return await main.fetch_models_from_upstream(PROVIDER['base_url'], 'private-test-key')
                    if operation == 'probe':
                        _, result = await main.probe_openai_models_endpoint(client, PROVIDER['base_url'], 'private-test-key')
                        return result
                    return await main.test_provider_connection(main.TestConnectionPayload(base_url=PROVIDER['base_url']))
            result = asyncio.run(run())
            self.assertEqual(result['video_models'], VIDEO_MODELS, operation)
            self.assertEqual(result['chat_models'], ['chat-a'])
            self.assertEqual(len(result['all']), 6)
            self.assertIn('Seedance2.0', result['model_sources'])
            doc_headers = next(kw['headers'] for url, kw in client.gets if url == SEEDANCE_DOC_URL)
            self.assertNotIn('Authorization', doc_headers)

    def test_document_failure_preserves_upstream_models(self):
        client = Client()
        client.docs_fail = True
        with patch.object(main.httpx, 'AsyncClient', return_value=client):
            result = asyncio.run(main.fetch_models_from_upstream(PROVIDER['base_url'], 'test-key'))
        self.assertEqual(result['all'], ['Seedance2.5','chat-a'])
        self.assertEqual(result['video_models'], ['Seedance2.5'])
        self.assertIn('手动填写', result['message'])

    def test_explicitly_disabled_model_is_not_reintroduced(self):
        client = Client()
        client.models += [{'id': 'Seedance2.0', 'enabled': False}]
        with patch.object(main.httpx, 'AsyncClient', return_value=client):
            result = asyncio.run(main.fetch_models_from_upstream(PROVIDER['base_url'], 'test-key'))
        self.assertNotIn('Seedance2.0', result['all'])

    def test_other_provider_does_not_request_documentation(self):
        client = Client()
        with patch.object(main.httpx, 'AsyncClient', return_value=client):
            result = asyncio.run(main.fetch_models_from_upstream('https://other.example/v1', 'test-key'))
        self.assertEqual(len(client.gets), 1)
        self.assertEqual(result['all'], ['chat-a'])

    def run_video(self, client, payload=None):
        async def run():
            with patch.object(main, 'get_api_provider', return_value=PROVIDER), \
                    patch.object(main, 'provider_env_key_value', return_value='private-test-key'), \
                    patch.object(main.httpx, 'AsyncClient', return_value=client), \
                    patch.object(main.asyncio, 'sleep', new=AsyncMock()), \
                    patch.object(main, 'save_remote_video_to_output', new=AsyncMock(return_value='/assets/result.mp4')), \
                    patch.object(main, 'save_canvas_video_to_history', side_effect=lambda p, provider, result: result) as history:
                result = await main.canvas_video(payload or self.payload())
                self.assertEqual(history.call_count, 1)
                return result
        return asyncio.run(run())

    def test_canvas_submission_poll_download_and_shared_history(self):
        client = Client()
        result = self.run_video(client, self.payload(generate_audio=False, camerafixed=True, seed=42))
        url, request = client.posts[0]
        self.assertEqual(url, PROVIDER['base_url'] + '/videos/generations')
        self.assertEqual(request['headers']['X-MultiModal-Async'], 'true')
        self.assertEqual(request['headers']['Authorization'], 'Bearer private-test-key')
        self.assertEqual(request['json'], {
            'model': 'Seedance2.0', 'input': {'prompt': 'Product turning'},
            'parameters': {'duration': 5, 'ratio': '16:9', 'resolution': '720p',
                           'generate_audio': False, 'watermark': False, 'camera_fixed': True, 'seed': 42}})
        self.assertEqual(client.gets[0][0], PROVIDER['base_url'] + '/tasks/task-123')
        self.assertEqual(result['videos'], ['/assets/result.mp4'])
        self.assertEqual(result['task_id'], 'task-123')

    def test_multimodal_references_and_frame_roles(self):
        client = Client()
        self.run_video(client, self.payload(
            images=[{'url': 'https://cdn.example/first.png', 'role': 'first_frame'},
                    {'url': 'data:image/png;base64,YQ==', 'role': 'last_frame'}],
            videos=['https://cdn.example/ref.mp4'], audios=['https://cdn.example/ref.mp3']))
        media = client.posts[0][1]['json']['input']['media']
        self.assertEqual([item['type'] for item in media],
                         ['first_frame', 'last_frame', 'reference_video', 'reference_audio'])

    def test_local_media_goes_directly_to_provider_as_base64(self):
        path = Path(os.environ['XIAOMEI_CANVAS_DATA_ROOT']) / 'ref.mp4'
        path.write_bytes(b'video-bytes')
        with patch.object(main, 'local_media_path_for_cloud_upload', return_value=str(path)), \
                patch.object(main, 'content_type_for_path', return_value='video/mp4'):
            result = asyncio.run(main.scnet_video_reference_url('/assets/ref.mp4', 'video'))
        self.assertEqual(result, 'data:video/mp4;base64,dmlkZW8tYnl0ZXM=')

    def test_bad_options_fail_before_paid_request(self):
        for field, value in [('duration', 3), ('duration', 16), ('aspect_ratio', '1:1'),
                             ('resolution', '4k'), ('model', 'veo3')]:
            payload = self.payload()
            setattr(payload, field, value)
            client = Client()
            with self.assertRaises(main.HTTPException):
                asyncio.run(main.generate_scnet_video(client, payload, PROVIDER))
            self.assertEqual(client.posts, [])
        with self.assertRaises(main.HTTPException):
            asyncio.run(main.scnet_video_reference_url('asset://other-provider/id', 'image'))

    def test_failed_and_cancelled_tasks_stop_polling(self):
        for status in ['failed', 'cancelled']:
            client = Client(status=status)
            with self.assertRaises(main.HTTPException) as error:
                self.run_video(client)
            self.assertIn('quota exhausted', error.exception.detail)
            self.assertEqual(len(client.gets), 1)

    def test_authentication_failure_is_reported_without_retrying_submit(self):
        client = Client(code=403)
        with self.assertRaises(main.HTTPException) as error:
            self.run_video(client)
        self.assertEqual(error.exception.status_code, 403)
        self.assertEqual(len(client.posts), 1)
        self.assertEqual(client.gets, [])

    def test_pending_task_times_out(self):
        client = Client(status='pending')
        with patch.object(main, 'VIDEO_POLL_TIMEOUT', 0):
            with self.assertRaises(main.HTTPException) as error:
                self.run_video(client)
        self.assertEqual(error.exception.status_code, 504)

    def test_all_marketplace_models_submit_and_poll(self):
        for model in VIDEO_MODELS:
            self.assertEqual(main.classify_upstream_model(model),'video')
            payload = self.payload()
            payload.model = model
            payload.resolution = '768p' if model == 'MiniMax-H3' else '720p'
            client = Client()
            self.run_video(client, payload)
            body = client.posts[0][1]['json']
            self.assertEqual(body['model'],model)
            if model != 'Seedance2.0' and model != 'Seedance2.5':
                self.assertNotIn('camera_fixed',body['parameters'])
                self.assertNotIn('generate_audio',body['parameters'])
            if model == 'MiniMax-H3': self.assertEqual(body['parameters']['resolution'],'768P')

    def test_wan_maps_audio_and_prompt_extension(self):
        payload = self.payload(audios=['https://cdn.example/audio.mp3'],enhance_prompt=True)
        payload.model = 'Wan2.7-T2V'
        client = Client()
        self.run_video(client,payload)
        body = client.posts[0][1]['json']
        self.assertEqual(body['input']['audio_url'],'https://cdn.example/audio.mp3')
        self.assertTrue(body['parameters']['prompt_extend'])
        self.assertNotIn('media',body['input'])

    def test_text_only_models_reject_images_before_submit(self):
        for model in ['Wan2.7-T2V','HappyHorse-1.0-T2V']:
            payload = self.payload(images=[{'url':'https://cdn.example/a.png'}])
            payload.model = model
            client = Client()
            with self.assertRaises(main.HTTPException): self.run_video(client,payload)
            self.assertEqual(client.posts,[])

    def test_minimax_rejects_mixed_frame_and_reference_modes(self):
        payload = self.payload(images=[{'url':'https://cdn.example/a.png','role':'first_frame'}], videos=['https://cdn.example/a.mp4'])
        payload.model = 'MiniMax-H3'
        payload.resolution = '2k'
        client = Client()
        with self.assertRaises(main.HTTPException): self.run_video(client,payload)
        self.assertEqual(client.posts,[])

    def test_minimax_gateway_sends_both_audio_switch_values(self):
        for protocol in ('openai', 'apimart'):
            for audio in (True, False):
                with self.subTest(protocol=protocol, audio=audio):
                    provider = dict(id='gateway-test', name='Gateway', protocol=protocol, base_url='https://gateway.example/v1')
                    client = Client()
                    async def run():
                        with patch.object(main, 'get_api_provider', return_value=provider), \
                                patch.object(main, 'provider_env_key_value', return_value='private-test-key'), \
                                patch.object(main.httpx, 'AsyncClient', return_value=client), \
                                patch.object(main, 'video_output_urls', return_value=['https://media.example/result.mp4']), \
                                patch.object(main, 'save_remote_video_to_output', new=AsyncMock(return_value='/output/result.mp4')), \
                                patch.object(main, 'save_canvas_video_to_history', side_effect=lambda p, provider, result: result):
                            return await main.canvas_video(main.CanvasVideoRequest(
                                provider_id=provider['id'],model='minimax-h3-2k',prompt='Product turning',
                                duration=15,resolution='2k',generate_audio=audio))
                    asyncio.run(run())
                    self.assertIs(client.posts[0][1]['json']['generate_audio'],audio)

    def test_minimax_rejects_duration_outside_slider_range(self):
        for duration in (3, 16):
            client = Client()
            payload = self.payload()
            payload.model, payload.resolution, payload.duration = 'MiniMax-H3', '2k', duration
            with self.assertRaises(main.HTTPException) as error:
                self.run_video(client,payload)
            self.assertEqual(error.exception.status_code,400)
            self.assertEqual(client.posts,[])


if __name__ == '__main__':
    if '--worker' in sys.argv:
        import main
        unittest.main(argv=[sys.argv[0]])
    else:
        with tempfile.TemporaryDirectory(prefix='xiaomei-scnet-tests-') as directory:
            static = Path(directory) / 'static'
            static.mkdir()
            (static / 'index.html').write_bytes((ROOT / 'static/index.html').read_bytes())
            env = {**os.environ, 'XIAOMEI_CANVAS_PROJECT_ROOT': directory,
                   'XIAOMEI_CANVAS_DATA_ROOT': directory, 'PYTHONIOENCODING': 'utf-8'}
            result = subprocess.run([sys.executable, str(Path(__file__).resolve()), '--worker'],
                                    env=env, cwd=ROOT, timeout=100)
            sys.exit(result.returncode)
