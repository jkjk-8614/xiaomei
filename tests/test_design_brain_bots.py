"""设计大脑多 BOT 编排测试：注入 fake host 与隔离存储，覆盖完整管线与失败路径。

运行方式（仓库自带 Python，含 fastapi）：
    ./python/python.exe -m unittest tests.test_design_brain_bots
系统 py 缺少 fastapi 时自动跳过（与 test_design_brain_api_runtime 同约定）。
"""
import asyncio
import sys
import tempfile
import time
import unittest
from copy import deepcopy
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

try:
    import design_brain_bots
    from design_brain_bots import DesignBotOrchestrator, parse_model_json
    from design_brain_store import (
        AgentTaskStore,
        DesignProfileStore,
        DesignRunStore,
        ExperienceStore,
        ReferenceItemStore,
    )
    from fastapi import HTTPException
except ImportError as exc:  # pragma: no cover - 系统 Python 无 fastapi 时跳过
    raise unittest.SkipTest(f"design_brain_bots 依赖不可用：{exc}") from exc


class FakePayload:
    def __init__(self, **kwargs):
        self.__dict__.update(kwargs)


DIRECTOR_CREATE = {
    "reply": "好的，我来安排商品图设计任务。",
    "intent": "create_task",
    "brief": {
        "task_type": "other",
        "goal": "胡桃木相框高级商品图",
        "product": {"name": "胡桃木相框", "category": "家居", "features": ["真实木纹"],
                    "constraints": ["保持四角边框结构", "木色为深胡桃色"]},
        "deliverables": [{"text": "2 张商品图"}],
        "style_direction": "高级质感",
        "need_confirmation": True,
    },
}

PLANNER_TWO_SHOTS = {
    "direction": "浅灰渐变底，柔光侧打，突出木纹",
    "rationale": "参考档案偏好浅底与柔光",
    "constraints_locked": ["保持四角边框结构", "木色为深胡桃色"],
    "flexible": ["背景纹理细节"],
    "acceptance": ["商品结构完整", "木纹清晰可见"],
    "shots": [
        {"id": "shot_1", "kind": "main_image", "purpose": "商品图", "size": "1024x1024", "count": 1,
         "prompt": "胡桃木相框居中，浅灰渐变底，柔光，真实木纹", "negative": "杂乱背景",
         "acceptance": ["四角边框完整"]},
        {"id": "shot_2", "kind": "scene", "purpose": "场景图", "size": "1024x1024", "count": 1,
         "prompt": "胡桃木相框置于书桌一角，暖光", "negative": "", "acceptance": ["氛围自然"]},
    ],
}


def sku_plan(count=2):
    plan = deepcopy(PLANNER_TWO_SHOTS)
    plan["visual_framework"] = {"palette": ["#F5F1E8", "#252525"], "fonts": ["微软雅黑"],
        "style": "统一简洁相框陈列", "brand": "无Logo", "product_pose": "同一相框正面平视、同一大小比例"}
    plan["sku_scene"] = "图4的米白墙与原木桌面，花瓶固定左侧，书本固定右侧，正面平视，左侧柔光，暖米色色调，同一拍摄尺度"
    plan["shots"] = [{**deepcopy(plan["shots"][0]), "id": f"shot_{index + 1}",
                      "sku_values": {"parameters": f"容量 {index + 1}", "gifts": "送收纳袋", "attributes": f"规格 {index + 1}"}}
                     for index in range(count)]
    return plan

REVIEW_PASS = {"verdict": "pass", "issues": []}
REVIEW_CRITICAL = {"verdict": "issues", "issues": [
    {"severity": "critical", "area": "structure", "description": "边框左上角缺失一块",
     "evidence": "左上角画面", "suggestion": "补全四角边框结构"}]}


