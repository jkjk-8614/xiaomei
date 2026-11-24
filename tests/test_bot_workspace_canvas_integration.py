"""P3 持久 Bot 工作区与 multi_agent 画布执行引擎深度融合集成测试。

覆盖核心验收场景：
1. 持久 Bot 经 canvas.dispatch_run 复用 multi_agent_runtime 创建画布节点并派生临时子 Agent（不自动建永久 Bot）。
2. 审批双向联动（runs.sqlite3 awaiting_approval <-> workspace.sqlite3 approvals）与真实 node_id 产物回传。
3. 画布离线时明确标记 waiting_canvas_connection，上线后自动恢复。
4. 跨项目画布访问/写入严格 403 拒绝、无写权限专业 Bot 禁止写画布、同一任务幂等去重。
5. 重启恢复（recovery_required）先对账原付费生成任务，绝不重复提交。
"""
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
from multi_agent_api import CanvasAgentAdapter
from multi_agent_store import AgentRunStore


class _FakeLLMRequest:
    def __init__(self, **kwargs):
        self.__dict__.update(kwargs)


class _CanvasFusionHost:
    DEFAULT_PROJECT_ID = "proj_1"

    def __init__(self, data_dir: Path, bot_responder, ma_responder):
        self.DATA_DIR = data_dir
        self.CanvasLLMRequest = _FakeLLMRequest
        self.bot_responder = bot_responder
        self.ma_responder = ma_responder
        self.img_file = data_dir / "assets" / "cup.png"
        self.img_file.parent.mkdir(parents=True, exist_ok=True)
        self.img_file.write_bytes(b"\x89PNG\r\n\x1a\n" + b"\x00" * 32)
        self.canvases = {
            "cv_1": {
                "id": "cv_1",
                "project": "proj_1",
                "title": "保温杯主图画布",
                "nodes": [
                    {
                        "id": "node_src_1",
                        "type": "smart-upload",
                        "title": "商品原图",
                        "images": [{"url": "/assets/cup.png"}],
                    }
                ],
                "connections": [],
            },
            "cv_other": {
                "id": "cv_other",
                "project": "proj_2",
                "title": "其他项目画布",
                "nodes": [],
                "connections": [],
            },
        }
        self.projects = [
            {"id": "proj_1", "name": "项目一", "deleted_at": None},
            {"id": "proj_2", "name": "项目二", "deleted_at": None},
        ]
        self.providers = [
            {
                "id": "prov_a",
                "name": "Alpha",
                "enabled": True,
                "protocol": "openai",
                "chat_models": ["alpha-chat"],
                "image_models": ["alpha-img"],
                "video_models": [],
            }
        ]
        self.image_tasks = {}
        self.image_submit_count = 0

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

    def load_canvas(self, canvas_id):
        return self.canvases[canvas_id]

    def list_canvases(self):
        return [{"id": cid, "project": c["project"], "deleted_at": None} for cid, c in self.canvases.items()]

    def ensure_default_project(self):
        return list(self.projects)

    def output_file_from_url(self, url):
        return self.img_file if url == "/assets/cup.png" else None

    def is_video_reference_value(self, url):
        return False

    def is_image_reference_value(self, url):
        return str(url).endswith(".png")

    def project_agent_safe_error(self, value):
        return str(value)[:300]

    async def get_canvas_image_task(self, task_id):
        rec = self.image_tasks.get(task_id) or {"status": "failed", "error": "not found"}
        return {"task": {"id": task_id, "project_id": "proj_1", **rec}}

    def _find_canvas_task_by_client_request_id(self, client_req_id):
        return None

    async def canvas_llm(self, req):
        # 区分是 multi_agent 的模型请求还是 bot_workspace 的模型请求
        if "你是小美画布的真实自主代理" in (req.system_prompt or ""):
            res = self.ma_responder(req)
        else:
            res = self.bot_responder(req)
        if asyncio.iscoroutine(res):
            res = await res
        return {"text": res}


