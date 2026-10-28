import io
import shutil
import tempfile
import threading
import time
import unittest
import zipfile
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import requests
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient
from ComfyUI.integration.comfy_apps import AppLibrary, install_comfy_apps
from ComfyUI.integration.comfy_app_runtime import ManagedRuntime


class EditorBridgeArchiveTests(unittest.TestCase):
    def test_download_uses_shipped_plugin_and_excludes_runtime_data(self):
        source = Path(__file__).resolve().parents[1] / 'ComfyUI/tools/comfy-app-bridge'
        with tempfile.TemporaryDirectory(prefix='桥接安装包-') as root:
            bridge = Path(root) / 'ComfyUI/tools/comfy-app-bridge'
            shutil.copytree(source, bridge)
            (bridge / '.env').write_text('private config', encoding='utf-8')
            (bridge / '__pycache__').mkdir(exist_ok=True)
            (bridge / '__pycache__/cache.pyc').write_bytes(b'cache')
            app = FastAPI()
            service = install_comfy_apps(app, SimpleNamespace(BASE_DIR=root))
            with TestClient(app) as client:
                response = client.get('/api/comfy-apps/editor-bridge.zip')
            self.assertEqual(response.status_code, 200, response.text[:100] if response.status_code != 200 else '')
            self.assertIn('Xiaomei-ComfyUI-Bridge.zip', response.headers['content-disposition'])
            with zipfile.ZipFile(io.BytesIO(response.content)) as archive:
                expected = {'xiaomei_app_bridge/__init__.py', 'xiaomei_app_bridge/web/bridge.js',
                            'xiaomei_app_bridge/README.md'}
                self.assertEqual(set(archive.namelist()), expected)
                for name in expected:
                    self.assertEqual(archive.read(name), (source / name.split('/', 1)[1]).read_bytes())
            service.runtime.start_existing = MagicMock()
            (bridge / 'web/bridge.js').unlink()
            with TestClient(app) as client:
                response = client.get('/api/comfy-apps/editor-bridge.zip')
            self.assertEqual(response.status_code, 503)
            self.assertIn('web/bridge.js', response.json()['detail'])
            service.runtime.start_existing.assert_not_called()


class RuntimeRecoveryTests(unittest.TestCase):
    def library(self):
        library = AppLibrary.__new__(AppLibrary)
        library.runtime = MagicMock(address='127.0.0.1:8190')
        return library

    def test_running_environment_is_reused(self):
        library = self.library()
        library.runtime.info.return_value = {'LoadImage': {}}
        self.assertEqual(library.backend({'managed': True}, start=True),
                         ('127.0.0.1:8190', {'LoadImage': {}}))
        library.runtime.start_existing.assert_not_called()

    def test_stopped_environment_recovers_without_install(self):
        library = self.library()
        library.runtime.info.side_effect = requests.ConnectionError('offline')
        library.runtime.start_existing.return_value = {'LoadImage': {}}
        self.assertEqual(library.backend({'managed': True}, start=True)[1], {'LoadImage': {}})
        library.runtime.start_existing.assert_called_once_with()
        library.runtime.prepare.assert_not_called()

    def test_inspection_does_not_start_environment(self):
        library = self.library()
        library.runtime.info.side_effect = requests.ConnectionError('offline')
        with self.assertRaises(HTTPException):
            library.backend({'managed': True})
        library.runtime.start_existing.assert_not_called()

    def test_start_failure_preserves_reason(self):
        library = self.library()
        library.runtime.info.side_effect = requests.ConnectionError('offline')
        library.runtime.start_existing.side_effect = RuntimeError('missing environment')
        with self.assertRaises(HTTPException) as caught:
            library.backend({'managed': True}, start=True)
        self.assertEqual(caught.exception.status_code, 503)
        self.assertEqual(caught.exception.detail, 'missing environment')

    def test_live_but_busy_runtime_is_not_relaunched(self):
        with tempfile.TemporaryDirectory() as root:
            runtime = ManagedRuntime(root)
            identity = MagicMock()
            identity.json.return_value = {'root': str(runtime.root), 'output': str(runtime.output)}
            with patch('ComfyUI.integration.comfy_app_runtime.requests.get', return_value=identity), \
                    patch.object(runtime, 'info', side_effect=requests.Timeout()), \
                    patch('ComfyUI.integration.comfy_app_runtime.subprocess.Popen') as spawn:
                with self.assertRaisesRegex(RuntimeError, '已启动'):
                    runtime.start_existing()
                spawn.assert_not_called()
            self.assertTrue(runtime.guard.acquire(blocking=False))
            runtime.guard.release()


