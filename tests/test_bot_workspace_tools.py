"""P2 统一 Bot 管理工具、权限边界校验、自然语言建 Bot 与跨 Bot 委派测试。"""
from __future__ import annotations

import asyncio
import json
import tempfile
import unittest
from pathlib import Path

from bot_workspace_config import MANAGER_BOT_ID
from bot_workspace_runtime import BotWorkspaceRuntime
from bot_workspace_store import BotWorkspaceStore, SPECIALIST_DEFAULT_TOOLS
from bot_workspace_tools import BotWorkspaceToolExecutor


class _FakeLLMRequest:
    def __init__(self, **kwargs):
        self.__dict__.update(kwargs)


class _ScriptedHost:
    def __init__(self, data_dir: Path, responder):
        self.DATA_DIR = data_dir
        self.CanvasLLMRequest = _FakeLLMRequest
        self.responder = responder
        self.calls = []
        self._providers = [
            {
                "id": "prov_alpha",
                "name": "Alpha",
                "enabled": True,
                "protocol": "openai",
                "chat_models": ["alpha-mgr", "alpha-fast"],
                "image_models": ["alpha-img"],
                "video_models": [],
            },
            {
                "id": "prov_beta",
                "name": "Beta",
                "enabled": True,
                "protocol": "anthropic",
                "chat_models": ["beta-writer"],
                "image_models": [],
                "video_models": [],
            },
        ]

    def load_api_providers(self):
        return list(self._providers)

    def get_api_provider_exact(self, pid: str):
        for p in self._providers:
            if p["id"] == pid:
                return p
        raise KeyError(pid)

    async def canvas_llm(self, req):
        self.calls.append({
            "provider": req.provider,
            "model": req.model,
            "message": req.message,
            "messages": list(req.messages or []),
            "system_prompt": req.system_prompt,
        })
        text = self.responder(req, len(self.calls))
        if asyncio.iscoroutine(text):
            text = await text
        return {"text": text}


async def _wait_turn(store: BotWorkspaceStore, turn_id: str, target_statuses=("completed", "failed", "cancelled"), timeout: float = 5.0):
    loop = asyncio.get_running_loop()
    deadline = loop.time() + timeout
    while loop.time() < deadline:
        turn = store.get_turn(turn_id)
        if turn["status"] in target_statuses:
            return turn
        await asyncio.sleep(0.03)
    return store.get_turn(turn_id)


class BotWorkspaceToolsTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.data_dir = Path(self.tmp.name) / "工具协议测试"
        self.store = BotWorkspaceStore(data_dir=self.data_dir)
        self.store.ensure_manager_bot()
        self.store.update_bot(MANAGER_BOT_ID, {"chat_model": {"provider_id": "prov_alpha", "model": "alpha-mgr"}})

    async def asyncTearDown(self):
        self.tmp.cleanup()

    async def test_natural_language_create_update_archive_restore_bot(self):
        created_id_holder = {}

        def responder(req, idx):
            if idx == 1:
                return json.dumps({
                    "reply": "好的，我来帮你创建这位永久专业 Bot。",
                    "tool_call": {
                        "tool": "bot.create",
                        "args": {
                            "name": "主图策划专家",
                            "role": "负责电商主图卖点拆解与构图策划",
                            "system_instructions": "输出前先提炼三大核心卖点，再给出主图排版建议。",
                            "chat_model": {"provider_id": "prov_beta", "model": "beta-writer"},
                            "skill_ids": ["ecommerce_main_visual"],
                            "tool_permissions": ["bot.list", "bot.read", "memory.read", "memory.remember", "canvas.read"],
                        },
                    },
                }, ensure_ascii=False)
            return "已为你创建永久 Bot「主图策划专家」，并绑定了独立模型 beta-writer 和电商主图技能。"

        host = _ScriptedHost(self.data_dir, responder)
        executor = BotWorkspaceToolExecutor(host=host, store=self.store)
        runtime = BotWorkspaceRuntime(host, self.store, tool_executor=executor)
        await runtime.start()
        try:
            sess = self.store.ensure_default_session(MANAGER_BOT_ID)
            _, turn, _ = runtime.enqueue_user_message(sess["session_id"], content="帮我创建一个主图策划专家永久 Bot")
            final_turn = await _wait_turn(self.store, turn["turn_id"])
            self.assertEqual(final_turn["status"], "completed")

            bots = self.store.list_bots(include_archived=False)
            self.assertEqual(len(bots), 2)
            spec = [b for b in bots if not b["is_manager"]][0]
            created_id_holder["id"] = spec["bot_id"]
            self.assertEqual(spec["name"], "主图策划专家")
            self.assertEqual(spec["chat_model"]["model"], "beta-writer")
            self.assertEqual(spec["skills"][0]["skill_id"], "ecommerce_main_visual")
            self.assertFalse(spec["is_manager"])

            # 测试 bot.read / bot.update / bot.archive / bot.restore 直接通过执行器权限验证
            mgr = self.store.get_bot(MANAGER_BOT_ID)
            mgr_turn = self.store.get_turn(turn["turn_id"])

            read_out = await executor.execute(tool_name="bot.read", args={"name": "主图策划专家"}, bot=mgr, turn=mgr_turn, runtime=runtime)
            self.assertTrue(read_out["ok"])
            self.assertEqual(read_out["result"]["bot"]["bot_id"], spec["bot_id"])

            upd_out = await executor.execute(
                tool_name="bot.update",
                args={"bot_id": spec["bot_id"], "role": "电商主图与首屏转化专家"},
                bot=mgr, turn=mgr_turn, runtime=runtime,
            )
            self.assertTrue(upd_out["ok"])
            self.assertEqual(self.store.get_bot(spec["bot_id"])["role"], "电商主图与首屏转化专家")

            arch_out = await executor.execute(
                tool_name="bot.archive",
                args={"bot_id": spec["bot_id"], "reason": "阶段性归档"},
                bot=mgr, turn=mgr_turn, runtime=runtime,
            )
            self.assertTrue(arch_out["ok"])
            self.assertEqual(self.store.get_bot(spec["bot_id"])["status"], "archived")

            rest_out = await executor.execute(
                tool_name="bot.restore",
                args={"bot_id": spec["bot_id"]},
                bot=mgr, turn=mgr_turn, runtime=runtime,
            )
            self.assertTrue(rest_out["ok"])
            self.assertEqual(self.store.get_bot(spec["bot_id"])["status"], "active")
        finally:
            await runtime.close()

    async def test_specialist_permission_escalation_and_forbidden_tools_blocked(self):
        host = _ScriptedHost(self.data_dir, lambda req, idx: "ok")
        executor = BotWorkspaceToolExecutor(host=host, store=self.store)
        runtime = BotWorkspaceRuntime(host, self.store, tool_executor=executor)

        spec = self.store.create_bot({
            "name": "普通专业助手",
            "tool_permissions": list(SPECIALIST_DEFAULT_TOOLS),
        })
        spec_sess = self.store.ensure_default_session(spec["bot_id"])
        _, spec_turn, _ = self.store.enqueue_message_and_turn(spec_sess["session_id"], content="测试权限")

        # 1. 普通 Bot 调用总管理工具必须被拒绝（哪怕调用方伪造 bot dict 中的 is_manager=True）
        forged_bot = {**spec, "is_manager": True, "tool_permissions": ["bot.create", "bot.archive"]}
        for tool, args in (
            ("bot.create", {"name": "非法新Bot"}),
            ("bot.update", {"bot_id": spec["bot_id"], "role": "提权"}),
            ("bot.archive", {"bot_id": MANAGER_BOT_ID}),
            ("bot.restore", {"bot_id": spec["bot_id"]}),
        ):
            out = await executor.execute(tool_name=tool, args=args, bot=forged_bot, turn=spec_turn, runtime=runtime)
            self.assertFalse(out["ok"], f"{tool} must be rejected for specialist bot")
            self.assertEqual(out["code"], "permission_denied")

        # 2. 系统 Shell 工具必须永远被拦截
        for bad_tool in ("shell.exec", "powershell", "bash", "os.system"):
            out = await executor.execute(tool_name=bad_tool, args={"cmd": "whoami"}, bot=self.store.get_bot(MANAGER_BOT_ID), turn=spec_turn, runtime=runtime)
            self.assertFalse(out["ok"])
            self.assertEqual(out["code"], "forbidden_tool")

        # 3. 总管理也不能通过 bot.create 创建第二个总管理，或给子 Bot 授予 bot.create
        mgr = self.store.get_bot(MANAGER_BOT_ID)
        mgr_sess = self.store.ensure_default_session(MANAGER_BOT_ID)
        _, mgr_turn, _ = self.store.enqueue_message_and_turn(mgr_sess["session_id"], content="校验边界")

        bad_mgr = await executor.execute(
            tool_name="bot.create", args={"name": "二号总管", "is_manager": True},
            bot=mgr, turn=mgr_turn, runtime=runtime,
        )
        self.assertFalse(bad_mgr["ok"])
        self.assertEqual(bad_mgr["code"], "manager_unique")

        bad_perm = await executor.execute(
            tool_name="bot.create", args={"name": "越权子Bot", "tool_permissions": ["bot.create", "bot.list"]},
            bot=mgr, turn=mgr_turn, runtime=runtime,
        )
        self.assertFalse(bad_perm["ok"])
        self.assertEqual(bad_perm["code"], "permission_escalation")

        # 4. 普通 Bot 不能写入 shared 记忆，也不能存敏感密钥
        bad_shared = await executor.execute(
            tool_name="memory.remember", args={"content": "企图污染全局共享记忆", "scope": "shared"},
            bot=spec, turn=spec_turn, runtime=runtime,
        )
        self.assertFalse(bad_shared["ok"])
        self.assertEqual(bad_shared["code"], "forbidden")

        bad_secret = await executor.execute(
            tool_name="memory.remember", args={"content": "密钥是 sk-1234567890abcdefghijklmnop", "scope": "bot"},
            bot=spec, turn=spec_turn, runtime=runtime,
        )
        self.assertFalse(bad_secret["ok"])
        self.assertEqual(bad_secret["code"], "secret_rejected")

    async def test_cross_bot_delegation_roundtrip_and_cycle_prevention(self):
        writer = self.store.create_bot({
            "name": "文案专家",
            "role": "电商卖点文案撰写",
            "chat_model": {"provider_id": "prov_beta", "model": "beta-writer"},
            "tool_permissions": ["bot.list", "bot.read", "bot.delegate", "memory.read", "memory.remember", "canvas.read"],
            "delegation_policy": {"allow_delegate": True, "max_delegation_depth": 2},
        })

        def responder(req, idx):
            # 1) 总管理收到用户消息 → 委派给文案专家
            if req.model == "alpha-mgr" and "[跨 Bot 委派消息]" not in req.message:
                return json.dumps({
                    "reply": "我把卖点文案任务委派给文案专家。",
                    "tool_call": {
                        "tool": "bot.delegate",
                        "args": {
                            "target_bot_id": writer["bot_id"],
                            "goal": "为冰感防晒衣提炼 3 条核心卖点",
                            "instructions": "每条不超过 12 字",
                            "granted_permissions": ["bot.read", "memory.read", "canvas.read"],
                            "wait_for_result": True,
                        },
                    },
                }, ensure_ascii=False)
            # 2) 文案专家用独立模型 beta-writer 执行
            if req.model == "beta-writer":
                return "1. UPF50+全波段防晒\n2. 接触瞬间凉感降温\n3. 轻盈透气不闷汗"
            # 3) 总管理被委派结果唤醒，汇总给用户
            return f"文案专家已完成提炼，以下是最终汇总：\n{req.message}"

        host = _ScriptedHost(self.data_dir, responder)
        executor = BotWorkspaceToolExecutor(host=host, store=self.store)
        runtime = BotWorkspaceRuntime(host, self.store, tool_executor=executor)
        await runtime.start()
        try:
            sess = self.store.ensure_default_session(MANAGER_BOT_ID, project_id="proj_sun", canvas_id="cv_sun")
            _, turn, _ = runtime.enqueue_user_message(
                sess["session_id"], content="帮我出防晒衣主图卖点", project_id="proj_sun", canvas_id="cv_sun"
            )
            finished = await _wait_turn(self.store, turn["turn_id"], timeout=6.0)
            self.assertEqual(finished["status"], "completed")
            self.assertIn("UPF50+", finished["result_summary"])

            # 校验两次模型调用分别用了 alpha-mgr 与 beta-writer
            models_used = [c["model"] for c in host.calls]
            self.assertIn("alpha-mgr", models_used)
            self.assertIn("beta-writer", models_used)

            # 校验委派记录与权限交集
            delegations = self.store.list_delegations(parent_turn_id=turn["turn_id"])
            self.assertEqual(len(delegations), 1)
            del_rec = delegations[0]
            self.assertEqual(del_rec["status"], "completed")
            self.assertEqual(set(del_rec["granted_permissions"]), {"bot.read", "memory.read", "canvas.read"})

            # 循环委派检测：子回合试图反向委派回总管理必须报错 delegation_cycle
            child_turn = self.store.get_turn(del_rec["target_turn_id"])
            # 临时给子回合补上 bot.delegate 权限快照来验证循环拦截本身
            cycle_turn = {**child_turn, "permission_snapshot": {**child_turn["permission_snapshot"], "tool_permissions": ["bot.delegate"]}}
            cycle_out = await executor.execute(
                tool_name="bot.delegate",
                args={"target_bot_id": MANAGER_BOT_ID, "goal": "反推回总管理"},
                bot=writer, turn=cycle_turn, runtime=runtime,
            )
            self.assertFalse(cycle_out["ok"])
            self.assertEqual(cycle_out["code"], "delegation_cycle")
        finally:
            await runtime.close()

    async def test_cancel_task_cascades_and_restricts_unauthorized_cancel(self):
        spec = self.store.create_bot({"name": "执行助理", "tool_permissions": list(SPECIALIST_DEFAULT_TOOLS) + ["bot.cancel_task"]})
        host = _ScriptedHost(self.data_dir, lambda req, idx: "ok")
        executor = BotWorkspaceToolExecutor(host=host, store=self.store)
        runtime = BotWorkspaceRuntime(host, self.store, tool_executor=executor)

        mgr_sess = self.store.ensure_default_session(MANAGER_BOT_ID)
        _, mgr_turn, _ = self.store.enqueue_message_and_turn(mgr_sess["session_id"], content="父任务")
        delegation, child_turn, _ = self.store.create_delegation(
            parent_bot_id=MANAGER_BOT_ID,
            parent_session_id=mgr_sess["session_id"],
            parent_turn_id=mgr_turn["turn_id"],
            target_bot_id=spec["bot_id"],
            goal="子任务",
        )

        # 普通 Bot 试图取消总管理的父任务必须拒绝
        unauth = await executor.execute(
            tool_name="bot.cancel_task",
            args={"turn_id": mgr_turn["turn_id"], "reason": "越权取消"},
            bot=spec, turn=child_turn, runtime=runtime,
        )
        self.assertFalse(unauth["ok"])
        self.assertEqual(unauth["code"], "forbidden")

        # 总管理取消委派 → 子回合与委派均变为 cancelled
        mgr = self.store.get_bot(MANAGER_BOT_ID)
        ok_cancel = await executor.execute(
            tool_name="bot.cancel_task",
            args={"delegation_id": delegation["delegation_id"], "reason": "需求已取消"},
            bot=mgr, turn=mgr_turn, runtime=runtime,
        )
        self.assertTrue(ok_cancel["ok"])
        self.assertEqual(self.store.get_turn(child_turn["turn_id"])["status"], "cancelled")
        self.assertEqual(self.store.get_delegation(delegation["delegation_id"])["status"], "cancelled")


if __name__ == "__main__":
    unittest.main()
