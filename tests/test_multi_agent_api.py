import asyncio
import copy
import json
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import httpx
from fastapi import FastAPI, HTTPException
from PIL import Image

from multi_agent_api import install_multi_agent, canvas_digest
from multi_agent_runtime import RunRequest, ToolCall
from multi_agent_store import AgentError, TERMINAL
from project_agent_store import ProjectAgentStore


class MultiAgentApiTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.tmp=tempfile.TemporaryDirectory(prefix='小美协作API-')
        self.root=Path(self.tmp.name)
        Image.new('RGB',(100,120),'#cfaf8f').save(self.root/'frame.png')
        self.canvas={'id':'canvas_a','project':'project_a','nodes':[
            {'id':'frame','type':'smart-upload','title':'相框产品图','images':[{'url':'/assets/frame.png'}]},
            {'id':'paint','type':'smart-paint','images':[],'runSettings':{'engine':'api','provider_id':'test','model':'image'},'text':'相框客厅场景'},
        ],'connections':[{'from':'frame','to':'paint','kind':'input'}],'updated_at':1}
        self.generation={}
        self.host=SimpleNamespace(DATA_DIR=str(self.root),DEFAULT_PROJECT_ID='default',
            PROJECT_AGENT_STORE=ProjectAgentStore(self.root),
            project_agent_safe_error=lambda v:str(getattr(v,'detail',v))[:1000],
            load_canvas=lambda ident:copy.deepcopy(self.canvas),
            list_canvases=lambda:[{'id':'canvas_a','project':'project_a'},{'id':'private','project':'project_b'}],
            ensure_default_project=lambda:[{'id':'project_a'},{'id':'project_b'}],
            load_api_providers=lambda:[{'id':'test','enabled':True,'chat_models':['chat'],'image_models':['image'],'video_models':['video']}],
            get_api_provider_exact=lambda ident:{'id':'test','chat_models':['chat'],'image_models':['image'],'video_models':['video']} if ident=='test' else self.fail('bad provider'),
            _project_agent_access=self.access,_project_agent_local_access=self.local,
            output_file_from_url=lambda url:str(self.root/'frame.png') if url in {'/assets/frame.png','/output/result.png'} else None,
            is_video_reference_value=lambda url:url.endswith('.mp4'),is_image_reference_value=lambda url:url.endswith('.png'),
            _find_canvas_task_by_client_request_id=lambda ident:next((v for v in self.generation.values() if v.get('client_request_id')==ident),None),
            get_canvas_image_task=self.get_generation,get_canvas_comfy_task=self.get_generation,
            cancel_canvas_image_task=AsyncMock(),cancel_canvas_comfy_task=AsyncMock())
        self.app=FastAPI()
        self.adapter=install_multi_agent(self.app,self.host)
        self.store=self.adapter.store
        self.engine=self.adapter.runtime
        self.transport=httpx.ASGITransport(app=self.app,client=('127.0.0.1',1234))
        self.client=httpx.AsyncClient(transport=self.transport,base_url='http://127.0.0.1:3000')
        self.body=dict(project_id='project_a',canvas_id='canvas_a',idempotency_key='request-1',
                       goal='相框三种场景',provider_id='test',model='chat',source_node_ids=['frame'],source_images=['/assets/frame.png'])

    def local(self,request):
        if request.headers.get('x-xiaomei-share-gateway') or request.client.host!='127.0.0.1':
            raise HTTPException(403,'local only')

    def access(self,request,project_id,canvas_id=''):
        self.local(request)
        if project_id not in {'project_a','project_b'}:
            raise HTTPException(404,'missing project')
        if canvas_id and (canvas_id!=self.canvas['id'] or project_id!=self.canvas['project']):
            raise HTTPException(403,'project mismatch')

    async def get_generation(self,ident):
        if ident not in self.generation:
            raise HTTPException(404,'missing')
        return copy.deepcopy(self.generation[ident])

    async def asyncTearDown(self):
        await self.engine.close()
        await self.client.aclose()
        self.tmp.cleanup()

    def create(self,**overrides):
        req=RunRequest(**{**self.body,**overrides})
        context=self.adapter.context(req,self.canvas)
        return self.store.create(req,context)[0]

    async def command(self,run,tool='canvas.run_node',args=None):
        await self.engine.dispatch(run['run_id'],run['root_task_id'],ToolCall(tool='canvas.command',args={
            'idempotency_key':'operation-1','operation':{'tool':tool,'target':{'node_id':'paint','image_index':0},'args':args or {}}}))
        return self.store.snapshot(run['run_id'],'project_a')['actions'][0]

    async def post(self,run,suffix,**values):
        return await self.client.post('/api/canvas-agent/multi/runs/'+run['run_id']+suffix,json={
            'project_id':'project_a','canvas_id':'canvas_a',**values})

    async def test_phase2_command_registration_execution_and_generation_acceptance_are_separate(self):
        run=self.create()
        action=await self.command(run)
        self.assertEqual(action['status'],'awaiting_approval')
        response=await self.post(run,f"/actions/{action['action_id']}/claim",client_id='browser')
        self.assertEqual(response.status_code,409)
        await self.post(run,f"/actions/{action['action_id']}/approve",approved=True)
        response=await self.post(run,f"/actions/{action['action_id']}/claim",client_id='browser')
        self.assertEqual(response.status_code,200,response.text)
        lease=response.json()['action']['lease_token']
        payload=SimpleNamespace(multi_agent_action_id=action['action_id'],multi_agent_execution_token=lease,
                                project_id='project_a',provider_id='test',model='image',n=1)
        payload.model_dump=lambda:{'multi_agent_action_id':action['action_id'],'provider_id':'test','model':'image','n':1}
        self.assertIsNone(self.adapter.before_generation(payload,'image'))
        self.adapter.generation_submitted(action['action_id'],'img-1')
        self.generation['img-1']={'id':'img-1','project_id':'project_a','status':'running'}
        self.canvas['nodes'][1]['_agent_action_ids']=[action['action_id']]
        await self.post(run,f"/actions/{action['action_id']}/receipt",lease_token=lease,node_ids=['paint'],status='applied')
        await self.adapter.reconcile(run['run_id'])
        self.assertEqual(self.store.snapshot(run['run_id'],'project_a')['actions'][0]['status'],'waiting_result')
        self.generation['img-1'].update(status='succeeded',result={'images':['/output/result.png']})
        await self.adapter.reconcile(run['run_id'])
        self.assertNotEqual(self.store.snapshot(run['run_id'],'project_a')['actions'][0]['status'],'completed')
        self.canvas['nodes'][1]['images']=[{'url':'/output/result.png'}]
        await self.adapter.reconcile(run['run_id'])
        completed=self.store.snapshot(run['run_id'],'project_a')['actions'][0]
        self.assertEqual(completed['status'],'completed')
        self.assertEqual(completed['stage'],'acceptance')
        self.assertEqual(completed['result']['image_urls'],['/output/result.png'])
        self.assertEqual(self.adapter.before_generation(payload,'image')['task_id'],'img-1')

    async def test_canvas_edit_between_approval_and_execution_requires_new_confirmation(self):
        run=self.create()
        action=await self.command(run,'canvas.update_node',{'prompt':'new'})
        self.canvas['nodes'][1]['text']='user edit'
        response=await self.post(run,f"/actions/{action['action_id']}/claim",client_id='browser')
        self.assertEqual(response.status_code,409)
        fresh=self.store.snapshot(run['run_id'],'project_a')['actions'][0]
        self.assertEqual(fresh['status'],'awaiting_approval')
        self.assertIn('修改',fresh['error'])

    async def test_generation_input_changes_require_confirmation_without_locking_shared_readers(self):
        run=self.create(policy={'authorized_generations':3},limits={'generation_unit_cost':.1,'max_cost':1.0})
        action=await self.command(run)
        self.canvas['nodes'][0]['images']=[{'url':'/assets/replaced-frame.png'}]
        response=await self.post(run,f"/actions/{action['action_id']}/claim",client_id='browser')
        self.assertEqual(response.status_code,409,response.text)
        self.assertEqual(response.json()['detail']['code'],'canvas_conflict')
        with patch.object(self.engine,'start'):
            await self.post(run,f"/actions/{action['action_id']}/approve",approved=True)
        self.canvas['connections']=[]
        response=await self.post(run,f"/actions/{action['action_id']}/claim",client_id='browser')
        self.assertEqual(response.status_code,409,response.text)
        self.assertEqual(response.json()['detail']['code'],'canvas_conflict')
        self.assertEqual(action['resources'],['canvas_a:paint'],'product input is read without locking other scenes')

    async def test_permissions_and_ref_scope_are_enforced(self):
        run=self.create(policy={'allow_canvas_writes':False})
        with self.assertRaises(AgentError):
            await self.command(run)
        with self.assertRaises(AgentError):
            self.adapter.validate_refs(run,[{'kind':'image','id':'/assets/other-project.png'}])
        req=RunRequest(**{**self.body,'source_images':['/assets/other-project.png']})
        with self.assertRaises(AgentError):
            self.adapter.context(req,self.canvas)
        self.assertEqual((await self.client.get('/api/canvas-agent/multi/runs',params={'project_id':'project_b'})).json()['runs'],[])
        response=await self.client.get('/api/canvas-agent/multi/config',headers={'x-xiaomei-share-gateway':'1'})
        self.assertEqual(response.status_code,403)

    async def test_service_side_strict_validation_and_model_list(self):
        invalid=await self.client.post('/api/canvas-agent/multi/runs',json={**self.body,'shell':'whoami'})
        self.assertEqual(invalid.status_code,422)
        with self.assertRaises(AgentError):
            self.adapter.validate_model('test','not-in-config')
        config=(await self.client.get('/api/canvas-agent/multi/config')).json()
        self.assertEqual(config['model_choices'][0]['chat_models'],['chat'])
        self.assertNotIn('api_key',json.dumps(config))

    async def test_phase3_unknown_paid_task_is_never_automatically_resubmitted(self):
        run=self.create()
        action=await self.command(run)
        await self.post(run,f"/actions/{action['action_id']}/approve",approved=True)
        response=await self.post(run,f"/actions/{action['action_id']}/claim",client_id='browser')
        lease=response.json()['action']['lease_token']
        payload=SimpleNamespace(multi_agent_action_id=action['action_id'],multi_agent_execution_token=lease,
                                project_id='project_a',provider_id='test',model='image',n=1)
        payload.model_dump=lambda:{'n':1}
        self.adapter.before_generation(payload,'image')
        self.store.recover()
        for _ in range(3):
            await self.adapter.reconcile(run['run_id'])
        with self.assertRaisesRegex(AgentError,'状态待核对'):
            self.adapter.before_generation(payload,'image')
        self.assertEqual(self.generation,{})
        self.assertEqual(self.store.snapshot(run['run_id'],'project_a')['actions'][0]['status'],'waiting_result')

    async def test_uncertain_paid_network_failure_blocks_automatic_reassignment(self):
        run=self.create(policy={'authorized_generations':3},limits={'generation_unit_cost':.1,'max_cost':1.0})
        action=await self.command(run)
        self.adapter.generation_submitted(action['action_id'],'uncertain-paid')
        self.generation['uncertain-paid']={'id':'uncertain-paid','project_id':'project_a','status':'failed',
            'status_code':502,'error':'Server disconnected without sending a response'}
        await self.adapter.reconcile(run['run_id'])
        fresh=self.store.snapshot(run['run_id'],'project_a')['actions'][0]
        self.assertEqual(fresh['status'],'waiting_result')
        self.assertTrue(fresh['submission_unknown'])
        with self.assertRaisesRegex(AgentError,'另一个代理'):
            await self.engine.dispatch(run['run_id'],run['root_task_id'],ToolCall(tool='canvas.command',args={
                'idempotency_key':'unsafe-retry','operation':{'tool':'canvas.run_node','target':'paint','args':{}}}))
        self.generation['uncertain-paid'].update(status_code=400,error='invalid image dimensions')
        await self.adapter.reconcile(run['run_id'])
        self.assertEqual(self.store.snapshot(run['run_id'],'project_a')['actions'][0]['status'],'failed')

    async def test_recovery_finds_original_generation_id_without_another_submit(self):
        run=self.create()
        action=await self.command(run)
        with self.store.transaction() as db:
            stored=self.store.get(db,'actions',action['action_id'])
            stored['status']='executing'
            self.store.put(db,'actions',stored)
        self.generation['original']={'id':'original','project_id':'project_a','status':'succeeded',
            'client_request_id':action['client_request_id'],'result':{'images':['/output/result.png']}}
        self.canvas['nodes'][1].update(images=[{'url':'/output/result.png'}],_agent_action_ids=[action['action_id']])
        self.store.recover()
        await self.adapter.reconcile(run['run_id'])
        result=self.store.snapshot(run['run_id'],'project_a')['actions'][0]
        self.assertEqual(result['generation_task_ids'],['original'])
        self.assertEqual(result['status'],'completed')

    async def test_paid_budget_refusal_and_same_action_id_cannot_duplicate_cost(self):
        run=self.create(limits={'max_cost':1.0,'generation_unit_cost':.6},policy={'authorized_generations':3})
        action=await self.command(run)
        self.assertEqual(action['status'],'registered')
        same=await self.command(run)
        self.assertEqual(same['action_id'],action['action_id'])
        with self.store.transaction() as db:
            current=self.store.get(db,'actions',action['action_id'])
            current['status']='failed'
            self.store.put(db,'actions',current)
        with self.assertRaisesRegex(AgentError,'预算'):
            await self.engine.dispatch(run['run_id'],run['root_task_id'],ToolCall(tool='canvas.command',args={
                'idempotency_key':'another-paid','operation':{'tool':'canvas.run_node','target':'paint','args':{}}}))
        snap=self.store.snapshot(run['run_id'],'project_a')
        self.assertEqual(snap['run']['estimated_cost'],.6)
        self.assertEqual(snap['run']['generation_count'],1)

    async def test_cancel_prevents_claim_and_generation_and_cancels_known_remote(self):
        run=self.create()
        action=await self.command(run)
        with self.store.transaction() as db:
            current=self.store.get(db,'actions',action['action_id'])
            current.update(generation_task_ids=['paid-1'])
            self.store.put(db,'actions',current)
        await self.post(run,'/interrupt')
        response=await self.post(run,f"/actions/{action['action_id']}/claim",client_id='browser')
        self.assertEqual(response.status_code,409)
        payload=SimpleNamespace(multi_agent_action_id=action['action_id'],multi_agent_execution_token='unused')
        with self.assertRaises(AgentError):
            self.adapter.before_generation(payload,'image')
        self.host.cancel_canvas_image_task.assert_awaited_once_with('paid-1')

    async def test_same_resource_conflict_and_no_silent_local_executor(self):
        run=self.create()
        await self.command(run,'canvas.update_node',{'title':'new'})
        with self.assertRaisesRegex(AgentError,'同一节点'):
            await self.engine.dispatch(run['run_id'],run['root_task_id'],ToolCall(tool='canvas.command',args={
                'idempotency_key':'competing','operation':{'tool':'canvas.update_node','target':'paint','args':{'title':'racing'}}}))
        for kind in ['smart-loop','smart-agent']:
            self.canvas['nodes'][1]['type']=kind
            with self.assertRaises(AgentError):
                self.adapter.validate_command(run,{'tool':'canvas.run_node','target':'paint','args':{}})

    async def test_project_asset_import_and_strict_nested_parameters(self):
        run=self.create()
        assets=self.adapter.read_tool(run,{},'canvas.list_assets',{})['assets']
        self.assertEqual({a['canvas_id'] for a in assets},{'canvas_a'})
        await self.engine.dispatch(run['run_id'],run['root_task_id'],ToolCall(tool='canvas.use_project_asset',args={
            'idempotency_key':'asset-1','url':'/assets/frame.png','title':'原产品素材'}))
        action=self.store.snapshot(run['run_id'],'project_a')['actions'][0]
        self.assertEqual(action['operation']['tool'],'canvas.use_project_asset')
        self.assertEqual(action['status'],'registered')
        with self.assertRaises(AgentError):
            await self.engine.dispatch(run['run_id'],run['root_task_id'],ToolCall(tool='canvas.use_project_asset',args={
                'idempotency_key':'asset-2','url':'/assets/private.png'}))
        with self.assertRaises(AgentError):
            await self.engine.dispatch(run['run_id'],run['root_task_id'],ToolCall(tool='canvas.command',args={
                'idempotency_key':'bad-fields','operation':{'tool':'canvas.read','args':{},'shell':'blocked'}}))

    async def test_visual_review_sends_actual_scoped_result_images(self):
        from main import CanvasLLMRequest
        self.host.CanvasLLMRequest=CanvasLLMRequest
        self.host.canvas_llm=AsyncMock(return_value={'text':'{}'})
        run=self.create()
        self.canvas['nodes'][1]['images']=[{'url':'/output/result.png'}]
        await self.engine.dispatch(run['run_id'],run['root_task_id'],ToolCall(tool='canvas.check_product',args={'node_ids':['paint']}))
        task=self.store.snapshot(run['run_id'],'project_a')['tasks'][0]
        await self.adapter.model(run,task,'测试视觉审查')
        payload=self.host.canvas_llm.call_args.args[0]
        self.assertEqual(payload.images,['/assets/frame.png','/output/result.png'])
        self.assertFalse(payload.allow_model_fallback)
        self.assertIn('unknown',task['messages'][-1]['content'])

    async def test_gpu_and_generation_concurrency_are_enforced(self):
        run=self.create(limits={'concurrency':1},policy={'allow_local_gpu':True})
        self.canvas['nodes'][1]['runSettings']={'engine':'comfy'}
        first=await self.command(run)
        first_claim=await self.post(run,f"/actions/{first['action_id']}/claim",client_id='one')
        self.assertEqual(first_claim.status_code,200,first_claim.text)
        with self.store.transaction() as db:
            stored=self.store.get(db,'actions',first['action_id']);stored['status']='waiting_result';self.store.put(db,'actions',stored)
        self.canvas['nodes'].append({'id':'paint2','type':'smart-paint','images':[],'runSettings':{'engine':'comfy'}})
        other=self.create(idempotency_key='second-run',policy={'allow_local_gpu':True})
        await self.engine.dispatch(other['run_id'],other['root_task_id'],ToolCall(tool='canvas.command',args={
            'idempotency_key':'second-op','operation':{'tool':'canvas.run_node','target':'paint2','args':{}}}))
        second=self.store.snapshot(other['run_id'],'project_a')['actions'][0]
        denied=await self.post(other,f"/actions/{second['action_id']}/claim",client_id='two')
        self.assertEqual(denied.json()['detail']['code'],'gpu_busy')
        await self.engine.dispatch(run['run_id'],run['root_task_id'],ToolCall(tool='canvas.command',args={
            'idempotency_key':'limit-op','operation':{'tool':'canvas.run_node','target':'paint2','args':{}}}))
        limited=self.store.snapshot(run['run_id'],'project_a')['actions'][-1]
        denied=await self.post(run,f"/actions/{limited['action_id']}/claim",client_id='three')
        self.assertEqual(denied.json()['detail']['code'],'generation_busy')

    async def test_agent_cancel_subagent_also_cancels_submitted_generation(self):
        from multi_agent_runtime import ALL_TOOLS
        run=self.create()
        await self.engine.dispatch(run['run_id'],run['root_task_id'],ToolCall(tool='agent.spawn_subagent',args={
            'idempotency_key':'child','agent_role':'制作','goal':'制作场景','allowed_tools':sorted(ALL_TOOLS)}))
        child=self.store.snapshot(run['run_id'],'project_a')['tasks'][1]
        await self.engine.dispatch(run['run_id'],child['task_id'],ToolCall(tool='canvas.command',args={
            'idempotency_key':'run','operation':{'tool':'canvas.run_node','target':'paint','args':{}}}))
        action=self.store.snapshot(run['run_id'],'project_a')['actions'][0]
        self.adapter.generation_submitted(action['action_id'],'child-paid')
        await self.engine.dispatch(run['run_id'],run['root_task_id'],ToolCall(tool='agent.cancel_subagent',args={'task_id':child['task_id']}))
        self.host.cancel_canvas_image_task.assert_awaited_once_with('child-paid')

    async def test_retry_child_reopens_completed_parent_for_new_summary(self):
        run=self.create()
        await self.engine.dispatch(run['run_id'],run['root_task_id'],ToolCall(tool='agent.spawn_subagent',args={
            'idempotency_key':'child','agent_role':'分析','goal':'结构检查'}))
        child=self.store.snapshot(run['run_id'],'project_a')['tasks'][1]
        with self.store.transaction() as db:
            child.update(status='failed',error='暂时断网');self.store.put(db,'tasks',child)
            root=self.store.get(db,'tasks',run['root_task_id']);root.update(status='completed',summary='一项失败');self.store.put(db,'tasks',root)
            run['status']='completed';self.store.put(db,'runs',run)
        response=await self.post(run,f"/tasks/{child['task_id']}/retry",instructions='再核对一次')
        self.assertEqual(response.status_code,200,response.text)
        snap=self.store.snapshot(run['run_id'],'project_a')
        self.assertEqual(snap['tasks'][0]['status'],'waiting_result')
        self.assertEqual(snap['tasks'][0]['waiting_for']['task_id'],child['task_id'])
        self.assertEqual(snap['tasks'][1]['instructions'],'再核对一次')

    async def test_unsubmitted_claim_can_resume_but_unknown_paid_submit_cannot(self):
        run=self.create()
        action=await self.command(run)
        await self.post(run,f"/actions/{action['action_id']}/approve",approved=True)
        claim=await self.post(run,f"/actions/{action['action_id']}/claim",client_id='closed-browser')
        old_token=claim.json()['action']['lease_token']
        resumed=await self.post(run,f"/actions/{action['action_id']}/resume-unsubmitted")
        self.assertEqual(resumed.status_code,200,resumed.text)
        payload=SimpleNamespace(multi_agent_action_id=action['action_id'],multi_agent_execution_token=old_token,
            project_id='project_a',provider_id='test',model='image',n=1,model_dump=lambda:{'n':1})
        with self.assertRaises(AgentError):
            self.adapter.before_generation(payload,'image')
        new=await self.post(run,f"/actions/{action['action_id']}/claim",client_id='new-browser')
        payload.multi_agent_execution_token=new.json()['action']['lease_token']
        self.adapter.before_generation(payload,'image')
        refused=await self.post(run,f"/actions/{action['action_id']}/resume-unsubmitted")
        self.assertEqual(refused.status_code,409)
        self.assertEqual(self.store.snapshot(run['run_id'],'project_a')['run']['generation_count'],1)

    async def test_video_uses_scoped_references_single_submit_and_actual_result(self):
        from main import CanvasVideoRequest
        self.canvas['nodes'][1]['runSettings'].update(apiKind='video',videoProvider='test',videoModel='video')
        run=self.create()
        action=await self.command(run)
        await self.post(run,f"/actions/{action['action_id']}/approve",approved=True)
        claim=await self.post(run,f"/actions/{action['action_id']}/claim",client_id='video-browser')
        payload=CanvasVideoRequest(prompt='相框视频',provider_id='test',model='video',project_id='project_a',
            multi_agent_action_id=action['action_id'],multi_agent_execution_token=claim.json()['action']['lease_token'],images=[{'url':'/assets/frame.png'}])
        original=AsyncMock(return_value={'videos':['/output/frame.mp4']})
        with self.assertRaises(AgentError):
            await self.adapter.video(payload.model_copy(update={'audios':['/assets/private.mp3']}),original)
        await self.adapter.video(payload,original)
        with self.assertRaises(AgentError):
            await self.adapter.video(payload,original)
        original.assert_awaited_once()
        self.canvas['nodes'][1].update(images=[{'url':'/output/frame.mp4','kind':'video'}],_agent_action_ids=[action['action_id']])
        await self.adapter.reconcile(run['run_id'])
        self.assertEqual(self.store.snapshot(run['run_id'],'project_a')['actions'][0]['status'],'completed')


if __name__=='__main__':
    unittest.main()