class FakeHost:
    """实现编排器所需的最小 host 面：LLM、生图任务与模型校验。"""

    def __init__(self, *, director=None, planner=None, reviews=None, reviewer_raw=None, task_flow=None):
        self.director = director or DIRECTOR_CREATE
        self.planner = planner or PLANNER_TWO_SHOTS
        self.review_queue = list(reviews or [])
        self.reviewer_raw = reviewer_raw
        self.task_flow = task_flow or ["queued", "running", "succeeded"]
        self.llm_calls = []
        self.llm_payloads = []
        self.created = []
        self.by_client = {}
        self.canvas_tasks = {}
        self.cancelled = []
        self.cancel_scoped = []
        self._media = tempfile.TemporaryDirectory()
        self.media_root = Path(self._media.name)
        from PIL import Image
        Image.new("RGB", (750, 750), "#dcc7a4").save(self.media_root / "template.png")
        self.history = []

    # ---- 请求模型 ----
    def CanvasLLMRequest(self, **kwargs):
        return FakePayload(**kwargs)

    def OnlineImageRequest(self, **kwargs):
        return FakePayload(**kwargs)

    def AIReference(self, **kwargs):
        return FakePayload(**kwargs)

    # ---- 模型与路径 ----
    def get_api_provider_exact(self, provider_id):
        if provider_id not in ("chat-p", "image-p"):
            raise HTTPException(status_code=404, detail="平台不存在")
        return {"id": provider_id, "name": provider_id, "protocol": "openai",
                "chat_models": ["m-chat"], "image_models": ["m-img"]}

    def load_api_providers(self):
        return [self.get_api_provider_exact("chat-p"), self.get_api_provider_exact("image-p")]

    def output_file_from_url(self, url):
        if not str(url).startswith(("/assets/", "/api/storage-files/")):
            return None
        path = self.media_root / Path(str(url)).name
        return path if path.is_file() else self.media_root / "template.png"

    def save_generated_image_bytes(self, content, **kwargs):
        import hashlib
        name = "local-" + hashlib.sha256(content).hexdigest()[:16] + ".png"
        path = self.media_root / name
        path.write_bytes(content)
        return "/assets/" + name, path

    def asset_registry_register_media(self, url, **kwargs):
        return {"id": "asset_local"}

    def save_to_history(self, record):
        self.history.append(deepcopy(record))

    def project_agent_safe_error(self, text):
        return str(text)

    # ---- LLM ----
    async def canvas_llm(self, payload):
        system = payload.system_prompt or ""
        self.llm_calls.append(system[:40])
        self.llm_payloads.append(payload)
        if "交付总结" in system:
            text = json_dumps({"reply": "已完成两张图，请查看。"})
        elif "设计总监 BOT" in system:
            text = self.director if isinstance(self.director, str) else json_dumps(self.director)
        elif "设计规划 BOT" in system:
            text = json_dumps(self.planner)
        elif "质量检查 BOT" in system:
            if self.reviewer_raw is not None:
                text = self.reviewer_raw
            elif self.review_queue:
                text = json_dumps(self.review_queue.pop(0))
            else:
                text = json_dumps(REVIEW_PASS)
        else:
            text = json_dumps({"reply": "收到"})
        return {"text": text, "model": payload.model or "m-chat", "raw_usage": {}}

    # ---- 生图任务 ----
    async def create_canvas_image_task(self, payload):
        self.created.append(payload)
        key = getattr(payload, "client_request_id", "")
        if key and key in self.by_client:
            return {"task_id": self.by_client[key], "status": "queued", "recovered": True}
        task_id = f"ct_{len(self.canvas_tasks) + 1}"
        if key:
            self.by_client[key] = task_id
        self.canvas_tasks[task_id] = {"status": self.task_flow[0], "step": 0,
                                      "flow": list(self.task_flow),
                                      "result": {"image_items": [
                                          {"url": f"/assets/out-{task_id}.png", "asset_ref_id": f"asset_{task_id}"}]},
                                      "error": ""}
        return {"task_id": task_id, "status": "queued"}

    async def get_canvas_image_task(self, task_id):
        task = self.canvas_tasks[task_id]
        task["step"] += 1
        if task["step"] < len(task["flow"]):
            task["status"] = task["flow"][task["step"]]
        if task["status"] in ("failed", "cancelled") and not task["error"]:
            task["error"] = "上游生成失败"
        return dict(task)

    async def cancel_canvas_image_task(self, task_id):
        self.cancelled.append(task_id)
        self.canvas_tasks[task_id]["status"] = "cancelled"
        return {"task_id": task_id, "status": "cancelled"}


