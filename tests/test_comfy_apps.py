import json
import tempfile
import unittest
import threading
import time
from unittest.mock import patch, MagicMock
from pathlib import Path
from types import SimpleNamespace

from ComfyUI.integration.comfy_apps import (AppLibrary, active_graph, apply_dlss5_preset, dlss5_preset_field, extract_fields, normalize_legacy_model_values,
                        normalize_legacy_node_types, normalize_legacy_scheduler_values, validate_fields)
from ComfyUI.integration.comfy_app_runtime import ManagedRuntime
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient
from ComfyUI.integration.comfy_apps import install_comfy_apps
from ComfyUI.integration.comfy_apps import workflow_groups, workflow_for_group


INFO = {
    'LoadImage': {'python_module': 'nodes', 'input': {'required': {'image': [['sample.png'], {}]}}},
    'SaveImage': {'python_module': 'nodes', 'output_node': True, 'input': {}},
    'KSampler': {'python_module': 'nodes', 'input': {'required': {'steps': ['INT', {'min': 1, 'max': 100}], 'seed': ['INT', {'min': 0}]}}},
}
GRAPH = {
    '1': {'class_type': 'LoadImage', 'inputs': {'image': 'author.png'}},
    '2': {'class_type': 'LoadImage', 'inputs': {'image': 'unused.png'}},
    '3': {'class_type': 'SaveImage', 'inputs': {'images': ['1', 0], 'filename_prefix': 'author'}},
}


