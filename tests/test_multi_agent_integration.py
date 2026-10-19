"""Run the orchestration graph through the production generation queue with fixture providers."""
import asyncio
import copy
import json
import tempfile
import threading
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import httpx
from fastapi import FastAPI
from PIL import Image

import main
from multi_agent_api import install_multi_agent
from multi_agent_runtime import ALL_TOOLS, PAID_REQUEST_SCOPE, RunRequest, TERMINAL, ToolCall
from project_agent_store import ProjectAgentStore


class MultiAgentIntegrationTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='相框分工集成-')
        self.root = Path(self.tmp.name)
        Image.new('RGB', (64, 80), '#95725a').save(self.root / '产品.png')
        self.canvas = {'id': 'canvas_a', 'project': 'project_a', 'nodes': [
            {'id': 'frame', 'type': 'smart-upload', 'images': [{'url': '/assets/frame.png'}]}], 'connections': []}
        self.calls, self.turns, self.generated = [], {}, []
        provider = {'id': 'fixture', 'protocol': 'openai', 'enabled': True,
                    'chat_models': ['chat'], 'image_models': ['image'], 'video_models': ['video']}
        self.host = SimpleNamespace(DATA_DIR=str(self.root), DEFAULT_PROJECT_ID='default',
            PROJECT_AGENT_STORE=ProjectAgentStore(self.root), load_canvas=lambda _: copy.deepcopy(self.canvas),
            list_canvases=lambda: [self.canvas], ensure_default_project=lambda: [{'id': 'project_a'}],
            load_api_providers=lambda: [provider], get_api_provider_exact=lambda _: provider,
            project_agent_safe_error=lambda e: str(e), _project_agent_access=lambda *a: None,
            _project_agent_local_access=lambda *a: None,
            output_file_from_url=lambda u: str(self.root / '产品.png') if u.startswith(('/assets/', '/output/')) else None,
            is_video_reference_value=lambda u: u.endswith('.mp4'), is_image_reference_value=lambda u: u.endswith('.png'),
            CanvasLLMRequest=main.CanvasLLMRequest, canvas_llm=self.model,
            _find_canvas_task_by_client_request_id=main._find_canvas_task_by_client_request_id,
            get_canvas_image_task=main.get_canvas_image_task, get_canvas_comfy_task=main.get_canvas_comfy_task,
            cancel_canvas_image_task=main.cancel_canvas_image_task, cancel_canvas_comfy_task=main.cancel_canvas_comfy_task)
        self.app = FastAPI()
        self.adapter = install_multi_agent(self.app, self.host)
        self.app.post('/api/canvas-image-tasks')(main.create_canvas_image_task)
        self.app.post('/api/canvas-comfy-tasks')(main.create_canvas_comfy_task)
        self.client = httpx.AsyncClient(transport=httpx.ASGITransport(app=self.app, client=('127.0.0.1', 123)), base_url='http://127.0.0.1')

        async def generate(payload, *a, **kw):
            self.assertEqual(PAID_REQUEST_SCOPE.get(), bool(payload.multi_agent_action_id))
            self.generated.append(payload.multi_agent_action_id)
            await asyncio.sleep(.03)
            return {'images': [f'/output/{payload.multi_agent_action_id or "legacy"}.png']}

        self.patch = patch.multiple(main, MULTI_AGENT=self.adapter, DATA_DIR=str(self.root),
            CANVAS_TASKS_FILE=str(self.root / '旧生成队列.json'), CANVAS_TASKS={},
            CANVAS_IMAGE_BACKGROUND_TASKS={}, CANVAS_COMFY_CANCEL_EVENTS={}, build_online_image_result=generate)
        self.patch.start()

    async def asyncTearDown(self):
        await self.adapter.runtime.close()
        jobs = list(main.CANVAS_IMAGE_BACKGROUND_TASKS.values())
        for job in jobs:
            job.cancel()
        await asyncio.gather(*jobs, return_exceptions=True)
        await self.client.aclose()
        self.patch.stop()
        self.tmp.cleanup()

    async def model(self, payload):
        context = json.loads(payload.system_prompt.split('\n', 1)[1].split('\n画布命令参数白名单', 1)[0])
        ident = context['identity']
        task_id, role = ident['task_id'], ident['agent_role']
        turn = self.turns.get(task_id, 0)
        self.turns[task_id] = turn + 1
        self.calls.append((task_id, role, list(payload.images), copy.deepcopy(payload.messages)))
        tasks = self.adapter.store.snapshot(self.run_id, 'project_a')['tasks']
        by_role = {t['agent_role']: t for t in tasks}

        def spawn(name, dependencies):
            return {'tool': 'agent.spawn_subagent', 'args': {'idempotency_key': name, 'agent_role': name,
                'goal': name, 'dependencies': dependencies, 'allowed_tools': sorted(ALL_TOOLS)}}

        if role == 'main':
            if turn == 0:
                call = spawn('产品分析', [])
            elif turn == 1:
                call = spawn('场景设计', [by_role['产品分析']['task_id']])
            elif turn in (2, 3, 4):
                call = spawn(f'场景制作{turn - 1}', [by_role['场景设计']['task_id']])
            elif turn == 5:
                call = spawn('质量检查', [by_role[f'场景制作{i}']['task_id'] for i in (1, 2, 3)])
            elif turn == 6:
                call = {'tool': 'agent.get_subagent_result', 'args': {'task_id': by_role['质量检查']['task_id']}}
            else:
                call = {'tool': 'agent.finish_task', 'args': {'summary': '三张图片已回画布；尺寸未提供，需人工复核。'}}
        elif role in {'产品分析', '场景设计'}:
            call = {'tool': 'agent.finish_task', 'args': {'summary': '保留矩形框与支架；客厅、书房、床头三种方案。'}}
        elif role == '质量检查':
            if turn == 0:
                call = {'tool': 'canvas.check_product', 'args': {'node_ids': [f'output-{i}' for i in (1, 2, 3)]}}
            else:
                self.assertEqual(len(payload.images), 4, 'quality model must receive the source and actual generated images')
                self.assertIn('unknown', payload.messages[-1]['content'])
                call = {'tool': 'agent.finish_task', 'args': {'summary': '已读取三张实际结果；物理尺寸未知，需复核。'}}
        else:
            number = int(role[-1])
            target = f'output-{number}'
            if turn == 0:
                op = {'tool': 'canvas.create_node', 'args': {'type': 'smart-paint', 'title': role,
                    'prompt': '保持相框结构，制作指定场景', 'settings': {'engine': 'api', 'provider_id': 'fixture', 'model': 'image'}}}
            elif turn == 1:
                op = {'tool': 'canvas.connect', 'args': {'from': 'frame', 'to': target, 'kind': 'input'}}
            elif turn == 2:
                op = {'tool': 'canvas.run_node', 'target': target, 'args': {}}
            else:
                return {'text': json.dumps({'tool': 'agent.finish_task', 'args': {'summary': role + '已保存',
                    'result_refs': [{'kind': 'node', 'id': target}]}}, ensure_ascii=False)}
            call = {'tool': 'canvas.command', 'args': {'idempotency_key': f'op-{turn}', 'operation': op}}
        return {'text': json.dumps(call, ensure_ascii=False), 'raw_usage': {'prompt_tokens': 50, 'completion_tokens': 20}}

    async def execute_registered(self, snapshot):
        for action in snapshot['actions']:
            if action['status'] != 'registered':
                continue
            base = f'/api/canvas-agent/multi/runs/{self.run_id}/actions/{action["action_id"]}'
            scope = {'project_id': 'project_a', 'canvas_id': 'canvas_a'}
            claim = await self.client.post(base + '/claim', json={**scope, 'client_id': 'fixture-browser'})
            self.assertEqual(claim.status_code, 200, claim.text)
            claimed = claim.json()['action']
            op, args = action['operation'], action['operation']['args']
            number = int(next(t['agent_role'] for t in snapshot['tasks'] if t['task_id'] == action['task_id'])[-1])
            node_id = f'output-{number}'
            if op['tool'] == 'canvas.create_node':
                self.canvas['nodes'].append({'id': node_id, 'type': args['type'], 'text': args['prompt'],
                    'runSettings': args['settings'], 'images': []})
            elif op['tool'] == 'canvas.connect':
                self.canvas['connections'].append(args)
            elif op['tool'] == 'canvas.run_node':
                payload = {'prompt': '相框场景', 'provider_id': 'fixture', 'model': 'image', 'project_id': 'project_a',
                    'reference_images': [{'url': '/assets/frame.png'}], 'multi_agent_action_id': action['action_id'],
                    'multi_agent_execution_token': claimed['lease_token'], 'client_request_id': action['action_id']}
                first, repeat = await self.client.post('/api/canvas-image-tasks', json=payload), await self.client.post('/api/canvas-image-tasks', json=payload)
                self.assertEqual(first.status_code, 200, first.text)
                self.assertEqual(first.json()['task_id'], repeat.json()['task_id'], 'one action may only create one paid task')
            node = next(n for n in self.canvas['nodes'] if n['id'] == node_id)
            node.setdefault('_agent_action_ids', []).append(action['action_id'])
            response = await self.client.post(base + '/receipt', json={**scope, 'lease_token': claimed['lease_token'], 'status': 'applied', 'node_ids': [node_id]})
            self.assertEqual(response.status_code, 200, response.text)

        # Simulates only the browser's result persistence; production queue and adapter determine success.
        for action in snapshot['actions']:
            if action['operation']['tool'] != 'canvas.run_node' or not action['generation_task_ids']:
                continue
            remote = await main.get_canvas_image_task(action['generation_task_ids'][0])
            if remote['status'] == 'succeeded':
                target = action['operation']['target']
                node = next(n for n in self.canvas['nodes'] if n['id'] == (target['node_id'] if isinstance(target, dict) else target))
                node['images'] = [{'url': url} for url in remote['result']['images']]

    async def test_frame_graph_uses_independent_models_production_queue_and_actual_visual_results(self):
        request = RunRequest(project_id='project_a', canvas_id='canvas_a', idempotency_key='frame-demo',
            goal='分析相框，制作三张场景图，检查实际图片', provider_id='fixture', model='chat',
            source_images=['/assets/frame.png'], limits={'generation_unit_cost': .1, 'max_cost': 1.0},
            policy={'authorized_generations': 3})
        run, _ = self.adapter.store.create(request, self.adapter.context(request, self.canvas))
        self.run_id = run['run_id']
        self.adapter.runtime.start(self.run_id)
        for _ in range(220):
            snap = self.adapter.store.snapshot(self.run_id, 'project_a')
            if snap['run']['status'] in TERMINAL:
                break
            await self.execute_registered(snap)
            await asyncio.sleep(.04)
        self.assertEqual(snap['run']['status'], 'completed', str(snap['run']))
        self.assertEqual(len(snap['tasks']), 7)
        self.assertEqual(len(self.generated), 3)
        self.assertEqual(len(set(self.generated)), 3)
        self.assertEqual(snap['run']['generation_count'], 3)
        self.assertEqual(snap['run']['estimated_cost'], .3)
        self.assertEqual(len(snap['tasks'][0]['result_refs']), 3)
        self.assertEqual(len({call[0] for call in self.calls}), 7)
        self.assertTrue(all(not call[3] for call in self.calls if self.turns[call[0]] == 1))

    async def test_legacy_image_request_does_not_require_agent_authorization(self):
        created = await main.create_canvas_image_task(main.OnlineImageRequest(prompt='旧版单次生成'))
        for _ in range(30):
            task = await main.get_canvas_image_task(created['task_id'])
            if task['status'] == 'succeeded':
                break
            await asyncio.sleep(.02)
        self.assertEqual(task['status'], 'succeeded')
        self.assertEqual(self.generated, [''])

    async def test_actual_app_route_smoke_uses_no_startup_migration_or_private_config(self):
        with patch.object(main, 'load_api_providers', return_value=[]), \
             patch.object(main, 'ensure_key_profile_store_for_providers', return_value={}), \
             patch.object(main, 'detect_codex_image_capabilities', new=AsyncMock(return_value={'image_models': []})), \
             patch.object(main, '_read_history_api_rows', return_value=[]):
            async with httpx.AsyncClient(transport=httpx.ASGITransport(app=main.app, client=('127.0.0.1', 123)),
                                         base_url='http://127.0.0.1') as client:
                for path in ('/', '/api/app-info', '/api/providers', '/api/history', '/api/canvas-agent/multi/config'):
                    response = await client.get(path)
                    self.assertEqual(response.status_code, 200, path)
                config = (await client.get('/api/canvas-agent/multi/config')).json()
                self.assertTrue(config['enabled'])
                self.assertEqual(config['limits']['concurrency'], 3)
                self.assertEqual(config['model_choices'], [])
                self.assertIn('agent.spawn_subagent', config['tools'])

    async def test_autonomous_model_call_has_one_transport_attempt_and_output_cap(self):
        client = AsyncMock()
        client.__aenter__.return_value = client
        client.post.return_value = httpx.Response(503, json={'error': 'upstream temporarily unavailable'})
        payload = main.CanvasLLMRequest(message='分析相框', provider='fixture', model='chat',
            allow_model_fallback=False, transport_retries=0, max_output_tokens=4096)
        with patch.object(main.httpx, 'AsyncClient', return_value=client), \
             patch.object(main, 'get_api_provider', return_value={'id': 'fixture', 'protocol': 'openai'}), \
             patch.object(main, 'resolve_canvas_skill_request', return_value=(None, '')), \
             patch.object(main, 'resolve_chat_provider', return_value=('https://fixture.invalid', {}, 'chat')):
            with self.assertRaises(main.HTTPException):
                await main.canvas_llm(payload)
        self.assertEqual(client.post.await_count, 1)
        self.assertEqual(client.post.call_args.kwargs['json']['max_tokens'], 4096)

    async def test_paid_transport_never_reposts_via_responses_fallback_or_transient_retry(self):
        client=AsyncMock()
        client.post.side_effect=httpx.ReadError('response lost')
        client.request.side_effect=httpx.ReadError('response lost')
        with self.assertRaises(httpx.ReadError):
            token=PAID_REQUEST_SCOPE.set(True)
            try:
                await main.post_openai_responses(client,'https://fixture.invalid/responses',{}, {'model':'fixture'})
            finally:
                PAID_REQUEST_SCOPE.reset(token)
        client.post.assert_awaited_once()
        client.stream.assert_not_called()
        token=PAID_REQUEST_SCOPE.set(True)
        try:
            with self.assertRaises(httpx.ReadError):
                await main.httpx_request_with_transient_retries(client,'POST','https://fixture.invalid/videos',attempts=3)
        finally:
            PAID_REQUEST_SCOPE.reset(token)
        client.request.assert_awaited_once()
        stream_client=MagicMock()
        context=AsyncMock()
        context.__aenter__.side_effect=httpx.ReadError('stream response lost')
        stream_client.stream.return_value=context
        stream_client.post=AsyncMock()
        token=PAID_REQUEST_SCOPE.set(True)
        try:
            with self.assertRaises(httpx.ReadError):
                await main.post_openai_responses_stream(stream_client,'https://fixture.invalid/responses',{}, {'model':'fixture'})
        finally:
            PAID_REQUEST_SCOPE.reset(token)
        stream_client.post.assert_not_awaited()
        self.assertFalse(PAID_REQUEST_SCOPE.get())

    async def test_uncertain_non_gpt_edit_never_falls_back_to_a_second_paid_request(self):
        provider={'id':'fixture','protocol':'openai','image_request_mode':'openai',
                  'base_url':'https://fixture.invalid/v1','image_models':['fixture-image']}
        client_type=httpx.AsyncClient
        for disconnected in (False,True):
            with self.subTest(disconnected=disconnected):
                requests=[]

                async def respond(request):
                    requests.append(request)
                    if disconnected:
                        raise httpx.ReadError('response lost',request=request)
                    return httpx.Response(503,json={'error':'temporarily unavailable'})

                with patch.object(main,'get_api_provider',return_value=provider), \
                     patch.object(main,'api_headers',return_value={}), \
                     patch.object(main,'output_file_from_url',return_value=str(self.root/'产品.png')), \
                     patch.object(main,'append_gpt_image_edit_diagnostic'), \
                     patch.object(main.httpx,'AsyncClient',side_effect=lambda **kw: client_type(transport=httpx.MockTransport(respond),**kw)):
                    token=PAID_REQUEST_SCOPE.set(True)
                    try:
                        with self.assertRaises(main.HTTPException):
                            await main.generate_ai_image('相框场景','1024x1024','auto','fixture-image',
                                                         [{'url':'/assets/frame.png'}],'fixture')
                    finally:
                        PAID_REQUEST_SCOPE.reset(token)
                self.assertEqual(len(requests),1)
                self.assertTrue(requests[0].url.path.endswith('/images/edits'))

    async def local_workflow_action(self):
        self.canvas['nodes'].append({'id': 'local', 'type': 'smart-comfy-workflow',
                                    'runSettings': {'engine': 'comfy'}, 'workflow': 'fixture.json'})
        request = RunRequest(project_id='project_a', canvas_id='canvas_a', idempotency_key='local-run',
            goal='执行已有本地工作流', provider_id='fixture', model='chat', policy={'allow_local_gpu': True})
        run, _ = self.adapter.store.create(request, self.adapter.context(request, self.canvas))
        await self.adapter.runtime.dispatch(run['run_id'], run['root_task_id'], ToolCall(tool='canvas.command',
            args={'idempotency_key': 'local-action', 'operation': {'tool': 'canvas.run_node', 'target': 'local', 'args': {}}}))
        action = self.adapter.store.snapshot(run['run_id'], 'project_a')['actions'][0]
        claim = await self.client.post(f'/api/canvas-agent/multi/runs/{run["run_id"]}/actions/{action["action_id"]}/claim',
            json={'project_id': 'project_a', 'canvas_id': 'canvas_a', 'client_id': 'test-browser'})
        self.assertEqual(claim.status_code, 200, claim.text)
        payload = main.GenerateRequest(workflow_json='fixture.json', project_id='project_a',
            multi_agent_action_id=action['action_id'], multi_agent_execution_token=claim.json()['action']['lease_token'],
            client_request_id=action['action_id'])
        return run, action, payload

    async def test_comfy_authorization_precedes_model_startup_and_submission_is_idempotent(self):
        run, action, payload = await self.local_workflow_action()
        seen = []

        async def local_queue(task_id, prepared):
            seen.append(prepared)

        with patch.object(main, '_prepare_canvas_comfy_payload', side_effect=lambda p: p) as prepare, \
             patch.object(main, 'COMFYUI_INSTANCES', ['127.0.0.1:8188']), \
             patch.object(main, 'run_canvas_comfy_task', side_effect=local_queue):
            denied = payload.model_copy(update={'multi_agent_execution_token': 'invalid'})
            response = await self.client.post('/api/canvas-comfy-tasks', json=denied.model_dump())
            self.assertEqual(response.status_code, 403)
            prepare.assert_not_called()
            first = await self.client.post('/api/canvas-comfy-tasks', json=payload.model_dump())
            repeat = await self.client.post('/api/canvas-comfy-tasks', json=payload.model_dump())
            self.assertEqual(first.status_code, 200, first.text)
            self.assertEqual(first.json()['task_id'], repeat.json()['task_id'])
            await asyncio.sleep(.02)
        self.assertEqual(prepare.call_count, 1)
        self.assertEqual(len(seen), 1)
        self.assertTrue(seen[0].local_only)
        self.assertEqual(seen[0].preferred_backend, '127.0.0.1:8188')

    async def test_comfy_preparation_failure_or_remote_backend_is_not_submitted(self):
        run, action, payload = await self.local_workflow_action()
        for failure in (RuntimeError('本地模型未准备好'), None):
            with self.subTest(failure=failure):
                with self.adapter.store.transaction() as db:
                    fresh = self.adapter.store.get(db, 'actions', action['action_id'])
                    fresh.update(status='claimed', request_signature='')
                    self.adapter.store.put(db, 'actions', fresh)
                options = {'side_effect': failure} if failure else {'side_effect': lambda p: p.model_copy(update={'preferred_backend': 'remote.invalid:8188'})}
                with patch.object(main, '_prepare_canvas_comfy_payload', **options), \
                     patch.object(main, 'COMFYUI_INSTANCES', ['127.0.0.1:8188', 'remote.invalid:8188']), \
                     patch.object(main, 'run_canvas_comfy_task', new_callable=AsyncMock) as submit:
                    with self.assertRaises((RuntimeError, ValueError)):
                        await main.create_canvas_comfy_task(payload)
                    submit.assert_not_called()
                fresh = self.adapter.store.snapshot(run['run_id'], 'project_a')['actions'][0]
                self.assertEqual(fresh['status'], 'failed')
                self.assertFalse(fresh['generation_task_ids'])

    async def test_stop_during_comfy_preparation_does_not_queue_a_generation(self):
        run, action, payload = await self.local_workflow_action()
        preparing, released = threading.Event(), threading.Event()

        def prepare(p):
            preparing.set()
            if not released.wait(5):
                raise RuntimeError('test preparation timed out')
            return p

        with patch.object(main, '_prepare_canvas_comfy_payload', side_effect=prepare), \
             patch.object(main, 'COMFYUI_INSTANCES', ['127.0.0.1:8188']), \
             patch.object(main, 'run_canvas_comfy_task', new_callable=AsyncMock) as submit:
            job = asyncio.create_task(self.client.post('/api/canvas-comfy-tasks', json=payload.model_dump()))
            try:
                for _ in range(100):
                    if preparing.is_set():
                        break
                    await asyncio.sleep(.01)
                self.assertTrue(preparing.is_set())
                await self.adapter.runtime.cancel(run['run_id'], 'project_a')
            finally:
                released.set()
            response = await job
            self.assertEqual(response.status_code, 409, response.text)
            submit.assert_not_called()
        self.assertEqual(main.CANVAS_TASKS, {})
        self.assertEqual(self.adapter.store.snapshot(run['run_id'], 'project_a')['actions'][0]['status'], 'cancelled')


if __name__ == '__main__':
    unittest.main()
