import tempfile
import unittest
from unittest.mock import AsyncMock, patch

from fastapi import HTTPException
from starlette.requests import Request

import main
from project_agent_store import ProjectAgentStore


def local_request(remote=False, gateway=False):
    host = '192.0.2.10' if remote else '127.0.0.1'
    headers = [(b'host',b'127.0.0.1:3000')]
    if gateway: headers.append((b'x-xiaomei-share-gateway', b'1'))
    return Request({'type':'http','method':'POST','path':'/', 'scheme':'http',
                    'query_string':b'', 'headers':headers,
                    'client':(host,12345), 'server':('127.0.0.1',3000)})


class ProjectAgentApiTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.store = ProjectAgentStore(self.temp.name)
        self.canvases = {
            'canvas_a': {'id':'canvas_a','project':'project_a','updated_at':1,
                         'nodes':[{'id':'image_a','type':'smart-upload','images':[{'url':'/assets/test-a.png'}]}], 'connections':[]},
            'canvas_b': {'id':'canvas_b','project':'project_a','updated_at':1,
                         'nodes':[{'id':'image_b','type':'smart-upload','images':[{'url':'/assets/test-b.png'}]}], 'connections':[]},
        }
        patches = [patch.object(main,'PROJECT_AGENT_STORE',self.store),
                   patch.object(main,'ensure_default_project',return_value=[{'id':'project_a','name':'A'},{'id':'project_b','name':'B'}]),
                   patch.object(main,'load_canvas',side_effect=lambda canvas_id: self.canvases[canvas_id])]
        for item in patches:
            item.start(); self.addCleanup(item.stop)

    async def test_local_rule_cache_feedback_and_project_isolation(self):
        payload = main.ProjectAgentAnalyzeInput(project_id='project_a',canvas_id='canvas_a',canvas_revision=1,trigger='assets_added',event_ids=['evt-01'])
        with patch.object(main,'canvas_llm',new=AsyncMock(side_effect=AssertionError('default must stay local'))) as model:
            first = await main.project_agent_analyze(payload,local_request())
            cached = await main.project_agent_analyze(payload,local_request())
            self.assertEqual(model.await_count,0)
        self.assertEqual(first['suggestion']['id'],cached['suggestion']['id'])
        self.assertEqual(self.store.read('project_b')['memories'],[])
        feedback = main.ProjectAgentFeedbackInput(project_id='project_a',canvas_id='canvas_a',action='accept',option_key='detail_page',expected_canvas_revision=1,idempotency_key='feedback-01')
        result = await main.project_agent_suggestion_feedback(first['suggestion']['id'],feedback,local_request())
        self.assertTrue(result['plan_mode'])
        self.assertEqual(self.store.read('project_a')['memories'][0]['text'],'商品详情页')
        self.assertEqual(self.store.read('project_b')['memories'],[])
        duplicate = await main.project_agent_suggestion_feedback(first['suggestion']['id'],feedback,local_request())
        self.assertEqual(duplicate,result)

    async def test_moved_or_changed_canvas_and_remote_visitor_are_rejected(self):
        payload = main.ProjectAgentAnalyzeInput(project_id='project_b',canvas_id='canvas_a',canvas_revision=1,trigger='assets_added')
        with self.assertRaises(HTTPException) as mismatch:
            await main.project_agent_analyze(payload,local_request())
        self.assertEqual(mismatch.exception.status_code,403)
        payload.project_id = 'project_a'
        payload.canvas_id = '../canvas_a'
        with self.assertRaises(HTTPException) as invalid:
            await main.project_agent_analyze(payload,local_request())
        self.assertEqual(invalid.exception.status_code,422)
        payload.canvas_id = 'canvas_a'
        with self.assertRaises(HTTPException) as visitor:
            await main.project_agent_analyze(payload,local_request(remote=True))
        self.assertEqual(visitor.exception.status_code,403)
        first = await main.project_agent_analyze(payload,local_request())
        self.canvases['canvas_a']['updated_at'] = 2
        feedback = main.ProjectAgentFeedbackInput(project_id='project_a',canvas_id='canvas_a',action='accept',option_key='main_image',expected_canvas_revision=1,idempotency_key='feedback-02')
        with self.assertRaises(HTTPException) as stale:
            await main.project_agent_suggestion_feedback(first['suggestion']['id'],feedback,local_request())
        self.assertEqual(stale.exception.status_code,409)
        self.assertEqual(self.store.read('project_a')['memories'],[])

    async def test_shared_project_goal_and_live_canvas_progress(self):
        self.store.add_memory('project_a','goal','做 8 屏详情页','canvas_a')
        self.store.add_memory('project_a','todo','检查卖点','canvas_a')
        self.canvases['canvas_a']['nodes'].append({'id':'paint_a','type':'smart-paint','images':[{'url':'/output/1.png'},{'url':'/output/2.png'},{'url':'/output/3.png'}]})
        a1 = await main.project_agent_state('project_a',local_request(),'canvas_a')
        a2 = await main.project_agent_state('project_a',local_request(),'canvas_b')
        other = await main.project_agent_state('project_b',local_request())
        self.assertEqual(a1['progress']['result_count'],3)
        self.assertEqual(a1['progress']['stage'],'reviewing')
        self.assertEqual(a2['progress']['goal'],'做 8 屏详情页')
        self.assertEqual(a2['progress']['result_count'],0)
        self.assertEqual(other['memories'],[])
        self.assertNotIn('completed',str(a1['progress']))

    async def test_reopen_with_goal_and_todo_is_local_and_dismissed_suggestion_stays_quiet(self):
        self.store.add_memory('project_a','goal','制作相框详情页','canvas_a')
        self.store.add_memory('project_a','todo','检查卖点','canvas_a')
        payload = main.ProjectAgentAnalyzeInput(project_id='project_a',canvas_id='canvas_a',canvas_revision=1,trigger='canvas_opened')
        with patch.object(main,'canvas_llm',new=AsyncMock(side_effect=AssertionError('must stay local'))) as model:
            first = await main.project_agent_analyze(payload,local_request())
            self.assertEqual(model.await_count,0)
        self.assertEqual(first['suggestion']['suggestion']['title'],'接着做')
        feedback = main.ProjectAgentFeedbackInput(project_id='project_a',canvas_id='canvas_a',action='dismiss',expected_canvas_revision=1,idempotency_key='dismiss-reopen')
        await main.project_agent_suggestion_feedback(first['suggestion']['id'],feedback,local_request())
        repeat = await main.project_agent_analyze(payload,local_request())
        self.assertIsNone(repeat['suggestion'])
        self.assertEqual(repeat['reason'],'dismissed')

    async def test_global_off_disables_automatic_suggestions(self):
        self.store.set_global(False,0)
        payload = main.ProjectAgentAnalyzeInput(project_id='project_a',canvas_id='canvas_a',canvas_revision=1,trigger='assets_added')
        with patch.object(main,'canvas_llm',new=AsyncMock(side_effect=AssertionError('must not call'))) as model:
            result = await main.project_agent_analyze(payload,local_request())
            self.assertIsNone(result['suggestion'])
            self.assertEqual(model.await_count,0)
        self.assertEqual(result['reason'],'disabled')

    async def test_changed_canvas_drops_in_flight_model_result(self):
        self.store.update('project_a',lambda state: state['settings'].update(allow_model_analysis=True,provider='provider',model='model'))
        async def changed(_):
            self.canvases['canvas_a']['updated_at'] = 2
            return {'text':'{"kind":"main_image","confidence":"high"}'}
        with patch.object(main,'get_api_provider_exact',return_value={'chat_models':['model']}), \
             patch.object(main,'canvas_llm',new=AsyncMock(side_effect=changed)):
            result = await main.project_agent_analyze(main.ProjectAgentAnalyzeInput(project_id='project_a',canvas_id='canvas_a',canvas_revision=1,trigger='assets_added'),local_request())
        self.assertIsNone(result['suggestion'])
        self.assertEqual(result['reason'],'stale')


    async def test_share_gateway_is_denied_even_over_loopback(self):
        payload = main.ProjectAgentAnalyzeInput(project_id='project_a',canvas_id='canvas_a',canvas_revision=1,trigger='assets_added')
        with self.assertRaises(HTTPException) as visitor:
            await main.project_agent_analyze(payload,local_request(gateway=True))
        self.assertEqual(visitor.exception.status_code,403)

    async def test_restore_rejects_original_revision_after_a_save(self):
        payload = main.ProjectAgentAnalyzeInput(project_id='project_a',canvas_id='canvas_a',canvas_revision=1,trigger='assets_added')
        suggestion = (await main.project_agent_analyze(payload,local_request()))['suggestion']
        feedback = main.ProjectAgentFeedbackInput(project_id='project_a',canvas_id='canvas_a',action='dismiss',expected_canvas_revision=1,idempotency_key='dismiss-01')
        await main.project_agent_suggestion_feedback(suggestion['id'],feedback,local_request())
        self.canvases['canvas_a']['updated_at'] = 2
        restore = main.ProjectAgentRestoreInput(project_id='project_a',canvas_id='canvas_a',expected_canvas_revision=2,idempotency_key='restore-01')
        with self.assertRaises(HTTPException) as stale:
            await main.project_agent_restore_suggestion(suggestion['id'],restore,local_request())
        self.assertEqual(stale.exception.status_code,409)

    async def test_global_switch_cycle_invalidates_in_flight_model_result(self):
        self.store.update('project_a',lambda state: state['settings'].update(allow_model_analysis=True,provider='provider',model='model'))
        async def switched(_):
            self.store.set_global(False,0)
            self.store.set_global(True,1)
            return {'text':'{"kind":"main_image","confidence":"high"}'}
        with patch.object(main,'get_api_provider_exact',return_value={'chat_models':['model']}), \
             patch.object(main,'canvas_llm',new=AsyncMock(side_effect=switched)):
            result = await main.project_agent_analyze(main.ProjectAgentAnalyzeInput(project_id='project_a',canvas_id='canvas_a',canvas_revision=1,trigger='assets_added'),local_request())
        self.assertIsNone(result['suggestion'])
        self.assertEqual(result['reason'],'stale')

    async def test_memory_edit_invalidates_in_flight_model_result(self):
        self.store.update('project_a',lambda state: state['settings'].update(allow_model_analysis=True,provider='provider',model='model'))
        async def corrected(_):
            self.store.add_memory('project_a','goal','先整理素材','canvas_a')
            return {'text':'{"kind":"main_image","confidence":"high"}'}
        with patch.object(main,'get_api_provider_exact',return_value={'chat_models':['model']}), \
             patch.object(main,'canvas_llm',new=AsyncMock(side_effect=corrected)):
            result = await main.project_agent_analyze(main.ProjectAgentAnalyzeInput(project_id='project_a',canvas_id='canvas_a',canvas_revision=1,trigger='assets_added'),local_request())
        self.assertIsNone(result['suggestion'])
        self.assertEqual(result['reason'],'stale')
        self.assertEqual(self.store.read('project_a')['memories'][0]['text'],'先整理素材')

    async def test_model_analysis_requires_explicit_consent_and_known_model(self):
        payload = main.ProjectAgentSettingsInput(expected_revision=0,proactive_enabled=True,paused=False,
            frequency='standard',allow_model_analysis=True,allow_image_analysis=False,daily_limit=20,
            provider='provider',model='model')
        with self.assertRaises(HTTPException) as consent:
            await main.project_agent_update_settings('project_a',payload,local_request())
        self.assertEqual(consent.exception.status_code,403)
        payload.consent = True
        with patch.object(main,'get_api_provider_exact',return_value={'chat_models':['other']}):
            with self.assertRaises(HTTPException) as unknown:
                await main.project_agent_update_settings('project_a',payload,local_request())
        self.assertEqual(unknown.exception.status_code,422)
        self.assertFalse(self.store.read('project_a')['settings']['allow_model_analysis'])
        with patch.object(main,'get_api_provider_exact',return_value={'chat_models':['model']}):
            saved = await main.project_agent_update_settings('project_a',payload,local_request())
        self.assertTrue(saved['settings']['allow_model_analysis'])

    async def test_model_timeout_falls_back_to_local_suggestion(self):
        self.store.update('project_a',lambda state: state['settings'].update(allow_model_analysis=True,provider='provider',model='model'))
        with patch.object(main,'get_api_provider_exact',return_value={'chat_models':['model']}), \
             patch.object(main,'canvas_llm',new=AsyncMock(side_effect=TimeoutError('offline'))):
            result = await main.project_agent_analyze(main.ProjectAgentAnalyzeInput(project_id='project_a',canvas_id='canvas_a',canvas_revision=1,trigger='assets_added'),local_request())
        self.assertEqual(result['suggestion']['suggestion']['kind'],'local')
        self.assertEqual(result['suggestion']['status'],'ready')

    async def test_opt_in_model_call_obeys_daily_budget(self):
        self.store.update('project_a',lambda state: state['settings'].update(allow_model_analysis=True,provider='provider',model='model',daily_limit=1))
        with patch.object(main,'get_api_provider_exact',return_value={'chat_models':['model']}), \
             patch.object(main,'canvas_llm',new=AsyncMock(return_value={'text':'{"kind":"detail_page","confidence":"medium"}'})) as model:
            first = await main.project_agent_analyze(main.ProjectAgentAnalyzeInput(project_id='project_a',canvas_id='canvas_a',canvas_revision=1,trigger='assets_added',mode='manual'),local_request())
            second = await main.project_agent_analyze(main.ProjectAgentAnalyzeInput(project_id='project_a',canvas_id='canvas_b',canvas_revision=1,trigger='assets_added',mode='manual'),local_request())
            self.assertEqual(model.await_count,1)
        self.assertEqual(self.store.read('project_a')['analysis']['count'],1)
        self.assertEqual(first['suggestion']['suggestion']['title'],'要做详情页吗？')
        self.assertEqual(second['suggestion']['suggestion']['kind'],'local')


if __name__ == '__main__':
    unittest.main()
