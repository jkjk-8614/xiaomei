import asyncio
import copy
import json
import tempfile
import unittest
from unittest.mock import patch
from pathlib import Path
from types import SimpleNamespace

import httpx
from fastapi import FastAPI
from PIL import Image, ImageDraw

from canvas_image_layers import install_image_layers, LayerService, audit_alpha, validate_plan, repair_checkerboard_alpha


class Host:
    def __init__(self, root):
        self.DATA_DIR = str(root / 'data')
        self.OUTPUT_DIR = str(root / 'output')
        Path(self.OUTPUT_DIR).mkdir()
        self.CanvasLLMRequest = self.OnlineImageRequest = self.AIReference = SimpleNamespace
        self.submissions = []
        self.tasks = {}
        self.fail_review = False
        self.opaque = False
        self.calls = 0
        self.plan = {'elements': [{'id':'environment', 'name':'背景', 'layer_id':'layer-1'}, {'id':'product', 'name':'红色商品', 'layer_id':'layer-2'}], 'layers': [
            {'name':'背景', 'kind':'background', 'include_ids':['environment'], 'bbox':[0,0,1000,1000], 'prompt':'纯背景，排除红色商品'},
            {'name':'商品', 'kind':'object', 'include_ids':['product'], 'bbox':[250,250,750,750], 'prompt':'只保留红色商品'}]}
        Image.new('RGB', (64,48), 'white').save(root / 'output' / 'source.png')

    def get_api_provider_exact(self, provider):
        return {'id':provider, 'chat_models':['vision'], 'image_models':['image']}

    def local_media_path_from_url(self, url):
        if not url.startswith('/output/') or '..' in url:
            return None
        return str(Path(self.OUTPUT_DIR) / url.removeprefix('/output/').split('?')[0])

    async def canvas_llm(self, payload):
        self.calls += 1
        if len(payload.images) == 1:
            value = self.plan
        elif len(payload.images) == 3:
            if self.fail_review:
                self.fail_review = False
                raise RuntimeError('upstream failure with secret')
            value = {'layers':[{'id':'layer-1','pass':True,'issues':[], 'matches':[]}, {'id':'layer-2','pass':True,'issues':[],'matches':[{'source':[250,250],'generated':[250,250]}, {'source':[750,750],'generated':[750,750]}]}]}
            value['duplicates'] = []
            for entry in value['layers']:
                entry.update(observed_elements=['背景' if entry['id']=='layer-1' else '商品'], unexpected_elements=[], missing_element_ids=[], retry_instruction='')
        else:
            value = {'pass':True, 'issues':[]}
        return {'text':json.dumps(value)}

    async def create_canvas_image_task(self, payload):
        if payload.client_request_id in self.tasks:
            return {'task_id':payload.client_request_id}
        self.submissions.append(payload)
        image = Image.new('RGBA', (64,48), 'white' if payload.background == 'opaque' or self.opaque else (0,0,0,0))
        if payload.background != 'opaque':
            ImageDraw.Draw(image).rectangle((16,12,48,36), fill='red')
        name = str(len(self.submissions)) + '.png'
        image.save(Path(self.OUTPUT_DIR) / name)
        self.tasks[payload.client_request_id] = {'status':'succeeded', 'result':{'images':['/output/' + name]}}
        return {'task_id':payload.client_request_id}

    async def get_canvas_image_task(self, task_id):
        return self.tasks[task_id]


class PipelineTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='图层测试-')
        self.addCleanup(self.tmp.cleanup)
        self.host = Host(Path(self.tmp.name))
        self.app = FastAPI()
        self.service = install_image_layers(self.app, self.host)
        self.client = httpx.AsyncClient(transport=httpx.ASGITransport(app=self.app), base_url='http://test')
        self.addAsyncCleanup(self.client.aclose)
        self.payload = dict(source_url='/output/source.png', source_node_id='node', project_id='canvas', request_id='request-1234',
            analysis_provider='p', analysis_model='vision', image_provider='p', image_model='image', layer_count=2, resolution='auto', concurrency=1, max_retries=0, method='regenerate')

    async def create(self):
        response = await self.client.post('/api/image-layers', json=self.payload)
        self.assertEqual(response.status_code, 200, response.text)
        job_id = response.json()['id']
        await self.service.running[job_id]
        return self.service.get(job_id)

    async def test_cli_permission_denial_explains_analysis_failure_without_layers(self):
        self.payload['analysis_provider'] = 'gemini-cli'
        async def denied(_payload):
            self.assertIn('不要调用终端命令', _payload.system_prompt)
            return {'text':'Antigravity CLI 返回了空回复。',
                    'raw':{'_stderr':'jetski: no output produced — a tool required the "command" permission that headless mode cannot prompt for, so it was auto-denied.'},
                    'vision_input':{'submitted':1,'skipped':0}}
        self.host.canvas_llm = denied
        job = await self.create()
        self.assertEqual(job['status'], 'failed')
        self.assertEqual(job['phase'], '分层分析失败，尚未生成图层')
        self.assertIn('命令权限被拒绝', job['error'])
        self.assertEqual(job['layers'], [])
        self.assertEqual(self.host.submissions, [])

    async def test_empty_analysis_response_has_actionable_error(self):
        async def empty(_payload):
            return {'text':'', 'vision_input':{'submitted':1,'skipped':0}}
        self.host.canvas_llm = empty
        job = await self.create()
        self.assertEqual(job['status'], 'failed')
        self.assertIn('分析模型返回空内容', job['error'])
        self.assertEqual(job['layers'], [])

    async def test_cutout_fill_keeps_source_pixels_and_only_generates_background_hole(self):
        self.payload['method']='cutout_fill'
        self.host.plan['bbox_format']='xyxy'
        background,product=self.host.plan['layers']
        background.update(extraction='background',regions=[],occluded_by=['layer-2'])
        product.update(extraction='color',regions=[{'polygon':[[200,200],[800,200],[800,850],[200,850]],'colors':['#FF0000'],'tolerance':40}],occluded_by=[])
        image=Image.new('RGBA',(64,48),'#223344');ImageDraw.Draw(image).rectangle((16,12,48,36),fill='red')
        image.save(Path(self.host.OUTPUT_DIR)/'source.png')
        job=await self.create()
        self.assertEqual(job['status'],'completed',job.get('error'))
        self.assertEqual(len(self.host.submissions),1)
        self.assertEqual(len(self.host.submissions[0].reference_images),3)
        self.assertIn('补齐',self.host.submissions[0].prompt)
        with Image.open(self.host.local_media_path_from_url(job['layers'][1]['url'])) as result:
            self.assertEqual(result.getpixel((25,20)),image.getpixel((25,20)))
            self.assertEqual(result.getpixel((0,0))[3],0)
        with Image.open(self.host.local_media_path_from_url(job['layers'][0]['url'])) as result:
            self.assertEqual(result.getpixel((0,0)),image.getpixel((0,0)))
            self.assertEqual(result.getpixel((25,20)),(255,255,255,255))
        # False AI anchor suggestions may never move a source cutout.
        job['layers'][1]['matches']=[{'source':[0,0],'generated':[250,250]},{'source':[500,500],'generated':[750,750]}]
        self.service.compose(job)
        self.assertEqual(job['layers'][1]['transform'],[0,0,64,0,64,48,0,48])

    async def test_cutout_failure_never_falls_back_to_redrawing(self):
        self.payload['method']='cutout_fill'
        self.host.plan['bbox_format']='xyxy'
        self.host.plan['layers'][0].update(extraction='background',regions=[],occluded_by=['layer-2'])
        self.host.plan['layers'][1].update(extraction='color',regions=[{'polygon':[[200,200],[800,200],[800,850],[200,850]],'colors':['#FF0000'],'tolerance':40}],occluded_by=[])
        job=await self.create()
        self.assertEqual(job['status'],'failed')
        self.assertIn('没有抠出',job['error'])
        self.assertEqual(len(self.host.submissions),0)

    async def test_ai_layer_receives_source_detail_without_changing_output_canvas(self):
        self.host.plan['bbox_format']='xyxy'
        job=await self.create()
        foreground=self.host.submissions[1]
        self.assertEqual(len(foreground.reference_images),2)
        self.assertIn('完整画布',foreground.prompt)
        self.assertFalse(job['layers'][1].get('source_locked'))
        with Image.open(self.host.local_media_path_from_url(foreground.reference_images[1].url)) as detail:
            self.assertEqual(detail.size,(32,24))

    async def test_invalid_completion_preserves_cutout_preview_and_requires_review(self):
        job=await self.create()
        layer=job['layers'][1]
        cutout_url=layer['url']
        layer.update(source_locked=True,needs_fill=True,cutout_url=cutout_url,
                     repair_mask_url=cutout_url)
        job['request']['method']='cutout_fill';job['cutouts_ready']=True
        self.service.prepare_retry(job,layer)
        self.host.opaque=True
        self.service.launch(job)
        await self.service.running[job['id']]
        self.assertEqual(job['status'],'needs-review')
        self.assertEqual(layer['url'],cutout_url)
        self.assertIn('透明背景',layer['completion_issue'])
        self.assertTrue(job['composite_url'])
        self.assertEqual(len(self.host.submissions),3)
        self.service.prepare_retry(job,layer)
        self.assertIn('透明背景',layer['retry_feedback'])

    async def test_record_replace_retries_windows_sharing_violation(self):
        import os
        original=os.replace
        attempts=[]
        def temporary_lock(source,destination):
            attempts.append(1)
            if len(attempts)==1:raise PermissionError('sharing violation')
            return original(source,destination)
        with patch('canvas_image_layers.os.replace',side_effect=temporary_lock),patch('canvas_image_layers.time.sleep'):
            self.service.save({'id':'f'*32,'status':'paused'})
        self.assertEqual(len(attempts),2)
        self.assertEqual(self.service.get('f'*32)['status'],'paused')

    async def test_persistent_save_failure_releases_running_slot(self):
        job=await self.create()
        job['request']['method']='regenerate'
        async def failure(*args):raise ValueError('test failure')
        self.service.running[job['id']]=asyncio.current_task()
        with patch.object(self.service,'generate_batch',side_effect=failure),patch.object(self.service,'save',side_effect=PermissionError('sharing violation')):
            with self.assertRaises(PermissionError):await self.service.run(job)
        self.assertNotIn(job['id'],self.service.running)

    async def test_complete_idempotency_and_composite(self):
        job = await self.create()
        self.assertEqual(job['status'], 'completed')
        self.assertEqual(len(self.host.submissions), 2)
        self.assertEqual(self.host.submissions[1].background, 'transparent')
        with Image.open(self.host.local_media_path_from_url(job['composite_url'])) as result:
            self.assertEqual(result.size, (64,48))
            self.assertEqual(result.getpixel((20,20))[:3], (255,0,0))

            self.assertEqual(result.getpixel((0,0))[:3], (255,255,255))
        second = await self.client.post('/api/image-layers', json=self.payload)
        self.assertEqual(second.json()['id'], job['id'])
        self.assertEqual(len(self.host.submissions), 2)
        history = await self.client.get('/api/image-layers?project_id=canvas&source_node_id=node')
        self.assertEqual(len(history.json()), 1)
        self.assertNotIn('prompt', history.json()[0]['layers'][0])

    async def test_open_native_photoshop_only_saved_current_psd(self):
        job=await self.create()
        endpoint=f"/api/image-layers/{job['id']}/photoshop/open?revision={job['revision']}"
        with patch('canvas_image_layers.installed_photoshop',return_value=Path('C:/Adobe/Photoshop.exe')), patch('canvas_image_layers.subprocess.Popen') as launch:
            self.assertEqual((await self.client.post(endpoint)).status_code,409)
            file=self.service.output/job['id']/f"layers-{job['revision']}.psd"
            file.write_bytes(b'8BPS\x00\x01'+bytes(20))
            self.assertEqual((await self.client.post(endpoint,headers={'Origin':'https://unrelated.example'})).status_code,403)
            launch.assert_not_called()
            response=await self.client.post(endpoint)
            self.assertEqual(response.status_code,200,response.text)
            self.assertEqual(response.json()['status'],'launched')
            self.assertEqual(launch.call_args.args[0][1],str(file.resolve()))
            self.assertFalse(launch.call_args.kwargs['shell'])
            job['revision']='changed'
            self.assertEqual((await self.client.post(endpoint)).status_code,409)

    async def test_resume_after_analysis_failure_keeps_generated_layers(self):
        self.host.fail_review = True
        job = await self.create()
        self.assertEqual(job['status'], 'paused')
        self.assertTrue(Path(self.host.local_media_path_from_url(job['composite_url'])).is_file())
        self.assertNotIn('secret', job['error'])
        recovered = LayerService(self.host)
        restored = recovered.get(job['id'])
        recovered.launch(restored)
        await recovered.running[job['id']]
        self.assertEqual(restored['status'], 'completed')
        self.assertEqual(len(self.host.submissions), 2)

    async def test_retry_only_one_layer_and_alpha_review(self):
        self.host.opaque = True
        job = await self.create()
        self.assertEqual(job['status'], 'needs-review')
        self.assertIn('透明', job['layers'][1]['alpha_issue'])
        first_url = job['layers'][0]['url']
        self.host.opaque = False
        response = await self.client.post(f"/api/image-layers/{job['id']}/layers/layer-2/retry")
        self.assertEqual(response.status_code, 200)
        await self.service.running[job['id']]
        self.assertEqual(job['status'], 'completed')
        self.assertEqual(len(self.host.submissions), 3)
        self.assertEqual(job['layers'][0]['url'], first_url)

    async def test_rebuild_preview_from_existing_images_without_model_calls(self):
        self.host.fail_review = True
        job = await self.create()
        job.pop('composite_url')
        job['status'] = 'failed'
        calls, submissions = self.host.calls, len(self.host.submissions)
        urls = [x['url'] for x in job['layers']]
        response = await self.client.post(f"/api/image-layers/{job['id']}/preview")
        self.assertEqual(response.status_code, 200)
        self.assertTrue(Path(self.host.local_media_path_from_url(response.json()['composite_url'])).is_file())
        self.assertEqual((self.host.calls, len(self.host.submissions)), (calls, submissions))
        self.assertEqual([x['url'] for x in job['layers']], urls)
        self.assertEqual(job['status'], 'failed')
        revision = job['revision']
        await self.client.post(f"/api/image-layers/{job['id']}/preview")
        self.assertEqual(job['revision'], revision)
        job.pop('composite_url')
        job['layers'][1].pop('url')
        self.assertEqual((await self.client.post(f"/api/image-layers/{job['id']}/preview")).status_code, 409)

    async def test_invalid_plan_does_not_generate(self):
        self.host.plan['layers'][1]['kind'] = 'background'
        job = await self.create()
        self.assertEqual(job['status'], 'failed')
        self.assertFalse(self.host.submissions)

    async def test_failed_image_never_automatically_resubmitted(self):
        original = self.host.create_canvas_image_task
        async def failure(payload):
            result = await original(payload)
            self.host.tasks[result['task_id']] = {'status':'failed', 'upstream_task_id':'provider-task'}
            return result
        self.host.create_canvas_image_task = failure
        job = await self.create()
        self.assertEqual(job['status'], 'failed')
        await self.client.post(f"/api/image-layers/{job['id']}/resume")
        await self.service.running[job['id']]
        self.assertEqual(len(self.host.submissions), 1)

    async def test_bad_source_and_psd_rejected(self):
        self.payload['source_url'] = '/output/../../secret.png'
        self.assertEqual((await self.client.post('/api/image-layers', json=self.payload)).status_code,400)
        self.payload['source_url'] = '/output/source.png'
        job = await self.create()
        response = await self.client.post(f"/api/image-layers/{job['id']}/psd?revision={job['revision']}", content=b'invalid')
        self.assertEqual(response.status_code,400)
        self.assertFalse(list((self.service.output/job['id']).glob('*.tmp')))

    async def test_stop_after_submission_resumes_same_task(self):
        original = self.host.create_canvas_image_task
        async def stop_after_submit(payload):
            result = await original(payload)
            next(iter(self.service.jobs.values()))['stop_requested'] = True
            return result
        self.host.create_canvas_image_task = stop_after_submit
        job = await self.create()
        self.assertEqual(job['status'], 'paused')
        self.assertEqual(len(self.host.submissions), 1)
        self.host.create_canvas_image_task = original
        await self.client.post(f"/api/image-layers/{job['id']}/resume")
        await self.service.running[job['id']]
        self.assertEqual(job['status'], 'completed')
        self.assertEqual(len(self.host.submissions), 2)

    async def test_alignment_and_low_resolution_are_recorded(self):
        job = await self.create()
        layer = job['layers'][1]
        layer['matches'] = [{'generated':[250,250], 'source':[375,250]}, {'generated':[750,750], 'source':[875,750]}]
        await asyncio.to_thread(self.service.compose, job)
        self.assertAlmostEqual(layer['transform'][0], 8)
        with Image.open(self.host.local_media_path_from_url(layer['aligned_url'])) as image:
            self.assertEqual(image.getpixel((17,20))[3], 0)
            self.assertEqual(image.getpixel((30,20))[:3], (255,0,0))
        job['width'], job['height'] = 128, 96
        await asyncio.to_thread(self.service.compose, job)
        self.assertTrue(layer['resolution_issue'])

    async def test_retry_passes_failure_feedback_to_model(self):
        self.host.opaque = True
        job = await self.create()
        await self.client.post(f"/api/image-layers/{job['id']}/layers/layer-2/retry")
        await self.service.running[job['id']]
        self.assertIn('上次检查发现', self.host.submissions[-1].prompt)
        self.assertIn('透明背景', self.host.submissions[-1].prompt)

    async def test_review_issues_override_pass_and_invalid_review_can_resume(self):
        original = self.host.canvas_llm
        async def issues(payload):
            result = await original(payload)
            data = json.loads(result['text'])
            if len(payload.images) == 3:
                data['layers'][1]['issues'] = ['重复商品']
            return {'text':json.dumps(data)}
        self.host.canvas_llm = issues
        job = await self.create()
        self.assertEqual(job['status'], 'needs-review')
        self.assertFalse(job['layers'][1]['semantic_pass'])
        self.payload['request_id'] = 'invalid-review-2'
        async def malformed(payload):
            result = await original(payload)
            if len(payload.images) == 3:
                data = json.loads(result['text'])
                data['layers'][1]['matches'] = None
                result['text'] = json.dumps(data)
            return result
        self.host.canvas_llm = malformed
        other = await self.create()
        self.assertEqual(other['status'], 'paused')
        self.assertNotIn('review', other)
        self.host.canvas_llm = original
        self.service.launch(other)
        await self.service.running[other['id']]
        self.assertEqual(other['status'], 'completed')

    async def test_aspect_ratio_is_not_stretched_and_unreliable_anchors_flagged(self):
        job = await self.create()
        layer = job['layers'][1]
        Image.new('RGBA', (32,32), (255,0,0,255)).save(self.host.local_media_path_from_url(layer['url']))
        layer['matches'] = []
        self.service.compose(job)
        self.assertTrue(layer['aspect_issue'])
        self.assertTrue(layer['alignment_issue'])
        box = layer['transform']
        self.assertEqual(box[2]-box[0],box[5]-box[1])
        with Image.open(self.host.local_media_path_from_url(layer['aligned_url'])) as image:
            self.assertEqual(image.getpixel((0,24))[3],0)

    async def test_immutable_outputs_and_stale_psd_revision(self):
        job = await self.create()
        previous = job['revision']
        old_url = job['layers'][1]['aligned_url']
        old_bytes = Path(self.host.local_media_path_from_url(old_url)).read_bytes()
        self.service.compose(job)
        self.assertNotEqual(old_url, job['layers'][1]['aligned_url'])
        self.assertEqual(Path(self.host.local_media_path_from_url(old_url)).read_bytes(), old_bytes)
        response = await self.client.post(f"/api/image-layers/{job['id']}/psd?revision={previous}", content=b'invalid')
        self.assertEqual(response.status_code,409)

    async def test_source_and_generated_files_survive_original_deletion(self):
        job = await self.create()
        for path in Path(self.host.OUTPUT_DIR).glob('*.png'):
            path.unlink()
        self.service.compose(job)
        self.assertTrue(Path(self.host.local_media_path_from_url(job['composite_url'])).exists())

    async def test_preflight_rejects_excessive_workload_without_analysis(self):
        Image.new('RGB',(128,128),'white').save(Path(self.host.OUTPUT_DIR)/'source.png')
        self.payload.update(layer_count=12,resolution='4K')
        response = await self.client.post('/api/image-layers',json=self.payload)
        self.assertEqual(response.status_code,400)
        self.assertEqual(self.host.calls,0)

    async def test_idempotency_key_cannot_silently_change_model_settings(self):
        await self.create()
        self.payload['resolution']='1K'
        response = await self.client.post('/api/image-layers',json=self.payload)
        self.assertEqual(response.status_code,409)
        self.assertEqual(len(self.host.submissions),2)

    async def test_element_ownership_rejects_duplicate_missing_and_wrong_owner(self):
        for change in ('duplicate', 'missing', 'owner', 'unknown'):
            plan = copy.deepcopy(self.host.plan)
            if change == 'duplicate':
                plan['layers'][0]['include_ids'].append('product')
            elif change == 'missing':
                plan['elements'].append({'id':'text', 'name':'文字', 'layer_id':'layer-2'})
            elif change == 'owner':
                plan['elements'][1]['layer_id'] = 'layer-1'
            else:
                plan['layers'][1]['include_ids'] = ['unknown']
            with self.subTest(change=change), self.assertRaises(ValueError):
                validate_plan(plan)
        job = await self.create()
        self.assertEqual(job['layers'][0]['exclude_ids'], ['product'])
        self.assertIn('元素白名单', self.host.submissions[1].prompt)

    async def test_auto_correction_fixes_only_failed_layer(self):
        self.payload['max_retries'] = 1
        self.host.opaque = True
        original = self.host.create_canvas_image_task
        async def fix(payload):
            if payload.client_request_id.endswith('layer-2-1'):
                self.host.opaque = False
            return await original(payload)
        self.host.create_canvas_image_task = fix
        job = await self.create()
        self.assertEqual(job['status'], 'completed')
        self.assertEqual(len(self.host.submissions), 3)
        self.assertEqual(job['layers'][0]['attempt'], 0)
        self.assertEqual(job['layers'][1]['auto_retries'], 1)
        self.assertIn('透明背景', self.host.submissions[-1].prompt)

    async def test_auto_correction_budget_survives_service_restart(self):
        self.payload['max_retries'] = 1
        self.host.opaque = True
        original = self.host.create_canvas_image_task
        async def stop_retry(payload):
            result = await original(payload)
            if payload.client_request_id.endswith('layer-2-1'):
                next(iter(self.service.jobs.values()))['stop_requested'] = True
            return result
        self.host.create_canvas_image_task = stop_retry
        job = await self.create()
        self.assertEqual(job['status'], 'paused')
        self.assertEqual(len(self.host.submissions), 3)
        recovered = LayerService(self.host)
        restored = recovered.get(job['id'])
        self.host.create_canvas_image_task = original
        recovered.launch(restored)
        await recovered.running[job['id']]
        self.assertEqual(restored['status'], 'needs-review')
        self.assertEqual(restored['layers'][1]['auto_retries'], 1)
        self.assertEqual(len(self.host.submissions), 3)

    async def test_structured_findings_override_incorrect_pass(self):
        original = self.host.canvas_llm
        for field in ('unexpected_elements', 'missing_element_ids', 'duplicates'):
            async def review(payload):
                result = await original(payload)
                if len(payload.images) == 3:
                    data = json.loads(result['text'])
                    if field == 'duplicates':
                        data[field] = [{'element':'商品', 'wrong_layer_ids':['layer-2']}]
                    else:
                        data['layers'][1][field] = ['product']
                    result['text'] = json.dumps(data)
                return result
            self.host.canvas_llm = review
            self.payload['request_id'] = 'structured-' + field
            job = await self.create()
            self.assertEqual(job['status'], 'needs-review')
            self.assertFalse(job['layers'][1]['semantic_pass'])
            self.assertTrue(job['layers'][1]['issues'])

    async def test_alignment_failure_retries_only_affected_layer_with_budget(self):
        self.payload['max_retries'] = 1
        original = self.host.canvas_llm
        async def review(payload):
            result = await original(payload)
            if len(payload.images) == 3:
                data = json.loads(result['text'])
                data['layers'][1]['matches'] = []
                data['layers'][1]['retry_instruction'] = '保持原图坐标，不要放大商品'
                result['text'] = json.dumps(data)
            return result
        self.host.canvas_llm = review
        job = await self.create()
        self.assertEqual(job['status'], 'needs-review')
        self.assertEqual(len(self.host.submissions), 3)
        self.assertEqual(job['layers'][0]['attempt'], 0)
        self.assertEqual(job['layers'][1]['auto_retries'], 1)
        self.assertIn('不要放大商品', self.host.submissions[-1].prompt)
        self.assertIn('定位锚点', self.host.submissions[-1].prompt)

    async def test_concurrent_failure_settles_other_worker_before_resume(self):
        self.payload.update(concurrency=2, max_retries=2)
        original = self.host.create_canvas_image_task
        both_started = asyncio.Event()
        entered = 0
        async def generate(payload):
            nonlocal entered
            entered += 1
            if entered == 2:
                both_started.set()
            await asyncio.wait_for(both_started.wait(), 2)
            result = await original(payload)
            if payload.background == 'opaque':
                self.host.tasks[result['task_id']] = {'status':'failed'}
            else:
                await asyncio.sleep(.04)
            return result
        self.host.create_canvas_image_task = generate
        job = await self.create()
        self.assertEqual(job['status'], 'failed')
        self.assertEqual(len(self.host.submissions), 2)
        self.assertEqual(job['layers'][1]['status'], 'generated')
        self.assertNotIn(job['id'], self.service.running)
        self.service.launch(job)
        await self.service.running[job['id']]
        self.assertEqual(len(self.host.submissions), 2)

    async def test_generation_worker_limit_is_enforced(self):
        self.payload['concurrency'] = 3
        job = await self.create()
        job['layers'] = [dict(id=str(i)) for i in range(8)]
        active = peak = finished = 0
        original = self.service.generate_layer
        async def probe(job, layer):
            nonlocal active, peak, finished
            active += 1
            peak = max(peak, active)
            await asyncio.sleep(.01)
            active -= 1
            finished += 1
        self.service.generate_layer = probe
        await self.service.generate_batch(job)
        self.service.generate_layer = original
        self.assertEqual((peak, finished, active), (3, 8, 0))

    async def test_resume_queries_upstream_without_resubmitting(self):
        original = self.host.create_canvas_image_task
        saved = {}
        queries = []
        async def fail(payload):
            result = await original(payload)
            saved[result['task_id']] = self.host.tasks[result['task_id']]['result']
            self.host.tasks[result['task_id']] = {'status':'failed', 'upstream_task_id':result['task_id']}
            return result
        async def query(payload):
            queries.append(payload.task_id)
            if len(queries) == 1:
                return {'status':'running'}
            return {'status':'succeeded', **saved[payload.task_id]}
        self.host.create_canvas_image_task = fail
        self.host.query_image_task = query
        self.host.ImageTaskQueryRequest = SimpleNamespace
        job = await self.create()
        self.assertEqual(job['status'], 'paused')
        self.assertEqual(len(self.host.submissions), 1)
        self.service.launch(job)
        await self.service.running[job['id']]
        self.assertEqual(job['status'], 'completed')
        self.assertEqual(len(self.host.submissions), 2)
        self.assertEqual(queries[0], queries[1])

    async def test_saved_receipt_recovers_images_without_upstream_generation(self):
        original = self.host.create_canvas_image_task
        saved = {}
        async def fail(payload):
            result = await original(payload)
            saved[result['task_id']] = self.host.tasks[result['task_id']]['result']
            self.host.tasks[result['task_id']] = {'status':'failed', 'recovery_id':result['task_id']}
            return result
        async def recover(identity, **kwargs):
            return {'status':'succeeded', **saved[identity], 'raw':'secret must not persist'}
        self.host.create_canvas_image_task = fail
        self.host.recover_unparsed_image_result = recover
        job = await self.create()
        self.assertEqual(job['status'], 'completed')
        self.assertEqual(len(self.host.submissions), 2)
        self.assertNotIn('secret', json.dumps(job))

    async def test_jimeng_queue_resumes_same_submit_id(self):
        original = self.host.create_canvas_image_task
        saved, queried = {}, []
        async def enqueue(payload):
            result = await original(payload)
            saved[result['task_id']] = self.host.tasks[result['task_id']]['result']['images']
            self.host.tasks[result['task_id']] = {'status':'jimeng_pending', 'submit_id':result['task_id']}
            return result
        async def query(payload):
            queried.append(payload.submit_id)
            if len(queried) == 1:
                return {'status':'pending'}
            return {'status':'succeeded', 'urls':saved[payload.submit_id]}
        self.host.create_canvas_image_task = enqueue
        self.host.jimeng_query_media = query
        self.host.JimengQueryMediaRequest = SimpleNamespace
        job = await self.create()
        self.assertEqual(job['status'], 'paused')
        self.service.launch(job)
        await self.service.running[job['id']]
        self.assertEqual(job['status'], 'completed')
        self.assertEqual(queried[0], queried[1])
        self.assertEqual(len(self.host.submissions), 2)


