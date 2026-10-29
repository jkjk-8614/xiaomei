"""Exercise outpaint result checks in temporary storage, without user config."""
import ast
import asyncio
import math
import os
import sys
from pathlib import Path
import re
import tempfile

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import time
import uuid
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
        names = {'_outpaint_preserve_number', '_validate_outpaint_frame',
                 '_outpaint_center_matches', '_outpaint_original_redrawn'}
        tree = ast.parse(source.read_text(encoding='utf-8'))
        body = [n for n in tree.body if getattr(n, 'name', None) in names]
        self.assertEqual(len(body), len(names))
        self.ns = dict(globals(), output_file_from_url=lambda url: str(self.root / url.lstrip('/')))
        exec(compile(ast.Module(body=body, type_ignores=[]), str(source), 'exec'), self.ns)
        self.preserve = dict(sourceUrl='/source.png', canvasW=200, canvasH=120,
                             sourceW=80, sourceH=80, x=100, y=20)
        original = Image.new('RGBA', (80, 80), (230, 20, 40, 255))
        original.putpixel((0, 0), (0, 0, 0, 0))
        original.save(self.root / 'source.png')

    def save_result(self, size=(200, 120), include_source=True):
        generated = Image.new('RGBA', (200, 120), 'blue')
        if include_source:
            with Image.open(self.root / 'source.png') as source:
                generated.paste(source, (100, 20))
        generated.resize(size, Image.Resampling.LANCZOS).save(self.root / 'generated.png')
        return (self.root / 'generated.png').read_bytes()

    def test_matching_result_is_left_byte_for_byte_unchanged(self):
        before = self.save_result()
        self.assertFalse(self.ns['_outpaint_original_redrawn']('/generated.png', self.preserve))
        self.assertEqual((self.root / 'generated.png').read_bytes(), before)

    def test_redrawn_result_is_marked_without_replacing_source_pixels(self):
        before = self.save_result(include_source=False)
        self.assertTrue(self.ns['_outpaint_original_redrawn']('/generated.png', self.preserve))
        self.assertEqual((self.root / 'generated.png').read_bytes(), before)
        with Image.open(self.root / 'generated.png') as result:
            self.assertEqual(result.getpixel((120, 40)), (0, 0, 255, 255))

    def test_different_output_ratio_is_kept_and_marked(self):
        before = self.save_result(size=(200, 200))
        self.assertTrue(self.ns['_outpaint_original_redrawn']('/generated.png', self.preserve))
        self.assertEqual((self.root / 'generated.png').read_bytes(), before)
        with Image.open(self.root / 'generated.png') as result:
            self.assertEqual(result.size, (200, 200))

    def test_missing_original_does_not_discard_saved_result(self):
        self.save_result()
        self.preserve['sourceUrl'] = '/missing.png'
        self.assertIsNone(self.ns['_outpaint_original_redrawn']('/generated.png', self.preserve))
        self.assertTrue((self.root / 'generated.png').exists())

    def test_out_of_frame_geometry_is_rejected_before_generation(self):
        for changes in [dict(x=-1), dict(y=100), dict(canvasW=0), dict(canvasW=20000)]:
            with self.subTest(changes=changes), self.assertRaises(ValueError):
                self.ns['_validate_outpaint_frame']({**self.preserve, **changes})

    def test_native_edit_sends_mask_and_never_retries_without_it(self):
        source = Path(__file__).resolve().parents[1] / 'main.py'
        node = next(n for n in ast.parse(source.read_text(encoding='utf-8')).body
                    if getattr(n, 'name', '') == 'generate_ai_image')
        calls = []
        status = 200
        protocol = 'openai'
        request_mode = 'openai'

        class Client:
            def __init__(self, **kwargs):
                pass
            async def __aenter__(self):
                return self
            async def __aexit__(self, *args):
                pass
            async def post(self, url, **kwargs):
                files = [(key, value[1].read()) for key, value in kwargs.get('files', [])]
                calls.append((url, files, kwargs.get('json')))
                return httpx.Response(status, json={'image': 'fixture'}, request=httpx.Request('POST', url))

        ns = dict(self.ns, httpx=SimpleNamespace(AsyncClient=Client, Timeout=httpx.Timeout, HTTPError=httpx.HTTPError),
                  HTTPException=HTTPException, time=time, AI_REQUEST_TIMEOUT=30, ONLINE_IMAGE_REFERENCE_MAX=10,
                  GPT_IMAGE2_EDIT_IDEMPOTENCY_SUPPORTED=False,
                  GPT_IMAGE2_EDIT_HTTP2=False,
                  image_edit_input_stats=lambda _paths: (0, 0),
                  upstream_request_id=lambda _response: "",
                  append_gpt_image_edit_diagnostic=lambda **_kwargs: None,
                  get_api_provider=lambda _: {'id': 'fixture', 'base_url': 'https://fixture.test'},
                  effective_protocol=lambda *args: protocol, effective_image_request_mode=lambda *args: request_mode,
                  normalize_image_quality=lambda *args: '', gpt_image_background_options=lambda *args: {},
                  provider_endpoint_url=lambda p, key, default: p['base_url'] + default,
                  api_headers=lambda **kwargs: {}, content_type_for_path=lambda _: 'image/png',
                   image_task_error_payload=lambda _: None, extract_image=lambda raw: raw['image'],
                   reference_to_data_url=lambda ref, max_size=None: 'data:image/png;base64,fixture')
        async def gemini_image(*args):
            calls.append(('gemini', [], None))
            return 'fixture', {'image': 'fixture'}
        ns['generate_gemini_provider_image'] = gemini_image
        for name in ['is_codex_provider', 'is_gemini_cli_provider', 'is_jimeng_provider',
                     'is_runninghub_provider', 'is_comfly_gemini_image_model', 'is_volcengine_provider',
                     'is_gpt_image_2_model', 'is_apimart_provider', 'is_comfly_provider',
                     'is_soonstudio_provider']:
            ns[name] = lambda *args: False
        exec(compile(ast.Module(body=[node], type_ignores=[]), str(source), 'exec'), ns)
        ref = {'url': '/source.png', 'outpaint_canvas': True}
        result = asyncio.run(ns['generate_ai_image']('expand', '200x120', '', 'fixture', [ref]))
        self.assertEqual(result[0], 'fixture')
        self.assertEqual([key for key, _ in calls[0][1]], ['image', 'mask'])
        self.assertEqual(calls[0][1][0][1], calls[0][1][1][1])
        calls.clear()
        protocol, request_mode = 'gemini', 'openai'
        self.assertEqual(asyncio.run(ns['generate_ai_image']('expand', '200x120', '', 'fixture', [ref]))[0], 'fixture')
        self.assertEqual(calls[0][0], 'gemini')
        calls.clear()
        protocol, request_mode = 'openai', 'openai-json'
        self.assertEqual(asyncio.run(ns['generate_ai_image']('expand', '200x120', '', 'fixture', [ref]))[0], 'fixture')
        self.assertTrue(calls[0][0].endswith('/images/generations'))
        self.assertEqual(len(calls[0][2]['extra_body']['image']), 1)
        calls.clear()
        protocol = request_mode = 'openai'
        status = 400
        with self.assertRaises(HTTPException) as error:
            asyncio.run(ns['generate_ai_image']('expand', '200x120', '', 'fixture', [ref]))
        self.assertIn('蒙版', error.exception.detail)
        self.assertEqual(len(calls), 1)
        calls.clear()
        status = 200
        asyncio.run(ns['generate_ai_image']('edit', '200x120', '', 'fixture', [{'url': '/source.png'}]))
        self.assertEqual([key for key, _ in calls[0][1]], ['image'])

    def gemini_request_config(self, size, aspect_ratio, refs, resolution=""):
        """Capture the imageConfig that the Gemini native route submits upstream."""
        source = Path(__file__).resolve().parents[1] / 'main.py'
        tree = ast.parse(source.read_text(encoding='utf-8'))
        wanted = {'parse_size_pair', 'apimart_size_resolution', 'apimart_nearest_aspect',
                  'normalize_gemini_aspect_ratio',
                  'gemini_image_config', 'generate_gemini_provider_image'}
        body = [
            node for node in tree.body
            if getattr(node, 'name', None) in wanted
            or (isinstance(node, ast.Assign)
                and any(getattr(target, 'id', '') in {'GEMINI_ASPECT_RATIO_CHOICES', 'APIMART_ASPECT_RATIOS'}
                        for target in node.targets))
        ]
        self.assertEqual(len(body), len(wanted) + 2)
        captured = {}

        class Response:
            def raise_for_status(self):
                pass

            def json(self):
                return {'candidates': [{'content': {'parts': [{'inlineData': {'data': 'fixture'}}]}}]}

        class Client:
            def __init__(self, **kwargs):
                pass

            async def __aenter__(self):
                return self

            async def __aexit__(self, *args):
                pass

        async def post(client, endpoint, headers, body):
            captured['config'] = body['generationConfig']['imageConfig']
            return Response()

        async def acquire(provider_id, model):
            return 'slot'

        ns = {
            're': re, 'math': math, 'asyncio': asyncio,
            'httpx': SimpleNamespace(AsyncClient=Client, Timeout=lambda **kwargs: None),
            'HTTPException': HTTPException,
            'ONLINE_IMAGE_REFERENCE_MAX': 10,
            'GEMINI_IMAGE_REQUEST_TIMEOUT': 300,
            'gemini_model_name': lambda model: str(model),
            'gemini_endpoint_url': lambda provider, model: 'https://fixture.test',
            'gemini_reference_part': lambda ref: {'inlineData': {'data': 'fixture'}},
            'is_comfly_provider': lambda provider: False,
            'product_fidelity_capabilities': lambda provider, model: {
                'supportedOutputSizes': ['4K'], 'supportedAspectRatios': ['1:1', '3:4']},
            'acquire_gemini_image_slot': acquire,
            'release_gemini_image_slot': lambda slot: None,
            'post_gemini_image_with_retry': post,
            'api_headers': lambda **kwargs: {},
            'extract_image': lambda raw: 'fixture',
        }
        exec(compile(ast.Module(body=body, type_ignores=[]), str(source), 'exec'), ns)
        asyncio.run(ns['generate_gemini_provider_image'](
            'prompt', size, 'nano-banana-2.1', refs, {'id': 'fixture'}, aspect_ratio, resolution=resolution))
        return captured['config']

    def test_selected_resolution_is_sent_as_native_image_config(self):
        for resolution in ['1k', '2k', '4k']:
            with self.subTest(resolution=resolution):
                config = self.gemini_request_config('1024x4096', '1:4', [], resolution=resolution)
                self.assertEqual(config['imageSize'], resolution.upper())
                self.assertEqual(config['aspectRatio'], '1:4')

    def test_outpaint_declares_canvas_aspect_ratio(self):
        """缺 aspectRatio 时部分通道按 1:1 出图，2880x3840 扩图会回来 4096x4096。"""
        config = self.gemini_request_config(
            '2880x3840', 'source', [{'url': '/canvas.png', 'outpaint_canvas': True}])
        self.assertEqual(config, {'imageSize': '4K', 'aspectRatio': '3:4'})

    def test_plain_reference_run_keeps_adaptive_ratio(self):
        config = self.gemini_request_config('1024x1536', 'source', [{'url': '/ref.png'}])
        self.assertNotIn('aspectRatio', config)


if __name__ == '__main__':
    unittest.main()
