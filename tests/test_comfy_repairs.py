import json
import tempfile
import threading
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import MagicMock, patch
import requests
from fastapi import FastAPI
from fastapi.testclient import TestClient
from ComfyUI.integration.comfy_apps import AppLibrary, install_comfy_apps, MANUAL_MODEL_SOURCES
from ComfyUI.integration.comfy_app_runtime import ManagedRuntime

class ComfyRepairTests(unittest.TestCase):
    def test_installed_bridge_is_not_offered_again_for_unconverted_graph(self):
        with tempfile.TemporaryDirectory() as root:
            service = AppLibrary(SimpleNamespace(BASE_DIR=root))
            item = {'source': {'nodes': [{'type': 'SaveImage'}]}, 'report': {}}
            self.assertTrue(any(e['kind'] == '转换桥接' for e in service._dependency_preflight(item)['auto_installable']))
            bridge = service.runtime.root / 'custom_nodes' / 'xiaomei_app_bridge'
            (bridge / 'web').mkdir(parents=True)
            (bridge / '__init__.py').write_text('', encoding='utf-8')
            (bridge / 'web' / 'bridge.js').write_text('', encoding='utf-8')
            self.assertFalse(any(e['kind'] == '转换桥接' for e in service._dependency_preflight(item)['auto_installable']))

    def test_saved_false_model_missing_status_is_removed(self):
        with tempfile.TemporaryDirectory() as root:
            service = AppLibrary(SimpleNamespace(BASE_DIR=root))
            item = {'source': {'nodes': [{'type': 'SaveImage'}]}, 'report': {
                'missing_models': ['None', 'cuda:0'],
                'model_requirements': [{'name': 'cuda:0', 'category': 'SEEDVR2'}]}}
            self.assertEqual(service._refresh_static_report(item)['missing_models'], [])

    def test_legacy_vae_alias_uses_current_model_file(self):
        with tempfile.TemporaryDirectory() as root:
            service = AppLibrary(SimpleNamespace(BASE_DIR=root))
            service.runtime.base = Path(root) / 'comfy-base'
            model = service.runtime.base / 'models' / 'vae' / 'ae.safetensors'
            model.parent.mkdir(parents=True)
            model.write_bytes(b'vae')
            item = {'source': {'nodes': [{'type': 'VAELoader', 'widgets_values': ['ae.sft']} ]},
                    'report': {}}
            report = service._refresh_static_report(item)
            self.assertEqual(report['missing_models'], [])
            self.assertEqual(report['model_requirements'][0]['resolved_name'], 'ae.safetensors')
            graph = {'1': {'class_type': 'VAELoader', 'inputs': {'vae_name': 'ae.sft'}}}
            candidates, unresolved = service._app_model_candidates({'api': graph, 'source': graph})
            self.assertFalse(candidates)
            self.assertEqual(unresolved[0]['value'], 'ae.sft')

    def test_interrupted_download_resumes_without_duplicate_bytes(self):
        with tempfile.TemporaryDirectory() as root:
            runtime = ManagedRuntime(root); runtime.base = Path(root)
            first = MagicMock(status_code=200, headers={'Content-Length': '6'})
            def interrupted(**kwargs):
                yield b'abc'
                raise requests.ConnectionError('timeout')
            first.iter_content.side_effect = interrupted
            second = MagicMock(status_code=206, headers={'Content-Length': '3', 'Content-Range': 'bytes 3-5/6'})
            second.iter_content.return_value = [b'def']
            plan = {'name': 'weight.safetensors', 'category': 'loras', 'url': 'https://huggingface.co/Comfy-Org/test/resolve/main/weight.safetensors', 'size_bytes': 6}
            with patch('ComfyUI.integration.comfy_app_runtime.requests.get', side_effect=[first, second]) as get, patch.object(runtime.cancel, 'wait', return_value=False):
                runtime._download_model(plan, Path(root) / 'log')
            self.assertEqual(get.call_args_list[1].kwargs['headers']['Range'], 'bytes=3-')
            self.assertEqual((Path(root) / 'models/loras/weight.safetensors').read_bytes(), b'abcdef')
            self.assertFalse(list(Path(root).rglob('*.download')))

    def test_download_does_not_retry_auth_failure_and_can_cancel_backoff(self):
        with tempfile.TemporaryDirectory() as root:
            runtime = ManagedRuntime(root)
            response = requests.Response(); response.status_code = 403
            error = RuntimeError('forbidden'); error.__cause__ = requests.HTTPError(response=response)
            with patch.object(runtime, '_download_model_attempt', side_effect=error) as attempt:
                with self.assertRaisesRegex(RuntimeError, 'forbidden'):
                    runtime._download_model({'name': 'test'}, Path(root) / 'log')
                self.assertEqual(attempt.call_count, 1)
            error = RuntimeError('timeout'); error.__cause__ = requests.Timeout()
            with patch.object(runtime, '_download_model_attempt', side_effect=error) as attempt, patch.object(runtime.cancel, 'wait', return_value=True):
                with self.assertRaisesRegex(RuntimeError, '取消'):
                    runtime._download_model({'name': 'test'}, Path(root) / 'log')
                self.assertEqual(attempt.call_count, 1)

    def test_catalog_without_library_omits_presets_without_removing_shared_references(self):
        with tempfile.TemporaryDirectory() as root:
            service = AppLibrary(SimpleNamespace(BASE_DIR=root))
            for identity in ['a' * 32, 'b' * 32]:
                path = service.path(identity); path.parent.mkdir(parents=True); path.write_text('{}')
            entries = [{'id': 'a'*32, 'title': 'Imported', 'workflow': 'custom/import.json'},
                       {'id': 'b'*32, 'title': 'Preset', 'workflow': 'custom/preset.json', 'source_kind': 'workflow'}]
            with patch.object(service, 'read', side_effect=lambda identity: next(dict(x) for x in entries if x['id']==identity)), patch.object(service, '_workflow_names') as scan:
                result = service.catalog(include_library=False)
            self.assertEqual([x['title'] for x in result['entries']], ['Imported'])
            self.assertEqual(len(result['apps']), 2)
            scan.assert_not_called()

    def test_simple_catalog_includes_unenabled_workflow_library_entries(self):
        with tempfile.TemporaryDirectory() as root:
            workflow_graph = {
                '1': {'class_type': 'SaveImage', 'inputs': {}},
            }
            workflow_root = Path(root) / 'ComfyUI' / 'workflows'
            for name in ('project/one.json', 'project/two.json', 'project/three.json'):
                path = workflow_root / name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text(json.dumps(workflow_graph), encoding='utf-8')

            host = SimpleNamespace(
                BASE_DIR=root,
                workflow_path_from_name=lambda name: workflow_root / name,
                workflow_config_path=lambda name: workflow_root / (name + '.config.json'),
            )
            app = FastAPI()
            service = install_comfy_apps(app, host)
            enabled_id = 'c' * 32
            service.save({
                'id': enabled_id,
                'title': '已启用工作流',
                'description': '本地工作流应用',
                'source': workflow_graph,
                'api': workflow_graph,
                'fields': [],
                'workflow_source': 'project/one.json',
                'workflow': 'custom/app_' + enabled_id + '.json',
                'source_kind': 'workflow',
            })

            with TestClient(app) as client:
                response = client.get('/api/comfy-apps/catalog')

            self.assertEqual(response.status_code, 200, response.text)
            entries = response.json()['entries']
            self.assertEqual({item['workflow_ref'] for item in entries}, {
                'project/one.json', 'project/two.json', 'project/three.json',
            })
            self.assertEqual(len(entries), 3)
            self.assertEqual(sum(item['entry_type'] == 'workflow' for item in entries), 2)

    def test_zimage_guidance_is_not_a_fabricated_minimum(self):
        with tempfile.TemporaryDirectory() as root:
            service = AppLibrary(SimpleNamespace(BASE_DIR=root))
            hardware = {'gpu': [{'name': 'RTX 4060', 'vram_gb': 8}], 'ram_gb': 32, 'disk_free_gb': 200, 'base_comfyui_ready': True}
            dependencies = {'installed': [], 'auto_installable': [], 'manual': []}
            item = {'source': {'1': {'class_type': 'UNETLoader', 'inputs': {'unet_name': 'z_image_turbo_bf16.safetensors'}}}}
            with patch.object(service, 'hardware_info', return_value=hardware), patch.object(service, '_dependency_preflight', return_value=dependencies):
                result = service.preflight(item)
            self.assertFalse(result['hard_failures'])
            self.assertFalse(result['requirements']['unknown'])
            self.assertIn('512', json.dumps(result['guidance']))
            self.assertFalse(result['requirements']['known'])

    def test_wrong_same_name_lora_is_not_imported(self):
        with tempfile.TemporaryDirectory() as root:
            host = SimpleNamespace(BASE_DIR=root, CANVAS_TASKS={}, CANVAS_TASK_LOCK=threading.RLock(),
                workflow_path_from_name=lambda n: Path(root)/n, workflow_config_path=lambda n: Path(root)/(n+'.config.json'))
            app = FastAPI(); service = install_comfy_apps(app, host); service.runtime.base = Path(root)/'base'
            name = 'z-image-Turbo-细节增强v2.safetensors'; identity = 'a'*32
            item = {'id': identity, 'report': {'missing_models': [name], 'model_requirements': [{'name': name, 'category': 'loras'}]}}
            with patch.object(service, 'read', return_value=item), TestClient(app) as client:
                response = client.post('/api/comfy-apps/'+identity+'/models/import', data={'dependency': name, 'category': 'loras'}, files={'file': (name, b'wrong file')})
            self.assertEqual(response.status_code, 400)
            self.assertIn('SHA-256', response.json()['detail'])
            self.assertFalse(list(service.runtime.base.rglob('*.safetensors')))
            self.assertFalse(list(service.runtime.base.rglob('*.upload')))
