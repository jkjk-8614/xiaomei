import unittest
from ComfyUI.integration.comfy_workflow_inspection import inspect_workflow


class WorkflowInspectionTests(unittest.TestCase):
    def test_custom_socket_does_not_shift_seedvr_model(self):
        graph = {'nodes': [{'id': 98, 'type': 'SeedVR2LoadDiTModel',
            'inputs': [{'name': 'cache_model', 'type': 'MODEL'},
                       {'name': 'torch_compile_args', 'type': 'SEEDVR2_TORCH_COMPILE'},
                       {'name': 'model', 'type': 'COMBO', 'widget': {'name': 'model'}},
                       {'name': 'device', 'type': 'COMBO', 'widget': {'name': 'device'}}],
            'widgets_values': ['seedvr.safetensors', 'cuda:0']}]}
        result = inspect_workflow(graph, {'SeedVR2LoadDiTModel': {}})
        self.assertEqual([r['name'] for r in result['model_requirements']], ['seedvr.safetensors'])
        self.assertNotIn('cuda:0', result['missing_models'])

    def test_none_and_device_are_not_missing_models_with_live_schema(self):
        for value in ['None', 'null', 'cuda:0', 'cpu']:
            result = inspect_workflow({'1': {'class_type': 'SeedVR2LoadDiTModel',
                'inputs': {'model': value}}}, {'SeedVR2LoadDiTModel': {'input': {'required': {'model': [['real.safetensors']]}}}})
            self.assertEqual(result['missing_models'], [])
            self.assertEqual(result['model_requirements'], [])

    def test_subgraph_inspects_inner_dependencies_instead_of_uuid(self):
        graph = {'nodes': [{'id': 1, 'type': 'subgraph-id'}], 'definitions': {'subgraphs': [
            {'id': 'subgraph-id', 'nodes': [{'id': 2, 'type': 'MissingInner'},
                {'id': 3, 'type': 'VAELoader', 'widgets_values': ['ae.sft']}]}]}}
        result = inspect_workflow(graph, {'SaveImage': {}})
        self.assertEqual(result['missing_nodes'], ['MissingInner', 'VAELoader'])
        self.assertEqual(result['model_requirements'][0]['name'], 'ae.sft')

    def test_rgthree_label_requires_package(self):
        graph = {'nodes': [{'type': 'Label (rgthree)'}, {'type': 'Bookmark (rgthree)'}]}
        self.assertEqual(len(inspect_workflow(graph, {'SaveImage': {}})['missing_nodes']), 2)
        self.assertEqual(inspect_workflow(graph, {'Image Comparer (rgthree)': {}})['missing_nodes'], [])

    def test_linked_model_socket_does_not_become_lora_filename(self):
        graph = {'nodes': [{'id': 111, 'type': 'LoraLoaderModelOnly',
            'inputs': [{'name': 'model', 'type': 'MODEL', 'link': 119}],
            'widgets_values': ['人像 LoRA', 0.8]}]}
        info = {'LoraLoaderModelOnly': {'input': {'required': {
            'model': ['MODEL'], 'lora_name': [['available.safetensors']],
            'strength_model': ['FLOAT', {'default': 1}]}}}}
        for schema in ({}, info):
            result = inspect_workflow(graph, schema)
            self.assertEqual([(r['name'], r['category'], r['input']) for r in result['model_requirements']],
                             [('人像 LoRA', 'loras', 'lora_name')])

    def test_offline_standard_loader_without_inputs_keeps_category(self):
        result = inspect_workflow({'nodes': [{'type': 'VAELoader', 'inputs': [],
            'widgets_values': ['ae.sft']}]}, {})
        self.assertEqual(result['model_requirements'][0]['category'], 'vae')

    def test_ui_missing_dependencies(self):
        info = {"UNETLoader": {"input": {"required": {"unet_name": [["available.safetensors"]]}}}}
        result = inspect_workflow({"nodes": [
            {"type": "UNETLoader", "widgets_values": ["missing.safetensors", "default"]},
            {"type": "UnknownCustom"}, {"type": "Note"}]}, info)
        self.assertEqual(result["missing_nodes"], ["UnknownCustom"])
        self.assertEqual(result["missing_models"], ["missing.safetensors"])

    def test_api_choices_and_paid_node(self):
        info = {"VAELoader": {"input": {"required": {"vae_name": ["COMBO", {"options": ["vae"]}]}}},
                "Cloud": {"api_node": True}}
        result = inspect_workflow({"prompt": {"1": {"class_type": "VAELoader", "inputs": {"vae_name": "vae"}},
                                               "2": {"class_type": "Cloud", "inputs": {}}}}, info)
        self.assertEqual(result["missing_models"], [])
        self.assertEqual(result["review_nodes"], ["Cloud"])

    def test_offline_backend_keeps_static_model_references_without_fake_nodes(self):
        result = inspect_workflow({"prompt": {
            "1": {"class_type": "LoadTextEncoderShared //Inspire", "inputs": {
                "model_name1": "qwen_3_4b.safetensors", "model_name2": "None"}},
            "2": {"class_type": "LoadDiffusionModelShared //Inspire", "inputs": {
                "model_name": "z_image_turbo_bf16.safetensors"}},
        }}, {})
        self.assertFalse(result["backend_available"])
        self.assertEqual(result["missing_nodes"], [])
        self.assertEqual(result["missing_models"], [])
        self.assertEqual(
            [(item["name"], item["category"]) for item in result["model_requirements"]],
            [("qwen_3_4b.safetensors", "text_encoders"),
             ("z_image_turbo_bf16.safetensors", "diffusion_models")],
        )

    def test_ui_model_picker_metadata_is_preserved(self):
        result = inspect_workflow({"nodes": [{
            "id": 1, "type": "UNETLoader", "widgets_values": ["model.safetensors"],
            "inputs": [{"widget": {"name": "unet_name"}, "name": "unet_name"}],
            "properties": {"models": [{
                "name": "model.safetensors", "directory": "diffusion_models",
                "url": "https://huggingface.co/example/model.safetensors"}]},
        }]}, {})
        self.assertEqual(result["model_requirements"][0]["category"], "diffusion_models")
        self.assertEqual(result["model_requirements"][0]["source"],
                         "https://huggingface.co/example/model.safetensors")

    def test_civitai_image_saver_title_is_not_a_model_requirement(self):
        result = inspect_workflow({"prompt": {
            "1889": {"class_type": "Civitai Hash Fetcher (Image Saver)", "inputs": {
                "username": "latentheart",
                "model_name": "Z-Image Turbo + 4k Upscaling + Detail Daemon",
                "version": "",
            }},
        }}, {"Civitai Hash Fetcher (Image Saver)": {}})
        self.assertEqual(result["model_requirements"], [])
        self.assertEqual(result["missing_models"], [])

    def test_swarm_inputs_are_recognized_as_local_workflow_controls(self):
        result = inspect_workflow({"prompt": {
            "1": {"class_type": "SwarmWorkflowDescription", "inputs": {
                "description": "local", "enable_in_simple_tab": True}},
            "2": {"class_type": "SwarmInputText", "inputs": {
                "title": "Prompt", "value": "default", "raw_id": "prompt"}},
            "3": {"class_type": "SaveImage", "inputs": {"text": ["2", 0]}},
        }}, {"SaveImage": {"output_node": True}})
        self.assertEqual(result["missing_nodes"], [])
        self.assertEqual(result["workflow_description"]["enable_in_simple_tab"], True)
        self.assertEqual(result["swarm_inputs"][1]["type"], "SwarmInputText")

    def test_invalid_workflows(self):
        for workflow in [[], {}, {"nodes": []}, {"nodes": [None]}, {"prompt": []}, {"foo": {}}]:
            with self.subTest(workflow=workflow), self.assertRaises(ValueError):
                inspect_workflow(workflow, {})

    def test_invalid_api_reports_real_node_id(self):
        with self.assertRaisesRegex(ValueError, '节点 79 缺少 class_type'):
            inspect_workflow({'79': {'inputs': {}}}, {})

    def test_rgthree_frontend_control_requires_installed_package(self):
        graph = {'nodes': [{'type': 'Fast Groups Bypasser (rgthree)'}]}
        self.assertEqual(inspect_workflow(graph, {'SaveImage': {}})['missing_nodes'], ['Fast Groups Bypasser (rgthree)'])
        self.assertEqual(inspect_workflow(graph, {'Image Comparer (rgthree)': {}})['missing_nodes'], [])

    def test_kjnodes_set_get_are_frontend_nodes_when_package_is_loaded(self):
        graph = {'nodes': [
            {'type': 'SetNode', 'properties': {'aux_id': 'kijai/ComfyUI-KJNodes'}},
            {'type': 'GetNode', 'properties': {'aux_id': 'kijai/ComfyUI-KJNodes'}},
        ]}
        self.assertEqual(inspect_workflow(graph, {'SaveImage': {}})['missing_nodes'],
                         ['GetNode', 'SetNode'])
        self.assertEqual(inspect_workflow(graph, {'INTConstant': {}})['missing_nodes'], [])

    def test_legacy_display_label_uses_current_backend_node(self):
        graph = {'nodes': [{'type': 'Get Image Size'}]}
        self.assertEqual(inspect_workflow(graph, {'GetImageSize': {}})['missing_nodes'], [])

    def test_bypassed_ui_nodes_do_not_block_current_workflow(self):
        graph = {'nodes': [
            {'type': 'MissingOptionalNode', 'mode': 4},
            {'type': 'MissingDisabledNode', 'mode': 2},
            {'type': 'MissingActiveNode', 'mode': 0},
        ]}
        self.assertEqual(inspect_workflow(graph, {'SaveImage': {}})['missing_nodes'],
                         ['MissingActiveNode'])


if __name__ == '__main__':
    unittest.main()
