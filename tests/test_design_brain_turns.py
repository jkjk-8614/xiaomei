"""设计大脑 Bot 团队回合引擎测试（P1）。

用假宿主（FakeHost）+ 假编排器跑完整回合，不触碰真实模型与生图：
- 私聊只有一个 Bot 发言；
- 群聊 admin_first：管理员先答，@ 点名后接力；
- pass 不发消息；
- 接力到上限暂停并留系统消息；
- 没选模型时给出可读提示而不是静默失败；
- brain.workflow.run 成功建任务并写结果卡。
"""
import asyncio
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

try:
    from design_brain_team import TeamStore
    from design_brain_turns import TurnEngine
except ImportError as exc:  # pragma: no cover
    raise unittest.SkipTest(f"design_brain_turns 依赖不可用：{exc}") from exc


class FakeRequest:
    def __init__(self, **kwargs):
        self.__dict__.update(kwargs)


class FakeHost:
    CanvasLLMRequest = FakeRequest

    def __init__(self, replies):
        self.replies = list(replies)
        self.calls = []

    async def canvas_llm(self, payload):
        self.calls.append(payload)
        text = self.replies.pop(0) if self.replies else '{"say":"","pass":true}'
        return {"text": text}


class FakeOrchestrator:
    def __init__(self):
        self.calls = []
        self.requirement_updates = []

    def update_requirements(self, task_id, text):
        self.requirement_updates.append((task_id, text))

    async def chat(self, **kwargs):
        self.calls.append(kwargs)
        return {"reply": "已创建主图任务，方案稍后出现在工作区", "task_id": "job_test"}