def json_dumps(value):
    import json
    return json.dumps(value, ensure_ascii=False)


class DesignBotOrchestratorTestBase(unittest.TestCase):
    def setUp(self):
        design_brain_bots.CANVAS_TASK_POLL_INTERVAL = 0.01
        self._tmp = tempfile.TemporaryDirectory()
        root = Path(self._tmp.name)
        self.tasks_store = AgentTaskStore(root)
        self.runs_store = DesignRunStore(root)
        self.profile_store = DesignProfileStore(root)
        self.references_store = ReferenceItemStore(root)
        self.experiences_store = ExperienceStore(root)

    def tearDown(self):
        design_brain_bots.CANVAS_TASK_POLL_INTERVAL = 2.0
        self._tmp.cleanup()

    def make_orchestrator(self, host):
        return DesignBotOrchestrator(
            host, self.tasks_store,
            references=self.references_store, experiences=self.experiences_store,
            runs=self.runs_store, profile=self.profile_store)

    def chat_models(self):
        return {"chat": {"provider": "chat-p", "model": "m-chat"},
                "vision": {"provider": "chat-p", "model": "m-chat"},
                "image": {"provider": "image-p", "model": "m-img"}}

    async def drive_until(self, orch, task_id, statuses, timeout=15.0):
        deadline = time.monotonic() + timeout
        orch.start(task_id)
        while time.monotonic() < deadline:
            await asyncio.sleep(0.01)
            task = orch.tasks.get(task_id)
            if task["status"] in statuses:
                await asyncio.sleep(0.05)
                return orch.tasks.get(task_id)
        task = orch.tasks.get(task_id)
        raise AssertionError(f"等待状态 {statuses} 超时，当前 {task['status']}：{task['error']}")

    def create_task_via_chat(self, orch, host, *, auto_confirm=False):
        return asyncio.run(self._create_and_plan(orch, auto_confirm))

    async def _create_and_plan(self, orch, auto_confirm):
        result = await orch.chat(
            task_id="", message="给胡桃木相框做两张商品图",
            product_images=["/assets/products/frame.png"],
            models=self.chat_models(), auto_confirm=auto_confirm)
        task_id = result["task_id"]
        self.assertTrue(task_id)
        if auto_confirm:
            task = await self.drive_until(orch, task_id, {"delivered", "failed", "cancelled"})
        else:
            task = await self.drive_until(orch, task_id, {"awaiting_confirmation", "failed"})
        return task_id, task


