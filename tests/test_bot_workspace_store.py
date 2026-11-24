"""P1 持久 Bot 工作区存储层、运行时与路由端到端测试。"""
from __future__ import annotations

import asyncio
import sqlite3
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace

from fastapi import FastAPI
from fastapi.testclient import TestClient

from bot_workspace_api import install_bot_workspace
from bot_workspace_config import MANAGER_BOT_ID
from bot_workspace_runtime import BotWorkspaceRuntime
from bot_workspace_store import (
    BotWorkspaceError,
    BotWorkspaceStore,
    MANAGER_ONLY_TOOLS,
    SPECIALIST_DEFAULT_TOOLS,
)


class _FakeLLMRequest:
    def __init__(self, **kwargs):
        self.__dict__.update(kwargs)


class _FakeHost:
    def __init__(self, data_dir: Path):
        self.DATA_DIR = data_dir
        self.CanvasLLMRequest = _FakeLLMRequest
        self.llm_calls = []
        self._providers = [
            {
                "id": "prov_alpha",
                "name": "Alpha API",
                "enabled": True,
                "protocol": "openai",
                "chat_models": ["alpha-chat-1", "alpha-chat-2"],
                "image_models": ["alpha-img-1"],
                "video_models": [],
            },
            {
                "id": "prov_beta",
                "name": "Beta API",
                "enabled": True,
                "protocol": "anthropic",
                "chat_models": ["beta-claude-1"],
                "image_models": [],
                "video_models": [],
            },
        ]
        self._skills = [
            {
                "id": "ecommerce_main_visual",
                "display_name": "电商主图策划",
                "description": "拆解主图视觉结构",
                "category": "ecommerce",
                "enabled": True,
                "lifecycle": "ready",
            }
        ]

    def load_api_providers(self):
        return list(self._providers)

    def get_api_provider_exact(self, pid: str):
        for p in self._providers:
            if p["id"] == pid:
                return p
        raise KeyError(pid)

    def list_agent_skill_records(self):
        return list(self._skills)

    def resolve_canvas_skill_request(self, skill_id: str):
        for item in self._skills:
            if item["id"] == skill_id:
                return item, f"# Skill {item['display_name']}\n严格按商品卖点拆解。"
        return None, ""

    async def canvas_llm(self, req):
        self.llm_calls.append({
            "provider": req.provider,
            "model": req.model,
            "message": req.message,
            "system_prompt": req.system_prompt,
        })
        return {"text": f"[{req.provider}/{req.model}] 已收到：{req.message}"}


class BotWorkspaceStoreTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.data_dir = Path(self.tmp.name) / "数据中文目录"
        self.store = BotWorkspaceStore(data_dir=self.data_dir)

    def tearDown(self):
        self.tmp.cleanup()

    def test_fresh_install_has_only_single_manager_bot(self):
        mgr, created = self.store.ensure_manager_bot()
        self.assertTrue(created)
        self.assertEqual(mgr["bot_id"], MANAGER_BOT_ID)
        self.assertTrue(mgr["is_manager"])

        # 再次调用幂等
        mgr2, created2 = self.store.ensure_manager_bot()
        self.assertFalse(created2)
        self.assertEqual(mgr2["bot_id"], MANAGER_BOT_ID)

        bots = self.store.list_bots(include_archived=True)
        self.assertEqual(len(bots), 1)
        self.assertEqual(bots[0]["bot_id"], MANAGER_BOT_ID)

        # 不允许通过业务接口创建第二个总管理
        with self.assertRaises(BotWorkspaceError) as ctx:
            self.store.create_bot({"name": "第二总管", "is_manager": True})
        self.assertEqual(ctx.exception.status, 403)

        # SQLite 部分唯一索引也必须兜底阻止第二个总管理
        with sqlite3.connect(str(self.store.path)) as conn:
            with self.assertRaises(sqlite3.IntegrityError):
                conn.execute(
                    "INSERT INTO bots(bot_id, name, avatar_json, is_manager, status, created_at, updated_at) "
                    "VALUES('bot_fake_mgr', '假总管', '{}', 1, 'active', 1, 1)"
                )

        # 不允许归档总管理
        with self.assertRaises(BotWorkspaceError) as arch_ctx:
            self.store.archive_bot(MANAGER_BOT_ID)
        self.assertEqual(arch_ctx.exception.status, 409)

    def test_two_bots_isolated_sessions_models_memories_and_persistence(self):
        self.store.ensure_manager_bot()
        bot_a = self.store.create_bot({
            "name": "主图文案师",
            "role": "负责主图卖点提炼",
            "chat_model": {"provider_id": "prov_alpha", "model": "alpha-chat-1"},
            "skill_ids": ["ecommerce_main_visual"],
        })
        bot_b = self.store.create_bot({
            "name": "色彩审校师",
            "role": "负责色调与对比度审校",
            "chat_model": {"provider_id": "prov_beta", "model": "beta-claude-1"},
        })

        # 独立多会话与消息隔离
        sess_a1 = self.store.create_session(bot_a["bot_id"], title="项目A会话", project_id="proj_a", canvas_id="cv_a")
        sess_a2 = self.store.create_session(bot_a["bot_id"], title="第二会话", project_id="proj_a", canvas_id="cv_a")
        sess_b1 = self.store.create_session(bot_b["bot_id"], title="审校会话", project_id="proj_b", canvas_id="cv_b")

        self.store.enqueue_message_and_turn(sess_a1["session_id"], content="给保温杯写主图卖点", idempotency_key="k_a1", project_id="proj_a", canvas_id="cv_a")
        self.store.enqueue_message_and_turn(sess_b1["session_id"], content="检查莫兰迪蓝绿配色", idempotency_key="k_b1", project_id="proj_b", canvas_id="cv_b")

        # 独立记忆隔离
        self.store.add_memory(bot_a["bot_id"], "主图标题不超过8个字", scope="bot")
        self.store.add_memory(bot_b["bot_id"], "禁止纯黑高饱和刺眼渐变", scope="bot")
        self.store.add_memory(MANAGER_BOT_ID, "全团队统一保持商品主体占比≥45%", scope="shared")

        # 普通 Bot 不能写 shared 记忆
        with self.assertRaises(BotWorkspaceError) as mem_ctx:
            self.store.add_memory(bot_a["bot_id"], "擅自写共享记忆", scope="shared")
        self.assertEqual(mem_ctx.exception.status, 403)

        # 模拟重启：全新打开同一路径 SQLite
        reopened = BotWorkspaceStore(data_dir=self.data_dir)
        bots_after = {b["bot_id"]: b for b in reopened.list_bots()}
        self.assertIn(bot_a["bot_id"], bots_after)
        self.assertIn(bot_b["bot_id"], bots_after)
        self.assertEqual(bots_after[bot_a["bot_id"]]["chat_model"]["model"], "alpha-chat-1")
        self.assertEqual(bots_after[bot_b["bot_id"]]["chat_model"]["model"], "beta-claude-1")
        self.assertEqual(bots_after[bot_a["bot_id"]]["skills"][0]["skill_id"], "ecommerce_main_visual")

        # 会话数量与消息隔离确认
        self.assertGreaterEqual(len(reopened.list_sessions(bot_a["bot_id"])), 3)  # 默认会话 + 2 个新会话
        self.assertEqual(len(reopened.list_messages(sess_a1["session_id"])["messages"]), 1)
        self.assertEqual(len(reopened.list_messages(sess_a2["session_id"])["messages"]), 0)
        self.assertEqual(len(reopened.list_messages(sess_b1["session_id"])["messages"]), 1)

        # 记忆隔离确认（A 看不到 B 的 bot 记忆，两者都可见 shared）
        ctx_a = reopened.memory_context_for(bot_a["bot_id"])
        ctx_b = reopened.memory_context_for(bot_b["bot_id"])
        self.assertIn("主图标题不超过8个字", ctx_a)
        self.assertNotIn("禁止纯黑高饱和刺眼渐变", ctx_a)
        self.assertIn("商品主体占比", ctx_a)
        self.assertIn("禁止纯黑高饱和刺眼渐变", ctx_b)
        self.assertNotIn("主图标题不超过8个字", ctx_b)

    def test_idempotency_dedup_and_conflict(self):
        self.store.ensure_manager_bot()
        sess = self.store.ensure_default_session(MANAGER_BOT_ID, project_id="p1", canvas_id="c1")
        m1, t1, created1 = self.store.enqueue_message_and_turn(
            sess["session_id"], content="生成主图方案", idempotency_key="req_dup_01", project_id="p1", canvas_id="c1"
        )
        m2, t2, created2 = self.store.enqueue_message_and_turn(
            sess["session_id"], content="生成主图方案", idempotency_key="req_dup_01", project_id="p1", canvas_id="c1"
        )
        self.assertTrue(created1)
        self.assertFalse(created2)
        self.assertEqual(m1["message_id"], m2["message_id"])
        self.assertEqual(t1["turn_id"], t2["turn_id"])

        # 同 key 不同内容必须 409 拒绝
        with self.assertRaises(BotWorkspaceError) as ctx:
            self.store.enqueue_message_and_turn(
                sess["session_id"], content="完全不同的内容", idempotency_key="req_dup_01", project_id="p1", canvas_id="c1"
            )
        self.assertEqual(ctx.exception.status, 409)

    def test_cross_project_write_rejected_and_secret_rejected(self):
        self.store.ensure_manager_bot()
        sess = self.store.create_session(MANAGER_BOT_ID, title="项目1会话", project_id="proj_one", canvas_id="cv_one")

        # 跨项目写入会话必须拒绝
        with self.assertRaises(BotWorkspaceError) as pm_ctx:
            self.store.enqueue_message_and_turn(
                sess["session_id"], content="试图跨项目发消息", project_id="proj_two", canvas_id="cv_two"
            )
        self.assertEqual(pm_ctx.exception.status, 403)

        # 含疑似 API Key 写入 Bot / 记忆 / 消息均必须拒绝
        with self.assertRaises(BotWorkspaceError) as sec1:
            self.store.create_bot({"name": "坏配置", "system_instructions": "使用密钥 sk-1234567890abcdef123456"})
        self.assertEqual(sec1.exception.code, "secret_rejected")

        with self.assertRaises(BotWorkspaceError) as sec2:
            self.store.add_memory(MANAGER_BOT_ID, "我的凭证 Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9")
        self.assertEqual(sec2.exception.code, "secret_rejected")

        with self.assertRaises(BotWorkspaceError) as sec3:
            self.store.enqueue_message_and_turn(
                sess["session_id"], content="api_key=abcdef1234567890", project_id="proj_one", canvas_id="cv_one"
            )
        self.assertEqual(sec3.exception.code, "secret_rejected")

    def test_permission_escalation_forbidden_and_archive_restore_and_recovery(self):
        self.store.ensure_manager_bot()
        # 普通 Bot 请求总管理权限或系统 Shell 权限必须 403
        for bad_tool in ("bot.create", "bot.archive", "shell.exec", "powershell"):
            with self.assertRaises(BotWorkspaceError) as ctx:
                self.store.create_bot({"name": f"越权_{bad_tool}", "tool_permissions": [bad_tool]})
            self.assertEqual(ctx.exception.status, 403)

        bot = self.store.create_bot({"name": "合规专家", "tool_permissions": list(SPECIALIST_DEFAULT_TOOLS)})
        # 普通 Bot 试图修改 is_manager 或给自己加 bot.create
        with self.assertRaises(BotWorkspaceError) as up1:
            self.store.update_bot(bot["bot_id"], {"is_manager": True})
        self.assertEqual(up1.exception.status, 403)
        with self.assertRaises(BotWorkspaceError) as up2:
            self.store.update_bot(bot["bot_id"], {"tool_permissions": ["bot.create"]})
        self.assertEqual(up2.exception.status, 403)

        # 归档后不可发消息，恢复后正常
        archived = self.store.archive_bot(bot["bot_id"], reason="暂停")
        self.assertEqual(archived["status"], "archived")
        self.assertNotIn(bot["bot_id"], [b["bot_id"] for b in self.store.list_bots(include_archived=False)])
        self.assertIn(bot["bot_id"], [b["bot_id"] for b in self.store.list_bots(include_archived=True)])

        sess = self.store.list_sessions(bot["bot_id"])[0]
        with self.assertRaises(BotWorkspaceError) as send_arch:
            self.store.enqueue_message_and_turn(sess["session_id"], content="已归档发消息")
        self.assertEqual(send_arch.exception.status, 409)

        restored = self.store.restore_bot(bot["bot_id"])
        self.assertEqual(restored["status"], "active")
        _, turn, _ = self.store.enqueue_message_and_turn(sess["session_id"], content="恢复后发消息")

        # 模拟运行中断与重启恢复
        self.store.update_turn(turn["turn_id"], status="running")
        rec = self.store.recover_after_restart()
        self.assertEqual(rec["interrupted_turns"], 1)
        after_turn = self.store.get_turn(turn["turn_id"])
        self.assertEqual(after_turn["status"], "recovery_required")
        self.assertTrue(after_turn["recovery_required"])


class BotWorkspaceApiAndRuntimeTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.data_dir = Path(self.tmp.name) / "工作区测试"
        self.host = _FakeHost(self.data_dir)
        self.app = FastAPI()
        self.bundle = install_bot_workspace(self.app, self.host, data_dir=self.data_dir, auto_migrate=False)
        self.client = TestClient(self.app)
        self.origin_headers = {"Origin": "http://testserver"}

    def tearDown(self):
        self.client.close()
        self.tmp.cleanup()

    def test_api_two_bots_independent_chat_and_models(self):
        with TestClient(self.app) as client:
            cfg = client.get("/api/bot-workspace/config").json()
            self.assertEqual(cfg["manager_bot_id"], MANAGER_BOT_ID)
            self.assertEqual(len(cfg["providers"]), 2)

            bots = client.get("/api/bot-workspace/bots").json()["bots"]
            self.assertEqual([b["bot_id"] for b in bots], [MANAGER_BOT_ID])

            # 共享画布访问必须 403
            shared_res = client.get("/api/bot-workspace/bots", headers={"x-xiaomei-share-gateway": "1"})
            self.assertEqual(shared_res.status_code, 403)

            # 缺 Origin 的写请求必须 403
            no_origin = client.post("/api/bot-workspace/bots", json={"name": "无来源"})
            self.assertEqual(no_origin.status_code, 403)

            # 创建两个使用不同动态模型的永久 Bot
            r_a = client.post(
                "/api/bot-workspace/bots",
                headers=self.origin_headers,
                json={"name": "文案专家", "chat_model": {"provider_id": "prov_alpha", "model": "alpha-chat-2"}},
            )
            self.assertEqual(r_a.status_code, 200, r_a.text)
            bot_a = r_a.json()["bot"]

            r_b = client.post(
                "/api/bot-workspace/bots",
                headers=self.origin_headers,
                json={"name": "审校专家", "chat_model": {"provider_id": "prov_beta", "model": "beta-claude-1"}},
            )
            self.assertEqual(r_b.status_code, 200, r_b.text)
            bot_b = r_b.json()["bot"]

            # 不在动态列表中的模型应被拒绝
            bad_model = client.post(
                "/api/bot-workspace/bots",
                headers=self.origin_headers,
                json={"name": "无效模型", "chat_model": {"provider_id": "prov_alpha", "model": "non-existent-model"}},
            )
            self.assertEqual(bad_model.status_code, 422)

            # 分别发送消息并等待事件驱动调度完成
            sess_a = client.get(f"/api/bot-workspace/bots/{bot_a['bot_id']}/sessions").json()["sessions"][0]
            sess_b = client.get(f"/api/bot-workspace/bots/{bot_b['bot_id']}/sessions").json()["sessions"][0]

            send_a = client.post(
                f"/api/bot-workspace/sessions/{sess_a['session_id']}/messages",
                headers=self.origin_headers,
                json={"content": "写一句杯子主图文案", "idempotency_key": "api_a_1"},
            )
            send_b = client.post(
                f"/api/bot-workspace/sessions/{sess_b['session_id']}/messages",
                headers=self.origin_headers,
                json={"content": "检查配色对比度", "idempotency_key": "api_b_1"},
            )
            self.assertEqual(send_a.status_code, 200)
            self.assertEqual(send_b.status_code, 200)

            # 轮询确认两个独立回合均使用各自模型完成
            import time
            deadline = time.time() + 5.0
            while time.time() < deadline:
                ta = client.get(f"/api/bot-workspace/turns/{send_a.json()['turn']['turn_id']}").json()["turn"]
                tb = client.get(f"/api/bot-workspace/turns/{send_b.json()['turn']['turn_id']}").json()["turn"]
                if ta["status"] == "completed" and tb["status"] == "completed":
                    break
                time.sleep(0.05)

            msgs_a = client.get(f"/api/bot-workspace/sessions/{sess_a['session_id']}/messages").json()["messages"]
            msgs_b = client.get(f"/api/bot-workspace/sessions/{sess_b['session_id']}/messages").json()["messages"]
            self.assertEqual(len(msgs_a), 2)
            self.assertEqual(len(msgs_b), 2)
            self.assertIn("[prov_alpha/alpha-chat-2]", msgs_a[-1]["content"])
            self.assertIn("[prov_beta/beta-claude-1]", msgs_b[-1]["content"])

            # 增量事件拉取应包含新事件
            poll = client.get("/api/bot-workspace/events/poll?after=0").json()
            self.assertGreater(poll["cursor"], 0)
            self.assertTrue(any(e["event_type"] == "message_created" for e in poll["events"]))


if __name__ == "__main__":
    unittest.main()
