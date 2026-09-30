import base64
import io
import tempfile
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch

import httpx
from PIL import Image
import main


class ImageBackgroundTransportTests(unittest.IsolatedAsyncioTestCase):
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


if __name__ == '__main__':
    unittest.main()