class SkuConsistencyTest(DesignBotOrchestratorTestBase):
    async def prepare(self, host, *, auto_confirm=False):
        orch = self.make_orchestrator(host)
        result = await orch.chat(
            task_id="", message="做2张相框SKU展示图，图1、图2是商品，图4是固定场景，仅替换参数、赠品和属性名",
            product_images=["/assets/products/a.png", "/assets/products/b.png", "/assets/products/scene.png"],
            models=self.chat_models(), auto_confirm=auto_confirm)
        task = await self.drive_until(orch, result["task_id"],
                                     {"delivered", "failed"} if auto_confirm else {"awaiting_confirmation", "failed"})
        return orch, task

    def test_shared_scene_persisted_and_compared_with_same_anchor(self):
        host = FakeHost(planner=sku_plan())
        async def scenario():
            orch, task = await self.prepare(host)
            self.assertEqual(task["status"], "awaiting_confirmation", task["error"])
            self.assertEqual(task["brief"]["series_mode"], "sku")
            self.assertIn("图4是固定场景", task["brief"]["source_text"])
            for shot in task["plan"]["shots"]:
                self.assertIn(task["plan"]["sku_scene"], shot["prompt"])
                self.assertIn("三个信息位可变", shot["prompt"])
                self.assertIn("保持四角边框结构", shot["prompt"])
            self.assertFalse(host.created)
            restored = AgentTaskStore(self._tmp.name).get(task["id"])
            self.assertEqual(restored["plan"], task["plan"])
            orch.tasks.patch(task["id"], lambda t: t.update(status="executing"))
            task = await self.drive_until(orch, task["id"], {"delivered", "failed"})
            self.assertEqual(task["status"], "delivered", task["error"])
            baseline = "/assets/out-ct_1.png"
            self.assertEqual(task["execution"]["sku_anchor_url"], baseline)
            self.assertEqual([r.url for r in host.created[0].reference_images], task["product_images"])
            self.assertEqual(len(host.created), 1, "整组 SKU 只生成一次底图")
            self.assertEqual(len(host.history), 2)
            reviews = [p for p in host.llm_payloads if "质量检查 BOT" in p.system_prompt]
            self.assertEqual(reviews[1].images, [task["execution"]["shots"][1]["outputs"][0]["url"], baseline])
            self.assertIn("最后一张是全组固定场景基准", reviews[1].message)
        asyncio.run(scenario())

    def test_missing_variant_or_mixed_size_blocks_before_generation(self):
        for issue in ("variant", "size"):
            with self.subTest(issue=issue):
                plan = sku_plan()
                if issue == "variant":
                    del plan["shots"][1]["sku_values"]
                else:
                    plan["shots"][1]["size"] = "1024x1536"
                host = FakeHost(planner=plan)
                async def scenario():
                    _, task = await self.prepare(host, auto_confirm=True)
                    self.assertEqual(task["status"], "failed")
                    self.assertIn("SKU", task["error"])
                    self.assertFalse(host.created)
                    self.assertEqual(len([p for p in host.llm_payloads if "设计规划 BOT" in p.system_prompt]), 2)
                asyncio.run(scenario())

    def test_missing_sku_scene_is_filled_from_product_constraints_and_warned(self):
        """规划模型漏掉 sku_scene 时由商品约束补齐并告警，而不是整单失败。

        这条与 default_sku_scene() 的容错一致：共同场景在规划阶段就定下来并写进
        每一张的 prompt，全组仍然共享同一场景，只是来源标记为系统补齐，用户
        可以在确认前复核。
        """
        plan = sku_plan()
        del plan["sku_scene"]
        host = FakeHost(planner=plan)
        async def scenario():
            _, task = await self.prepare(host, auto_confirm=True)
            self.assertEqual(task["status"], "delivered", task["error"])
            scene = task["plan"].get("sku_scene") or ""
            self.assertTrue(scene, "缺失的 SKU 共同场景必须被补齐")
            self.assertIn("保持四角边框结构", scene)
            for shot in task["plan"]["shots"]:
                self.assertIn(scene, shot["prompt"])
            warnings = " ".join(task["plan"].get("planning_warnings") or [])
            self.assertIn("SKU", warnings)
            self.assertIn("补齐", warnings)
        asyncio.run(scenario())

    def test_failed_anchor_does_not_generate_remaining_skus(self):
        host = FakeHost(planner=sku_plan(), task_flow=["queued", "failed"])
        async def scenario():
            _, task = await self.prepare(host, auto_confirm=True)
            self.assertEqual(task["status"], "failed")
            self.assertIn("场景基准图生成失败", task["error"])
            self.assertIn(task["execution"]["shots"][0]["error"], task["error"])
            self.assertEqual(len(host.created), 1)
        asyncio.run(scenario())

    def test_sku_structure_issues_require_manual_review_of_fixed_template(self):
        host = FakeHost(planner=sku_plan(), reviews=[REVIEW_CRITICAL, REVIEW_PASS])
        async def scenario():
            _, task = await self.prepare(host, auto_confirm=True)
            self.assertEqual(task["status"], "delivered", task["error"])
            self.assertEqual(len(host.created), 1, "修正文字仍沿用底图，不重新生图")
            restored = AgentTaskStore(self._tmp.name).get(task["id"])
            self.assertEqual(restored["execution"]["sku_anchor_url"], "/assets/out-ct_1.png")
            self.assertEqual(task["reviews"][0]["verdict"], "needs_human")
            self.assertEqual(task["usage"]["auto_revisions"], 0)
        asyncio.run(scenario())