class TurnEngineTest(unittest.TestCase):
    def test_existing_custom_bot_instructions_receive_sku_rule_without_rewrite(self):
        self.team.update_bot("bot_director", {"instructions": "用户自己写的总监工作说明"})
        chat = self.team.ensure_dm_chat("bot_director")
        engine = self._engine([])
        prompt = engine._system_prompt(chat, None, self.team.get_bot("bot_director"))
        self.assertIn("用户自己写的总监工作说明", prompt)
        self.assertIn("文字模板共用一张无可变文字的底图", prompt)
        self.assertIn("series_mode=sku_variants", prompt)
        self.assertIn("允许已确认的框色和照片变化", prompt)
        self.assertEqual(self.team.get_bot("bot_director")["instructions"], "用户自己写的总监工作说明")

    def test_resolution_followup_is_written_to_linked_task_before_bot_reply(self):
        orch = FakeOrchestrator()
        chat = self.team.ensure_dm_chat('bot_director')
        self.team.append_message(chat['id'], role='bot', bot_id='bot_director', kind='result',
                                 text='任务已创建', task_id='job_existing')
        self.team.append_message(chat['id'], role='user', text='@设计总监 图片是4k')
        engine = self._engine(['{"say":"已更新","mentions":[],"pass":false}'], orch)
        self._run(engine, chat['id'])
        self.assertEqual(orch.requirement_updates, [('job_existing', '@设计总监 图片是4k')])

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.team = TeamStore(self.temp.name)
        self.team.ensure_seeded()
        for bot_id in ("bot_director", "bot_planner", "bot_reference"):
            self.team.update_bot(bot_id, {"model": {"provider": "p", "model": "m"}})

    def tearDown(self):
        self.temp.cleanup()

    def _engine(self, replies, orchestrator=None):
        self.host = FakeHost(replies)
        return TurnEngine(self.host, self.team, orchestrator)

    def _run(self, engine, chat_id):
        asyncio.run(engine._run(chat_id))

    def test_activity_reports_model_and_tool_work_then_clears_after_stop(self):
        async def scenario():
            chat = self.team.ensure_dm_chat("bot_director")
            self.team.append_message(chat["id"], role="user", text="查找参考")
            gate = asyncio.Event()

            class SlowHost(FakeHost):
                async def canvas_llm(self, payload):
                    await gate.wait()
                    return {"text": '{"say":"收到"}'}

            engine = TurnEngine(SlowHost([]), self.team)
            self.assertTrue(engine.start(chat["id"]))
            await asyncio.sleep(0.02)
            state = engine.status(chat["id"])
            self.assertTrue(state["running"])
            self.assertEqual(state["bot_id"], "bot_director")
            self.assertEqual(state["activity"], "thinking")
            self.assertGreater(state["started_at"], 0)
            started = state["started_at"]
            await engine._invoke_tool(chat, self.team.get_bot("bot_director"),
                                      {"tool": "brain.memory.recall", "args": {}})
            state = engine.status(chat["id"])
            self.assertEqual(state["activity"], "searching")
            self.assertEqual(state["tool"], "brain.memory.recall")
            self.assertEqual(state["started_at"], started)
            await engine.stop(chat["id"])
            state = engine.status(chat["id"])
            self.assertFalse(state["running"])
            self.assertEqual(state["activity"], "idle")
            self.assertEqual(state["activity_label"], "")
            self.assertEqual(state["tool"], "")

        asyncio.run(scenario())

    def test_dm_single_bot_reply(self):
        chat = self.team.ensure_dm_chat("bot_director")
        self.team.append_message(chat["id"], role="user", text="这套主图怎么拍")
        engine = self._engine(['{"say":"先定浅灰底，再压深木纹。","mentions":[],"pass":false}'])
        self._run(engine, chat["id"])
        messages = self.team.list_messages(chat["id"])["messages"]
        self.assertEqual(messages[-1]["role"], "bot")
        self.assertEqual(messages[-1]["bot_id"], "bot_director")
        self.assertIn("浅灰底", messages[-1]["text"])

    def test_group_admin_first_then_mention_relay(self):
        created = self.team.create_group({
            "name": "接力群", "members": ["bot_director", "bot_planner"], "relay_limit": 4,
        })
        chat_id = created["chat"]["id"]
        self.team.append_message(chat_id, role="user", text="出两个方向")
        engine = self._engine([
            '{"say":"@设计规划 你先给方向","mentions":["bot_planner"],"pass":false}',
            '{"say":"方向 A 浅底特写，方向 B 场景叙事。","mentions":[],"pass":false}',
        ])
        self._run(engine, chat_id)
        messages = self.team.list_messages(chat_id)["messages"]
        bot_messages = [item for item in messages if item["role"] == "bot"]
        self.assertEqual([item["bot_id"] for item in bot_messages], ["bot_director", "bot_planner"])
        self.assertEqual(self.team.get_chat(chat_id)["relay_count"], 1)
        self.assertFalse(self.team.get_chat(chat_id)["paused"])

    def test_discussion_images_reach_model_and_retry_without_creating_task(self):
        chat = self.team.ensure_dm_chat("bot_director")
        images = [f"/api/storage-files/upload/product-{index}.png" for index in range(25)]
        self.team.append_message(chat["id"], role="user", text="先讨论商品的视觉方向，不要生图",
                                 meta={"product_images": images})
        orchestrator = FakeOrchestrator()
        engine = self._engine(['不是 JSON', '{"say":"建议先突出木纹质感。","mentions":[]}'], orchestrator)
        self._run(engine, chat["id"])
        self.assertEqual(len(self.host.calls), 2)
        self.assertTrue(all(call.images == images for call in self.host.calls))
        self.assertEqual(orchestrator.calls, [])

    def test_pipeline_reply_is_corrected_before_creating_workflow(self):
        from design_brain_bots import DIRECTOR_SYSTEM
        self.team.update_bot("bot_director", {"instructions": DIRECTOR_SYSTEM})
        chat = self.team.ensure_dm_chat("bot_director")
        self.team.update_chat(chat["id"], {"defaults": {
            "image": {"provider": "image-provider", "model": "image-model"},
        }})
        images = [f"/product-{index}.png" for index in range(9)]
        self.team.append_message(chat["id"], role="user", text="用这9张参考图制作15张相框SKU图",
                                 meta={"product_images": images})
        orchestrator = FakeOrchestrator()
        engine = self._engine([
            '{"reply":"已创建任务","intent":"create_task","brief":{"goal":"15张SKU图"}}',
            '{"say":"开始整理方案","call":{"tool":"brain.workflow.run","args":{"brief_text":"15张相框SKU图"}}}',
            '{"say":"方案稍后在工作区显示"}',
        ], orchestrator)
        self._run(engine, chat["id"])
        self.assertEqual(len(self.host.calls), 2)
        self.assertTrue(all(payload.images == images for payload in self.host.calls))
        self.assertIn("团队宿主的输出协议优先", self.host.calls[0].system_prompt)
        self.assertIn("上一次回复不符合团队协议", self.host.calls[1].message)
        self.assertTrue(self.host.calls[1].message.endswith("声称任务已创建。"))
        self.assertEqual(self.team.get_bot("bot_director")["instructions"], DIRECTOR_SYSTEM)
        self.assertEqual(len(orchestrator.calls), 1)
        self.assertIn("15张", orchestrator.calls[0]["message"])
        messages = self.team.list_messages(chat["id"])["messages"]
        self.assertTrue(any(m["kind"] == "result" and m["task_id"] == "job_test" for m in messages))
        self.assertFalse(any(m["text"] == "已创建任务" for m in messages))

    def test_invalid_reply_reports_failure_and_original_retry_after_one_correction(self):
        for reply in ('{}', '{"reply":"收到","intent":"answer"}',
                      '{"pass":"false","say":"收到"}', '{"say":["收到"]}',
                      '{"call":{"tool":"","args":{}}}', '{"mentions":"bot_planner"}'):
            with self.subTest(reply=reply):
                chat = self.team.ensure_dm_chat("bot_director")
                source = self.team.append_message(chat["id"], role="user", text="制作SKU图")
                orchestrator = FakeOrchestrator()
                engine = self._engine([reply, reply], orchestrator)
                self._run(engine, chat["id"])
                failure = self.team.list_messages(chat["id"])["messages"][-1]
                self.assertEqual(len(self.host.calls), 2)
                self.assertEqual(orchestrator.calls, [])
                self.assertIn("模型回复格式不符合团队要求", failure["text"])
                self.assertEqual(failure["meta"], {"retryable": True, "retry_message_id": source["id"]})
                self.assertFalse(engine.status(chat["id"])["running"])

    def test_truncated_protocol_reply_is_not_shown_or_executed(self):
        chat = self.team.ensure_dm_chat("bot_director")
        source = self.team.append_message(chat["id"], role="user", text="制作详情页")
        reply = '{"say":"任务已创建","mentions":[],"pass":false,"call":{"tool":"brain.workflow.run","args":'
        orchestrator = FakeOrchestrator()
        engine = self._engine([reply, reply], orchestrator)
        self._run(engine, chat["id"])
        messages = self.team.list_messages(chat["id"])["messages"]
        self.assertFalse(any(reply in m["text"] for m in messages))
        self.assertIn("模型回复格式不符合团队要求", messages[-1]["text"])
        self.assertEqual(messages[-1]["meta"]["retry_message_id"], source["id"])
        self.assertEqual(orchestrator.calls, [])

    def test_empty_reply_reports_retry_after_one_correction(self):
        chat = self.team.ensure_dm_chat("bot_director")
        source = self.team.append_message(chat["id"], role="user", text="制作SKU图")
        engine = self._engine(['', ''])
        self._run(engine, chat["id"])
        failure = self.team.list_messages(chat["id"])["messages"][-1]
        self.assertEqual(len(self.host.calls), 2)
        self.assertIn("模型没有返回回复", failure["text"])
        self.assertEqual(failure["meta"]["retry_message_id"], source["id"])

    def test_plain_text_reply_still_displays_after_correction(self):
        chat = self.team.ensure_dm_chat("bot_director")
        self.team.append_message(chat["id"], role="user", text="讨论相框构图")
        engine = self._engine(['建议先统一构图', '建议统一构图后再定配色'])
        self._run(engine, chat["id"])
        reply = self.team.list_messages(chat["id"])["messages"][-1]
        self.assertEqual(reply["role"], "bot")
        self.assertEqual(reply["text"], '建议统一构图后再定配色')

    def test_new_message_does_not_attach_images_from_an_earlier_message(self):
        chat = self.team.ensure_dm_chat("bot_director")
        self.team.append_message(chat["id"], role="user", text="上一个商品",
                                 meta={"product_images": ["/previous.png"]})
        self.team.append_message(chat["id"], role="user", text="现在只讨论排版")
        engine = self._engine(['{"say":"可以先定层级。"}'])
        self._run(engine, chat["id"])
        self.assertEqual(self.host.calls[0].images, [])

    def test_pass_writes_nothing(self):
        chat = self.team.ensure_dm_chat("bot_planner")
        self.team.append_message(chat["id"], role="user", text="在吗")
        engine = self._engine(['{"say":"","mentions":[],"pass":true}'])
        self._run(engine, chat["id"])
        messages = self.team.list_messages(chat["id"])["messages"]
        self.assertEqual([item["role"] for item in messages], ["user"])

    def test_relay_limit_pauses(self):
        created = self.team.create_group({
            "name": "限额群", "members": ["bot_director", "bot_planner"], "relay_limit": 2,
        })
        chat_id = created["chat"]["id"]
        self.team.append_message(chat_id, role="user", text="一直聊")
        engine = self._engine([
            '{"say":"1","mentions":["bot_planner"],"pass":false}',
            '{"say":"2","mentions":["bot_director"],"pass":false}',
            '{"say":"3","mentions":["bot_planner"],"pass":false}',
            '{"say":"4","mentions":[],"pass":false}',
        ])
        self._run(engine, chat_id)
        chat = self.team.get_chat(chat_id)
        self.assertTrue(chat["paused"])
        system = [item for item in self.team.list_messages(chat_id)["messages"] if item["role"] == "system"]
        self.assertTrue(system)
        self.assertIn("暂停", system[-1]["text"])

    def test_missing_model_reports_readably(self):
        self.team.update_bot("bot_reviewer", {"model": {"provider": "", "model": ""}})
        chat = self.team.ensure_dm_chat("bot_reviewer")
        self.team.append_message(chat["id"], role="user", text="看下图")
        engine = self._engine([])
        self._run(engine, chat["id"])
        messages = self.team.list_messages(chat["id"])["messages"]
        self.assertEqual(messages[-1]["role"], "system")
        self.assertIn("选择模型", messages[-1]["text"])
        self.assertEqual(self.host.calls, [])
        self.assertTrue(messages[-1]["meta"]["retryable"])
        self.assertEqual(messages[-1]["meta"]["retry_message_id"], messages[0]["id"])

    def test_model_failure_links_retry_to_original_message(self):
        chat = self.team.ensure_dm_chat("bot_director")
        source = self.team.append_message(chat["id"], role="user", text="给商品做主图",
                                          meta={"product_images": ["/product.png"]})
        engine = self._engine([])

        async def fail(payload):
            # 发言途中收到新消息时，错误仍关联本轮原请求。
            self.team.append_message(chat["id"], role="user", text="另一条需求")
            raise RuntimeError("平台暂不可用")

        self.host.canvas_llm = fail
        self._run(engine, chat["id"])
        failure = self.team.list_messages(chat["id"])["messages"][-1]
        self.assertIn("模型调用失败", failure["text"])
        self.assertEqual(failure["meta"], {"retryable": True, "retry_message_id": source["id"]})
        self.assertFalse(engine.status(chat["id"])["running"])

    def test_workflow_tool_creates_task_card(self):
        orchestrator = FakeOrchestrator()
        chat = self.team.ensure_dm_chat("bot_director")
        self.team.update_chat(chat["id"], {"defaults": {
            "chat": {"provider": "p", "model": "m"},
            "image": {"provider": "ip", "model": "im"},
        }})
        self.team.append_message(chat["id"], role="user", text="给胡桃木相框做套主图")
        engine = self._engine([
            '{"say":"我来开任务","mentions":[],"pass":false,'
            '"call":{"tool":"brain.workflow.run","args":{"brief_text":"胡桃木相框主图一套"}}}',
            '{"say":"再创建一次","call":{"tool":"brain.workflow.run","args":{"brief_text":"胡桃木相框主图一套"}}}',
        ], orchestrator)
        self._run(engine, chat["id"])
        self.assertEqual(len(orchestrator.calls), 1)
        self.assertEqual(len(self.host.calls), 1)
        self.assertEqual(orchestrator.calls[0]["message"], "胡桃木相框主图一套")
        self.assertEqual(orchestrator.calls[0]["source_text"], "给胡桃木相框做套主图")
        self.assertEqual(orchestrator.calls[0]["models"]["image"]["provider"], "ip")
        messages = self.team.list_messages(chat["id"])["messages"]
        cards = [item for item in messages if item["kind"] == "result"]
        self.assertEqual(cards[0]["task_id"], "job_test")
        self.assertEqual(messages[-1]["role"], "bot")

    def test_tool_denied_without_capability(self):
        orchestrator = FakeOrchestrator()
        chat = self.team.ensure_dm_chat("bot_planner")
        self.team.update_chat(chat["id"], {"defaults": {
            "chat": {"provider": "p", "model": "m"},
            "image": {"provider": "ip", "model": "im"},
        }})
        self.team.append_message(chat["id"], role="user", text="直接出图")
        engine = self._engine([
            '{"say":"","mentions":[],"pass":false,'
            '"call":{"tool":"brain.workflow.run","args":{"brief_text":"直接出图"}}}',
        ], orchestrator)
        self._run(engine, chat["id"])
        self.assertEqual(orchestrator.calls, [])
        system = [item for item in self.team.list_messages(chat["id"])["messages"] if item["role"] == "system"]
        self.assertIn("没有标准流水线权限", system[-1]["text"])
        self.assertTrue(system[-1]["meta"]["retryable"])
        source = self.team.list_messages(chat["id"])["messages"][0]
        self.assertEqual(system[-1]["meta"]["retry_message_id"], source["id"])


if __name__ == "__main__":
    unittest.main()