class AppTests(unittest.TestCase):
    def test_grouped_dlss5_settings_become_an_executable_preset(self):
        source = {'nodes': [
            {'id': 30, 'type': 'DLSS5Settings', 'pos': [10, 10],
             'inputs': [{'name': 'nr_intensity', 'widget': {'name': 'nr_intensity'}},
                        {'name': 'dlss_model_preset', 'widget': {'name': 'dlss_model_preset'}}],
             'widgets_values': [0.5, 'K']},
            {'id': 24, 'type': 'DLSS5Settings', 'pos': [110, 10],
             'inputs': [{'name': 'nr_intensity', 'widget': {'name': 'nr_intensity'}},
                        {'name': 'dlss_model_preset', 'widget': {'name': 'dlss_model_preset'}}],
             'widgets_values': [0.8, 'L']},
            {'id': 31, 'type': 'DLSS5Settings', 'pos': [210, 10],
             'inputs': [{'name': 'nr_intensity', 'widget': {'name': 'nr_intensity'}},
                        {'name': 'dlss_model_preset', 'widget': {'name': 'dlss_model_preset'}}],
             'widgets_values': [1.0, 'M']},
            {'id': 3, 'type': 'DLSS5EnhanceImages', 'pos': [400, 10]}],
            'groups': [{'id': 4, 'title': '低', 'bounding': [0, 0, 90, 90]},
                       {'id': 5, 'title': '中', 'bounding': [100, 0, 90, 90]},
                       {'id': 6, 'title': '高', 'bounding': [200, 0, 90, 90]}]}
        original = {'1': {'class_type': 'LoadImage', 'inputs': {'image': 'source.png'}},
                    '3': {'class_type': 'DLSS5EnhanceImages', 'inputs': {'images': ['1', 0]}},
                    '10': {'class_type': 'SaveImage', 'inputs': {'images': ['3', 0]}}}
        item = {'source': source, 'api': original}
        self.assertEqual(workflow_groups(source), [])
        self.assertEqual([group['title'] for group in workflow_groups(source, include_preset_groups=True)], ['低', '中', '高'])
        field = dlss5_preset_field(item)
        self.assertEqual(field['options'], ['原工作流默认', '低', '中', '高'])
        self.assertEqual([control['input'] for control in field['preset_controls']],
                         ['nr_intensity', 'dlss_model_preset'])
        self.assertEqual(field['preset_controls'][0]['defaults'], {'低': 0.5, '中': 0.8, '高': 1.0})
        schema = {'DLSS5Settings': {'input': {'required': {
            'nr_intensity': ['FLOAT', {'min': 0, 'max': 2, 'step': 0.01}],
            'dlss_model_preset': ['COMBO', {'options': ['Default', 'J', 'K', 'L', 'M']}],
        }}}}
        enriched = dlss5_preset_field(item, schema)
        self.assertFalse(field['preset_schema_complete'])
        self.assertTrue(enriched['preset_schema_complete'])
        self.assertEqual(enriched['preset_controls'][0]['max'], 2)
        self.assertEqual(enriched['preset_controls'][0]['step'], 0.01)
        self.assertEqual(enriched['preset_controls'][1]['options'], ['Default', 'J', 'K', 'L', 'M'])
        self.assertEqual(validate_fields([field], {}, {}), {})
        for label, node_id, intensity in [('低', '30', 0.5), ('中', '24', 0.8), ('高', '31', 1.0)]:
            params = validate_fields([field], {field['id']: label}, {})
            graph = apply_dlss5_preset(json.loads(json.dumps(original)), item, params)
            self.assertEqual(params['3']['settings'], [node_id, 0])
            self.assertEqual(graph[node_id]['inputs']['nr_intensity'], intensity)
            self.assertEqual(graph[node_id]['class_type'], 'DLSS5Settings')
        self.assertEqual(set(original), {'1', '3', '10'})
        with self.assertRaisesRegex(ValueError, '请选择有效选项'):
            validate_fields([field], {field['id']: '极高'}, {})
        with self.assertRaisesRegex(ValueError, '增强档位无效'):
            apply_dlss5_preset(json.loads(json.dumps(original)), item, {'3': {'settings': ['999', 0]}})

    def test_dlss_easy_controls_are_exposed_and_applied(self):
        controls = {
            'scenario': (['Auto (recommended)', 'Still image'], 'Auto (recommended)'),
            'operation': (['Upscale + neural rendering', 'Upscale only'], 'Upscale + neural rendering'),
            'scale': (['2x', '3x'], '2x'),
            'quality': (['Quality', 'Balanced'], 'Quality'),
            'look': (['Neutral / faithful', 'Realistic detail'], 'Neutral / faithful'),
            'effect_strength': ('FLOAT', 0.85),
        }
        graph = {'2': {'class_type': 'DLSS5EasyPipeline', 'inputs': {
            name: default for name, (_, default) in controls.items()}}}
        specs = {name: [options, {'min': 0, 'max': 1, 'step': 0.01}]
                 if name == 'effect_strength' else [options, {}]
                 for name, (options, _) in controls.items()}
        fields = extract_fields(graph, {'DLSS5EasyPipeline': {'input': {'required': specs}}})
        self.assertEqual({field['id'] for field in fields}, {f'2:{name}' for name in controls})
        self.assertTrue(all(field['advanced'] is False for field in fields))
        self.assertEqual(next(field for field in fields if field['input'] == 'scale')['options'], ['2x', '3x'])
        selected = {'2:scenario': 'Still image', '2:scale': '3x', '2:effect_strength': 0.6}
        params = validate_fields(fields, selected, {})
        self.assertEqual(params['2'], {'scenario': 'Still image', 'operation': 'Upscale + neural rendering',
                                       'scale': '3x', 'quality': 'Quality', 'look': 'Neutral / faithful',
                                       'effect_strength': 0.6})

    def test_comparison_follows_its_upstream_branch(self):
        source = {'nodes': [
            {'id': 1, 'type': 'SaveImage', 'pos': [10, 30]},
            {'id': 2, 'type': 'LoadImage', 'pos': [110, 30]},
            {'id': 3, 'type': 'KSampler', 'pos': [120, 30]},
            {'id': 4, 'type': 'Image Comparer (rgthree)', 'pos': [210, 30]},
            {'id': 5, 'type': 'SaveImage', 'pos': [220, 30]}],
            'groups': [{'id': i, 'bounding': [i * 100, 0, 90, 90]} for i in range(3)],
            'links': [[1, 2, 0, 3, 0, 'IMAGE'], [2, 2, 0, 4, 0, 'IMAGE'],
                      [3, 3, 0, 4, 1, 'IMAGE'], [4, 3, 0, 5, 0, 'IMAGE']]}
        original = json.dumps(source)
        for dictionary_links in (False, True):
            if dictionary_links:
                source['links'] = [{'origin_id': link[1], 'target_id': link[3]} for link in source['links']]
            self.assertEqual([g['id'] for g in workflow_groups(source)], ['0', '1'])
            selected, _ = workflow_for_group(source, '1')
            self.assertEqual({n['id'] for n in selected['nodes'] if n['mode'] == 0}, {2, 3, 4, 5})
            selected, _ = workflow_for_group(source, '0')
            self.assertEqual({n['id'] for n in selected['nodes'] if n['mode'] == 0}, {1})
            with self.assertRaises(ValueError):
                workflow_for_group(source, '2')
            if not dictionary_links:
                self.assertEqual(json.dumps(source), original)
        source['links'].append({'origin_id': 1, 'target_id': 4})
        self.assertEqual(len(workflow_groups(source)), 3)

    def test_group_selection_enables_dependencies_without_changing_source(self):
        source = {'nodes': [
            {'id': 1, 'type': 'LoadImage', 'pos': [10, 30], 'mode': 4},
            {'id': 2, 'type': 'PreviewImage', 'pos': [110, 30], 'mode': 4},
            {'id': 3, 'type': 'SaveImage', 'pos': [210, 30], 'mode': 0},
            {'id': 4, 'type': 'Fast Groups Bypasser (rgthree)', 'pos': [400, 30]}],
            'groups': [{'id': i, 'title': str(i), 'bounding': [i * 100, 0, 90, 90]} for i in range(3)],
            'links': [[1, 1, 0, 2, 0, 'IMAGE']]}
        original = json.dumps(source)
        self.assertEqual(len(workflow_groups(source)), 3)
        selected, group = workflow_for_group(source, '1')
        self.assertEqual(group['nodes'], ['2'])
        self.assertEqual({n['id']: n['mode'] for n in selected['nodes']}, {1: 0, 2: 0, 3: 2})
        self.assertEqual(json.dumps(source), original)
        with self.assertRaisesRegex(ValueError, '分组不存在'):
            workflow_for_group(source, 'missing')

    def test_group_apps_are_isolated_and_reused(self):
        with tempfile.TemporaryDirectory() as root:
            host = SimpleNamespace(BASE_DIR=root, CANVAS_TASKS={}, CANVAS_TASK_LOCK=threading.RLock(),
                workflow_path_from_name=lambda n: Path(root) / 'ComfyUI' / 'workflows' / n,
                workflow_config_path=lambda n: Path(root) / 'ComfyUI' / 'workflows' / (n + '.config.json'))
            service = install_comfy_apps(FastAPI(), host)
            identity = 'a' * 32
            parent = {'id': identity, 'title': '原工作流', 'source': {
                'nodes': [{'id': 1, 'type': 'LoadImage', 'pos': [10, 30], 'mode': 4}],
                'groups': [{'id': 1, 'title': '图生图', 'bounding': [0, 0, 90, 90]}]},
                'workflow': 'custom/original.json', 'fields': [], 'api': None}
            service.save(parent)
            before = service.path(identity).read_bytes()
            with patch.object(service, 'backend', side_effect=HTTPException(503, '未连接')):
                child = service.enable_group(identity, '1')
                again = service.enable_group(child['id'], '1')
            self.assertEqual(child['id'], again['id'])
            self.assertNotEqual(child['workflow'], parent['workflow'])
            self.assertEqual(child['source']['nodes'][0]['mode'], 0)
            self.assertEqual(service.path(identity).read_bytes(), before)
            stale = service.read(child['id'])
            stale['source']['nodes'][0]['pos'] = [11, 30]
            stale['api'] = GRAPH
            stale['uploads'] = ['keep-upload']
            service.save(stale)
            refreshed = service.enable_group(identity, '1')
            self.assertIsNone(refreshed['api'])
            self.assertEqual(refreshed['source']['nodes'][0]['mode'], 0)
            self.assertEqual(refreshed['uploads'], ['keep-upload'])

    def test_import_while_backend_offline_keeps_workflow(self):
        with tempfile.TemporaryDirectory() as root:
            host = SimpleNamespace(BASE_DIR=root, CANVAS_TASKS={}, CANVAS_TASK_LOCK=threading.RLock(),
                workflow_path_from_name=lambda n: Path(root) / 'ComfyUI' / 'workflows' / n,
                workflow_config_path=lambda n: Path(root) / 'ComfyUI' / 'workflows' / (n + '.config.json'))
            app = FastAPI(); service = install_comfy_apps(app, host)
            with patch.object(service, 'backend', side_effect=HTTPException(503, '本地服务未连接')), TestClient(app) as client:
                result = client.post('/api/comfy-apps/import', json={'name': 'offline', 'workflow': GRAPH})
                self.assertEqual(result.status_code, 200, result.text)
                self.assertEqual(service.read(result.json()['id'])['source'], GRAPH)
                self.assertFalse(service.read(result.json()['id'])['readiness']['can_run'])

    def test_negative_prompt_is_in_parameters(self):
        graph = {'1': {'class_type': 'CLIPTextEncode', 'inputs': {'text': 'product'}},
                 '2': {'class_type': 'CLIPTextEncode', 'inputs': {'text': 'blur'}},
                 '3': {'class_type': 'KSampler', 'inputs': {'positive': ['1', 0], 'negative': ['2', 0]}}}
        fields = extract_fields(graph, {'CLIPTextEncode': {'input': {'required': {'text': ['STRING', {}]}}}})
        self.assertFalse(fields[0]['advanced'])
        self.assertEqual(fields[1]['name'], '反向提示词')
        self.assertTrue(fields[1]['advanced'])

    def test_workflow_official_model_source(self):
        requirement = {'category': 'diffusion_models', 'source': 'https://huggingface.co/Comfy-Org/example/resolve/main/models/new.safetensors'}
        entry = AppLibrary._auto_model_entry('new.safetensors', requirement)
        self.assertEqual(entry['url'], requirement['source'])
        self.assertEqual(AppLibrary._auto_model_entry('ae.sft', {'category': 'vae'})['name'], 'ae.safetensors')
        seedvr2 = AppLibrary._auto_model_entry('seedvr2_ema_7b_sharp_fp16.safetensors', {'category': 'SEEDVR2'})
        self.assertEqual(seedvr2['category'], 'SEEDVR2')
        self.assertEqual(seedvr2['size_bytes'], 16479334424)
        self.assertEqual(seedvr2['sha256'], '20a93e01ff24beaeebc5de4e4e5be924359606c356c9c51509fba245bd2d77dd')
        for url in ('https://evil.example/new.safetensors',
                    'https://huggingface.co/Other/example/resolve/main/new.safetensors',
                    'https://huggingface.co/Comfy-Org/example/resolve/main/other.safetensors',
                    'https://huggingface.co:bad/Comfy-Org/example/resolve/main/new.safetensors',
                    'https://huggingface.co/Comfy-Org/example/resolve/main/../new.safetensors'):
            self.assertIsNone(AppLibrary._auto_model_entry('new.safetensors', {**requirement, 'source': url}))
        self.assertIsNone(AppLibrary._auto_model_entry('new.safetensors', {**requirement, 'category': '../outside'}))

    def test_source_removal_is_opt_in_and_shared_source_is_kept(self):
        with tempfile.TemporaryDirectory() as root:
            host = SimpleNamespace(BASE_DIR=root, CANVAS_TASKS={}, CANVAS_TASK_LOCK=threading.RLock(),
                workflow_path_from_name=lambda n: Path(root) / 'ComfyUI' / 'workflows' / n,
                workflow_config_path=lambda n: Path(root) / 'ComfyUI' / 'workflows' / (n + '.config.json'))
            app = FastAPI()
            service = install_comfy_apps(app, host)
            service.runtime.base = Path(root) / 'base'
            model = service.runtime.base / 'models' / 'upscale_models' / 'exclusive.pth'
            model.parent.mkdir(parents=True); model.write_bytes(b'model')
            graph = {'1': {'class_type': 'UpscaleModelLoader', 'inputs': {'model_name': model.name}}}
            source = Path(host.workflow_path_from_name('original.json'))
            source.parent.mkdir(parents=True); source.write_text(json.dumps(graph), encoding='utf-8')
            identity = 'c' * 32
            item = {'id': identity, 'title': 'original', 'description': '', 'source': graph, 'api': graph,
                    'fields': [], 'workflow_source': 'original.json', 'workflow': 'custom/app_' + identity + '.json', 'uploads': []}
            service.save(item)
            with TestClient(app) as client:
                self.assertEqual(client.get('/api/comfy-apps/' + identity).json()['entry_type'], 'app')
                normal = client.get('/api/comfy-apps/' + identity + '/delete-preview').json()
                self.assertFalse(normal['source_to_archive'])
                self.assertEqual(len(normal['models']['shared']), 1)
                plan = client.get('/api/comfy-apps/' + identity + '/delete-preview?remove_source=true').json()
                self.assertEqual(plan['source_to_archive'], 'original.json')
                self.assertEqual(len(plan['models']['exclusive']), 1)
                # A new reference created after the preview must still protect the source and model.
                other = {**item, 'id': 'd' * 32, 'workflow': 'custom/app_' + 'd' * 32 + '.json'}
                service.save(other)
                response = client.post('/api/comfy-apps/' + identity + '/delete', json={'token': plan['token'], 'confirmed': True})
                self.assertEqual(response.status_code, 200, response.text)
                self.assertTrue(source.exists()); self.assertTrue(model.exists())
                plan = client.get('/api/comfy-apps/' + other['id'] + '/delete-preview?remove_source=true').json()
                response = client.post('/api/comfy-apps/' + other['id'] + '/delete', json={'token': plan['token'], 'confirmed': True})
                self.assertEqual(response.status_code, 200, response.text)
                self.assertFalse(source.exists()); self.assertFalse(model.exists())
                self.assertTrue(list((Path(root) / 'ComfyUI/comfy_apps_deleted').glob('*/source_original.json')))

    def test_only_connected_image(self):
        graph = active_graph(GRAPH, INFO)
        self.assertEqual(set(graph), {'1', '3'})
        fields = extract_fields(graph, INFO)
        self.assertEqual(len(fields), 1)
        self.assertIsNone(fields[0]['default'])

    def test_no_outputs(self):
        with self.assertRaisesRegex(ValueError, '输出'):
            active_graph({'1': GRAPH['1']}, INFO)

    def test_unknown_link(self):
        with self.assertRaisesRegex(ValueError, '不存在'):
            active_graph({'3': GRAPH['3']}, INFO)

    def test_field_validation(self):
        fields = extract_fields(active_graph(GRAPH, INFO), INFO)
        with self.assertRaisesRegex(ValueError, '重新上传'):
            validate_fields(fields, {}, [])
        with self.assertRaisesRegex(ValueError, '未配置'):
            validate_fields(fields, {'bad': 'x'}, [])
        self.assertEqual(validate_fields(fields, {'1:image': 'mine.png'}, ['mine.png']), {'1': {'image': 'mine.png'}})

    def test_number_bounds_and_type(self):
        fields = extract_fields({'4': {'class_type': 'KSampler', 'inputs': {'steps': 30}}}, INFO)
        for value in (True, float('nan'), 1.5, 101, '12'):
            with self.assertRaises(ValueError):
                validate_fields(fields, {'4:steps': value}, [])
        self.assertEqual(validate_fields(fields, {}, []), {'4': {'steps': 30}})

    def test_legacy_flowmatch_scheduler_is_normalized_for_ksampler(self):
        graph = {
            '1': {'class_type': 'KSampler', 'inputs': {'scheduler': 'FlowMatchEulerDiscreteScheduler'}},
            '2': {'class_type': 'KSamplerAdvanced', 'inputs': {'scheduler': 'FlowMatchEulerDiscreteScheduler'}},
            '3': {'class_type': 'OtherNode', 'inputs': {'scheduler': 'FlowMatchEulerDiscreteScheduler'}},
        }
        normalize_legacy_scheduler_values(graph)
        self.assertEqual(graph['1']['inputs']['scheduler'], 'simple')
        self.assertEqual(graph['2']['inputs']['scheduler'], 'simple')
        self.assertEqual(graph['3']['inputs']['scheduler'], 'FlowMatchEulerDiscreteScheduler')

    def test_legacy_vae_filename_is_normalized_for_current_comfyui(self):
        graph = {'1': {'class_type': 'VAELoader', 'inputs': {'vae_name': 'ae.sft'}}}
        info = {'VAELoader': {'input': {'required': {'vae_name': [['ae.safetensors'], {}]}}}}
        normalize_legacy_model_values(graph, info)
        self.assertEqual(graph['1']['inputs']['vae_name'], 'ae.safetensors')

    def test_legacy_vae_filename_gets_current_download_plan_when_missing(self):
        with tempfile.TemporaryDirectory() as root:
            service = AppLibrary(SimpleNamespace(BASE_DIR=root))
            service.runtime.base = Path(root) / 'base'
            item = {'source': {'nodes': [{'type': 'VAELoader', 'widgets_values': ['ae.sft']}]},
                    'report': {}}
            models = [entry for entry in service._dependency_preflight(item)['auto_installable']
                      if entry.get('kind') == '模型']
            self.assertEqual(models[0]['name'], 'ae.sft')
            self.assertEqual(models[0]['download_id'], 'ae.safetensors')

    def test_legacy_display_label_is_normalized_before_api_storage(self):
        graph = {'1': {'class_type': 'Get Image Size', 'inputs': {}}}
        normalize_legacy_node_types(graph, {'GetImageSize': {}})
        self.assertEqual(graph['1']['class_type'], 'GetImageSize')

    def test_installed_custom_node_can_run_without_installing_code(self):
        with tempfile.TemporaryDirectory() as root:
            service = AppLibrary(SimpleNamespace(BASE_DIR=root))
            graph = {'1': {'class_type': 'Custom', 'inputs': {}}}
            item = {'source': graph, 'api': graph}
            result = service.analyze(item, {'Custom': {'python_module': 'custom_nodes.innocent'}})
            self.assertEqual(result['state'], 'ready')

    def test_custom_node_without_module_is_blocked(self):
        with tempfile.TemporaryDirectory() as root:
            service = AppLibrary(SimpleNamespace(BASE_DIR=root))
            graph = {'1': {'class_type': 'Custom', 'inputs': {}}}
            result = service.analyze({'source': graph, 'api': graph}, {'Custom': {}})
            self.assertEqual(result['state'], 'blocked')

    def test_cloud_is_blocked(self):
        with tempfile.TemporaryDirectory() as root:
            service = AppLibrary(SimpleNamespace(BASE_DIR=root))
            graph = {'1': {'class_type': 'Cloud', 'inputs': {}}}
            result = service.analyze({'source': graph, 'api': graph}, {'Cloud': {'api_node': True, 'python_module': 'nodes'}})
            self.assertEqual(result['state'], 'blocked')

    def test_compile_reuses_workflow_store(self):
        with tempfile.TemporaryDirectory() as root:
            host = SimpleNamespace(BASE_DIR=root, workflow_path_from_name=lambda n: Path(root) / n,
                workflow_config_path=lambda n: Path(root) / (n + '.config.json'))
            service = AppLibrary(host)
            item = {'id': 'a' * 32, 'title': 'Test', 'source': GRAPH, 'workflow': 'custom/app.json'}
            result = service.compile(item, GRAPH, INFO)
            self.assertEqual(result['state'], 'ready')
            self.assertTrue((Path(root) / 'custom/app.json').exists())
            self.assertEqual(len(result['fields']), 1)
            self.assertEqual(result['source'], GRAPH)

    def test_deleted_workflow_removes_matching_app_from_catalog(self):
        with tempfile.TemporaryDirectory() as root:
            identity = 'b' * 32
            workflow_name = f'custom/app_{identity}.json'
            workflow_path = Path(root) / 'ComfyUI' / 'workflows' / workflow_name
            config_path = Path(root) / 'ComfyUI' / 'workflows' / (workflow_name + '.config.json')
            app_path = Path(root) / 'ComfyUI' / 'comfy_apps' / identity / 'app.json'
            workflow_path.parent.mkdir(parents=True)
            app_path.parent.mkdir(parents=True)
            workflow_path.write_text('{}', encoding='utf-8')
            config_path.write_text('{}', encoding='utf-8')
            app_path.write_text(json.dumps({'id': identity, 'title': '待删除应用',
                                            'workflow': workflow_name}), encoding='utf-8')
            host = SimpleNamespace(BASE_DIR=root,
                                   workflow_path_from_name=lambda n: Path(root) / 'ComfyUI' / 'workflows' / n,
                                   workflow_config_path=lambda n: Path(root) / 'ComfyUI' / 'workflows' / (n + '.config.json'))
            service = AppLibrary(host)
            workflow_path.unlink()
            config_path.unlink()
            removed = service.sync_deleted_workflow(workflow_name)
            self.assertEqual([item['id'] for item in removed], [identity])
            self.assertFalse(app_path.exists())
            self.assertTrue(list((Path(root) / 'ComfyUI' / 'comfy_apps_deleted').glob('*')))

    def test_preparation_failures_are_never_ready(self):
        for failure in ('下载失败', '依赖冲突', '401：模型需要作者授权'):
            with self.subTest(failure=failure), tempfile.TemporaryDirectory() as root:
                tasks = {}
                host = SimpleNamespace(BASE_DIR=root, CANVAS_TASK_LOCK=threading.RLock(), CANVAS_TASKS=tasks,
                    workflow_path_from_name=lambda n: Path(root) / n,
                    workflow_config_path=lambda n: Path(root) / (n + '.config.json'),
                    add_canvas_task=lambda key, value: tasks.__setitem__(key, value),
                    update_canvas_task=lambda key, value: tasks[key].update(value))
                app = FastAPI()
                service = install_comfy_apps(app, host)
                identity = 'a' * 32
                service.save({'id': identity, 'title': 'Test', 'source': GRAPH, 'api': None,
                              'workflow': 'custom/test.json', 'description': 'SeeThrough 测试', 'state': 'blocked'})
                with patch.object(service, 'preflight', return_value={'hard_failures': []}), \
                     patch.object(service.runtime, 'prepare', side_effect=RuntimeError(failure)), TestClient(app) as client:
                    response = client.post('/api/comfy-apps/' + identity + '/prepare')
                    self.assertEqual(response.status_code, 200)
                    for _ in range(50):
                        task = client.get('/api/comfy-apps/' + identity + '/preparation').json()['task']
                        if task['status'] == 'failed':
                            break
                        time.sleep(0.01)
                    self.assertEqual(task['status'], 'failed')
                    self.assertIn(failure, task['error'])
                    self.assertEqual(service.read(identity)['state'], 'blocked')

    def test_preflight_separates_auto_and_manual_dependencies(self):
        with tempfile.TemporaryDirectory() as root:
            host = SimpleNamespace(BASE_DIR=root, COMFYUI_INSTANCES=[])
            service = AppLibrary(host)
            service.runtime.base = Path(root) / 'comfy-base'
            (service.runtime.base / 'core').mkdir(parents=True)
            (service.runtime.base / 'core' / 'main.py').write_text('', encoding='utf-8')
            (service.runtime.base / '.venv' / 'Scripts').mkdir(parents=True)
            (service.runtime.base / '.venv' / 'Scripts' / 'python.exe').write_bytes(b'')
            item = {'description': '本地工作流应用', 'api': None, 'source': {},
                    'report': {'missing_nodes': ['SeedVR2VideoUpscaler'],
                               'missing_models': ['model.safetensors'],
                               'review_nodes': [], 'unknown_nodes': []}}
            hardware = {'os': 'Windows', 'cpu': 'test', 'cpu_count': 8, 'ram_gb': 16,
                        'gpu': [{'name': 'RTX 4060', 'vram_gb': 8}], 'disk_free_gb': 20,
                        'base_comfyui_ready': True}
            with patch.object(service, 'hardware_info', return_value=hardware):
                result = service.preflight(item)
            self.assertEqual(result['status'], 'warning')
            self.assertTrue(result['dependencies']['auto_installable'])
            self.assertEqual([entry['name'] for entry in result['dependencies']['manual']],
                             ['model.safetensors'])
            packages = [entry for entry in result['dependencies']['auto_installable'] if entry['kind'] == '节点包']
            self.assertEqual(packages[0]['name'], 'ComfyUI-SeedVR2_VideoUpscaler')

    def test_public_model_gets_download_plan_and_authorized_model_stays_manual(self):
        with tempfile.TemporaryDirectory() as root:
            host = SimpleNamespace(BASE_DIR=root, COMFYUI_INSTANCES=[])
            service = AppLibrary(host)
            service.runtime.base = Path(root) / 'comfy-base'
            (service.runtime.base / 'core').mkdir(parents=True)
            (service.runtime.base / 'core' / 'main.py').write_text('', encoding='utf-8')
            (service.runtime.base / '.venv' / 'Scripts').mkdir(parents=True)
            (service.runtime.base / '.venv' / 'Scripts' / 'python.exe').write_bytes(b'')
            item = {'description': '本地工作流应用', 'api': {'1': {
                        'class_type': 'LoadTextEncoderShared //Inspire',
                        'inputs': {'model_name1': 'qwen_3_4b.safetensors'}}},
                    'source': {}, 'report': {
                        'missing_nodes': [], 'missing_models': ['qwen_3_4b.safetensors'],
                        'model_requirements': [{'name': 'qwen_3_4b.safetensors',
                                               'category': 'text_encoders'}],
                        'review_nodes': [], 'unknown_nodes': []}}
            hardware = {'os': 'Windows', 'cpu': 'test', 'cpu_count': 8, 'ram_gb': 16,
                        'gpu': [{'name': 'RTX 4060', 'vram_gb': 8}], 'disk_free_gb': 20,
                        'base_comfyui_ready': True}
            with patch.object(service, 'hardware_info', return_value=hardware):
                result = service.preflight(item)
            auto = [entry for entry in result['dependencies']['auto_installable']
                    if entry.get('kind') == '模型']
            self.assertEqual([entry['download_id'] for entry in auto], ['qwen_3_4b.safetensors'])
            self.assertEqual(service._auto_model_downloads(item, result)[0]['category'], 'text_encoders')

            item = {'description': '本地工作流应用', 'api': {'1': {
                        'class_type': 'LoadDiffusionModelShared //Inspire',
                        'inputs': {'model_name': 'flux-2-klein-9b-fp8.safetensors'}}},
                    'source': {}, 'report': {
                        'missing_nodes': [], 'missing_models': ['flux-2-klein-9b-fp8.safetensors'],
                        'model_requirements': [{'name': 'flux-2-klein-9b-fp8.safetensors',
                                               'category': 'diffusion_models'}],
                        'review_nodes': [], 'unknown_nodes': []}}
            with patch.object(service, 'hardware_info', return_value=hardware):
                result = service.preflight(item)
            self.assertFalse([entry for entry in result['dependencies']['auto_installable']
                              if entry.get('kind') == '模型'])
            manual = [entry for entry in result['dependencies']['manual']
                      if entry.get('kind') == '模型']
            self.assertEqual(manual[0]['source'], 'https://huggingface.co/black-forest-labs/FLUX.2-klein-9B')

    def test_prepare_hardware_failure_does_not_create_task(self):
        with tempfile.TemporaryDirectory() as root:
            tasks = {}
            host = SimpleNamespace(BASE_DIR=root, COMFYUI_INSTANCES=[],
                CANVAS_TASK_LOCK=threading.RLock(), CANVAS_TASKS=tasks,
                workflow_path_from_name=lambda n: Path(root) / n,
                workflow_config_path=lambda n: Path(root) / (n + '.config.json'),
                add_canvas_task=lambda key, value: tasks.__setitem__(key, value),
                update_canvas_task=lambda key, value: tasks[key].update(value))
            app = FastAPI()
            service = install_comfy_apps(app, host)
            identity = 'd' * 32
            service.save({'id': identity, 'title': '硬件预检', 'description': '本地工作流应用',
                          'source': {}, 'api': None, 'fields': [], 'workflow': 'custom/test.json',
                          'state': 'blocked'})
            blocked = {'status': 'blocked', 'summary': '当前环境不满足已知安装条件',
                       'hard_failures': ['显存不足：需要 8 GB，检测到 4 GB'], 'warnings': [],
                       'dependencies': {'installed': [], 'auto_installable': [], 'manual': []},
                       'hardware': {}, 'requirements': {}}
            with patch.object(service, 'preflight', return_value=blocked), \
                    patch.object(service.runtime, 'prepare') as prepare_runtime, \
                    TestClient(app) as client:
                response = client.post('/api/comfy-apps/' + identity + '/prepare')
            self.assertEqual(response.status_code, 409)
            self.assertIn('显存不足', response.json()['detail'])
            self.assertFalse(tasks)
            prepare_runtime.assert_not_called()

    def test_model_catalog_marks_referenced_models_as_shared(self):
        with tempfile.TemporaryDirectory() as root:
            host = SimpleNamespace(BASE_DIR=root, COMFYUI_INSTANCES=[],
                workflow_path_from_name=lambda n: Path(root) / n,
                workflow_config_path=lambda n: Path(root) / (n + '.config.json'))
            service = AppLibrary(host)
            service.runtime.base = Path(root) / 'comfy-base'
            model_root = service.runtime.base / 'models' / 'checkpoints'
            model_root.mkdir(parents=True)
            shared = model_root / 'shared.safetensors'
            unused = model_root / 'unused.safetensors'
            shared.write_bytes(b'shared-model')
            unused.write_bytes(b'unused-model')
            identity = 'e' * 32
            workflow = 'custom/model-test.json'
            graph = {'1': {'class_type': 'CheckpointLoaderSimple',
                           'inputs': {'ckpt_name': 'shared.safetensors'}}}
            service.save({'id': identity, 'title': '模型引用应用', 'description': '测试应用',
                          'source': graph, 'api': graph, 'fields': [], 'workflow': workflow})
            Path(host.workflow_path_from_name(workflow)).parent.mkdir(parents=True, exist_ok=True)
            Path(host.workflow_path_from_name(workflow)).write_text(json.dumps(graph), encoding='utf-8')
            catalog = service.model_catalog()
            by_name = {item['name']: item for item in catalog['models']}
            self.assertTrue(by_name['shared.safetensors']['protected'])
            self.assertIn('模型引用应用', by_name['shared.safetensors']['users'])
            self.assertFalse(by_name['unused.safetensors']['protected'])

    def test_model_catalog_protects_directory_model_shards_used_by_workflow(self):
        with tempfile.TemporaryDirectory() as root:
            workflow_root = Path(root) / 'ComfyUI' / 'workflows'
            host = SimpleNamespace(BASE_DIR=root, COMFYUI_INSTANCES=[],
                workflow_path_from_name=lambda name: workflow_root / name,
                workflow_config_path=lambda name: workflow_root / (name + '.config.json'))
            app = FastAPI()
            service = install_comfy_apps(app, host)
            service.runtime.base = Path(root) / 'comfy-base'
            model_dir = service.runtime.base / 'models' / 'LLM' / 'Qwen' / 'Qwen3-VL-4B-Instruct'
            model_dir.mkdir(parents=True)
            (model_dir / 'config.json').write_text('{}', encoding='utf-8')
            shard = model_dir / 'model-00001-of-00002.safetensors'
            shard.write_bytes(b'shard')
            identity = '9' * 32
            workflow_name = 'custom/directory-model.json'
            graph = {'1': {'class_type': 'AILab_QwenVL',
                           'inputs': {'model_name': 'Qwen3-VL-4B-Instruct'}}}
            service.save({'id': identity, 'title': '细节增强工作流', 'description': '测试应用',
                          'source': graph, 'api': graph, 'fields': [], 'workflow': workflow_name})
            workflow = Path(host.workflow_path_from_name(workflow_name))
            workflow.parent.mkdir(parents=True, exist_ok=True)
            workflow.write_text(json.dumps(graph), encoding='utf-8')

            with TestClient(app) as client:
                catalog = client.get('/api/comfy-apps/models').json()
                entry = next(item for item in catalog['models'] if item['name'] == shard.name)
                self.assertTrue(entry['protected'])
                self.assertFalse(entry['can_delete'])
                self.assertIn('细节增强工作流', entry['users'])
                self.assertIn('工作流：directory-model', entry['users'])
                self.assertIn('细节增强工作流', entry['delete_reason'])

                blocked = client.post('/api/comfy-apps/models/delete', json={
                    'model_id': entry['id'], 'confirmed': True})
                self.assertEqual(blocked.status_code, 409, blocked.text)
                self.assertIn('细节增强工作流', blocked.json()['detail'])
                self.assertTrue(shard.exists())

    def test_manual_model_protection_survives_app_deletion(self):
        with tempfile.TemporaryDirectory() as root:
            tasks = {}
            host = SimpleNamespace(BASE_DIR=root, COMFYUI_INSTANCES=[],
                CANVAS_TASK_LOCK=threading.RLock(), CANVAS_TASKS=tasks,
                workflow_path_from_name=lambda name: Path(root) / name,
                workflow_config_path=lambda name: Path(root) / (name + '.config.json'))
            app = FastAPI()
            service = install_comfy_apps(app, host)
            service.runtime.base = Path(root) / 'comfy-base'
            model_root = service.runtime.base / 'models' / 'checkpoints'
            model_root.mkdir(parents=True)
            keep = model_root / 'keep.safetensors'
            remove = model_root / 'remove.safetensors'
            keep.write_bytes(b'keep')
            remove.write_bytes(b'remove')
            identity = 'f' * 32
            workflow = 'custom/manual-protection.json'
            graph = {
                '1': {'class_type': 'CheckpointLoaderSimple', 'inputs': {'ckpt_name': 'keep.safetensors'}},
                '2': {'class_type': 'UpscaleModelLoader', 'inputs': {'model_name': 'remove.safetensors'}},
            }
            service.save({'id': identity, 'title': '手动保留测试', 'description': '测试应用',
                          'source': graph, 'api': graph, 'fields': [], 'workflow': workflow})
            Path(host.workflow_path_from_name(workflow)).parent.mkdir(parents=True, exist_ok=True)
            Path(host.workflow_path_from_name(workflow)).write_text(json.dumps(graph), encoding='utf-8')

            with TestClient(app) as client:
                catalog = client.get('/api/comfy-apps/models').json()
                keep_entry = next(item for item in catalog['models'] if item['name'] == keep.name)
                response = client.post('/api/comfy-apps/models/protection', json={
                    'model_id': keep_entry['id'], 'protected': True})
                self.assertEqual(response.status_code, 200, response.text)
                refreshed = client.get('/api/comfy-apps/models').json()
                refreshed_keep = next(item for item in refreshed['models'] if item['name'] == keep.name)
                self.assertTrue(refreshed_keep['protected'])
                self.assertTrue(refreshed_keep['user_protected'])

                preview = client.get('/api/comfy-apps/' + identity + '/delete-preview')
                self.assertEqual(preview.status_code, 200, preview.text)
                plan = preview.json()
                self.assertEqual([item['name'] for item in plan['models']['protected']], [keep.name])
                self.assertEqual([item['name'] for item in plan['models']['exclusive']], [remove.name])

                deleted = client.post('/api/comfy-apps/' + identity + '/delete', json={
                    'token': plan['token'], 'confirmed': True, 'delete_models': True})
                self.assertEqual(deleted.status_code, 200, deleted.text)
                result = deleted.json()
                self.assertEqual([item['name'] for item in result['protected_models_kept']], [keep.name])
                self.assertTrue(keep.exists())
                self.assertFalse(remove.exists())

    def test_direct_model_delete_requires_unreferenced_unprotected_model(self):
        with tempfile.TemporaryDirectory() as root:
            host = SimpleNamespace(BASE_DIR=root, COMFYUI_INSTANCES=[],
                workflow_path_from_name=lambda name: Path(root) / name,
                workflow_config_path=lambda name: Path(root) / (name + '.config.json'))
            app = FastAPI()
            service = install_comfy_apps(app, host)
            service.runtime.base = Path(root) / 'comfy-base'
            model_root = service.runtime.base / 'models' / 'checkpoints'
            model_root.mkdir(parents=True)
            unused = model_root / 'unused.safetensors'
            shared = model_root / 'shared.safetensors'
            unused.write_bytes(b'unused')
            shared.write_bytes(b'shared')
            identity = '1' * 32
            graph = {'1': {'class_type': 'CheckpointLoaderSimple',
                           'inputs': {'ckpt_name': shared.name}}}
            service.save({'id': identity, 'title': '引用模型应用', 'description': '测试应用',
                          'source': graph, 'api': graph, 'fields': [], 'workflow': 'custom/delete-test.json'})
            workflow = Path(host.workflow_path_from_name('custom/delete-test.json'))
            workflow.parent.mkdir(parents=True, exist_ok=True)
            workflow.write_text(json.dumps(graph), encoding='utf-8')

            with TestClient(app) as client:
                catalog = client.get('/api/comfy-apps/models').json()
                unused_id = next(item['id'] for item in catalog['models'] if item['name'] == unused.name)
                shared_id = next(item['id'] for item in catalog['models'] if item['name'] == shared.name)
                self.assertTrue(next(item for item in catalog['models'] if item['id'] == unused_id)['can_delete'])
                self.assertFalse(next(item for item in catalog['models'] if item['id'] == shared_id)['can_delete'])

                missing_confirmation = client.post('/api/comfy-apps/models/delete', json={'model_id': unused_id})
                self.assertEqual(missing_confirmation.status_code, 400)
                blocked = client.post('/api/comfy-apps/models/delete', json={'model_id': shared_id, 'confirmed': True})
                self.assertEqual(blocked.status_code, 409)
                self.assertTrue(shared.exists())

                deleted = client.post('/api/comfy-apps/models/delete', json={'model_id': unused_id, 'confirmed': True})
                self.assertEqual(deleted.status_code, 200, deleted.text)
                self.assertFalse(unused.exists())
                remaining = client.get('/api/comfy-apps/models').json()['models']
                self.assertEqual([item['name'] for item in remaining], [shared.name])

    def test_cancel_stops_install_process(self):
        with tempfile.TemporaryDirectory() as root:
            runtime = ManagedRuntime(root)
            runtime.cancel.set()
            process = MagicMock()
            process.poll.return_value = None
            with patch('ComfyUI.integration.comfy_app_runtime.subprocess.Popen', return_value=process):
                with self.assertRaisesRegex(RuntimeError, '取消'):
                    runtime.command(['unused'], Path(root) / 'log')
            process.terminate.assert_called_once()
            process.wait.assert_called_once()

    def test_delete_keeps_shared_models_and_archives_workflow(self):
        with tempfile.TemporaryDirectory() as root:
            tasks = {}
            host = SimpleNamespace(BASE_DIR=root, CANVAS_TASK_LOCK=threading.RLock(), CANVAS_TASKS=tasks,
                workflow_path_from_name=lambda name: Path(root) / name,
                workflow_config_path=lambda name: Path(root) / (name + '.config.json'))
            service = AppLibrary(host)
            service.runtime.base = Path(root) / 'comfy-base'
            model_root = service.runtime.base / 'models' / 'upscale_models'
            model_root.mkdir(parents=True)
            exclusive = model_root / 'exclusive.pth'
            shared = model_root / 'shared.pth'
            exclusive.write_bytes(b'exclusive')
            shared.write_bytes(b'shared')
            graph = lambda *names: {
                str(index + 1): {'class_type': 'UpscaleModelLoader', 'inputs': {'model_name': name}}
                for index, name in enumerate(names)
            }
            first = 'a' * 32
            second = 'b' * 32
            for identity, title, models in ((first, '第一个应用', ('exclusive.pth', 'shared.pth')),
                                            (second, '第二个应用', ('shared.pth',))):
                workflow = 'custom/app_' + identity + '.json'
                item = {'id': identity, 'title': title, 'description': '测试应用', 'source': graph(*models),
                        'api': graph(*models), 'fields': [], 'workflow': workflow, 'uploads': []}
                service.save(item)
                Path(host.workflow_path_from_name(workflow)).parent.mkdir(parents=True, exist_ok=True)
                Path(host.workflow_path_from_name(workflow)).write_text(json.dumps(graph(*models)), encoding='utf-8')
                Path(host.workflow_config_path(workflow)).write_text('{}', encoding='utf-8')
            builtin = Path(root) / 'ComfyUI' / 'workflows' / 'keep-shared.json'
            builtin.parent.mkdir(parents=True, exist_ok=True)
            builtin.write_text(json.dumps(graph('shared.pth')), encoding='utf-8')
            canvas = Path(root) / 'data' / 'canvases' / 'canvas.json'
            canvas.parent.mkdir(parents=True, exist_ok=True)
            canvas.write_text(json.dumps({'model_name': 'shared.pth'}), encoding='utf-8')

            app = FastAPI()
            service = install_comfy_apps(app, host)
            service.runtime.base = Path(root) / 'comfy-base'
            with TestClient(app) as client:
                preview = client.get('/api/comfy-apps/' + first + '/delete-preview')
                self.assertEqual(preview.status_code, 200)
                plan = preview.json()
                self.assertEqual([item['name'] for item in plan['models']['exclusive']], ['exclusive.pth'])
                self.assertEqual([item['name'] for item in plan['models']['shared']], ['shared.pth'])
                self.assertTrue(any('keep-shared' in user for user in plan['models']['shared'][0]['users']))
                self.assertTrue(any('画布：canvas' in user for user in plan['models']['shared'][0]['users']))
                self.assertTrue(plan['can_delete'])
                self.assertEqual(client.post('/api/comfy-apps/' + first + '/delete', json={
                    'token': 'wrong', 'confirmed': True, 'delete_models': True}).status_code, 409)
                self.assertTrue(exclusive.exists())
                deleted = client.post('/api/comfy-apps/' + first + '/delete', json={
                    'token': plan['token'], 'confirmed': True, 'delete_models': True})
                self.assertEqual(deleted.status_code, 200, deleted.text)
                self.assertFalse(Path(service.path(first)).exists())
                self.assertTrue(shared.exists())
                self.assertFalse(exclusive.exists())
                self.assertTrue((Path(root) / 'ComfyUI' / 'comfy_apps_deleted').exists())
                self.assertEqual(client.get('/api/comfy-apps/' + second).status_code, 200)


if __name__ == '__main__':
    unittest.main()