class RequestedOutputTest(DesignBotOrchestratorTestBase):
    def plan(self, count):
        plan = deepcopy(PLANNER_TWO_SHOTS)
        plan["shots"] = [{**plan["shots"][index % 2], "id": f"shot_{index + 1}"} for index in range(count)]
        return plan

    def test_fifteen_4k_images_survive_restart_and_reach_generation(self):
        host = FakeHost(planner=sku_plan(15))
        orch = self.make_orchestrator(host)
        async def scenario():
            result = await orch.chat(task_id="", message="相框 SKU 展示", source_text="做十五张相框SKU展示图，图片是4k",
                                     product_images=[], models=self.chat_models(), auto_confirm=False)
            task_id = result["task_id"]
            task = await self.drive_until(orch, task_id, {"awaiting_confirmation", "failed"})
            self.assertEqual(task["status"], "awaiting_confirmation", task["error"])
            self.assertEqual(task["brief"]["image_count"], 15)
            self.assertEqual(task["brief"]["resolution"], "4K")
            self.assertEqual(len(AgentTaskStore(self._tmp.name).get(task_id)["plan"]["shots"]), 15)
            self.assertTrue(all(shot["size"] == "4096x4096" for shot in task["plan"]["shots"]))
            self.assertFalse(host.created)
            orch.tasks.patch(task_id, lambda t: t.update(status="executing"))
            task = await self.drive_until(orch, task_id, {"delivered", "failed"})
            self.assertEqual(task["status"], "delivered", task["error"])
            self.assertEqual(len(host.created), 1)
            self.assertEqual(len(host.history), 15)
            self.assertTrue(all(p.size == "4096x4096" and p.n == 1 for p in host.created))
        asyncio.run(scenario())

    def test_short_plan_retries_then_fails_without_generation(self):
        host = FakeHost(planner=self.plan(8))
        orch = self.make_orchestrator(host)
        async def scenario():
            result = await orch.chat(task_id="", message="做15张相框图", product_images=[],
                                     models=self.chat_models(), auto_confirm=True)
            task = await self.drive_until(orch, result["task_id"], {"awaiting_confirmation", "failed", "delivered"})
            self.assertEqual(task["status"], "failed")
            self.assertIn("15", task["error"])
            self.assertIn("8", task["error"])
            self.assertEqual(len([p for p in host.llm_payloads if "设计规划 BOT" in p.system_prompt]), 2)
            self.assertFalse(host.created)
        asyncio.run(scenario())

    def test_short_plan_can_recover_on_the_single_validation_retry(self):
        host = FakeHost(planner=self.plan(8))
        original_llm = host.canvas_llm
        async def respond(payload):
            if "设计规划 BOT" in payload.system_prompt and "上次方案未通过校验" in payload.system_prompt:
                host.planner = self.plan(15)
            return await original_llm(payload)
        host.canvas_llm = respond
        orch = self.make_orchestrator(host)
        async def scenario():
            result = await orch.chat(task_id="", message="做15张相框图，4K", product_images=[],
                                     models=self.chat_models(), auto_confirm=False)
            task = await self.drive_until(orch, result["task_id"], {"awaiting_confirmation", "failed"})
            self.assertEqual(task["status"], "awaiting_confirmation", task["error"])
            self.assertEqual(len(task["plan"]["shots"]), 15)
            self.assertEqual(len([p for p in host.llm_payloads if "设计规划 BOT" in p.system_prompt]), 2)
            self.assertFalse(host.created)
        asyncio.run(scenario())

    def test_later_resolution_updates_awaiting_plan_preserving_aspect(self):
        host = FakeHost()
        orch = self.make_orchestrator(host)
        task = self.tasks_store.create({"status": "awaiting_confirmation", "brief": {"image_count": 2},
                                        "plan": {"shots": [
                                            {"id": "square", "prompt": "相框", "size": "1024x1024"},
                                            {"id": "portrait", "prompt": "相框竖图", "size": "768x1024"}]}})
        task = orch.update_requirements(task["id"], "@设计总监 图片是4k")
        self.assertEqual(task["brief"]["resolution"], "4K")
        self.assertEqual([s["size"] for s in task["plan"]["shots"]], ["4096x4096", "3072x4096"])
        self.assertFalse(host.created)


