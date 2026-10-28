"""SKU appearance requests use isolated fake models and keep text templates intact."""
import asyncio
import json
import sys
import unittest
from copy import deepcopy
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from design_brain_store import (
    AgentTaskStore, DesignBrainError, apply_plan_requirements, apply_sku_plan,
    image_requirements, normalize_agent_task,
)
from design_brain_visual_rules import DEFAULT_LAYOUT, sku_series_mode, task_kind
from tests.test_design_brain_bots import DesignBotOrchestratorTestBase, FakeHost, sku_plan
from tests.test_design_brain_batch import BatchHost


FRAME_REQUEST = '做15张相框SKU图，4K，每款使用不同照片组合，框色可选原木色或黑色'


def variant_plan(count=15):
    plan = sku_plan(count)
    plan['visual_framework']['palette'] = ['#F5F1E8', '#C8B69A', '#79736B']
    # A model may include unused default text slots; appearance output does not use them.
    plan['sku_layout'] = deepcopy(DEFAULT_LAYOUT)
    plan['sku_scene'] = '30×30cm正方形相框，米白厚卡纸，45度斜切开窗，照片嵌入内部；原木桌面、固定机位、暖光'
    for i, shot in enumerate(plan['shots']):
        shot.pop('sku_values')
        shot['sku_variant'] = f'{"原木色" if i % 2 == 0 else "黑色"}框，图5至9的生活照组合{i + 1}'
        shot['prompt'] = f'制作第{i + 1}款，{shot["sku_variant"]}，能看见卡纸厚度与开窗阴影，无文字'
    return plan


class SkuModeTest(unittest.TestCase):
    def test_appearance_request_takes_precedence_over_legacy_sku_mode(self):
        brief = {'series_mode': 'sku', 'goal': '15张相框SKU图',
                 'product': {'constraints': ['每款相框选用不同照片组合', '不能平贴表面']}}
        self.assertEqual(sku_series_mode(brief), 'sku_variants')
        self.assertEqual(task_kind(brief), 'sku_variants')
        task = normalize_agent_task({'status': 'failed', 'resume_phase': 'planning', 'brief': brief})
        self.assertEqual(task['brief']['series_mode'], 'sku_variants')
        self.assertEqual(task['resume_phase'], 'planning')
        self.assertEqual(image_requirements(FRAME_REQUEST)['series_mode'], 'sku_variants')

    def test_fixed_text_negation_and_non_sku_tasks_keep_their_mode(self):
        for text in ('SKU只换参数、赠品和属性名', 'SKU不要更换照片，不得替换框色',
                     'SKU照片保持一致，框色不变', 'SKU属性名称改文字，不改变产品颜色'):
            self.assertEqual(sku_series_mode({'goal': text}), 'sku', text)
        self.assertEqual(sku_series_mode({'goal': '做15张相框商品图，不同照片组合'}), '')
        self.assertEqual(sku_series_mode({'deliverables': [{'text': '15张SKU图，不同照片组合'}]}), 'sku_variants')
        self.assertEqual(sku_series_mode({'series_mode': 'sku_variants', 'goal': '整组款式'}), 'sku_variants')

    def test_variants_validate_without_counting_unused_text_slot_colors(self):
        brief = {'goal': FRAME_REQUEST, **image_requirements(FRAME_REQUEST)}
        plan = variant_plan()
        plan['shots'] = apply_plan_requirements(brief, plan['shots'])
        apply_sku_plan(brief, plan, compose=True)
        self.assertEqual(len(plan['shots']), 15)
        self.assertEqual(plan['sku_layout'], {})
        self.assertEqual(len(plan['visual_framework']['palette']), 3)
        self.assertTrue(all(s['size'] == '4096x4096' for s in plan['shots']))
        self.assertTrue(all(s['sku_variant'] in s['prompt'] for s in plan['shots']))
        self.assertTrue(all('45度斜切' in s['prompt'] for s in plan['shots']))

    def test_variants_require_scene_per_shot_appearance_and_same_size(self):
        for invalid in ('scene', 'variant', 'size', 'palette'):
            plan = variant_plan(2)
            if invalid == 'scene':
                plan['sku_scene'] = ''
            elif invalid == 'variant':
                plan['shots'][1]['sku_variant'] = ''
            elif invalid == 'size':
                plan['shots'][1]['size'] = '1024x1536'
            else:
                plan['visual_framework']['palette'].append('#FF0000')
            with self.subTest(invalid=invalid), self.assertRaises(DesignBrainError):
                apply_sku_plan({'series_mode': 'sku_variants'}, plan, compose=True)

    def test_fixed_template_color_identity_ignores_hex_case_and_still_limits_colors(self):
        plan = sku_plan()
        plan['visual_framework']['palette'].append('#ABCDEF')
        plan['sku_layout'] = deepcopy(DEFAULT_LAYOUT)
        for slot in plan['sku_layout'].values():
            slot['background'] = '#f5f1e8'
        apply_sku_plan({'series_mode': 'sku'}, plan)
        self.assertEqual(len(plan['visual_framework']['palette']), 3)
        plan['sku_layout']['gifts']['background'] = '#123456'
        with self.assertRaisesRegex(DesignBrainError, '合计不得超过3种'):
            apply_sku_plan({'series_mode': 'sku'}, plan)