class PreparationRescanTests(unittest.TestCase):
    def test_completed_preparation_reports_final_readiness(self):
        with tempfile.TemporaryDirectory() as root:
            tasks = {}
            host = SimpleNamespace(BASE_DIR=root, CANVAS_TASKS=tasks, CANVAS_TASK_LOCK=threading.RLock(),
                workflow_path_from_name=lambda n: Path(root) / 'workflows' / n,
                workflow_config_path=lambda n: Path(root) / 'workflows' / (n + '.config.json'),
                add_canvas_task=lambda key, value: tasks.__setitem__(key, value),
                update_canvas_task=lambda key, value: tasks[key].update(value))
            app = FastAPI()
            service = install_comfy_apps(app, host)
            app_id = 'b' * 32
            graph = {'1': {'class_type': 'SaveImage', 'inputs': {}}}
            info = {'SaveImage': {'python_module': 'nodes', 'output_node': True, 'input': {}}}
            service.save({'id': app_id, 'title': 'test', 'description': 'local',
                          'source': graph, 'api': graph, 'workflow': 'custom/test.json', 'fields': []})
            with patch.object(service, 'preflight', return_value={'hard_failures': []}), \
                    patch.object(service.runtime, 'prepare', return_value=info), TestClient(app) as client:
                response = client.post(f'/api/comfy-apps/{app_id}/install-nodes')
                self.assertEqual(response.status_code, 200, response.text)
                task = tasks[response.json()['task_id']]
                for _ in range(100):
                    if task['status'] not in ('queued', 'running'):
                        break
                    time.sleep(.01)
                self.assertEqual(task['status'], 'succeeded', task)
                readiness = service.read(app_id)['readiness']
                self.assertTrue(readiness['can_run'])
                self.assertEqual(task['stage'], readiness['summary'])
                self.assertEqual(task['progress']['detail'], readiness['summary'])

    def test_rescan_recovers_only_verified_complete_environment(self):
        graph = {'1': {'class_type': 'LoadImage', 'inputs': {'image': 'sample.png'}},
                 '2': {'class_type': 'SaveImage', 'inputs': {'images': ['1', 0]}}}
        info = {'Float': {'python_module': 'custom_nodes.xiaomei_app_bridge'},
                'LoadImage': {'python_module': 'nodes', 'input': {'required': {}}},
                'SaveImage': {'python_module': 'nodes', 'output_node': True, 'input': {}}}
        cases = [
            ('failed', '127.0.0.1:8190', info, True, True),
            ('cancelled', '127.0.0.1:8190', info, True, True),
            ('failed', '127.0.0.1:8188', info, True, False),
            ('failed', '127.0.0.1:8190', info, False, False),
            ('failed', '127.0.0.1:8190', {k: v for k, v in info.items() if k != 'Float'}, True, False),
            ('failed', '127.0.0.1:8190', {k: v for k, v in info.items() if k != 'LoadImage'}, True, False),
            ('running', '127.0.0.1:8190', info, True, False),
        ]
        for status, backend, checked, verified, recovered in cases:
            with self.subTest(status=status, backend=backend, nodes=list(checked), verified=verified), \
                    tempfile.TemporaryDirectory() as root:
                task = {'task_id': 'old', 'status': status, 'error': 'old failure'}
                host = SimpleNamespace(BASE_DIR=root, CANVAS_TASKS={'old': task},
                    CANVAS_TASK_LOCK=threading.RLock(),
                    workflow_path_from_name=lambda n: Path(root) / 'ComfyUI/workflows' / n,
                    workflow_config_path=lambda n: Path(root) / 'ComfyUI/workflows' / (n + '.config.json'))
                app = FastAPI()
                service = install_comfy_apps(app, host)
                app_id = 'a' * 32
                service.save({'id': app_id, 'title': 'test', 'description': 'local workflow',
                              'source': graph, 'api': graph, 'fields': [], 'workflow': 'custom/test.json',
                              'state': 'blocked', 'prepare_task': 'old', 'prepare_error': 'old failure'})
                identity_check = ({'return_value': checked} if verified else
                                  {'side_effect': requests.ConnectionError('identity unavailable')})
                with patch.object(service, 'backend', return_value=(backend, checked)), \
                        patch.object(service.runtime, 'info', **identity_check), TestClient(app) as client:
                    response = client.post(f'/api/comfy-apps/{app_id}/rescan')
                    self.assertEqual(response.status_code, 200, response.text)
                    result = response.json()
                    self.assertEqual(result['readiness']['can_run'], recovered, result['readiness'])
                    self.assertEqual('prepare_task' in result, not recovered)
                    self.assertEqual('prepare_error' in result, not recovered)
                    self.assertEqual(host.CANVAS_TASKS['old'], task)
                    self.assertEqual(service.read(app_id)['readiness']['can_run'], recovered)


if __name__ == '__main__':
    unittest.main()