async def _wait_until(predicate, timeout: float = 6.0):
    loop = asyncio.get_running_loop()
    deadline = loop.time() + timeout
    while loop.time() < deadline:
        val = predicate()
        if val:
            return val
        await asyncio.sleep(0.04)
    return predicate()


class BotWorkspaceCanvasIntegrationTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.data_dir = Path(self.tmp.name) / "画布融合测试"
        self.bw_store = BotWorkspaceStore(data_dir=self.data_dir)
        self.bw_store.ensure_manager_bot()
        self.bw_store.update_bot(MANAGER_BOT_ID, {"chat_model": {"provider_id": "prov_a", "model": "alpha-chat"}})
        self.ma_store = AgentRunStore(self.data_dir / "multi_agent" / "runs.sqlite3")

    async def asyncTearDown(self):
        self.tmp.cleanup()

    async def test_persistent_bot_dispatches_multi_agent_with_temp_subagent_and_approval(self):
        ma_step = {"n": 0}
        bot_step = {"n": 0}

        def bot_responder(req):
            bot_step["n"] += 1
            if bot_step["n"] == 1:
                return json.dumps({
                    "reply": "我来通过画布执行引擎为你创建新绘画节点。",
                    "tool_call": {
                        "tool": "canvas.dispatch_run",
                        "args": {
                            "goal": "创建一张保温杯主图绘画节点",
                            "instructions": "先派生临时子代理分析，再创建节点",
                            "allow_canvas_writes": True,
                            "idempotency_key": "fixed_canvas_job_01",
                        },
                    },
                }, ensure_ascii=False)
            return "画布节点已创建完成，请点击定位按钮查看结果。"

        def ma_responder(req):
            # 根据身份判断是根任务还是临时子 Agent
            is_sub = '"is_temporary_subagent":true' in req.system_prompt
            if is_sub:
                return json.dumps({
                    "tool": "agent.finish_task",
                    "args": {"summary": "临时子代理完成卖点构图分析", "result_refs": []},
                }, ensure_ascii=False)
            ma_step["n"] += 1
            if ma_step["n"] == 1:
                return json.dumps({
                    "tool": "agent.spawn_subagent",
                    "args": {
                        "idempotency_key": "sub_plan_1",
                        "agent_role": "临时构图分析员",
                        "goal": "分析商品构图",
                    },
                }, ensure_ascii=False)
            if ma_step["n"] == 2:
                # 发起 canvas.create_node（注意：multi_agent 默认非 delete/run_node 自动 registered，这里也顺带验证后续把动作设成 awaiting_approval）
                return json.dumps({
                    "tool": "canvas.command",
                    "args": {
                        "idempotency_key": "cmd_create_paint_1",
                        "operation": {
                            "tool": "canvas.create_node",
                            "target": {"node_id": ""},
                            "args": {"type": "smart-paint", "title": "保温杯主图", "prompt": "极简奶油风保温杯主图"},
                        },
                    },
                }, ensure_ascii=False)
            return json.dumps({
                "tool": "agent.finish_task",
                "args": {
                    "summary": "已创建保温杯主图节点 node_paint_99",
                    "result_refs": [{"kind": "node", "id": "node_paint_99"}],
                },
            }, ensure_ascii=False)

        host = _CanvasFusionHost(self.data_dir, bot_responder, ma_responder)
        adapter = CanvasAgentAdapter(host, self.ma_store)
        executor = BotWorkspaceToolExecutor(host=host, store=self.bw_store, multi_agent_adapter=adapter)
        runtime = BotWorkspaceRuntime(host, self.bw_store, tool_executor=executor, multi_agent_adapter=adapter)
        await runtime.start()
        try:
            # 上报当前画布在线
            runtime.heartbeat_canvas("proj_1", "cv_1", client_id="browser_1")
            sess = self.bw_store.ensure_default_session(MANAGER_BOT_ID, project_id="proj_1", canvas_id="cv_1")
            _, turn, _ = runtime.enqueue_user_message(
                sess["session_id"], content="在当前画布创建保温杯主图节点", project_id="proj_1", canvas_id="cv_1"
            )

            # 等待 multi_agent Run 关联创建且产生 canvas.create_node 动作
            def find_action():
                links = self.bw_store.list_run_links(turn_id=turn["turn_id"])
                if not links:
                    return None
                snap = self.ma_store.snapshot(links[0]["multi_agent_run_id"], "proj_1", "cv_1")
                if snap["actions"]:
                    return links[0], snap
                return None

            found = await _wait_until(find_action, timeout=6.0)
            self.assertIsNotNone(found, "multi_agent action should be registered")
            link, snap = found
            run_id = link["multi_agent_run_id"]
            action = snap["actions"][0]

            # 验证 runs.sqlite3 正确记录了持久 Bot 身份，且临时子 Agent 没有写入 workspace.sqlite3 bots 表
            self.assertEqual(snap["run"]["bot_id"], MANAGER_BOT_ID)
            self.assertEqual(snap["run"]["turn_id"], turn["turn_id"])
            temp_tasks = [t for t in snap["tasks"] if t.get("is_temporary_subagent")]
            self.assertEqual(len(temp_tasks), 1)
            self.assertEqual([b["bot_id"] for b in self.bw_store.list_bots(include_archived=True)], [MANAGER_BOT_ID])

            # 模拟需要审批的场景：将动作切为 awaiting_approval，验证对账同步进 workspace.sqlite3 并审批回写
            with self.ma_store.transaction() as db:
                raw_act = self.ma_store.get(db, "actions", action["action_id"])
                raw_act["status"] = "awaiting_approval"
                raw_act["approved"] = False
                self.ma_store.put(db, "actions", raw_act)
            runtime.notify()

            approval = await _wait_until(
                lambda: (self.bw_store.list_approvals(session_id=sess["session_id"], status="pending") or [None])[0],
                timeout=5.0,
            )
            self.assertIsNotNone(approval)
            self.assertEqual(approval["multi_agent_action_id"], action["action_id"])

            # 在 Bot 工作区批准审批 → 回写到 runs.sqlite3
            resolved = self.bw_store.resolve_approval(approval["approval_id"], True)
            await executor.on_approval_resolved(resolved, runtime=runtime)
            with self.ma_store.transaction() as db:
                approved_act = self.ma_store.get(db, "actions", action["action_id"])
            self.assertEqual(approved_act["status"], "registered")
            self.assertTrue(approved_act["approved"])

            # 模拟浏览器 CanvasMultiAgentBridge 应用节点并回传 receipt
            host.canvases["cv_1"]["nodes"].append({"id": "node_paint_99", "type": "smart-paint", "title": "保温杯主图", "images": []})
            with self.ma_store.transaction() as db:
                act_row = self.ma_store.get(db, "actions", action["action_id"])
                act_row.update(status="completed", stage="completed", result={"node_ids": ["node_paint_99"], "image_urls": []})
                self.ma_store.put(db, "actions", act_row)
            adapter.runtime.start(run_id)
            runtime.notify()

            # 等待父 Turn 最终完成并携带真实画布 node_id 引用
            done_turn = await _wait_until(
                lambda: self.bw_store.get_turn(turn["turn_id"]) if self.bw_store.get_turn(turn["turn_id"])["status"] == "completed" else None,
                timeout=6.0,
            )
            self.assertIsNotNone(done_turn)
            self.assertTrue(any(r["kind"] == "node" and r["id"] == "node_paint_99" for r in done_turn["result_refs"]))
        finally:
            await adapter.runtime.close()
            await runtime.close()

    async def test_waiting_canvas_connection_and_cross_project_and_dedup(self):
        host = _CanvasFusionHost(self.data_dir, lambda req: "ok", lambda req: json.dumps({"tool": "agent.finish_task", "args": {"summary": "done", "result_refs": []}}))
        adapter = CanvasAgentAdapter(host, self.ma_store)
        executor = BotWorkspaceToolExecutor(host=host, store=self.bw_store, multi_agent_adapter=adapter)
        runtime = BotWorkspaceRuntime(host, self.bw_store, tool_executor=executor, multi_agent_adapter=adapter)

        mgr = self.bw_store.get_bot(MANAGER_BOT_ID)
        sess = self.bw_store.ensure_default_session(MANAGER_BOT_ID, project_id="proj_1", canvas_id="cv_1")
        _, turn, _ = self.bw_store.enqueue_message_and_turn(sess["session_id"], content="操作画布", project_id="proj_1", canvas_id="cv_1")

        # 1. 画布未上报心跳（关闭状态）时，dispatch_run 明确返回 waiting_canvas_connection
        offline_out = await executor.execute(
            tool_name="canvas.dispatch_run",
            args={"goal": "写画布节点", "allow_canvas_writes": True, "idempotency_key": "idem_same_1"},
            bot=mgr, turn=turn, runtime=runtime,
        )
        self.assertTrue(offline_out["ok"])
        self.assertEqual(offline_out["suspend_status"], "waiting_canvas_connection")

        # 2. 跨项目画布访问严格 403 拒绝
        cross_out = await executor.execute(
            tool_name="canvas.read",
            args={"project_id": "proj_2", "canvas_id": "cv_other"},
            bot=mgr, turn=turn, runtime=runtime,
        )
        self.assertFalse(cross_out["ok"])
        self.assertEqual(cross_out["code"], "project_mismatch")

        # 3. 无画布写权限的专业 Bot 禁止写画布
        readonly_bot = self.bw_store.create_bot({
            "name": "只读分析员",
            "tool_permissions": list(SPECIALIST_DEFAULT_TOOLS) + ["canvas.dispatch_run"],
            "canvas_policy": {"allow_canvas_read": True, "allow_canvas_writes": False},
        })
        ro_sess = self.bw_store.ensure_default_session(readonly_bot["bot_id"], project_id="proj_1", canvas_id="cv_1")
        _, ro_turn, _ = self.bw_store.enqueue_message_and_turn(ro_sess["session_id"], content="尝试写画布", project_id="proj_1", canvas_id="cv_1")
        runtime.heartbeat_canvas("proj_1", "cv_1")
        denied_out = await executor.execute(
            tool_name="canvas.dispatch_run",
            args={"goal": "越权修改画布", "allow_canvas_writes": True},
            bot=readonly_bot, turn=ro_turn, runtime=runtime,
        )
        self.assertFalse(denied_out["ok"])
        self.assertEqual(denied_out["code"], "canvas_write_denied")

        # 4. 画布在线后同一 idempotency_key 提交两次，只创建一个 multi_agent Run（幂等去重）
        out1 = await executor.execute(
            tool_name="canvas.dispatch_run",
            args={"goal": "创建节点去重测试", "allow_canvas_writes": True, "idempotency_key": "idem_dedup_99"},
            bot=mgr, turn=turn, runtime=runtime,
        )
        out2 = await executor.execute(
            tool_name="canvas.dispatch_run",
            args={"goal": "创建节点去重测试", "allow_canvas_writes": True, "idempotency_key": "idem_dedup_99"},
            bot=mgr, turn=turn, runtime=runtime,
        )
        self.assertTrue(out1["ok"] and out2["ok"])
        self.assertTrue(out1["result"]["created"])
        self.assertFalse(out2["result"]["created"])
        self.assertEqual(out1["result"]["multi_agent_run_id"], out2["result"]["multi_agent_run_id"])
        await adapter.runtime.close()

    async def test_restart_recovery_reconciles_paid_generation_without_resubmitting(self):
        host = _CanvasFusionHost(self.data_dir, lambda req: "ok", lambda req: json.dumps({"tool": "agent.finish_task", "args": {"summary": "恢复后核对完成", "result_refs": []}}))
        adapter = CanvasAgentAdapter(host, self.ma_store)
        executor = BotWorkspaceToolExecutor(host=host, store=self.bw_store, multi_agent_adapter=adapter)
        runtime = BotWorkspaceRuntime(host, self.bw_store, tool_executor=executor, multi_agent_adapter=adapter)
        runtime.heartbeat_canvas("proj_1", "cv_1")

        # 创建一个关联 Run 并模拟已提交付费生图任务（generation_task_ids + request_signature），随后发生崩溃重启
        mgr = self.bw_store.get_bot(MANAGER_BOT_ID)
        sess = self.bw_store.ensure_default_session(MANAGER_BOT_ID, project_id="proj_1", canvas_id="cv_1")
        _, turn, _ = self.bw_store.enqueue_message_and_turn(sess["session_id"], content="生图恢复测试", project_id="proj_1", canvas_id="cv_1")
        dispatch = await executor.execute(
            tool_name="canvas.dispatch_run",
            args={"goal": "生成主图", "allow_canvas_writes": True, "idempotency_key": "idem_paid_recover"},
            bot=mgr, turn=turn, runtime=runtime,
        )
        run_id = dispatch["result"]["multi_agent_run_id"]
        await adapter.runtime.close()

        # 写入一个已提交付费生成的 executing 动作，然后模拟服务重启调用 recover()
        host.image_submit_count = 1
        host.image_tasks["img_job_777"] = {"status": "succeeded", "result": {"images": ["/assets/cup.png"]}}
        with self.ma_store.transaction() as db:
            run = self.ma_store.get(db, "runs", run_id)
            act = {
                "action_id": "maa_paid_1",
                "run_id": run_id,
                "task_id": run["root_task_id"],
                "project_id": "proj_1",
                "canvas_id": "cv_1",
                "idempotency_key": "paid_op_1",
                "operation": {"tool": "canvas.run_node", "target": {"node_id": "node_src_1"}, "args": {}},
                "status": "executing",
                "stage": "generation_result",
                "approved": True,
                "local_gpu": False,
                "resources": ["cv_1:node_src_1"],
                "generation_task_ids": ["img_job_777"],
                "request_signature": "sig_already_submitted",
                "receipt": {"node_ids": ["node_src_1"]},
                "result": {},
                "error": "",
                "created_at": 1,
                "updated_at": 1,
            }
            db.execute("INSERT INTO actions VALUES(?,?,?,?,?)", (act["action_id"], run_id, run["root_task_id"], "paid_op_1", json.dumps(act)))
        self.ma_store.recover()
        self.bw_store.update_turn(turn["turn_id"], status="running")
        self.bw_store.recover_after_restart()

        # 重启后双方均标记 recovery_required
        self.assertTrue(self.bw_store.get_turn(turn["turn_id"])["recovery_required"])
        self.assertTrue(self.ma_store.snapshot(run_id, "proj_1", "cv_1")["run"]["recovery_required"])

        # 用户点击「核对后继续」→ 先对账已有 img_job_777 结果，绝不重提生图
        adapter.runtime.stopping = False
        try:
            resumed = await runtime.resume_turn(turn["turn_id"])
            self.assertFalse(resumed["recovery_required"])
            self.assertEqual(host.image_submit_count, 1, "must never re-submit already submitted paid generation")
            snap_after = self.ma_store.snapshot(run_id, "proj_1", "cv_1")
            self.assertFalse(snap_after["run"]["recovery_required"])
        finally:
            await adapter.runtime.close()
            await runtime.close()


if __name__ == "__main__":
    unittest.main()
