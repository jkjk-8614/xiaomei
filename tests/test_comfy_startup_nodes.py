import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch

import requests

from ComfyUI.integration.comfy_app_runtime import ManagedRuntime
from ComfyUI.integration.comfy_node_registry import validate_node_package


class StartupNodeTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.runtime = ManagedRuntime(self.temp.name)
        self.runtime.base = Path(self.temp.name) / 'ComfyUI'
        self.workflow = self.runtime.base / 'workflows' / '工作流.json'
        self.write(self.workflow, {'nodes': [{'type': 'LoadImage'}]})
        for name in ('ComfyUI-Easy-Use', 'rgthree-comfy', 'xiaomei_app_bridge'):
            (self.runtime.root / 'custom_nodes' / name).mkdir(parents=True)
        self.info = {'LoadImage': {'python_module': 'nodes'},
                     'easy clearCacheAll': {'python_module': 'custom_nodes.ComfyUI-Easy-Use'}}

    def write(self, path, value):
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(value), encoding='utf-8')

    def profile(self):
        result = self.runtime.audit_startup_nodes(self.info, ['ComfyUI-Easy-Use'])
        self.write(self.runtime.root / 'startup-nodes.json', result)
        return result

    def environment(self):
        for path in (self.runtime.base / '.venv/Scripts/python.exe',
                     self.runtime.base / 'core/main.py',
                     self.runtime.root / '.venv/Scripts/python.exe'):
            path.parent.mkdir(parents=True, exist_ok=True)
            path.touch()
        self.bridge = self.runtime.base / 'tools/comfy-app-bridge/__init__.py'
        self.bridge.parent.mkdir(parents=True)
        self.bridge.write_text('# bridge', encoding='utf-8')
        (self.runtime.root / 'custom_nodes/xiaomei_app_bridge/__init__.py').write_text(
            '# bridge', encoding='utf-8')

    def test_skip_only_audited_unused_package(self):
        result = self.profile()
        self.assertEqual(result['skipped'], ['ComfyUI-Easy-Use'])
        self.assertEqual(self.runtime._startup_node_args(), [
            '--disable-all-custom-nodes', '--whitelist-custom-nodes',
            'rgthree-comfy', 'xiaomei_app_bridge'])
        self.assertTrue((self.runtime.root / 'custom_nodes/ComfyUI-Easy-Use').is_dir())

    def test_disabled_nested_and_original_nodes_are_protected(self):
        self.write(self.runtime.base / 'comfy_apps/a/app.json', {
            'original_api': {'1': {'class_type': 'easy clearCacheAll'}},
            'source': {'definitions': {'subgraphs': [{'nodes': [
                {'type': 'easy clearCacheAll', 'mode': 4}]}]}}})
        self.assertEqual(self.profile()['skipped'], [])
        self.assertEqual(self.runtime._startup_node_args(), [])

    def test_frontend_only_nodes_are_protected(self):
        self.write(self.workflow, {'nodes': [{'type': 'Fast Groups Bypasser (rgthree)'}]})
        self.info['Seed (rgthree)'] = {'python_module': 'custom_nodes.rgthree-comfy'}
        result = self.runtime.audit_startup_nodes(self.info, ['rgthree-comfy'])
        self.assertEqual(result['skipped'], [])

    def test_native_editor_saved_workflows_are_included(self):
        self.write(self.runtime.root / 'user/default/workflows/editor.json', {
            'nodes': [{'type': 'easy clearCacheAll', 'mode': 2}]})
        self.assertEqual(self.profile()['skipped'], [])

    def test_new_node_or_new_workflow_restores_full_loading(self):
        self.profile()
        self.write(self.workflow, {'1': {'class_type': 'easy clearCacheAll'}})
        self.assertEqual(self.runtime._startup_node_args(), [])
        self.write(self.workflow, {'nodes': [{'type': 'LoadImage'}]})
        self.write(self.workflow.with_name('new.json'), {'nodes': []})
        self.assertEqual(self.runtime._startup_node_args(), [])

    def test_parameter_and_task_updates_do_not_invalidate_node_audit(self):
        self.profile()
        self.write(self.workflow, {'nodes': [{'type': 'LoadImage', 'widgets_values': ['new.png']}]})
        self.assertIn('--whitelist-custom-nodes', self.runtime._startup_node_args())

    def test_package_changes_restore_full_loading(self):
        self.profile()
        (self.runtime.root / 'custom_nodes/new-package').mkdir()
        self.assertEqual(self.runtime._startup_node_args(), [])

    def test_corrupt_workflow_or_profile_falls_back(self):
        self.profile()
        self.workflow.write_text('{', encoding='utf-8')
        self.assertEqual(self.runtime._startup_node_args(), [])
        self.write(self.runtime.root / 'startup-nodes.json', [])
        self.assertEqual(self.runtime._startup_node_args(), [])

    def test_audit_rejects_missing_package_inventory(self):
        with self.assertRaisesRegex(ValueError, '完整节点清单'):
            self.runtime.audit_startup_nodes({}, ['ComfyUI-Easy-Use'])

    def test_previously_skipped_nodes_are_enabled_without_reinstall(self):
        self.profile()
        package = validate_node_package('ComfyUI-Easy-Use')
        self.assertEqual(self.runtime._packages_to_install([package]), [])
        unknown = {**package, 'nodes': ['newNode'], 'required_nodes': ['newNode']}
        self.assertEqual(self.runtime._packages_to_install([unknown]), [unknown])

    def test_live_runtime_reused_without_spawn_or_install(self):
        identity = MagicMock()
        identity.json.return_value = {'root': str(self.runtime.root), 'output': str(self.runtime.output)}
        with patch('ComfyUI.integration.comfy_app_runtime.requests.get', return_value=identity), \
                patch.object(self.runtime, 'info', return_value=self.info), \
                patch('ComfyUI.integration.comfy_app_runtime.subprocess.Popen') as spawn:
            self.assertEqual(self.runtime.start_existing(), self.info)
            spawn.assert_not_called()

    def test_starting_process_is_waited_for_not_duplicated(self):
        self.runtime.process = MagicMock()
        self.runtime.process.poll.return_value = None
        with patch('ComfyUI.integration.comfy_app_runtime.requests.get', side_effect=requests.Timeout()), \
                patch.object(self.runtime, '_wait_for_start', return_value=self.info) as wait, \
                patch('ComfyUI.integration.comfy_app_runtime.subprocess.Popen') as spawn:
            self.assertEqual(self.runtime.start_existing(), self.info)
            wait.assert_called_once()
            spawn.assert_not_called()

    def test_cold_start_uses_profile(self):
        self.environment()
        self.profile()
        with patch('ComfyUI.integration.comfy_app_runtime.requests.get', side_effect=requests.ConnectionError()), \
                patch.object(self.runtime, '_wait_for_start', return_value=self.info), \
                patch('ComfyUI.integration.comfy_app_runtime.subprocess.Popen') as spawn:
            self.runtime.start_existing()
            args = spawn.call_args.args[0]
            self.assertIn('--whitelist-custom-nodes', args)
            self.assertNotIn('ComfyUI-Easy-Use', args)

    def test_model_only_prepare_reuses_runtime(self):
        self.environment()
        with patch.object(self.runtime, 'info', return_value={'Float': {}}), \
                patch.object(self.runtime, '_download_model') as download, \
                patch.object(self.runtime, 'command') as command, \
                patch('ComfyUI.integration.comfy_app_runtime.subprocess.Popen') as spawn:
            self.runtime.prepare(lambda _: None, download_models=[{'name': 'model'}])
            download.assert_called_once()
            spawn.assert_not_called()
            command.assert_not_called()

    def test_bridge_update_does_not_reuse_old_process(self):
        self.environment()
        self.bridge.write_text('# new bridge', encoding='utf-8')
        with patch.object(self.runtime, 'info', return_value={'Float': {}}), \
                patch('ComfyUI.integration.comfy_app_runtime.requests.get', side_effect=requests.ConnectionError()), \
                patch('ComfyUI.integration.comfy_app_runtime.subprocess.Popen', side_effect=RuntimeError('new start')):
            with self.assertRaisesRegex(RuntimeError, 'new start'):
                self.runtime.prepare(lambda _: None)


if __name__ == '__main__':
    unittest.main()
