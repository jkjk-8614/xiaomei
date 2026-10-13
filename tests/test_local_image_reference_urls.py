import base64
import io
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from urllib.parse import quote

import httpx
from PIL import Image

import main


class LocalImageReferenceURLTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        self.generated = self.root / '生成图片'
        self.assets = self.root / '素材'
        self.generated.mkdir()
        self.assets.mkdir()
        self.name = '历史 参考图.png'
        buffer = io.BytesIO()
        Image.new('RGBA', (32, 48), (200, 100, 50, 128)).save(buffer, format='PNG')
        self.image_bytes = buffer.getvalue()
        for directory in (self.generated, self.assets, self.root):
            (directory / self.name).write_bytes(self.image_bytes)
        directories = patch.multiple(main, OUTPUT_OUTPUT_DIR=str(self.generated),
                                     OUTPUT_DIR=str(self.root), ASSETS_DIR=str(self.assets))
        directories.start()
        self.addCleanup(directories.stop)

    def test_local_absolute_urls_resolve_to_original_files(self):
        paths = {
            '/output/': self.generated,
            '/assets/': self.assets,
            '/api/storage-files/generated/': self.generated,
        }
        origins = ('', 'http://127.0.0.1:3000', 'http://localhost:3007',
                   'http://[::1]:3001', 'https://LOCALHOST:3002')
        for prefix, directory in paths.items():
            for origin in origins:
                url = origin + prefix + quote(self.name) + '?v=1'
                with self.subTest(url=url):
                    self.assertEqual(main.output_file_from_url(url), str(directory / self.name))
                    self.assertEqual(main.output_file_from_url({'url': url}), str(directory / self.name))
                    data_url = main.reference_to_data_url({'url': url})
                    self.assertTrue(data_url.startswith('data:image/png;base64,'))
                    self.assertEqual(base64.b64decode(data_url.split(',', 1)[1]), self.image_bytes)

    def test_remote_urls_and_paths_outside_storage_are_not_local_files(self):
        public = 'https://images.test/output/' + quote(self.name)
        urls = (public, 'http://localhost.images.test/output/' + quote(self.name),
                'http://127.0.0.1:3000/output/missing.png',
                'http://localhost:3000/assets/../' + quote(self.name),
                'http://localhost:3000/output/../../outside.png')
        for url in urls:
            with self.subTest(url=url):
                self.assertIsNone(main.output_file_from_url(url))
        self.assertEqual(main.reference_to_data_url({'url': public}), public)

    async def test_history_reference_reaches_json_and_multipart_requests(self):
        encoded = base64.b64encode(self.image_bytes).decode('ascii')
        original_url = 'http://127.0.0.1:3007/api/storage-files/generated/' + quote(self.name)
        provider = {'id': 'history-fixture', 'name': 'Fixture', 'base_url': 'https://images.test',
                    'protocol': 'openai', 'image_models': ['nano-banana-2']}
        client_type = httpx.AsyncClient
        for mode, apimart in (('gemini', False), ('openai-json', False), ('openai', False), ('openai', True)):
            requests = []

            async def respond(request):
                requests.append(request)
                return httpx.Response(200, json={'data': [{'b64_json': encoded}]})

            with self.subTest(mode=mode, apimart=apimart), \
                 patch.object(main, 'get_api_provider', return_value=provider), \
                 patch.object(main, 'api_headers', return_value={}), \
                 patch.object(main, 'effective_protocol', return_value='gemini' if mode == 'gemini' else 'openai'), \
                 patch.object(main, 'effective_image_request_mode', return_value=mode), \
                 patch.object(main, 'is_apimart_provider', return_value=apimart), \
                 patch.object(main, 'append_gpt_image_edit_diagnostic'), \
                 patch.object(main.httpx, 'AsyncClient', side_effect=lambda **kw: client_type(
                     transport=httpx.MockTransport(respond), **kw)):
                await main.generate_ai_image('编辑历史参考图', '1024x1024', 'auto', 'nano-banana-2',
                                             [{'url': original_url}], provider_id=provider['id'])
                self.assertEqual(len(requests), 1)
                request = requests[0]
                self.assertNotIn(b'127.0.0.1', request.content)
                if mode == 'gemini':
                    parts = json.loads(request.content)['contents'][0]['parts']
                    self.assertEqual(base64.b64decode(parts[1]['inlineData']['data']), self.image_bytes)
                elif mode == 'openai-json' or apimart:
                    body = json.loads(request.content)
                    images = body['image_urls'] if apimart else body['extra_body']['image']
                    self.assertEqual(len(images), 1)
                    self.assertTrue(images[0].startswith('data:image/png;base64,'))
                    with Image.open(io.BytesIO(base64.b64decode(images[0].split(',', 1)[1]))) as image:
                        self.assertEqual(image.size, (32, 48))
                        self.assertEqual(image.getpixel((0, 0)), (200, 100, 50, 128))
                else:
                    self.assertTrue(request.url.path.endswith('/images/edits'))
                    self.assertIn(b'name="image"', request.content)
                    self.assertIn(self.image_bytes, request.content)


if __name__ == '__main__':
    unittest.main()
