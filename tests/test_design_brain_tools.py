"""设计大脑工具集测试（P3）。

不调用真实模型与生图：宿主全部用假实现，参考库/档案用临时目录。
覆盖：工具可见性、参考检索、方案生成、生图提交与轮询、质检、
团队工具权限、任务确认/取消，以及回合引擎经工具箱的分发。
"""
import asyncio
import sys
import tempfile
import unittest
import json
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

try:
    from design_brain_store import DesignProfileStore, ReferenceItemStore
    from design_brain_store import apply_plan_requirements, apply_sku_plan
    from tests.test_design_brain_bots import sku_plan
    from design_brain_team import TeamStore
    from design_brain_tools import DesignToolbox, TOOL_SPECS
    from design_brain_turns import TurnEngine
except ImportError as exc:  # pragma: no cover
    raise unittest.SkipTest(f"design_brain_tools 依赖不可用：{exc}") from exc


class FakeRequest:
    def __init__(self, **kwargs):
        self.__dict__.update(kwargs)


class FakeAIReference:
    def __init__(self, **kwargs):
        self.__dict__.update(kwargs)


class FakeOnlineImageRequest:
    def __init__(self, **kwargs):
        self.__dict__.update(kwargs)


class FakeHost:
    CanvasLLMRequest = FakeRequest
    AIReference = FakeAIReference
    OnlineImageRequest = FakeOnlineImageRequest

    def __init__(self, replies=None):
        self.replies = list(replies or [])
        self.calls = []
        self.image_payloads = []
        self.image_tasks = {}

    async def canvas_llm(self, payload):
        self.calls.append(payload)
        text = self.replies.pop(0) if self.replies else "{}"
        return {"text": text}

    async def create_canvas_image_task(self, payload):
        self.image_payloads.append(payload)
        task_id = f"img_{len(self.image_payloads)}"
        self.image_tasks[task_id] = {
            "status": "succeeded",
            "result": {"image_items": [{"url": f"/output/{task_id}.png"}]},
        }
        return {"task_id": task_id}

    async def get_canvas_image_task(self, task_id):
        return self.image_tasks.get(task_id, {"status": "failed", "error": "missing"})


class FakeTaskStore:
    def __init__(self, task):
        self.task = task
        self.patches = 0

    def get(self, task_id):
        return self.task

    def patch(self, task_id, change):
        change(self.task)
        self.patches += 1
        return self.task


class FakeOrchestrator:
    def __init__(self, task=None):
        self.tasks = FakeTaskStore(task or {
            "id": "job_1", "status": "awaiting_confirmation",
            "plan": {"shots": [{"id": "shot_1", "prompt": "旧提示词", "size": "1024x1024"}]},
            "events": [],
        })
        self.started = []
        self.cancelled = []

    def start(self, task_id):
        self.started.append(task_id)

    async def confirm_task(self, task_id, payload):
        """按真实编排器的契约确认方案。

        ``brain.task.confirm`` 现在委托给 ``orchestrator.confirm_task``（见
        design_brain_tools._brain_task_confirm），所以替身必须保留同样的校验：
        张数不符、同组 SKU 尺寸不一致都要在启动前拒绝。
        """
        task = self.tasks.task
        if not payload.approved:
            self.cancelled.append((task_id, "用户拒绝了方案"))
            return task
        brief = task.get("brief") or {}
        plan = task.get("plan") or {}
        edits = {str(edit.get("id") or ""): edit for edit in payload.shot_edits if isinstance(edit, dict)}
        shots = plan.get("shots") or []
        for shot in shots:
            edit = edits.get(shot.get("id"), {})
            for key in ("prompt", "negative", "size"):
                if key in edit:
                    shot[key] = edit[key]
        plan["shots"] = apply_plan_requirements(brief, shots)
        apply_sku_plan(brief, plan)
        self.start(task_id)
        return task

    async def cancel(self, task_id, reason):
        self.cancelled.append((task_id, reason))
        return {"status": "cancelled"}