class FullPipelineTest(DesignBotOrchestratorTestBase):
    def test_planner_returns_task_specific_adjustment_options(self):
        options = [{"label": "突出木纹", "feedback": "通过侧光突出胡桃木纹理，保留四角边框结构"}]
        host = FakeHost(planner={**PLANNER_TWO_SHOTS, "adjustment_options": options})
        orch = self.make_orchestrator(host)
        _, task = self.create_task_via_chat(orch, host)
        self.assertEqual(task["status"], "awaiting_confirmation", task["error"])
        self.assertEqual(task["plan"]["adjustment_options"], options)
        self.assertFalse(host.created)

    def test_all_product_images_survive_planning_storage_and_generation(self):
        host = FakeHost()
        orch = self.make_orchestrator(host)
        images = [f"/assets/products/frame-{index}.png" for index in range(25)]

        async def scenario():
            result = await orch.chat(task_id="", message="为这些商品规划商品图",
                                     product_images=images, models=self.chat_models(), auto_confirm=False)
            task_id = result["task_id"]
            task = await self.drive_until(orch, task_id, {"awaiting_confirmation", "failed"})
            self.assertEqual(task["status"], "awaiting_confirmation", task["error"])
            self.assertEqual(task["product_images"], images)
            self.assertEqual(AgentTaskStore(self._tmp.name).get(task_id)["product_images"], images)
            self.assertEqual(host.llm_payloads[0].images, images)
            planner = next(call for call in host.llm_payloads if "设计规划 BOT" in call.system_prompt)
            self.assertEqual(planner.images, images)
            orch.tasks.patch(task_id, lambda t: t.__setitem__("status", "executing"))
            task = await self.drive_until(orch, task_id, {"delivered", "failed"})
            self.assertEqual(task["status"], "delivered", task["error"])
            self.assertTrue(host.created)
            for payload in host.created:
                self.assertEqual([ref.url for ref in payload.reference_images], images)

        asyncio.run(scenario())

    def test_delivered_with_traceability(self):
        """确认门禁 → 执行 → 质检 → 交付：幂等 ID、design_run_id 与执行记录完整。"""
        host = FakeHost()
        orch = self.make_orchestrator(host)

        async def scenario():
            task_id, task = await self._create_and_plan(orch, auto_confirm=False)
            self.assertEqual(task["status"], "awaiting_confirmation")
            self.assertFalse(host.created, "确认前不得提交任何生图任务")
            orch.tasks.patch(task_id, lambda t: t.__setitem__("status", "executing"))
            task = await self.drive_until(orch, task_id, {"delivered", "failed"})
            return task_id, task

        task_id, task = asyncio.run(scenario())
        self.assertEqual(task["status"], "delivered", task["error"])
        run_id = task["execution"]["design_run_id"]
        self.assertTrue(run_id)
        run = self.runs_store.get(run_id)
        self.assertEqual(run["status"], "completed")
        # 两个 shot 各一次提交，幂等 ID 稳定
        self.assertEqual(len(host.created), 2)
        self.assertEqual(host.created[0].client_request_id, f"dbot_{task_id}_shot_1_v1")
        self.assertEqual(host.created[0].design_run_id, run_id)
        self.assertEqual(host.created[0].history_source, "design_brain")
        self.assertEqual(host.created[0].provider_id, "image-p")
        self.assertEqual(host.created[0].reference_images[0].role, "image_1")
        self.assertIn("胡桃木相框", host.created[0].prompt)
        shots = {shot["id"]: shot for shot in task["execution"]["shots"]}
        self.assertEqual(shots["shot_1"]["status"], "succeeded")
        self.assertEqual(shots["shot_1"]["outputs"][0]["url"], "/assets/out-ct_1.png")
        # 质检通过 + 总监交付总结
        self.assertEqual(task["reviews"][0]["verdict"], "pass")
        self.assertTrue(any(m["bot"] == "director" and "已完成" in m["text"] for m in task["messages"]))
        self.assertEqual(task["usage"]["image_calls"], 2)

    def test_auto_confirm_skips_gate(self):
        host = FakeHost()
        orch = self.make_orchestrator(host)
        task_id, task = self.create_task_via_chat(orch, host, auto_confirm=True)
        self.assertEqual(task["status"], "delivered", task["error"])
        self.assertEqual(len(host.created), 2)

    def test_auto_revision_on_critical_issue(self):
        """质检 critical → 自动修正一轮（v2 幂等 ID）→ 复检 → 交付。"""
        host = FakeHost(reviews=[REVIEW_CRITICAL, REVIEW_PASS, REVIEW_PASS])
        orch = self.make_orchestrator(host)

        async def scenario():
            task_id, _ = await self._create_and_plan(orch, auto_confirm=True)
            task = await self.drive_until(orch, task_id, {"delivered", "failed"})
            return task_id, task

        task_id, task = asyncio.run(scenario())
        self.assertEqual(task["status"], "delivered", task["error"])
        self.assertEqual(task["usage"]["auto_revisions"], 1)
        ids = [payload.client_request_id for payload in host.created]
        self.assertIn(f"dbot_{task_id}_shot_1_v1", ids)
        self.assertIn(f"dbot_{task_id}_shot_1_v2", ids)
        shot1 = next(shot for shot in task["plan"]["shots"] if shot["id"] == "shot_1")
        self.assertIn("修正要求", shot1["prompt"])

    def test_needs_human_when_reviewer_output_invalid(self):
        host = FakeHost(reviewer_raw="抱歉，我无法判断。")
        orch = self.make_orchestrator(host)

        async def scenario():
            task_id, _ = await self._create_and_plan(orch, auto_confirm=True)
            return await self.drive_until(orch, task_id, {"delivered", "failed"})

        task = asyncio.run(scenario())
        self.assertEqual(task["status"], "delivered")
        verdicts = {review["shot_id"]: review["verdict"] for review in task["reviews"]}
        self.assertEqual(set(verdicts.values()), {"needs_human"}, "解析失败必须标人工确认，不得虚报通过")


