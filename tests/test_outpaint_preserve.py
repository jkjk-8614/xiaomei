"""Exercise production outpaint helpers in temporary storage, without user config."""
import ast
import asyncio
import math
import os
from pathlib import Path
import tempfile
import time
from types import SimpleNamespace
import unittest
import httpx
from fastapi import HTTPException
from PIL import Image, ImageOps


class OutpaintTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        source = Path(__file__).resolve().parents[1] / 'main.py'
        names = {'_outpaint_preserve_number', '_outpaint_output_crop_box',
                 '_outpaint_source_draw_geometry', '_compose_outpaint_center_local',
                 'preserve_outpaint_centers'}
        tree = ast.parse(source.read_text(encoding='utf-8'))
        body = [n for n in tree.body if getattr(n, 'name', None) in names]
        self.assertEqual(len(body), len(names))
        self.ns = dict(globals(), output_file_from_url=lambda url: str(self.root / url.lstrip('/')),
                       generated_output_filename=lambda *args, **kwargs: 'locked.png',
                       output_path_for=lambda name, kind: str(self.root / name),
                       output_url_for=lambda name, kind: '/' + name,
                       image_output_meta=lambda url: {'url': url})
        exec(compile(ast.Module(body=body, type_ignores=[]), str(source), 'exec'), self.ns)
        self.preserve = dict(sourceUrl='/source.png', canvasW=200, canvasH=120,
                             sourceW=80, sourceH=80, x=100, y=20)
        original = Image.new('RGBA', (80, 80), (230, 20, 40, 255))
        original.putpixel((0, 0), (0, 0, 0, 0))
        original.putpixel((79, 79), (20, 220, 40, 255))
        original.save(self.root / 'source.png')

    def compose(self, size):
        Image.new('RGBA', size, 'blue').save(self.root / 'generated.png')
        return self.ns['_compose_outpaint_center_local']('/generated.png', '/source.png', self.preserve)

    def test_complete_original_including_edges_and_alpha_is_unchanged(self):
        for size in [(200, 120), (400, 240), (202, 120)]:
            with self.subTest(size=size):
                _, meta = self.compose(size)
                with Image.open(self.root / 'locked.png') as result, Image.open(self.root / 'source.png') as source:
                    self.assertEqual(result.size, (200, 120))
                    self.assertEqual(result.crop((100, 20, 180, 100)).tobytes(), source.tobytes())
                    self.assertEqual(result.getpixel((0, 60)), (0, 0, 255, 255))
                self.assertTrue(meta['outpaint_center_locked'])

    def test_crop_does_not_stretch_or_shift_original(self):
        geometry = self.ns['_outpaint_source_draw_geometry'](400, 250, self.preserve, (0, 5, 400, 245))
        self.assertEqual(geometry, (200, 40, 160, 160))

    def test_incompatible_ratio_is_not_published(self):
        with self.assertRaisesRegex(ValueError, '比例'):
            self.compose((200, 200))
        self.assertFalse((self.root / 'locked.png').exists())

    def test_missing_original_fails_instead_of_publishing_raw_generation(self):
        self.preserve['sourceUrl'] = '/missing.png'
        with self.assertRaisesRegex(ValueError, '无法读取'):
            asyncio.run(self.ns['preserve_outpaint_centers'](['/generated.png'], [], self.preserve))

    def test_out_of_frame_geometry_is_rejected(self):
        for changes in [dict(x=-1), dict(y=100), dict(canvasW=0), dict(canvasW=20000)]:
            with self.subTest(changes=changes), self.assertRaises(ValueError):
                self.ns['_outpaint_source_draw_geometry'](200, 120, {**self.preserve, **changes})

    def test_ordinary_generation_is_unchanged(self):
        urls, items = ['/ordinary.png'], [{'url': '/ordinary.png'}]
        self.assertEqual(asyncio.run(self.ns['preserve_outpaint_centers'](urls, items, {})), (urls, items))

    def test_native_edit_sends_mask_and_never_retries_without_it(self):
        source = Path(__file__).resolve().parents[1] / 'main.py'
        node = next(n for n in ast.parse(source.read_text(encoding='utf-8')).body
                    if getattr(n, 'name', '') == 'generate_ai_image')
        calls = []
        status = 200

        class Client:
            def __init__(self, **kwargs):
                pass
            async def __aenter__(self):
                return self
            async def __aexit__(self, *args):
                pass
            async def post(self, url, **kwargs):
                files = [(key, value[1].read()) for key, value in kwargs.get('files', [])]
                calls.append((url, files))
                return httpx.Response(status, json={'image': 'fixture'}, request=httpx.Request('POST', url))

        ns = dict(self.ns, httpx=SimpleNamespace(AsyncClient=Client, Timeout=httpx.Timeout, HTTPError=httpx.HTTPError),
                  HTTPException=HTTPException, time=time, AI_REQUEST_TIMEOUT=30, ONLINE_IMAGE_REFERENCE_MAX=10,
                  get_api_provider=lambda _: {'id': 'fixture', 'base_url': 'https://fixture.test'},
                  effective_protocol=lambda *args: 'openai', effective_image_request_mode=lambda *args: 'openai',
                  normalize_image_quality=lambda *args: '', gpt_image_background_options=lambda *args: {},
                  provider_endpoint_url=lambda p, key, default: p['base_url'] + default,
                  api_headers=lambda **kwargs: {}, content_type_for_path=lambda _: 'image/png',
                  image_task_error_payload=lambda _: None, extract_image=lambda raw: raw['image'])
        for name in ['is_codex_provider', 'is_gemini_cli_provider', 'is_jimeng_provider',
                     'is_runninghub_provider', 'is_comfly_gemini_image_model', 'is_volcengine_provider',
                     'is_gpt_image_2_model', 'is_apimart_provider', 'is_comfly_provider']:
            ns[name] = lambda *args: False
        exec(compile(ast.Module(body=[node], type_ignores=[]), str(source), 'exec'), ns)
        ref = {'url': '/source.png', 'outpaint_canvas': True}
        result = asyncio.run(ns['generate_ai_image']('expand', '200x120', '', 'fixture', [ref]))
        self.assertEqual(result[0], 'fixture')
        self.assertEqual([key for key, _ in calls[0][1]], ['image', 'mask'])
        self.assertEqual(calls[0][1][0][1], calls[0][1][1][1])
        calls.clear()
        status = 400
        with self.assertRaises(HTTPException) as error:
            asyncio.run(ns['generate_ai_image']('expand', '200x120', '', 'fixture', [ref]))
        self.assertIn('蒙版', error.exception.detail)
        self.assertEqual(len(calls), 1)
        calls.clear()
        status = 200
        asyncio.run(ns['generate_ai_image']('edit', '200x120', '', 'fixture', [{'url': '/source.png'}]))
        self.assertEqual([key for key, _ in calls[0][1]], ['image'])


if __name__ == '__main__':
    unittest.main()
