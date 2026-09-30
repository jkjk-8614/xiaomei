import tempfile
import threading
import time
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import requests
from fastapi import FastAPI
from fastapi.testclient import TestClient
from ComfyUI.integration.comfy_apps import install_comfy_apps
from ComfyUI.integration.comfy_app_runtime import ManagedRuntime
from ComfyUI.integration.comfy_node_registry import (
    MANAGER_CACHE_TTL,
    NodeSourceResolver,
    canonical_github_source,
    packages_for_nodes,
    static_package_plan,
)


class CatalogResponse:
    def __init__(self, value):
        self.value = value

    def raise_for_status(self):
        return None

    def json(self):
        return self.value


class NodeInstallTests(unittest.TestCase):
    def make_service(self, root):
        tasks = {}
        host = SimpleNamespace(BASE_DIR=root, COMFYUI_INSTANCES=[], CANVAS_TASKS=tasks,
            CANVAS_TASK_LOCK=threading.RLock(),
            workflow_path_from_name=lambda name: Path(root) / name,
            workflow_config_path=lambda name: Path(root) / (name + '.config.json'),
            add_canvas_task=lambda key, value: tasks.__setitem__(key, value),
            update_canvas_task=lambda key, value: tasks[key].update(value))
        app = FastAPI()
        service = install_comfy_apps(app, host)
        item = {'id': 'a' * 32, 'title': 'Test', 'description': '本地工作流',
                'workflow': 'custom/test.json', 'api': None,
                'source': {'nodes': [{'id': 79, 'type': 'Image Comparer (rgthree)'}]},
                'report': {'missing_nodes': ['Image Comparer (rgthree)']}}
        service.save(item)
        return app, service, item, tasks

    def test_packages_are_exact_and_deduplicated(self):
        self.assertEqual(packages_for_nodes(['LatentNoised', 'LatentNoised']), ['RES4LYF'])
        self.assertEqual(packages_for_nodes(['Image Comparer (rgthree)', 'Seed (rgthree)', 'Unknown']), ['rgthree-comfy'])
        self.assertEqual(packages_for_nodes(['ImpactInt', 'Qwen3_VQA', 'TextInput_']), [
            'comfyui-impact-pack', 'ComfyUI_Qwen3-VL-Instruct', 'comfyui-mixlab-nodes'])
        self.assertEqual(packages_for_nodes([
            'Anything Everywhere', 'Image Saver', 'DetailDaemonSamplerNode',
            'Get Image Size', 'LGNoiseInjectionLatent', 'SimpleMath+', 'UnetLoaderGGUF',
        ]), [
            'cg-use-everywhere', 'ComfyUI-Image-Saver', 'ComfyUI-Detail-Daemon',
            'was-node-suite-comfyui', 'ComfyUI-LG_SamplingUtils', 'ComfyUI_essentials',
            'ComfyUI-GGUF',
        ])
        self.assertEqual(packages_for_nodes(['Float', 'LibLibVisionV2Seed', '../../unknown']), [])
        self.assertEqual(packages_for_nodes(['DLSS5EasyPipeline']), ['ComfyUI-DLSS5'])

    def test_manager_catalog_requires_exact_unique_match_and_pins_commit(self):
        extension_map = {
            'https://github.com/example/Comfy-Nodes': [['ExactNode'], {'title_aux': 'Example'}],
        }
        custom_list = {'custom_nodes': [{
            'install_type': 'git-clone',
            'files': ['https://github.com/example/Comfy-Nodes'],
            'reference': 'https://github.com/example/Comfy-Nodes',
        }]}
        responses = iter([CatalogResponse(extension_map), CatalogResponse(custom_list)])
        with tempfile.TemporaryDirectory() as root:
            resolver = NodeSourceResolver(Path(root) / 'cache.json',
                http_get=lambda *args, **kwargs: next(responses),
                revision_lookup=lambda source: 'a' * 40, clock=lambda: 100)
            result = resolver.resolve(['ExactNode', 'exactnode'])
        self.assertEqual(len(result['packages']), 1)
        self.assertEqual(result['packages'][0]['source'], 'https://github.com/example/Comfy-Nodes.git')
        self.assertEqual(result['packages'][0]['revision'], 'a' * 40)
        self.assertEqual(result['packages'][0]['required_nodes'], ['ExactNode'])
        self.assertEqual(result['issues']['exactnode']['status'], 'not_found')

    def test_manager_catalog_does_not_guess_between_ambiguous_sources(self):
        extension_map = {
            'https://github.com/example/one': [['SharedNode'], {}],
            'https://github.com/example/two': [['SharedNode'], {}],
        }
        custom_list = {'custom_nodes': [
            {'install_type': 'git-clone', 'files': [source]}
            for source in extension_map
        ]}
        responses = iter([CatalogResponse(extension_map), CatalogResponse(custom_list)])
        with tempfile.TemporaryDirectory() as root:
            resolver = NodeSourceResolver(Path(root) / 'cache.json',
                http_get=lambda *args, **kwargs: next(responses),
                revision_lookup=lambda source: 'b' * 40, clock=lambda: 100)
            result = resolver.resolve(['SharedNode'])
        self.assertEqual(result['packages'], [])
        self.assertEqual(result['issues']['SharedNode']['status'], 'ambiguous')
        self.assertEqual(len(result['issues']['SharedNode']['sources']), 2)

    def test_manager_catalog_uses_verified_stale_cache_offline(self):
        extension_map = {'https://github.com/example/offline': [['OfflineNode'], {}]}
        custom_list = {'custom_nodes': [{
            'install_type': 'git-clone', 'files': ['https://github.com/example/offline'],
        }]}
        responses = iter([CatalogResponse(extension_map), CatalogResponse(custom_list)])
        with tempfile.TemporaryDirectory() as root:
            cache = Path(root) / 'cache.json'
            online = NodeSourceResolver(cache,
                http_get=lambda *args, **kwargs: next(responses),
                revision_lookup=lambda source: 'c' * 40, clock=lambda: 100)
            self.assertEqual(len(online.resolve(['OfflineNode'])['packages']), 1)

            def offline(*args, **kwargs):
                raise requests.ConnectionError('offline')

            cached = NodeSourceResolver(cache, http_get=offline,
                revision_lookup=lambda source: (_ for _ in ()).throw(RuntimeError('offline')),
                clock=lambda: 100 + MANAGER_CACHE_TTL + 1)
            result = cached.resolve(['OfflineNode'])
        self.assertEqual(result['packages'][0]['revision'], 'c' * 40)
        self.assertTrue(result['packages'][0]['stale_revision'])
        self.assertTrue(result['catalog']['stale'])

    def test_unsafe_catalog_sources_are_never_installable(self):
        self.assertIsNone(canonical_github_source('http://github.com/example/repo'))
        self.assertIsNone(canonical_github_source('https://github.com/example/repo/tree/main'))
        self.assertIsNone(canonical_github_source('https://user:secret@github.com/example/repo'))
        extension_map = {'https://evil.example/example/repo': [['UnsafeNode'], {}]}
        custom_list = {'custom_nodes': [{
            'install_type': 'git-clone', 'files': ['https://evil.example/example/repo'],
        }]}
        responses = iter([CatalogResponse(extension_map), CatalogResponse(custom_list)])
        with tempfile.TemporaryDirectory() as root:
            resolver = NodeSourceResolver(Path(root) / 'cache.json',
                http_get=lambda *args, **kwargs: next(responses),
                revision_lookup=lambda source: 'd' * 40, clock=lambda: 100)
            result = resolver.resolve(['UnsafeNode'])
        self.assertEqual(result['packages'], [])
        self.assertEqual(result['issues']['UnsafeNode']['status'], 'unsafe_source')

    def test_unregistered_install_rejected_before_commands(self):
        with tempfile.TemporaryDirectory() as root:
            runtime = ManagedRuntime(root)
            with patch.object(runtime, 'command') as command, self.assertRaises(ValueError):
                runtime.install_node_packages(['rgthree-comfy', '../unknown'], 'python', Path(root) / 'log', lambda _: None)
            command.assert_not_called()

    def test_missing_nodes_stop_conversion_without_format_error(self):
        with tempfile.TemporaryDirectory() as root:
            app, service, item, _ = self.make_service(root)
            with patch.object(service, 'backend', return_value=('localhost:8190', {'SaveImage': {}})), TestClient(app) as client:
                result = client.post('/api/comfy-apps/' + item['id'] + '/convert', json={'prompt': {'79': {'inputs': {}}}})
                self.assertEqual(result.status_code, 409)
                self.assertIn('Image Comparer', result.json()['detail'])
                self.assertNotIn('conversion_error', service.read(item['id']))
                self.assertEqual(service.read(item['id'])['source'], item['source'])

    def test_node_only_install_never_searches_or_downloads_models(self):
        with tempfile.TemporaryDirectory() as root:
            app, service, item, tasks = self.make_service(root)
            info = {'Image Comparer (rgthree)': {'python_module': 'custom_nodes.rgthree'}}
            with patch.object(service, 'preflight', return_value={'hard_failures': []}), \
                 patch.object(service, 'find_missing_models') as search, \
                 patch.object(service.runtime, 'prepare', return_value=info) as prepare, TestClient(app) as client:
                response = client.post('/api/comfy-apps/' + item['id'] + '/install-nodes')
                self.assertEqual(response.status_code, 200)
                for _ in range(100):
                    task = tasks[response.json()['task_id']]
                    if task['status'] not in ('queued', 'running'):
                        break
                    time.sleep(.01)
                self.assertEqual(task['status'], 'succeeded', task)
                search.assert_not_called()
                self.assertEqual(prepare.call_args.args[3], [])
                self.assertEqual([entry['name'] for entry in prepare.call_args.args[4]], ['rgthree-comfy'])
                self.assertEqual(prepare.call_args.args[4][0]['required_nodes'], ['Image Comparer (rgthree)'])
                self.assertEqual(service.read(item['id'])['report']['missing_nodes'], [])

    def test_offline_import_starts_then_installs_nodes_found_by_live_scan(self):
        with tempfile.TemporaryDirectory() as root:
            app, service, item, tasks = self.make_service(root)
            item['source'] = {'nodes': [{'id': 2, 'type': 'DLSS5EasyPipeline'}]}
            item['report'] = {'backend_available': False, 'missing_nodes': []}
            service.save(item)
            dependencies = service._dependency_preflight(service.read(item['id']))
            self.assertTrue(any(entry['kind'] == '环境检查'
                                for entry in dependencies['auto_installable']))
            first_info = {'LoadImage': {'python_module': 'nodes'}}
            second_info = {**first_info, 'DLSS5EasyPipeline': {
                'python_module': 'custom_nodes.ComfyUI-DLSS5',
            }}
            with patch.object(service, 'preflight', return_value={'hard_failures': []}), \
                 patch.object(service.runtime, 'prepare', side_effect=[first_info, second_info]) as prepare, \
                 TestClient(app) as client:
                response = client.post('/api/comfy-apps/' + item['id'] + '/install-nodes')
                for _ in range(100):
                    task = tasks[response.json()['task_id']]
                    if task['status'] not in ('queued', 'running'):
                        break
                    time.sleep(.01)
            self.assertEqual(task['status'], 'succeeded', task)
            self.assertEqual(prepare.call_count, 2)
            self.assertEqual(prepare.call_args_list[0].args[4], [])
            self.assertEqual(prepare.call_args_list[1].args[4][0]['name'], 'ComfyUI-DLSS5')
            self.assertEqual(service.read(item['id'])['report']['missing_nodes'], [])

    def test_unresolved_nodes_do_not_report_success(self):
        with tempfile.TemporaryDirectory() as root:
            app, service, item, tasks = self.make_service(root)
            item['source']['nodes'].append({'id': 80, 'type': 'UnknownNode'})
            service.save(item)
            info = {'Image Comparer (rgthree)': {'python_module': 'custom_nodes.rgthree'}}
            resolution = {'packages': static_package_plan(['Image Comparer (rgthree)']),
                          'resolved_nodes': ['Image Comparer (rgthree)'],
                          'issues': {'UnknownNode': {'status': 'not_found', 'detail': 'not found', 'sources': []}},
                          'catalog': {'stale': False, 'error': ''}}
            with patch.object(service, 'preflight', return_value={'hard_failures': []}), \
                 patch.object(service.node_sources, 'resolve', return_value=resolution), \
                 patch.object(service.runtime, 'prepare', return_value=info), TestClient(app) as client:
                response = client.post('/api/comfy-apps/' + item['id'] + '/install-nodes')
                for _ in range(100):
                    task = tasks[response.json()['task_id']]
                    if task['status'] not in ('queued', 'running'):
                        break
                    time.sleep(.01)
                self.assertEqual(task['status'], 'failed', task)
                self.assertIn('UnknownNode', task['error'])
                self.assertIn('UnknownNode', service.read(item['id'])['report']['missing_nodes'])

    def test_installed_package_is_rechecked_after_restart(self):
        with tempfile.TemporaryDirectory() as root:
            app, service, item, tasks = self.make_service(root)
            item['source'] = {'nodes': [{'id': 2, 'type': 'DLSS5EasyPipeline'}]}
            item['report'] = {'missing_nodes': ['DLSS5EasyPipeline']}
            service.save(item)
            with patch.object(service, 'preflight', return_value={'hard_failures': []}), \
                 patch.object(service.runtime, 'prepare', return_value={'LoadImage': {}}) as prepare, \
                 TestClient(app) as client:
                response = client.post('/api/comfy-apps/' + item['id'] + '/install-nodes')
                for _ in range(100):
                    task = tasks[response.json()['task_id']]
                    if task['status'] not in ('queued', 'running'):
                        break
                    time.sleep(.01)
            self.assertEqual(task['status'], 'failed', task)
            self.assertIn('DLSS5EasyPipeline', task['error'])
            package = prepare.call_args.args[4][0]
            self.assertEqual(package['name'], 'ComfyUI-DLSS5')
            self.assertEqual(package['revision'], 'f4f59cd1fe39e785a3b600ca20b5e09194a9e38d')

    def test_successful_conversion_clears_previous_error(self):
        with tempfile.TemporaryDirectory() as root:
            app, service, item, _ = self.make_service(root)
            item['conversion_error'] = 'old failure'
            graph = {'1': {'class_type': 'SaveImage', 'inputs': {}}}
            service.compile(item, graph, {'SaveImage': {'output_node': True, 'python_module': 'nodes'}})
            self.assertNotIn('conversion_error', service.read(item['id']))


if __name__ == '__main__':
    unittest.main()