class FailureAndRecoveryTest(DesignBotOrchestratorTestBase):
    def test_all_shots_failed_marks_task_failed_with_resume_phase(self):
        host = FakeHost(task_flow=["queued", "failed"])
        orch = self.make_orchestrator(host)

        async def scenario():
            task_id, _ = await self._create_and_plan(orch, auto_confirm=True)
            task = await self.drive_until(orch, task_id, {"failed", "delivered"})
            return task_id, task

        task_id, task = asyncio.run(scenario())
        self.assertEqual(task["status"], "failed")
        self.assertEqual(task["resume_phase"], "executing")
        self.assertIn("失败", task["error"])

        # 恢复：换成功流程后 resume 重试执行阶段
        host.task_flow = ["queued", "running", "succeeded"]

        async def resume():
            orch.tasks.patch(task_id, lambda t: (t.__setitem__("status", "executing"), t.__setitem__("error", "")))
            return await self.drive_until(orch, task_id, {"delivered", "failed"})

        task = asyncio.run(resume())
        self.assertEqual(task["status"], "delivered", task["error"])

    def test_cancel_propagates_to_canvas_tasks(self):
        host = FakeHost(task_flow=["queued", "running"])
        orch = self.make_orchestrator(host)

        async def scenario():
            result = await orch.chat(task_id="", message="给胡桃木相框做两张商品图",
                                     product_images=[], models=self.chat_models(), auto_confirm=True)
            task_id = result["task_id"]
            deadline = time.monotonic() + 5
            while time.monotonic() < deadline and not host.created:
                await asyncio.sleep(0.01)
            self.assertTrue(host.created)
            await asyncio.sleep(0.2)  # 等任务编号写入分镜并进入轮询
            return await orch.cancel(task_id, "测试取消")

        task = asyncio.run(scenario())
        self.assertEqual(task["status"], "cancelled")
        self.assertTrue(host.cancelled, "取消必须传播到已提交的画布生图任务")

    def test_model_choice_validation(self):
        host = FakeHost()
        orch = self.make_orchestrator(host)
        with self.assertRaises(HTTPException):
            asyncio.run(orch.chat(task_id="", message="hi", product_images=[],
                                  models={"chat": {"provider": "chat-p", "model": "不存在"},
                                          "image": {"provider": "image-p", "model": "m-img"}},
                                  auto_confirm=None))
        with self.assertRaises(HTTPException):
            asyncio.run(orch.chat(task_id="", message="hi", product_images=[],
                                  models={"chat": {"provider": "chat-p", "model": "m-chat"},
                                          "image": {"provider": "chat-p", "model": "m-chat"}},
                                  auto_confirm=None))

    def test_invalid_product_image_rejected(self):
        host = FakeHost()
        orch = self.make_orchestrator(host)
        with self.assertRaises(HTTPException):
            asyncio.run(orch.chat(task_id="", message="做一张商品图",
                                  product_images=[f"/assets/products/frame-{index}.png" for index in range(25)]
                                                 + ["https://evil.example.com/x.png"],
                                  models=self.chat_models(), auto_confirm=None))


