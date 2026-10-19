import asyncio
import json
import tempfile
import unittest
from pathlib import Path

from multi_agent_runtime import MultiAgentRuntime, RunRequest, ToolCall, validate_graph
from multi_agent_store import AgentError, AgentRunStore, TERMINAL


class ModelAdapter:
    def __init__(self):
        self.calls = []
        self.active = 0
        self.peak = 0

    def safe_error(self, exc):
        return str(exc)

    def validate_model(self, provider, model):
        if model == 'missing':
            raise AgentError('model_unavailable', '模型不可用', 422)

    async def reconcile(self, run_id):
        pass

    async def cancel_generations(self, run_id):
        pass

    def validate_refs(self, run, refs):
        if refs:
            raise AgentError('invalid_ref', '结果不在当前项目中', 403)

    async def model(self, run, task, prompt):
        self.calls.append((task['task_id'], task['depth'], list(task['messages'])))
        self.active += 1
        self.peak = max(self.peak, self.active)
        await asyncio.sleep(.01)
        self.active -= 1
        if task['depth']:
            call = {'tool':'agent.finish_task','args':{'summary':'独立模型分析结果'}}
        elif not task['messages']:
            call = {'tool':'agent.spawn_subagent','args':{'idempotency_key':'analysis','agent_role':'产品分析','goal':'独立分析产品'}}
        elif len(task['messages']) == 2:
            other = json.loads(task['messages'][-1]['content'].split('：',1)[1])['result']
            call = {'tool':'agent.get_subagent_result','args':{'task_id':other['task_id']}}
        else:
            call = {'tool':'agent.finish_task','args':{'summary':'已汇总子代理结果'}}
        return {'text':json.dumps(call,ensure_ascii=False),'raw_usage':{'prompt_tokens':20,'completion_tokens':10}}


class MultiAgentTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='小美代理-')
        self.store = AgentRunStore(Path(self.tmp.name) / '运行.sqlite3')
        self.adapter = ModelAdapter()
        self.engine = MultiAgentRuntime(self.store,self.adapter)
        self.request = RunRequest(project_id='project_a',canvas_id='canvas_a',idempotency_key='user-1',
                                  goal='分析相框产品',provider_id='configured-provider',model='configured-model')
        self.run,_ = self.store.create(self.request,{'memories':[]})

    async def asyncTearDown(self):
        await self.engine.close()
        self.tmp.cleanup()

    def snapshot(self):
        return self.store.snapshot(self.run['run_id'],'project_a')

    async def wait_done(self):
        for _ in range(120):
            snap = self.snapshot()
            if snap['run']['status'] in TERMINAL:
                return snap
            await asyncio.sleep(.03)
        self.fail(str(self.snapshot()))

    async def test_phase1_real_independent_calls_and_results(self):
        self.engine.start(self.run['run_id'])
        snap = await self.wait_done()
        self.assertEqual(snap['run']['status'],'completed')
        self.assertEqual(len(snap['tasks']),2)
        child = snap['tasks'][1]
        self.assertEqual(child['parent_task_id'],snap['tasks'][0]['task_id'])
        self.assertEqual(child['summary'],'独立模型分析结果')
        self.assertTrue(any(depth == 1 and not history for _,depth,history in self.adapter.calls))
        self.assertGreater(snap['run']['token_usage']['input_tokens'],0)

    async def test_simple_task_does_not_require_subagent(self):
        async def direct(*args):
            return {'text':'{"tool":"agent.finish_task","args":{"summary":"分析完成"}}'}
        self.adapter.model = direct
        self.engine.start(self.run['run_id'])
        self.assertEqual(len((await self.wait_done())['tasks']),1)

    async def test_idempotency_and_project_isolation(self):
        existing,created = self.store.create(self.request,{})
        self.assertFalse(created)
        self.assertEqual(existing['run_id'],self.run['run_id'])
        with self.assertRaises(AgentError):
            self.store.create(self.request.model_copy(update={'goal':'different'}),{})
        with self.assertRaises(AgentError):
            self.store.snapshot(self.run['run_id'],'project_b')
        self.assertEqual(self.store.history('project_b'),[])

    async def test_failed_model_keeps_failure(self):
        async def broken(*args):
            raise ConnectionError('网络中断')
        self.adapter.model = broken
        self.engine.start(self.run['run_id'])
        snap = await self.wait_done()
        self.assertEqual(snap['run']['status'],'failed')
        self.assertIn('网络中断',snap['tasks'][0]['error'])

    async def spawn(self,parent,ident,deps=None,tools=None):
        args={'idempotency_key':ident,'agent_role':ident,'goal':ident,'dependencies':deps or []}
        if tools is not None:
            args['allowed_tools']=tools
        await self.engine.dispatch(self.run['run_id'],parent,ToolCall(tool='agent.spawn_subagent',args=args))
        return next(t for t in self.snapshot()['tasks'] if t['parent_task_id']==parent and t['idempotency_key']==ident)

    async def test_phase2_dependencies_wait_and_independent_jobs_overlap(self):
        root=self.run['root_task_id']
        analysis=await self.spawn(root,'analysis')
        scene=await self.spawn(root,'scene',[analysis['task_id']])
        generation=await self.spawn(root,'generation',[scene['task_id']])
        independent=await self.spawn(root,'independent')
        starts,ends={},{}
        async def worker(run,task,prompt):
            starts[task['task_id']]=asyncio.get_running_loop().time()
            await asyncio.sleep(.20)
            ends[task['task_id']]=asyncio.get_running_loop().time()
            return {'text':'{"tool":"agent.finish_task","args":{"summary":"已完成"}}'}
        self.adapter.model=worker
        # Park the parent until the final dependent result, freeing all three workers.
        await self.engine.dispatch(self.run['run_id'],root,ToolCall(tool='agent.get_subagent_result',args={'task_id':generation['task_id']}))
        self.engine.start(self.run['run_id'])
        await self.wait_done()
        self.assertGreaterEqual(starts[scene['task_id']],ends[analysis['task_id']])
        self.assertGreaterEqual(starts[generation['task_id']],ends[scene['task_id']])
        self.assertLess(starts[independent['task_id']],ends[analysis['task_id']])

    async def test_cancel_propagates_and_starts_no_more_models(self):
        root=self.run['root_task_id']
        await self.spawn(root,'analysis')
        await self.spawn(root,'later')
        began=asyncio.Event()
        async def slow(*args):
            began.set()
            await asyncio.sleep(5)
            return {'text':'{"tool":"agent.finish_task","args":{"summary":"不应完成"}}'}
        self.adapter.model=slow
        self.engine.start(self.run['run_id'])
        await asyncio.wait_for(began.wait(),1)
        await self.engine.cancel(self.run['run_id'],'project_a')
        await asyncio.sleep(.2)
        snap=self.snapshot()
        self.assertEqual(snap['run']['status'],'cancelled')
        self.assertTrue(all(t['status']=='cancelled' for t in snap['tasks']))

    async def test_dependency_cycle_rejected_including_parent_wait(self):
        root=self.run['root_task_id']
        first=await self.spawn(root,'first')
        second=await self.spawn(root,'second',[first['task_id']])
        with self.assertRaisesRegex(AgentError,'循环'):
            await self.engine.dispatch(self.run['run_id'],first['task_id'],ToolCall(tool='agent.spawn_subagent',args={
                'idempotency_key':'nested','agent_role':'nested','goal':'nested','dependencies':[second['task_id']]}))
            child=self.snapshot()['tasks'][-1]
            await self.engine.dispatch(self.run['run_id'],first['task_id'],ToolCall(tool='agent.get_subagent_result',args={'task_id':child['task_id']}))
        with self.assertRaises(AgentError):
            await self.spawn(first['task_id'],'wait-parent',[root])

    async def test_phase3_depth_children_permissions_and_duplicate_guards(self):
        root=self.run['root_task_id']
        first=await self.spawn(root,'first')
        second=await self.spawn(first['task_id'],'second')
        self.assertEqual(second['depth'],2)
        with self.assertRaisesRegex(AgentError,'层级'):
            await self.spawn(second['task_id'],'too-deep')
        with self.assertRaisesRegex(AgentError,'权限'):
            await self.spawn(first['task_id'],'escalation',tools=['canvas.command'])
        count=len(self.snapshot()['tasks'])
        same=await self.spawn(root,'first')
        self.assertEqual(same['task_id'],first['task_id'])
        self.assertEqual(len(self.snapshot()['tasks']),count)
        with self.assertRaises(AgentError):
            await self.engine.dispatch(self.run['run_id'],root,ToolCall(tool='agent.spawn_subagent',args={
                'idempotency_key':'first-other-key','agent_role':'first','goal':'first'}))
        for i in range(5):
            await self.spawn(root,f'bounded-{i}')
        with self.assertRaisesRegex(AgentError,'数量'):
            await self.spawn(root,'too-many')

    async def test_model_call_budget_and_step_ceiling_stop_before_extra_request(self):
        with self.store.transaction() as db:
            run=self.store.get(db,'runs',self.run['run_id'])
            run['limits'].update(max_cost=.5,model_call_cost=1.0)
            self.store.put(db,'runs',run)
        self.engine.start(self.run['run_id'])
        snap=await self.wait_done()
        self.assertEqual(self.adapter.calls,[])
        self.assertIn('预算',snap['tasks'][0]['error'])
        self.assertEqual(snap['run']['estimated_cost'],0)

    async def test_unbounded_invalid_dispatch_stops_at_step_limit(self):
        with self.store.transaction() as db:
            run=self.store.get(db,'runs',self.run['run_id'])
            run['limits'].update(max_steps=2)
            self.store.put(db,'runs',run)
        calls=[]
        async def invalid(*args):
            calls.append(1)
            return {'text':'{"tool":"shell.exec","args":{"command":"no"}}'}
        self.adapter.model=invalid
        self.engine.start(self.run['run_id'])
        snap=await self.wait_done()
        self.assertEqual(len(calls),2)
        self.assertEqual(snap['run']['status'],'failed')

    async def test_sqlite_recovery_preserves_usage_and_requires_explicit_resume(self):
        with self.store.transaction() as db:
            task=self.store.get(db,'tasks',self.run['root_task_id'])
            task['status']='running'
            self.store.put(db,'tasks',task)
            run=self.store.get(db,'runs',self.run['run_id'])
            run['estimated_cost']=2.5
            self.store.put(db,'runs',run)
        reopened=AgentRunStore(self.store.path)
        reopened.recover()
        snapshot=reopened.snapshot(self.run['run_id'],'project_a')
        self.assertTrue(snapshot['run']['recovery_required'])
        self.assertEqual(snapshot['tasks'][0]['status'],'waiting_result')
        self.assertEqual(snapshot['run']['estimated_cost'],2.5)
        self.engine.start(self.run['run_id'])
        await asyncio.sleep(.2)
        self.assertEqual(self.adapter.calls,[])


if __name__ == '__main__':
    unittest.main()
