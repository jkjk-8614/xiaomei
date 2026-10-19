import base64
import io
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch

import httpx
from PIL import Image
import main


class ImageBackgroundTransportTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        diagnostic = patch.object(main, 'append_gpt_image_edit_diagnostic')
        diagnostic.start()
        self.addCleanup(diagnostic.stop)

    async def test_layer_transparency_reaches_generation_and_edit_http_requests(self):
        image = io.BytesIO()
        Image.new('RGBA', (32, 32), (200, 100, 50, 0)).save(image, format='PNG')
        encoded = base64.b64encode(image.getvalue()).decode()
        provider = {'id':'layer-fixture', 'name':'Fixture', 'base_url':'https://images.test',
                    'protocol':'openai', 'image_request_mode':'openai', 'image_models':['gpt-image-2']}
        requests = []
        async def respond(request):
            requests.append(request)
            return httpx.Response(200, json={'data':[{'b64_json':encoded}]})
        client_type = httpx.AsyncClient
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / '参考图.png'
            source.write_bytes(image.getvalue())
            with patch.object(main, 'get_api_provider', return_value=provider), \
                 patch.object(main, 'api_headers', return_value={}), \
                 patch.object(main, 'output_file_from_url', return_value=str(source)), \
                 patch.object(main, 'save_ai_image_to_output', new=AsyncMock(return_value='/output/fixture.png')), \
                 patch.object(main, 'image_output_meta', return_value={'url':'/output/fixture.png'}), \
                 patch.object(main, 'save_to_history'), patch.object(main, 'GLOBAL_LOOP', None), \
                 patch.object(main.httpx, 'AsyncClient', side_effect=lambda **kw: client_type(transport=httpx.MockTransport(respond), **kw)):
                for refs in ([], [main.AIReference(url='/output/参考图.png')]):
                    payload = main.OnlineImageRequest(prompt='分离图层', model='gpt-image-2', provider_id=provider['id'],
                                                      size='768x1024', background='transparent', reference_images=refs)
                    result = await main.build_online_image_result(payload)
                    self.assertEqual(result['params']['background'], 'transparent')
        self.assertEqual(len(requests), 2)
        self.assertTrue(requests[0].url.path.endswith('/images/generations'))
        self.assertIn(b'"background":"transparent"', requests[0].content)
        self.assertIn(b'"output_format":"png"', requests[0].content)
        self.assertTrue(requests[1].url.path.endswith('/images/edits'))
        self.assertIn(b'name="background"\r\n\r\ntransparent', requests[1].content)
        self.assertIn(b'name="output_format"\r\n\r\npng', requests[1].content)
        self.assertIn(b'name="image[]"', requests[1].content)

    async def test_edit_does_not_retry_transport_disconnect_without_platform_idempotency(self):
        image = io.BytesIO()
        Image.new('RGB', (32, 32), (200, 100, 50)).save(image, format='PNG')
        encoded = base64.b64encode(image.getvalue()).decode()
        provider = {'id':'retry-fixture', 'name':'Fixture', 'base_url':'https://images.test',
                    'protocol':'openai', 'image_request_mode':'openai', 'image_models':['gpt-image-2']}
        requests = []

        async def respond(request):
            requests.append(request)
            if len(requests) == 1:
                raise httpx.RemoteProtocolError(
                    'Server disconnected without sending a response.', request=request
                )
            return httpx.Response(200, json={'data':[{'b64_json': encoded}]})

        client_type = httpx.AsyncClient
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / '参考图.png'
            source.write_bytes(image.getvalue())
            with patch.object(main, 'get_api_provider', return_value=provider), \
                 patch.object(main, 'api_headers', return_value={}), \
                 patch.object(main, 'output_file_from_url', return_value=str(source)), \
                 patch.object(main, 'save_ai_image_to_output', new=AsyncMock(return_value='/output/fixture.png')), \
                 patch.object(main, 'image_output_meta', return_value={'url':'/output/fixture.png'}), \
                 patch.object(main, 'save_to_history'), \
                 patch.object(main, 'GLOBAL_LOOP', None), \
                 patch.object(main.httpx, 'AsyncClient', side_effect=lambda **kw: client_type(transport=httpx.MockTransport(respond), **kw)):
                payload = main.OnlineImageRequest(
                    prompt='编辑参考图', model='gpt-image-2', provider_id=provider['id'],
                    size='768x1024', reference_images=[main.AIReference(url='/output/参考图.png')]
                )
                with self.assertRaises(main.HTTPException) as failure:
                    await main.build_online_image_result(payload)

        self.assertEqual(len(requests), 1)
        self.assertNotIn('Idempotency-Key', requests[0].headers)
        self.assertIn('Fixture 的 GPT-Image-2/2.5 编辑接口', failure.exception.detail)
        self.assertNotIn('6789API', failure.exception.detail)

    async def test_edit_failure_keeps_selected_platform_in_request_and_polled_error(self):
        providers = [
            ('comfly', 'comfly', 'https://ai.comfly.org', 'https://ai.comfly.org/v1/images/edits'),
            ('custom-images', '自定义图片平台', 'https://custom-images.test/v1', 'https://custom-images.test/v1/images/edits'),
            ('unnamed-images', '', 'https://unnamed-images.test', 'https://unnamed-images.test/v1/images/edits'),
            ('api-6789', '6789API', 'https://6789.test', 'https://6789.test/v1/images/edits'),
        ]
        client_type = httpx.AsyncClient
        with tempfile.TemporaryDirectory(prefix='image-provider-error-') as directory:
            source = Path(directory) / '参考图.png'
            Image.new('RGB', (32, 32), (200, 100, 50)).save(source)
            for provider_id, name, base_url, edit_url in providers:
                for status in (500, 503):
                    for history_source in ('online', 'canvas', 'commerce'):
                        with self.subTest(provider=provider_id, status=status, source=history_source):
                            model = 'gpt-image-2' if status == 500 else 'gpt-image-2.5-flare'
                            provider = dict(id=provider_id, name=name, base_url=base_url,
                                            protocol='openai', image_request_mode='openai',
                                            image_models=[model])
                            requests = []

                            async def respond(request):
                                requests.append(request)
                                return httpx.Response(status, text='Service temporarily unavailable',
                                                      headers={'x-request-id': 'upstream-edit-fixture'})

                            with patch.object(main, 'get_api_provider', return_value=provider), \
                                 patch.object(main, 'api_headers', return_value={}), \
                                 patch.object(main, 'output_file_from_url', return_value=str(source)), \
                                 patch.object(main, 'save_to_history') as save_history, \
                                 patch.multiple(main, DATA_DIR=directory, GLOBAL_LOOP=None,
                                                CANVAS_TASKS_FILE=str(Path(directory) / 'tasks.json'),
                                                CANVAS_TASKS={}, CANVAS_IMAGE_BACKGROUND_TASKS={}), \
                                 patch.object(main.httpx, 'AsyncClient', side_effect=lambda **kw: client_type(
                                     transport=httpx.MockTransport(respond), **kw)):
                                payload = main.OnlineImageRequest(
                                    prompt='编辑参考图', provider_id=provider_id, model=model,
                                    history_source=history_source, size='768x1024',
                                    reference_images=[main.AIReference(url='/output/参考图.png')],
                                )
                                created = await main.create_canvas_image_task(payload)
                                await main.CANVAS_IMAGE_BACKGROUND_TASKS[created['task_id']]
                                task = await main.get_canvas_image_task(created['task_id'])
                                save_history.assert_not_called()

                            self.assertEqual(len(requests), 1)
                            self.assertEqual(str(requests[0].url), edit_url)
                            self.assertIn(f'name="model"\r\n\r\n{model}'.encode(), requests[0].content)
                            self.assertEqual(task['provider_id'], provider_id)
                            self.assertEqual(task['status'], 'failed')
                            self.assertTrue(task['upstream_terminal_error'])
                            error = task['error']
                            self.assertIn(f'{name or provider_id} 的 GPT-Image-2/2.5 编辑接口', error)
                            self.assertIn(f'HTTP {status}', error)
                            self.assertIn('请求编号：upstream-edit-fixture', error)
                            self.assertIn('请先到该平台后台核对请求状态和扣费记录', error)
                            self.assertEqual(error.count('扣费记录'), 1)
                            if provider_id != 'api-6789':
                                self.assertNotIn('6789API', error)

    async def test_edit_does_not_retry_transient_bad_response_status(self):
        image = io.BytesIO()
        Image.new('RGB', (32, 32), (200, 100, 50)).save(image, format='PNG')
        encoded = base64.b64encode(image.getvalue()).decode()
        provider = {'id':'gateway-fixture', 'name':'Fixture', 'base_url':'https://images.test',
                    'protocol':'openai', 'image_request_mode':'openai', 'image_models':['gpt-image-2']}
        requests = []

        async def respond(request):
            requests.append(request)
            if len(requests) == 1:
                return httpx.Response(
                    502,
                    json={'error': {'message': 'openai_error', 'code': 'bad_response_status_code'}},
                    request=request,
                )
            return httpx.Response(200, json={'data':[{'b64_json': encoded}]}, request=request)

        client_type = httpx.AsyncClient
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / '参考图.png'
            source.write_bytes(image.getvalue())
            with patch.object(main, 'get_api_provider', return_value=provider), \
                 patch.object(main, 'api_headers', return_value={}), \
                 patch.object(main, 'output_file_from_url', return_value=str(source)), \
                 patch.object(main, 'save_ai_image_to_output', new=AsyncMock(return_value='/output/fixture.png')), \
                 patch.object(main, 'image_output_meta', return_value={'url':'/output/fixture.png'}), \
                 patch.object(main, 'save_to_history'), \
                 patch.object(main, 'GLOBAL_LOOP', None), \
                 patch.object(main, 'GPT_IMAGE2_EDIT_RETRY_DELAY', 0.2), \
                 patch.object(main.httpx, 'AsyncClient', side_effect=lambda **kw: client_type(transport=httpx.MockTransport(respond), **kw)):
                payload = main.OnlineImageRequest(
                    prompt='编辑参考图', model='gpt-image-2', provider_id=provider['id'],
                    size='768x1024', reference_images=[main.AIReference(url='/output/参考图.png')]
                )
                with self.assertRaises(main.HTTPException):
                    await main.build_online_image_result(payload)

        self.assertEqual(len(requests), 1)
        self.assertNotIn('Idempotency-Key', requests[0].headers)

    async def test_edit_does_not_retry_embedded_bad_response_status(self):
        image = io.BytesIO()
        Image.new('RGB', (32, 32), (200, 100, 50)).save(image, format='PNG')
        encoded = base64.b64encode(image.getvalue()).decode()
        provider = {'id':'embedded-gateway-fixture', 'name':'Fixture', 'base_url':'https://images.test',
                    'protocol':'openai', 'image_request_mode':'openai', 'image_models':['gpt-image-2']}
        requests = []

        async def respond(request):
            requests.append(request)
            if len(requests) == 1:
                return httpx.Response(
                    200,
                    json={'error': {'message': 'openai_error', 'code': 'bad_response_status_code'}},
                    request=request,
                )
            return httpx.Response(200, json={'data':[{'b64_json': encoded}]}, request=request)

        client_type = httpx.AsyncClient
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / '参考图.png'
            source.write_bytes(image.getvalue())
            with patch.object(main, 'get_api_provider', return_value=provider), \
                 patch.object(main, 'api_headers', return_value={}), \
                 patch.object(main, 'output_file_from_url', return_value=str(source)), \
                 patch.object(main, 'save_ai_image_to_output', new=AsyncMock(return_value='/output/fixture.png')), \
                 patch.object(main, 'image_output_meta', return_value={'url':'/output/fixture.png'}), \
                 patch.object(main, 'save_to_history'), \
                 patch.object(main, 'GLOBAL_LOOP', None), \
                 patch.object(main, 'GPT_IMAGE2_EDIT_RETRY_DELAY', 0.2), \
                 patch.object(main.httpx, 'AsyncClient', side_effect=lambda **kw: client_type(transport=httpx.MockTransport(respond), **kw)):
                payload = main.OnlineImageRequest(
                    prompt='编辑参考图', model='gpt-image-2', provider_id=provider['id'],
                    size='768x1024', reference_images=[main.AIReference(url='/output/参考图.png')]
                )
                with self.assertRaises(main.HTTPException):
                    await main.build_online_image_result(payload)

        self.assertEqual(len(requests), 1)

    async def test_auto_size_request_uses_explicit_portrait_pixels(self):
        image = io.BytesIO()
        Image.new('RGB', (32, 32), (200, 100, 50)).save(image, format='PNG')
        encoded = base64.b64encode(image.getvalue()).decode()
        provider = {'id':'ratio-fixture', 'name':'Fixture', 'base_url':'https://images.test',
                    'protocol':'openai', 'image_request_mode':'openai', 'image_models':['gpt-image-2']}
        requests = []

        async def respond(request):
            requests.append(request)
            return httpx.Response(200, json={'data':[{'b64_json': encoded}]})

        client_type = httpx.AsyncClient
        with patch.object(main, 'get_api_provider', return_value=provider), \
             patch.object(main, 'api_headers', return_value={}), \
             patch.object(main, 'save_ai_image_to_output', new=AsyncMock(return_value='/output/fixture.png')), \
             patch.object(main, 'image_output_meta', return_value={'url':'/output/fixture.png'}), \
             patch.object(main, 'save_to_history'), \
             patch.object(main, 'GLOBAL_LOOP', None), \
             patch.object(main.httpx, 'AsyncClient', side_effect=lambda **kw: client_type(transport=httpx.MockTransport(respond), **kw)):
            payload = main.OnlineImageRequest(
                prompt='竖屏构图', model='gpt-image-2', provider_id=provider['id'],
                size='auto', aspect_ratio='9:16'
            )
            await main.build_online_image_result(payload)

        self.assertEqual(len(requests), 1)
        self.assertEqual(json.loads(requests[0].content)['size'], '2160x3840')


if __name__ == '__main__':
    unittest.main()