def bot(capabilities, is_main=False):
    return {
        "id": "bot_director" if is_main else "bot_planner",
        "name": "设计总监" if is_main else "设计规划",
        "is_main": is_main,
        "capabilities": capabilities,
        "model": {"provider": "p", "model": "m"},
        "vision_model": {"provider": "p", "model": "m"},
        "image_model": {"provider": "ip", "model": "im"},
    }


CHAT = {
    "id": "dm_bot_planner", "kind": "dm", "bot_id": "bot_planner", "members": ["bot_planner"],
    "defaults": {"chat": {"provider": "p", "model": "m"},
                 "vision": {"provider": "p", "model": "m"},
                 "image": {"provider": "ip", "model": "im"}},
}


class ToolboxTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.team = TeamStore(self.temp.name)
        self.team.ensure_seeded()
        self.profile = DesignProfileStore(self.temp.name)
        self.profile.update({"aesthetics": {
            "style_tags": [{"tag": "极简", "weight": 0.8}],
            "composition": [{"tag": "居中", "weight": 0.6}],
        }, "tone": {"brand_words": ["高级"], "banned_words": ["土味"]}})
        self.references = ReferenceItemStore(self.temp.name)
        item = self.references.create({
            "hash": "a" * 64, "title": "浅灰底木作",
            "file": {"media": "media/aa/x.jpg", "name": "wood.jpg"},
            "classification": {"category": "家居", "purpose": "主图", "tags": ["浅灰"]},
        })
        self.references.set_analysis(item["id"], "ready", provider="p", model="m",
                                     content={"purpose": "主图", "material": "胡桃木", "lighting": "柔光"})
        self.orchestrator = FakeOrchestrator()
        self.host = FakeHost()

    def tearDown(self):
        self.temp.cleanup()

    def _toolbox(self):
        return DesignToolbox(self.host, self.team, self.orchestrator, self.profile, self.references)

    def test_availability_and_describe(self):
        toolbox = self._toolbox()
        names = toolbox.available(bot(["pack.read", "pack.plan"]))
        self.assertIn("brain.references.search", names)
        self.assertIn("brain.plan.compose", names)
        self.assertNotIn("brain.generate.submit", names)
        self.assertIn("brain.references.search", toolbox.describe(bot(["pack.read"])))
        # 空数组参数（capabilities/members）不能把提示生成炸掉
        self.assertIn("brain.team.create_bot", toolbox.describe(bot(["pack.team"])))
        self.assertEqual(len(TOOL_SPECS), 14)

    def test_profile_read_and_reference_search(self):
        toolbox = self._toolbox()
        result, ok = asyncio.run(toolbox.invoke("brain.profile.read", {}, bot=bot(["pack.read"]), chat=CHAT, group=None))
        self.assertTrue(ok)
        self.assertEqual(result["aesthetics"]["style_tags"][0]["tag"], "极简")
        result, ok = asyncio.run(toolbox.invoke("brain.references.search", {"query": "浅灰"},
                                                bot=bot(["pack.read"]), chat=CHAT, group=None))
        self.assertTrue(ok)
        self.assertEqual(result["total"], 1)
        self.assertEqual(result["items"][0]["analysis"]["material"], "胡桃木")

    def test_permission_denied(self):
        toolbox = self._toolbox()
        result, ok = asyncio.run(toolbox.invoke("brain.generate.submit", {"prompt": "x"},
                                                bot=bot(["pack.read"]), chat=CHAT, group=None))
        self.assertFalse(ok)
        self.assertIn("没有该工具权限", result["error"])

    def test_plan_compose(self):
        self.host.replies = ['{"direction":"浅灰极简","rationale":"档案偏好","constraints_locked":["深胡桃色"],'
                             '"flexible":["背景"],"acceptance":["结构完整"],'
                             '"shots":[{"id":"shot_1","kind":"main_image","purpose":"主图",'
                             '"prompt":"胡桃木相框居中，浅灰底","negative":"金色","size":"1024x1024",'
                             '"acceptance":["四角完整"]}]}']
        toolbox = self._toolbox()
        result, ok = asyncio.run(toolbox.invoke("brain.plan.compose", {"brief": "相框商品图", "shot_count": 1},
                                                bot=bot(["pack.plan"]), chat=CHAT, group=None))
        self.assertTrue(ok, result)
        self.assertEqual(result["shots"][0]["prompt"], "胡桃木相框居中，浅灰底")
        self.assertEqual(result["shots"][0]["size"], "1024x1024")

    def test_plan_compose_preserves_fifteen_4k_shots(self):
        self.host.replies = [json.dumps({'shots': [
            {'id': f'shot_{i}', 'prompt': f'相框角度{i}', 'size': '1024x1024'} for i in range(15)]})]
        result, ok = asyncio.run(self._toolbox().invoke('brain.plan.compose',
            {'brief': '生成15张4K相框图', 'shot_count': 2}, bot=bot(['pack.plan']), chat=CHAT, group=None))
        self.assertTrue(ok, result)
        self.assertEqual(len(result['shots']), 15)
        self.assertTrue(all(s['size'] == '4096x4096' for s in result['shots']))

    def test_plan_compose_rejects_missing_shots(self):
        self.host.replies = [json.dumps({'shots': [{'id': 'one', 'prompt': '相框'}]})] * 2
        result, ok = asyncio.run(self._toolbox().invoke('brain.plan.compose',
            {'brief': '生成15张相框图'}, bot=bot(['pack.plan']), chat=CHAT, group=None))
        self.assertFalse(ok)
        self.assertIn('15', result['error'])

    def test_sku_compose_requires_common_scene_and_only_varies_product(self):
        self.host.replies = [json.dumps({
            "sku_scene": "米白墙与原木桌面，固定花瓶，正面柔光",
            "visual_framework": sku_plan()["visual_framework"],
            "shots": [{"id": f"s{i}", "prompt": "不应采用的独立场景", "size": "1024x1024",
                       "sku_values": {"parameters": str(i + 1), "gifts": "送收纳袋", "attributes": "标准款"}} for i in range(2)]})]
        result, ok = asyncio.run(self._toolbox().invoke("brain.plan.compose",
            {"brief": "生成2张相框SKU图，只换产品"}, bot=bot(["pack.plan"]), chat=CHAT, group=None))
        self.assertTrue(ok, result)
        self.assertEqual(len(result["shots"]), 2)
        for shot in result["shots"]:
            self.assertIn(result["sku_scene"], shot["prompt"])
            self.assertNotIn("不应采用的独立场景", shot["prompt"])

    def test_sku_direct_generation_cannot_bypass_shared_scene_workflow(self):
        result, ok = asyncio.run(self._toolbox().invoke("brain.generate.submit",
            {"prompt": "红色款SKU展示"}, bot=bot(["pack.execute"]), chat=CHAT, group=None))
        self.assertFalse(ok)
        self.assertIn("brain.workflow.run", result["error"])
        self.assertFalse(self.host.image_payloads)

    def test_appearance_sku_tools_compose_and_confirm_without_text_slots(self):
        from tests.test_design_brain_sku_variants import variant_plan
        self.host.replies = [json.dumps(variant_plan(2))]
        plan, ok = asyncio.run(self._toolbox().invoke('brain.plan.compose',
            {'brief': '做2张SKU图，每款使用不同照片组合'},
            bot=bot(['pack.plan']), chat=CHAT, group=None))
        self.assertTrue(ok, plan)
        self.assertEqual(plan['sku_layout'], {})
        self.assertIn('生活照组合2', plan['shots'][1]['prompt'])
        self.orchestrator.tasks.task.update(brief={'series_mode': 'sku_variants', 'image_count': 2}, plan=plan)
        result, ok = asyncio.run(self._toolbox().invoke('brain.task.confirm', {'task_id': 'job_1'},
            bot=bot(['pack.workflow']), chat=CHAT, group=None))
        self.assertTrue(ok, result)
        self.assertEqual(self.orchestrator.started, ['job_1'])

    def test_appearance_sku_direct_generation_still_requires_group_workflow(self):
        result, ok = asyncio.run(self._toolbox().invoke('brain.generate.submit',
            {'prompt': 'SKU每款使用不同照片组合'},
            bot=bot(['pack.execute']), chat=CHAT, group=None))
        self.assertFalse(ok)
        self.assertIn('brain.workflow.run', result['error'])
        self.assertFalse(self.host.image_payloads)

    def test_sku_confirmation_rejects_mixed_sizes(self):
        self.orchestrator.tasks.task.update({"brief": {"series_mode": "sku", "image_count": 2},
            "plan": {"sku_scene": "同一桌面、机位与柔光", "visual_framework": sku_plan()["visual_framework"], "shots": [
                {"id": "s1", "prompt": "红色款", "size": "1024x1024"},
                {"id": "s2", "prompt": "蓝色款", "size": "1024x1536"}]}})
        result, ok = asyncio.run(self._toolbox().invoke("brain.task.confirm", {"task_id": "job_1"},
            bot=bot(["pack.workflow"]), chat=CHAT, group=None))
        self.assertFalse(ok)
        self.assertIn("同组 SKU", result["error"])
        self.assertFalse(self.orchestrator.started)

    def test_tool_confirmation_rejects_incomplete_legacy_plan(self):
        self.orchestrator.tasks.task['brief'] = {'image_count': 15}
        result, ok = asyncio.run(self._toolbox().invoke('brain.task.confirm', {'task_id': 'job_1'},
            bot=bot(['pack.workflow']), chat=CHAT, group=None))
        self.assertFalse(ok)
        self.assertIn('15', result['error'])
        self.assertFalse(self.orchestrator.started)
        self.assertEqual(self.orchestrator.tasks.task['status'], 'awaiting_confirmation')

    def test_generate_submit_and_status(self):
        toolbox = self._toolbox()
        images = [f"/assets/product-{index}.png" for index in range(25)]
        result, ok = asyncio.run(toolbox.invoke("brain.generate.submit",
                                                {"prompt": "胡桃木相框", "size": "1024x1536",
                                                 "reference_images": images},
                                                bot=bot(["pack.execute"]), chat=CHAT, group=None))
        self.assertTrue(ok, result)
        self.assertEqual(result["status"], "succeeded")
        self.assertEqual(result["outputs"], ["/output/img_1.png"])
        self.assertEqual(self.host.image_payloads[0].size, "1024x1536")
        self.assertEqual(self.host.image_payloads[0].provider_id, "ip")
        self.assertEqual([ref.url for ref in self.host.image_payloads[0].reference_images], images)

        status, ok = asyncio.run(toolbox.invoke("brain.generate.status", {"task_id": "img_1"},
                                                bot=bot(["pack.execute"]), chat=CHAT, group=None))
        self.assertTrue(ok)
        self.assertEqual(status["status"], "succeeded")

    def test_review_check(self):
        self.host.replies = ['{"verdict":"issues","issues":[{"severity":"major","area":"material",'
                             '"description":"木纹偏塑料","evidence":"左下角反光","suggestion":"降低高光"}]}']
        toolbox = self._toolbox()
        result, ok = asyncio.run(toolbox.invoke("brain.review.check",
                                                {"image": "/output/img_1.png", "acceptance": ["木纹真实"]},
                                                bot=bot(["pack.review"]), chat=CHAT, group=None))
        self.assertTrue(ok)
        self.assertEqual(result["verdict"], "issues")
        self.assertEqual(self.host.calls[0].images, ["/output/img_1.png"])

    def test_team_tools_require_main(self):
        toolbox = self._toolbox()
        result, ok = asyncio.run(toolbox.invoke("brain.team.create_bot", {"name": "文案 BOT"},
                                                bot=bot(["pack.team"], is_main=False), chat=CHAT, group=None))
        self.assertFalse(ok)
        self.assertIn("只有主 Bot", result["error"])

        result, ok = asyncio.run(toolbox.invoke("brain.team.create_bot", {"name": "文案 BOT", "role": "写文案"},
                                                bot=bot(["pack.team"], is_main=True), chat=CHAT, group=None))
        self.assertTrue(ok, result)
        self.assertEqual(result["name"], "文案 BOT")

    def test_task_confirm_applies_edits(self):
        toolbox = self._toolbox()
        result, ok = asyncio.run(toolbox.invoke("brain.task.confirm", {
            "task_id": "job_1", "approved": True,
            "shot_edits": [{"id": "shot_1", "prompt": "新提示词", "size": "1024x1536"}],
        }, bot=bot(["pack.workflow"]), chat=CHAT, group=None))
        self.assertTrue(ok, result)
        self.assertEqual(self.orchestrator.started, ["job_1"])
        shot = self.orchestrator.tasks.task["plan"]["shots"][0]
        self.assertEqual(shot["prompt"], "新提示词")
        self.assertEqual(shot["size"], "1024x1536")

    def test_task_cancel(self):
        toolbox = self._toolbox()
        result, ok = asyncio.run(toolbox.invoke("brain.task.cancel", {"task_id": "job_1", "reason": "方向不对"},
                                                bot=bot(["pack.workflow"]), chat=CHAT, group=None))
        self.assertTrue(ok)
        self.assertEqual(self.orchestrator.cancelled, [("job_1", "方向不对")])


class EngineToolDispatchTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.team = TeamStore(self.temp.name)
        self.team.ensure_seeded()
        self.team.update_bot("bot_planner", {"model": {"provider": "p", "model": "m"}})
        self.profile = DesignProfileStore(self.temp.name)
        self.profile.update({"aesthetics": {"style_tags": [{"tag": "极简", "weight": 0.8}]}})
        self.references = ReferenceItemStore(self.temp.name)
        self.references.create({
            "hash": "b" * 64, "title": "案例", "file": {"media": "media/bb/y.jpg", "name": "y.jpg"},
        })

    def tearDown(self):
        self.temp.cleanup()

    def test_system_prompt_lists_tools(self):
        toolbox = DesignToolbox(FakeHost(), self.team, None, self.profile, self.references)
        engine = TurnEngine(FakeHost(), self.team, None, toolbox=toolbox)
        bot = self.team.get_bot("bot_planner")
        prompt = engine._system_prompt({"id": "dm_bot_planner", "members": ["bot_planner"]}, None, bot)
        self.assertIn("brain.references.search", prompt)
        self.assertIn("brain.plan.compose", prompt)

    def test_engine_routes_reference_search_to_toolbox(self):
        host = FakeHost([
            '{"say":"我查一下参考库","mentions":[],"pass":false,'
            '"call":{"tool":"brain.references.search","args":{"query":"案例"}}}',
            '{"say":"找到 1 个案例。","mentions":[],"pass":false}',
        ])
        toolbox = DesignToolbox(host, self.team, None, self.profile, self.references)
        engine = TurnEngine(host, self.team, None, toolbox=toolbox)
        chat = self.team.ensure_dm_chat("bot_planner")
        self.team.append_message(chat["id"], role="user", text="找点参考")
        asyncio.run(engine._run(chat["id"]))
        messages = self.team.list_messages(chat["id"])["messages"]
        self.assertEqual(messages[-1]["role"], "bot")
        self.assertIn("找到 1 个案例", messages[-1]["text"])
        self.assertEqual(len(host.calls), 2)


if __name__ == "__main__":
    unittest.main()