class DirectorChatTest(DesignBotOrchestratorTestBase):
    def test_answer_intent_creates_no_task(self):
        host = FakeHost(director={"reply": "这个我可以直接回答……", "intent": "answer"})
        orch = self.make_orchestrator(host)
        result = asyncio.run(orch.chat(task_id="", message="什么是商品图？", product_images=[],
                                       models=self.chat_models(), auto_confirm=None))
        self.assertEqual(result["task_id"], "")
        self.assertEqual(self.tasks_store.list(), [])

    def test_fallback_creates_minimal_task_on_unparsable_director(self):
        host = FakeHost(director="我觉得应该先看看参考再决定。")
        orch = self.make_orchestrator(host)

        async def scenario():
            result = await orch.chat(task_id="", message="帮我给胡桃木相框出一张商品图，要高级感",
                                     product_images=[], models=self.chat_models(), auto_confirm=None)
            self.assertTrue(result["task_id"])
            task = await self.drive_until(orch, result["task_id"], {"awaiting_confirmation", "executing", "failed"})
            return task

        task = asyncio.run(scenario())
        self.assertIn("胡桃木相框", task["brief"]["goal"])

    def test_parse_model_json_handles_fenced_and_prefixed_text(self):
        self.assertEqual(parse_model_json('```json\n{"a": 1}\n```'), {"a": 1})
        self.assertEqual(parse_model_json('好的，结果如下 {"a": 2} 请查收'), {"a": 2})
        self.assertIsNone(parse_model_json("完全没有 JSON"))


if __name__ == "__main__":
    unittest.main()
