"""Large design tasks use real orchestration with isolated stores and fake models."""
import asyncio
import json
import sys
from copy import deepcopy
from unittest.mock import patch
import os
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from tests.test_design_brain_bots import DesignBotOrchestratorTestBase, FakeHost, PLANNER_TWO_SHOTS, sku_plan
from design_brain_store import AgentTaskStore, image_requirements
from design_brain_store import DesignRunStore
from tests.image_resolution_support import image_params_namespace


class BatchHost(FakeHost):
    def __init__(self, count, *, sku=False, fail_batch=False):
        super().__init__(task_flow=['succeeded'])
        self.plan = sku_plan(count) if sku else {
            **deepcopy(PLANNER_TWO_SHOTS), 'shots': [
                {**PLANNER_TWO_SHOTS['shots'][0], 'id': f'shot_{i + 1}', 'purpose': f'商品图{i + 1}'}
                for i in range(count)]}
        self.batches = []
        self.fail_batch = fail_batch
        self.active = self.peak = 0
        self.in_flight = set()
        self.resolve_image_generation_params = image_params_namespace()['resolve_image_generation_params']

    async def canvas_llm(self, payload):
        marker = '本次规划批次（JSON）：'
        if marker in payload.system_prompt:
            batch = json.loads(payload.system_prompt.split(marker, 1)[1].split('\n', 1)[0])
            self.batches.append(batch)
            self.planner = deepcopy(self.plan)
            self.planner['shots'] = self.planner['shots'][batch['start'] - 1:batch['end']]
            if self.fail_batch and batch['start'] > 1:
                self.planner['shots'] = self.planner['shots'][:1]
        return await super().canvas_llm(payload)

    async def create_canvas_image_task(self, payload):
        self.active += 1
        self.peak = max(self.peak, self.active)
        await asyncio.sleep(.001)
        result = await super().create_canvas_image_task(payload)
        self.in_flight.add(result['task_id'])
        return result

    async def get_canvas_image_task(self, task_id):
        result = await super().get_canvas_image_task(task_id)
        if task_id in self.in_flight and result['status'] == 'succeeded':
            self.in_flight.remove(task_id)
            self.active -= 1
        return result