class SkuVariantFlowTest(DesignBotOrchestratorTestBase):
    def test_fifteen_4k_variants_plan_confirm_generate_and_review(self):
        host = FakeHost(planner=variant_plan(), task_flow=['succeeded'])
        orch = self.make_orchestrator(host)

        async def scenario():
            result = await orch.chat(task_id='', message=FRAME_REQUEST,
                product_images=[f'/assets/ref-{i}.png' for i in range(1, 10)],
                models=self.chat_models(), auto_confirm=False)
            task = await self.drive_until(orch, result['task_id'], {'awaiting_confirmation', 'failed'})
            self.assertEqual(task['status'], 'awaiting_confirmation', task['error'])
            self.assertEqual(task['brief']['series_mode'], 'sku_variants')
            self.assertEqual(len(task['plan']['shots']), 15)
            self.assertFalse(host.created)
            orch.tasks.patch(task['id'], lambda t: t.update(status='executing'))
            task = await self.drive_until(orch, task['id'], {'delivered', 'failed'}, timeout=30)
            self.assertEqual(task['status'], 'delivered', task['error'])
            self.assertEqual(len(host.created), 15)
            self.assertEqual(task['usage']['image_calls'], 15)
            self.assertEqual(len({s['outputs'][0]['url'] for s in task['execution']['shots']}), 15)
            self.assertEqual(task['execution']['sku_anchor_url'], '')
            anchor = task['execution']['visual_anchor_url']
            self.assertEqual(anchor, '/assets/out-ct_1.png')
            for i, payload in enumerate(host.created):
                self.assertEqual(payload.size, '4096x4096')
                self.assertEqual(payload.resolution, '4k')
                self.assertIn(f'生活照组合{i + 1}', payload.prompt)
                self.assertEqual(len(payload.reference_images), 9 if i == 0 else 10)
                if i:
                    self.assertEqual(payload.reference_images[-1].url, anchor)
            self.assertEqual(len(task['reviews']), 15)
            reviews = [p for p in host.llm_payloads if '质量检查 BOT' in p.system_prompt]
            for payload in reviews:
                message = json.loads(payload.message)
                self.assertEqual(message['SKU制作方式'], 'sku_variants')
                self.assertIn('生活照组合', message['SKU本款外观'])
                # 图片顺序与比较要求现在是结构化清单（图号 → 用途），
                # “以本款方案为准、允许已确认外观变化”的判定口径在审核系统提示里。
                manifest = message['图片顺序与比较要求']
                self.assertTrue(manifest)
                self.assertEqual(manifest[0], {'image': 1, 'role': '待审核产物'})
                self.assertIn('本款方案', payload.system_prompt)
            restored = AgentTaskStore(self._tmp.name).get(task['id'])
            self.assertEqual(restored['brief']['series_mode'], 'sku_variants')
            self.assertEqual(len(restored['execution']['shots']), 15)

        asyncio.run(scenario())

    def test_failed_scene_anchor_stops_remaining_variants(self):
        host = FakeHost(planner=variant_plan(2), task_flow=['queued', 'failed'])
        orch = self.make_orchestrator(host)

        async def scenario():
            result = await orch.chat(task_id='', message='做2张SKU图，每款不同照片组合',
                product_images=[], models=self.chat_models(), auto_confirm=True)
            task = await self.drive_until(orch, result['task_id'], {'delivered', 'failed'})
            self.assertEqual(task['status'], 'failed')
            self.assertEqual(len(host.created), 1)
            self.assertIn('基准生成失败', task['error'])

        asyncio.run(scenario())

    def test_batched_variants_share_scene_and_keep_distinct_appearances(self):
        host = BatchHost(18)
        host.plan = variant_plan(18)
        orch = self.make_orchestrator(host)

        async def scenario():
            result = await orch.chat(task_id='', message='做18张SKU图，每款不同照片组合',
                product_images=[], models=self.chat_models(), auto_confirm=False)
            task = await self.drive_until(orch, result['task_id'], {'awaiting_confirmation', 'failed'})
            self.assertEqual(task['status'], 'awaiting_confirmation', task['error'])
            self.assertEqual([(b['start'], b['end']) for b in host.batches], [(1, 16), (17, 18)])
            self.assertEqual(len({s['sku_variant'] for s in task['plan']['shots']}), 18)
            self.assertTrue(all(task['plan']['sku_scene'] in s['prompt'] for s in task['plan']['shots']))

        asyncio.run(scenario())