class CompositionSafetyTests(unittest.TestCase):
    def test_checkerboard_repair_retains_enclosed_white_and_leaves_plain_white_alone(self):
        image = Image.new('RGBA', (128, 128), 'white')
        draw = ImageDraw.Draw(image)
        for y in range(0, 128, 8):
            for x in range(0, 128, 8):
                if (x//8+y//8)%2:
                    draw.rectangle((x,y,x+7,y+7), fill=(225,225,225,255))
        draw.rectangle((40,40,87,87), fill='red')
        draw.rectangle((50,50,77,77), fill='white')
        repaired, changed = repair_checkerboard_alpha(image)
        self.assertTrue(changed)
        self.assertEqual(repaired.getpixel((0,0))[3],0)
        self.assertEqual(repaired.getpixel((60,60)),(255,255,255,255))
        self.assertEqual(image.getpixel((0,0))[3],255)
        # Text counters containing a repeated checkerboard can become transparent,
        # while the enclosed solid white detail remains opaque.
        draw.rectangle((40,40,87,87),fill='red')
        draw.rectangle((43,43,49,49),fill='white')
        for y in range(56,72,4):
            for x in range(56,72,4):
                draw.rectangle((x,y,x+3,y+3),fill=(225,225,225,255) if (x//4+y//4)%2 else 'white')
        repaired,_=repair_checkerboard_alpha(image,repair_enclosed=True)
        self.assertEqual(repaired.getpixel((60,60))[3],0)
        self.assertEqual(repaired.getpixel((45,45)),(255,255,255,255))

        self.assertFalse(repair_checkerboard_alpha(Image.new('RGBA',(128,128),'white'))[1])

    def test_false_identity_anchors_outside_source_element_use_planned_position(self):
        with tempfile.TemporaryDirectory() as temp:
            host=Host(Path(temp));service=LayerService(host)
            Image.new('RGBA',(100,100),'blue').save(Path(host.OUTPUT_DIR)/'bg.png')
            raw=Image.new('RGBA',(100,100));ImageDraw.Draw(raw).rectangle((20,20,59,39),fill='red')
            raw.save(Path(host.OUTPUT_DIR)/'fg.png')
            job={'id':'e'*32,'width':100,'height':100,'source_url':'/output/source.png','plan':{'bbox_format':'xyxy'},'layers':[
                {'id':'layer-1','name':'bg','transparent':False,'url':'/output/bg.png'},
                {'id':'layer-2','name':'fg','transparent':True,'url':'/output/fg.png','bbox':[600,100,1000,300],
                 'matches':[{'source':[200,200],'generated':[200,200]},{'source':[590,390],'generated':[590,390]}]}]}
            service.compose(job)
            with Image.open(host.local_media_path_from_url(job['layers'][1]['aligned_url'])) as aligned:
                self.assertEqual(aligned.getchannel('A').getbbox(),(60,10,100,30))
            self.assertIn('规划框',job['layers'][1]['alignment_issue'])
            job['layers'][1]['matches']=[{'source':[610,120],'generated':[610,120]},{'source':[990,280],'generated':[990,280]}]
            service.compose(job)
            with Image.open(host.local_media_path_from_url(job['layers'][1]['aligned_url'])) as aligned:
                self.assertEqual(aligned.getchannel('A').getbbox(),(60,10,100,30))


    def test_planned_position_preserves_proportions_and_bad_alpha_does_not_cover_background(self):
        with tempfile.TemporaryDirectory() as temp:
            host=Host(Path(temp));service=LayerService(host)
            Image.new('RGBA',(100,100),'blue').save(Path(host.OUTPUT_DIR)/'bg.png')
            raw=Image.new('RGBA',(100,100));ImageDraw.Draw(raw).rectangle((20,20,59,39),fill='red')
            raw.save(Path(host.OUTPUT_DIR)/'fg.png')
            job={'id':'c'*32,'width':100,'height':100,'source_url':'/output/source.png','plan':{'bbox_format':'xyxy'},'layers':[
                {'id':'layer-1','name':'bg','transparent':False,'url':'/output/bg.png'},
                {'id':'layer-2','name':'fg','transparent':True,'url':'/output/fg.png','bbox':[600,100,1000,300]}]}
            service.compose(job)
            with Image.open(host.local_media_path_from_url(job['layers'][1]['aligned_url'])) as aligned:
                self.assertEqual(aligned.getchannel('A').getbbox(),(60,10,100,30))
            Image.new('RGBA',(100,100),'white').save(Path(host.OUTPUT_DIR)/'fg.png')
            service.compose(job)
            with Image.open(host.local_media_path_from_url(job['composite_url'])) as composite:
                self.assertEqual(composite.getpixel((70,20)),(0,0,255,255))
            self.assertTrue(job['composition_issues'])


if __name__ == '__main__':
    unittest.main()