class DesignBrainBatchTest(DesignBotOrchestratorTestBase):
    def test_hundred_images_plan_persist_generate_and_review_without_total_caps(self):
        host = BatchHost(100)
        orch = self.make_orchestrator(host)
        async def scenario():
            result = await orch.chat(task_id='', message='生成100张商品图，2K', product_images=[],
                                     models=self.chat_models(), auto_confirm=False)
            ident = result['task_id']
            task = await self.drive_until(orch, ident, {'awaiting_confirmation', 'failed'}, timeout=60)
            self.assertEqual(task['status'], 'awaiting_confirmation', task['error'])
            self.assertEqual([(b['start'], b['end']) for b in host.batches],
                             [(1,16), (17,32), (33,48), (49,64), (65,80), (81,96), (97,100)])
            self.assertFalse(host.created)
            self.assertEqual(len(AgentTaskStore(self._tmp.name).get(ident)['plan']['shots']), 100)
            self.assertEqual(len({shot['id'] for shot in task['plan']['shots']}), 100)
            self.assertTrue(all(s['resolution'] == '2k' and s['size'] == '2048x2048' for s in task['plan']['shots']))
            orch.tasks.patch(ident, lambda t: t.update(status='executing'))
            task = await self.drive_until(orch, ident, {'delivered', 'failed'}, timeout=90)
            self.assertEqual(task['status'], 'delivered', task['error'])
            self.assertEqual(len(host.created), 100, {
                'revisions': task['usage']['auto_revisions'],
                'repeated_ids': [p.client_request_id for p in host.created if sum(
                    other.client_request_id == p.client_request_id for other in host.created) > 1],
                'events': task['events'][-8:],
            })
            self.assertLessEqual(host.peak, 3)
            self.assertTrue(all(p.resolution == '2k' and p.size == '2048x2048' for p in host.created))
            self.assertEqual(len(task['execution']['shots']), 100)
            self.assertEqual(len(task['reviews']), 100)
            self.assertEqual(task['usage']['image_calls'], 100)
            self.assertGreater(task['usage']['llm_calls'], 100)
            restored = AgentTaskStore(self._tmp.name).get(ident)
            self.assertEqual(len(restored['execution']['shots']), 100)
            self.assertEqual(len(restored['reviews']), 100)
        asyncio.run(scenario())

    def test_missing_later_batch_keeps_partial_plan_and_never_generates(self):
        host = BatchHost(60, fail_batch=True)
        orch = self.make_orchestrator(host)
        async def scenario():
            result = await orch.chat(task_id='', message='生成60张商品图，4K', product_images=[],
                                     models=self.chat_models(), auto_confirm=True)
            task = await self.drive_until(orch, result['task_id'], {'failed', 'awaiting_confirmation'}, timeout=60)
            self.assertEqual(task['status'], 'failed')
            self.assertEqual(task['brief']['image_count'], 60)
            self.assertEqual(len(task['plan']['shots']), 16)
            self.assertFalse(host.created)
        asyncio.run(scenario())

    def test_fifty_skus_share_first_batch_scene_and_distinct_products(self):
        host = BatchHost(50, sku=True)
        orch = self.make_orchestrator(host)
        async def scenario():
            result = await orch.chat(task_id='', message='做50张相框SKU展示图，4K，同场景只变商品', product_images=[],
                                     models=self.chat_models(), auto_confirm=False)
            task = await self.drive_until(orch, result['task_id'], {'awaiting_confirmation', 'failed'}, timeout=60)
            self.assertEqual(task['status'], 'awaiting_confirmation', task['error'])
            self.assertEqual(len(task['plan']['shots']), 50)
            scene = task['plan']['sku_scene']
            self.assertTrue(all(scene in shot['prompt'] for shot in task['plan']['shots']))
            self.assertEqual(len({shot['sku_variant'] for shot in task['plan']['shots']}), 50)
            self.assertFalse(host.created)
        asyncio.run(scenario())

    def test_chinese_quantities_and_large_usage_counters_are_preserved(self):
        for phrase, count in [('一百张',100), ('六十张',60), ('一千零五张',1005)]:
            self.assertEqual(image_requirements(phrase)['image_count'], count)
        task = self.tasks_store.create({'usage': {'image_calls': 2000, 'llm_calls': 4000}})
        self.assertEqual(task['usage']['image_calls'], 2000)
        self.assertEqual(task['usage']['llm_calls'], 4000)

    def test_run_keeps_all_hundred_outputs_and_remains_idempotent(self):
        store = DesignRunStore(self._tmp.name)
        run = store.create({'title': '批量主图'})
        for i in range(100):
            store.note_task(run['id'], {'task_id': f'image_{i}', 'status': 'succeeded',
                'model': 'fixture', 'history_timestamp': i + 1,
                'asset_refs': [{'url': f'/assets/image_{i}.png'}]})
        restored = DesignRunStore(self._tmp.name).get(run['id'])
        self.assertEqual(len(restored['execution']['canvas_task_ids']), 100)
        self.assertEqual(len(restored['execution']['asset_refs']), 100)
        store.note_task(run['id'], {'task_id': 'image_0', 'status': 'succeeded',
            'asset_refs': [{'url': '/assets/image_0.png'}]})
        self.assertEqual(len(store.get(run['id'])['execution']['canvas_task_ids']), 100)

    def test_windows_sharing_conflict_retries_the_same_atomic_save(self):
        task = self.tasks_store.create({'title': '保存前'})
        replace = os.replace
        attempts = []
        def temporarily_locked(source, target):
            attempts.append(source)
            if len(attempts) <= 2:
                raise PermissionError('Windows sharing conflict')
            return replace(source, target)
        with patch('design_brain_store.os.replace', side_effect=temporarily_locked), \
             patch('design_brain_store.time.sleep'):
            self.tasks_store.patch(task['id'], lambda t: t.update(title='保存完成'))
        self.assertEqual(len(attempts), 3)
        self.assertEqual(len(set(attempts)), 1)
        self.assertEqual(self.tasks_store.get(task['id'])['title'], '保存完成')

    def test_persistent_save_failure_keeps_the_previous_record(self):
        task = self.tasks_store.create({'title': '原始任务'})
        with patch('design_brain_store.os.replace', side_effect=PermissionError('blocked')) as replace, \
             patch('design_brain_store.time.sleep'):
            with self.assertRaises(PermissionError):
                self.tasks_store.patch(task['id'], lambda t: t.update(title='未保存'))
            self.assertEqual(replace.call_count, 7)
        self.assertEqual(self.tasks_store.get(task['id'])['title'], '原始任务')
        self.assertFalse(list(self.tasks_store.root.glob('.agent-tasks-*.json')))
