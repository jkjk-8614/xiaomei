"""P4 设计大脑核心能力迁移测试（参考分析、规划、批量落画布审批与视觉质检）。"""
from __future__ import annotations

import asyncio
import json
import tempfile
import unittest
from pathlib import Path
from PIL import Image

from bot_workspace_config import MANAGER_BOT_ID
from bot_workspace_runtime import BotWorkspaceRuntime
from bot_workspace_store import BotWorkspaceStore
from bot_workspace_tools import BotWorkspaceToolExecutor
from design_brain_store import DesignProfileStore, ReferenceItemStore
from multi_agent_api import CanvasAgentAdapter
from multi_agent_store import AgentRunStore


class _FakeLLMRequest:
    def __init__(self, **kwargs):
        self.__dict__.update(kwargs)


class _DesignHost:
    DEFAULT_PROJECT_ID = "proj_design"

    def __init__(self, data_dir: Path, responder):
        self.DATA_DIR = data_dir
        self.CanvasLLMRequest = _FakeLLMRequest
        self.responder = responder
        self.calls = []
        self.providers = [
            {
                "id": "prov_a",
                "name": "Alpha",
                "enabled": True,
                "protocol": "openai",
                "chat_models": ["alpha-vision"],
                "image_models": ["alpha-img"],
                "video_models": [],
            }
        ]
        self.output_map = {}
        self.canvases = {
            "cv_design": {
                "id": "cv_design",
                "project": "proj_design",
                "title": "设计规划画布",
                "nodes": [],
                "connections": [],
            }
        }

        class _MemStore:
            def read(self, pid):
                return {"memories": [], "revision": 1}

        self.PROJECT_AGENT_STORE = _MemStore()

    def load_api_providers(self):
        return list(self.providers)

    def get_api_provider_exact(self, pid):
        for p in self.providers:
            if p["id"] == pid:
                return p
        raise KeyError(pid)

    def load_canvas(self, cid):
        return self.canvases[cid]

    def list_canvases(self):
        return [{"id": cid, "project": c["project"], "deleted_at": None} for cid, c in self.canvases.items()]

    def ensure_default_project(self):
        return [{"id": "proj_design", "name": "设计项目", "deleted_at": None}]

    def output_file_from_url(self, url):
        return self.output_map.get(url)

    def is_video_reference_value(self, url):
        return False

    def is_image_reference_value(self, url):
        return str(url).endswith(".png")

    def project_agent_safe_error(self, value):
        return str(value)[:300]

    async def canvas_llm(self, req):
        self.calls.append({"system": req.system_prompt, "message": req.message, "images": list(req.images or [])})
        out = self.responder(req)
        if asyncio.iscoroutine(out):
            out = await out
        return {"text": out}


def _make_png(path: Path, size=(1024, 1024)) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    Image.new("RGB", size, (230, 224, 210)).save(path, format="PNG")
    return path


class BotWorkspaceDesignCapabilitiesTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.data_dir = Path(self.tmp.name) / "设计大脑迁移测试"
        self.bw_store = BotWorkspaceStore(data_dir=self.data_dir)
        self.bw_store.ensure_manager_bot()
        self.bw_store.update_bot(MANAGER_BOT_ID, {"chat_model": {"provider_id": "prov_a", "model": "alpha-vision"}})
        self.ma_store = AgentRunStore(self.data_dir / "multi_agent" / "runs.sqlite3")

    async def asyncTearDown(self):
        self.tmp.cleanup()

    async def test_profile_reference_search_analyze_and_privacy_gate(self):
        profile_store = DesignProfileStore(self.data_dir)
        ref_store = ReferenceItemStore(self.data_dir)

        # 存入一张参考图
        rel_media = "media/tea_ref.png"
        sample_png = _make_png(ref_store.root / rel_media, (640, 640))
        import hashlib
        digest = hashlib.sha256(sample_png.read_bytes()).hexdigest()
        created_ref = ref_store.create({
            "title": "奶油风冷泡茶主图参考",
            "hash": digest,
            "file": {"media": rel_media, "thumb": rel_media, "name": "tea_ref.png", "size": sample_png.stat().st_size},
            "classification": {"category": "茶饮", "purpose": "主图"},
        })
        item_id = created_ref["id"]

        def responder(req):
            return json.dumps({
                "purpose": "电商主图首图",
                "composition": "中心主体留白 40%",
                "material": "磨砂玻璃与水雾反光",
                "lighting": "侧逆柔光",
                "takeaways": "色调干净，焦点集中",
                "restrictions": "避免文字遮挡主体",
            }, ensure_ascii=False)

        host = _DesignHost(self.data_dir, responder)
        adapter = CanvasAgentAdapter(host, self.ma_store)
        executor = BotWorkspaceToolExecutor(host=host, store=self.bw_store, multi_agent_adapter=adapter)
        runtime = BotWorkspaceRuntime(host, self.bw_store, tool_executor=executor, multi_agent_adapter=adapter)

        mgr = self.bw_store.get_bot(MANAGER_BOT_ID)
        sess = self.bw_store.ensure_default_session(MANAGER_BOT_ID, project_id="proj_design", canvas_id="cv_design")
        _, turn, _ = self.bw_store.enqueue_message_and_turn(sess["session_id"], content="分析参考库", project_id="proj_design", canvas_id="cv_design")

        # 1. 读取审美档案与检索参考库
        prof = await executor.execute(tool_name="design.profile.read", args={}, bot=mgr, turn=turn, runtime=runtime)
        self.assertTrue(prof["ok"])
        self.assertIn("aesthetics", prof["result"])

        search = await executor.execute(tool_name="design.references.search", args={"query": "奶油风"}, bot=mgr, turn=turn, runtime=runtime)
        self.assertTrue(search["ok"])
        self.assertEqual(search["result"]["total"], 1)

        # 2. 关闭云端分析隐私开关 → 必须拒绝外发参考图
        cur = profile_store.read()
        p = cur["profile"]
        p.setdefault("privacy", {})["allow_cloud_analysis"] = False
        profile_store.update(p, expected_revision=cur["revision"])
        blocked = await executor.execute(tool_name="design.references.analyze", args={"item_id": item_id}, bot=mgr, turn=turn, runtime=runtime)
        self.assertFalse(blocked["ok"])
        self.assertEqual(blocked["code"], "privacy_disabled")
        self.assertEqual(len(host.calls), 0)

        # 3. 打开云端分析隐私开关 → 正常分析并写回参考库，二次读取走缓存
        cur2 = profile_store.read()
        p2 = cur2["profile"]
        p2.setdefault("privacy", {})["allow_cloud_analysis"] = True
        profile_store.update(p2, expected_revision=cur2["revision"])

        analyzed = await executor.execute(tool_name="design.references.analyze", args={"item_id": item_id}, bot=mgr, turn=turn, runtime=runtime)
        self.assertTrue(analyzed["ok"])
        self.assertFalse(analyzed["result"]["cached"])
        self.assertEqual(analyzed["result"]["analysis"]["lighting"], "侧逆柔光")

        cached = await executor.execute(tool_name="design.references.analyze", args={"item_id": item_id}, bot=mgr, turn=turn, runtime=runtime)
        self.assertTrue(cached["ok"])
        self.assertTrue(cached["result"]["cached"])
        self.assertEqual(len(host.calls), 1)

    async def test_plan_compose_batch_approval_and_review_check(self):
        good_img = _make_png(self.data_dir / "assets" / "good_1024.png", (1024, 1024))
        small_img = _make_png(self.data_dir / "assets" / "tiny_256.png", (256, 256))

        def responder(req):
            if "你是小美画布的真实自主代理" in req.system_prompt:
                return json.dumps({"tool": "agent.finish_task", "args": {"summary": "画布批量分镜创建完成", "result_refs": []}}, ensure_ascii=False)
            if "verdict" in req.system_prompt:
                return json.dumps({
                    "verdict": "pass",
                    "issues": [],
                    "summary": "主体完整，光线自然",
                }, ensure_ascii=False)
            return json.dumps({
                "direction": "清透冷萃玻璃质感，米白极简背景",
                "constraints_locked": ["保留真实壶身比例", "禁止错别字"],
                "acceptance": ["主体清晰", "留白均衡"],
                "shots": [
                    {"id": "shot_1", "kind": "main", "purpose": "首图正面展示", "size": "1024x1024", "prompt": "极简米白背景下透明玻璃冷泡茶壶正面特写", "acceptance": ["主体完整"]},
                    {"id": "shot_2", "kind": "main", "purpose": "倒茶细节特写", "size": "1024x1024", "prompt": "冰块落入茶汤的微距特写", "acceptance": ["光线自然"]},
                ],
            }, ensure_ascii=False)

        host = _DesignHost(self.data_dir, responder)
        host.output_map["/assets/good_1024.png"] = good_img
        host.output_map["/assets/tiny_256.png"] = small_img
        adapter = CanvasAgentAdapter(host, self.ma_store)
        executor = BotWorkspaceToolExecutor(host=host, store=self.bw_store, multi_agent_adapter=adapter)
        runtime = BotWorkspaceRuntime(host, self.bw_store, tool_executor=executor, multi_agent_adapter=adapter)
        runtime.heartbeat_canvas("proj_design", "cv_design")

        mgr = self.bw_store.get_bot(MANAGER_BOT_ID)
        sess = self.bw_store.ensure_default_session(MANAGER_BOT_ID, project_id="proj_design", canvas_id="cv_design")
        _, turn, _ = self.bw_store.enqueue_message_and_turn(sess["session_id"], content="规划并审查两张冷泡茶壶主图", project_id="proj_design", canvas_id="cv_design")

        try:
            # 1. 生成结构化设计方案（不直接生图）
            composed = await executor.execute(
                tool_name="design.plan.compose",
                args={"brief": "为透明玻璃冷泡茶壶规划 2 张社交媒体氛围海报", "shot_count": 2},
                bot=mgr, turn=turn, runtime=runtime,
            )
            self.assertTrue(composed["ok"])
            self.assertEqual(composed["message_kind"], "design_plan")
            self.assertEqual(len(composed["result"]["shots"]), 2)
            self.assertEqual(len(self.bw_store.list_run_links(turn_id=turn["turn_id"])), 0, "plan compose must not start generation")

            # 2. 批量方案落画布：未确认前必须先建审批单挂起，绝不私自写画布
            batch_pending = await executor.execute(
                tool_name="design.batch.canvas_plan",
                args={
                    "plan_title": "冷泡茶壶两张主图",
                    "direction": composed["result"]["direction"],
                    "shots": composed["result"]["shots"],
                    "confirmed": False,
                },
                bot=mgr, turn=turn, runtime=runtime,
            )
            self.assertTrue(batch_pending["ok"])
            self.assertEqual(batch_pending["suspend_status"], "waiting_approval")
            self.assertEqual(len(self.bw_store.list_run_links(turn_id=turn["turn_id"])), 0)

            # 用户批准审批 → 自动落入 multi_agent 画布执行引擎
            approval_id = batch_pending["result"]["approval_id"]
            resolved = self.bw_store.resolve_approval(approval_id, True)
            await executor.on_approval_resolved(resolved, runtime=runtime)
            links = self.bw_store.list_run_links(turn_id=turn["turn_id"])
            self.assertEqual(len(links), 1)

            # 3. 质检：默认关闭云端分析时不外发图片、诚实返回 needs_human
            r_private = await executor.execute(
                tool_name="design.review.check",
                args={"image": "/assets/good_1024.png", "expected_size": "1024x1024", "acceptance": ["主体完整"]},
                bot=mgr, turn=turn, runtime=runtime,
            )
            self.assertTrue(r_private["ok"])
            self.assertEqual(r_private["result"]["verdict"], "needs_human")

            # 开启云端视觉分析后：合规大图 pass；过小像素图（256x256）被本地质量规则拦截为 issues；不存在图片标 needs_human
            prof_store = DesignProfileStore(self.data_dir)
            cur_p = prof_store.read()
            prof_obj = cur_p["profile"]
            prof_obj.setdefault("privacy", {})["allow_cloud_analysis"] = True
            prof_store.update(prof_obj, expected_revision=cur_p["revision"])

            r_good = await executor.execute(
                tool_name="design.review.check",
                args={"image": "/assets/good_1024.png", "expected_size": "1024x1024", "acceptance": ["主体完整"]},
                bot=mgr, turn=turn, runtime=runtime,
            )
            self.assertTrue(r_good["ok"])
            self.assertEqual(r_good["result"]["verdict"], "pass")

            r_tiny = await executor.execute(
                tool_name="design.review.check",
                args={"image": "/assets/tiny_256.png", "expected_size": "1024x1024"},
                bot=mgr, turn=turn, runtime=runtime,
            )
            self.assertTrue(r_tiny["ok"])
            self.assertEqual(r_tiny["result"]["verdict"], "issues")

            r_missing = await executor.execute(
                tool_name="design.review.check",
                args={"image": "/assets/not_exist.png", "expected_size": "1024x1024"},
                bot=mgr, turn=turn, runtime=runtime,
            )
            self.assertTrue(r_missing["ok"])
            self.assertEqual(r_missing["result"]["verdict"], "needs_human")
        finally:
            await adapter.runtime.close()
            await runtime.close()


if __name__ == "__main__":
    unittest.main()
