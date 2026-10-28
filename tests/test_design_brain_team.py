"""设计大脑 Bot 团队（P0）数据层与路由测试。

运行方式（仓库自带 Python，含 fastapi）：
    ./python/python.exe -m unittest tests.test_design_brain_team

覆盖：默认团队 seed 的幂等性、Bot/群 CRUD 与约束、会话与消息游标、
消息文件滚存、持久化重开、能力注册表，以及路由层的最小闭环。
"""
import base64
import io
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

try:
    import design_brain_team_api
    from design_brain_store import DesignBrainError
    from design_brain_team import (
        CAPABILITY_PACKS,
        TeamStore,
        normalize_bot,
        normalize_group,
    )
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
except ImportError as exc:  # pragma: no cover - 系统 Python 缺依赖时跳过
    raise unittest.SkipTest(f"design_brain_team 依赖不可用：{exc}") from exc


class TeamStoreTest(unittest.TestCase):
    def test_custom_bot_profile_survives_reopen_and_partial_update(self):
        from PIL import Image
        buffer = io.BytesIO()
        Image.new("RGB", (16, 16), "#227755").save(buffer, "PNG")
        image = "data:image/png;base64," + base64.b64encode(buffer.getvalue()).decode("ascii")
        bot = self.store.create_bot({
            "name": "挑剔的文案", "personality": "直率，喜欢追问", "task": "检查标题是否清楚",
            "instructions": "保留商品事实", "avatar": {"shape": "kitty", "color": "#123456", "image": image},
        })
        reopened = TeamStore(self.temp.name)
        saved = reopened.update_bot(bot["id"], {"role": "文案"})
        self.assertEqual(saved["personality"], "直率，喜欢追问")
        self.assertEqual(saved["task"], "检查标题是否清楚")
        self.assertEqual(saved["instructions"], "保留商品事实")
        self.assertEqual(saved["avatar"], bot["avatar"])
        cleared = reopened.update_bot(bot["id"], {"personality": "", "task": "", "avatar": {"shape": "bunny", "color": "#654321"}})
        self.assertEqual(cleared["personality"], "")
        self.assertEqual(cleared["task"], "")
        self.assertNotIn("image", reopened.get_bot(bot["id"])["avatar"])
        self.assertEqual(cleared["avatar"]["shape"], "bunny")

    def test_invalid_avatar_does_not_replace_saved_profile(self):
        from PIL import Image
        bot = self.store.create_bot({"name": "头像检查", "personality": "原来的人格"})
        oversized = io.BytesIO()
        Image.new("RGB", (1025, 2)).save(oversized, "PNG")
        invalid_images = [
            "https://example.com/avatar.png", "data:image/svg+xml;base64,PHN2Zz4=",
            "data:image/png;base64,aGVsbG8=", "data:image/png;base64,A" * 50000,
            "data:image/png;base64," + base64.b64encode(oversized.getvalue()).decode("ascii"),
        ]
        for image in invalid_images:
            with self.subTest(image=image[:40]):
                with self.assertRaises(DesignBrainError):
                    self.store.update_bot(bot["id"], {"personality": "不应写入", "avatar": {"image": image}})
                self.assertEqual(self.store.get_bot(bot["id"])["personality"], "原来的人格")

    def test_legacy_bot_profile_defaults_preserve_instructions(self):
        bot = normalize_bot({"id": "bot_old", "name": "旧成员", "instructions": "原工作说明"})
        self.assertEqual(bot["personality"], "")
        self.assertEqual(bot["task"], "")
        self.assertEqual(bot["instructions"], "原工作说明")

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.store = TeamStore(self.temp.name)

    def tearDown(self):
        self.temp.cleanup()

    # -- seed ---------------------------------------------------------

    def test_seed_creates_default_team_once(self):
        first = self.store.ensure_seeded({"bot_director": "总监指令"})
        self.assertTrue(first["seeded"])
        self.assertEqual(first["bots"], 5)
        bots = self.store.list_bots()
        self.assertEqual([bot["id"] for bot in bots],
                         ["bot_director", "bot_reference", "bot_planner", "bot_executor", "bot_reviewer"])
        director = self.store.get_bot("bot_director")
        self.assertTrue(director["is_main"])
        self.assertEqual(director["instructions"], "总监指令")
        self.assertEqual(self.store.get_bot("bot_executor")["capabilities"],
                         ["pack.execute", "pack.memory"])
        groups = self.store.list_groups()
        self.assertEqual(len(groups), 1)
        self.assertEqual(groups[0]["admin_bot_id"], "bot_director")
        self.assertEqual(self.store.get_chat(groups[0]["id"])["kind"], "group")
        self.assertEqual(self.store.get_chat("dm_bot_director")["kind"], "dm")

        second = self.store.ensure_seeded({"bot_director": "不该覆盖"})
        self.assertFalse(second["seeded"])
        self.assertEqual(self.store.get_bot("bot_director")["instructions"], "总监指令")

    # -- bot ----------------------------------------------------------

    def test_create_update_archive_bot(self):
        self.store.ensure_seeded()
        bot = self.store.create_bot({
            "name": "文案 BOT", "role": "写主图文案",
            "capabilities": ["pack.read", "pack.memory", "pack.unknown"],
            "avatar": {"text": "文", "color": "#123456"},
        })
        self.assertTrue(bot["id"].startswith("bot_"))
        self.assertEqual(bot["capabilities"], ["pack.read", "pack.memory"])
        self.assertFalse(bot["is_main"])

        updated = self.store.update_bot(bot["id"], {"role": "写详情页文案", "permission": "read"})
        self.assertEqual(updated["role"], "写详情页文案")
        self.assertEqual(updated["permission"], "read")

        archived = self.store.archive_bot(bot["id"])
        self.assertEqual(archived["status"], "archived")
        self.assertEqual(len(self.store.list_bots()), 5)
        self.assertEqual(len(self.store.list_bots(include_archived=True)), 6)
        self.assertEqual(self.store.restore_bot(bot["id"])["status"], "active")

    def test_seeded_instructions_do_not_embed_pipeline_output_protocol(self):
        self.store.ensure_seeded()
        for bot in self.store.list_bots():
            with self.subTest(bot=bot["id"]):
                self.assertTrue(bot["instructions"])
                self.assertNotIn('"reply"', bot["instructions"])
                self.assertNotIn('"intent"', bot["instructions"])
        self.store.update_bot("bot_director", {"instructions": "用户自定义说明"})
        self.store.ensure_seeded()
        self.assertEqual(self.store.get_bot("bot_director")["instructions"], "用户自定义说明")

    def test_bot_constraints(self):
        self.store.ensure_seeded()
        with self.assertRaises(DesignBrainError) as ctx:
            self.store.create_bot({"name": "设计总监"})
        self.assertEqual(ctx.exception.code, "bot_name_duplicate")

        with self.assertRaises(DesignBrainError) as ctx:
            self.store.archive_bot("bot_director")
        self.assertEqual(ctx.exception.code, "invalid_bot")

        with self.assertRaises(DesignBrainError) as ctx:
            self.store.archive_bot("bot_planner")
        self.assertEqual(ctx.exception.code, "bot_in_use")

        with self.assertRaises(DesignBrainError) as ctx:
            self.store.update_bot("bot_planner", {"status": "archived"})
        self.assertEqual(ctx.exception.code, "bot_in_use")

        with self.assertRaises(DesignBrainError) as ctx:
            self.store.get_bot("bot_missing")
        self.assertEqual(ctx.exception.status, 404)

    def test_normalize_bot_tolerates_bad_fields(self):
        bot = normalize_bot({
            "id": "bot_x", "name": "  ", "capabilities": ["pack.read", "nope"],
            "avatar": {"text": "很长", "color": "red"}, "permission": "root",
            "status": "weird", "created_at": "abc",
        })
        self.assertEqual(bot["name"], "未命名 Bot")
        self.assertEqual(bot["capabilities"], ["pack.read"])
        self.assertEqual(bot["avatar"]["text"], "很长")
        self.assertTrue(bot["avatar"]["color"].startswith("#"))
        self.assertEqual(bot["permission"], "workspace")
        self.assertEqual(bot["status"], "active")

    # -- group --------------------------------------------------------

    def test_group_crud_and_chat(self):
        self.store.ensure_seeded()
        created = self.store.create_group({
            "name": "相框项目群", "members": ["bot_reference", "bot_missing"],
            "notice": "深胡桃色，不要金色", "relay_limit": 99,
        })
        group = created["group"]
        self.assertEqual(group["members"], ["bot_director", "bot_reference"])
        self.assertEqual(group["relay_limit"], 40)
        self.assertEqual(created["chat"]["id"], group["id"])
        self.assertEqual(created["chat"]["members"], group["members"])

        updated = self.store.update_group(group["id"], {
            "members": ["bot_director", "bot_planner", "bot_reviewer"],
            "admin_bot_id": "bot_planner",
        })
        self.assertEqual(updated["group"]["admin_bot_id"], "bot_planner")
        self.assertIn("bot_planner", updated["group"]["members"])
        self.assertEqual(updated["chat"]["members"], updated["group"]["members"])

        with self.assertRaises(DesignBrainError) as ctx:
            self.store.create_group({"name": "相框项目群"})
        self.assertEqual(ctx.exception.code, "group_name_duplicate")

        self.assertTrue(self.store.archive_group(group["id"])["archived"])
        self.assertEqual(len(self.store.list_groups()), 1)
        self.assertEqual(len(self.store.list_groups(include_archived=True)), 2)

    def test_group_falls_back_to_main_bot(self):
        self.store.ensure_seeded()
        created = self.store.create_group({"name": "空群", "members": ["bot_missing"]})
        self.assertEqual(created["group"]["members"], ["bot_director"])
        self.assertEqual(created["group"]["admin_bot_id"], "bot_director")

    # -- chat ---------------------------------------------------------

    def test_messages_cursor_and_persistence(self):
        self.store.ensure_seeded()
        chat = self.store.ensure_dm_chat("bot_director")
        self.store.append_message(chat["id"], role="user", text="给相框做套主图")
        self.store.append_message(chat["id"], role="bot", bot_id="bot_director", text="好的")
        third = self.store.append_message(chat["id"], role="user", text="要深胡桃色")

        page = self.store.list_messages(chat["id"], after=0)
        self.assertEqual(len(page["messages"]), 3)
        self.assertEqual(page["cursor"], third["seq"])

        tail = self.store.list_messages(chat["id"], after=2)
        self.assertEqual([item["text"] for item in tail["messages"]], ["要深胡桃色"])
        self.assertFalse(tail["has_more"])

        reopened = TeamStore(self.temp.name)
        self.assertEqual(len(reopened.list_messages(chat["id"])["messages"]), 3)
        self.assertEqual(reopened.get_chat(chat["id"])["seq"], 3)

    def test_message_file_rotation(self):
        self.store.ensure_seeded()
        chat = self.store.ensure_dm_chat("bot_director")
        with mock.patch("design_brain_team.MESSAGE_FILE_MAX", 2):
            self.store.append_message(chat["id"], role="user", text="一")
            self.store.append_message(chat["id"], role="user", text="二")
            self.store.append_message(chat["id"], role="user", text="三")
        archive = Path(self.temp.name) / "design_brain" / "team" / "chats" / chat["id"] / "archive"
        self.assertTrue(any(archive.glob("messages-*.jsonl")))
        page = self.store.list_messages(chat["id"])
        self.assertEqual([item["text"] for item in page["messages"]], ["三"])
        self.assertEqual(page["messages"][0]["seq"], 3)

    def test_capabilities_registry(self):
        registry = self.store.capabilities()
        self.assertEqual(len(registry["packs"]), len(CAPABILITY_PACKS))
        ids = [pack["id"] for pack in registry["packs"]]
        self.assertIn("pack.workflow", ids)
        self.assertTrue((Path(self.temp.name) / "design_brain" / "team" / "capabilities.json").is_file())

    def test_normalize_group_clamps(self):
        group = normalize_group({"id": "grp_x", "name": "", "members": ["bot_a"],
                                 "reply_mode": "everyone", "relay_limit": -5})
        self.assertEqual(group["name"], "未命名群")
        self.assertEqual(group["reply_mode"], "admin_first")
        self.assertEqual(group["relay_limit"], 2)


class TeamApiTest(unittest.TestCase):
    def test_custom_profile_create_edit_read_and_validation(self):
        from PIL import Image
        buffer = io.BytesIO()
        Image.new("RGB", (16, 16), "#135790").save(buffer, "WEBP")
        image = "data:image/webp;base64," + base64.b64encode(buffer.getvalue()).decode("ascii")
        created = self.client.post("/api/design-brain/bots", headers=self.headers, json={
            "name": "自定义成员", "personality": "热心而简洁", "task": "检查构图", "avatar": {"shape": "peanut", "color": "#135790", "image": image},
        })
        self.assertEqual(created.status_code, 200, created.text)
        bot_id = created.json()["id"]
        response = self.client.patch(f"/api/design-brain/bots/{bot_id}", headers=self.headers,
                                     json={"personality": "敢于质疑", "task": "提出一个反例"})
        self.assertEqual(response.status_code, 200, response.text)
        saved = self.client.get(f"/api/design-brain/bots/{bot_id}").json()
        self.assertEqual(saved["personality"], "敢于质疑")
        self.assertEqual(saved["task"], "提出一个反例")
        self.assertEqual(saved["avatar"]["shape"], "peanut")
        self.assertEqual(saved["avatar"]["image"], image)
        for patch in ({"personality": "长" * 2001}, {"task": "长" * 4001}, {"avatar": {"image": "invalid"}}):
            with self.subTest(patch=str(patch)[:30]):
                failed = self.client.patch(f"/api/design-brain/bots/{bot_id}", headers=self.headers, json=patch)
                self.assertEqual(failed.status_code, 422, failed.text)
                self.assertEqual(self.client.get(f"/api/design-brain/bots/{bot_id}").json(), saved)

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.store = TeamStore(self.temp.name)
        self.store.ensure_seeded()
        self.patch = mock.patch.object(design_brain_team_api, "TEAM", self.store)
        self.patch.start()
        app = FastAPI()
        app.include_router(design_brain_team_api.router)
        self.client = TestClient(app)
        self.headers = {"origin": "http://testserver"}

    def tearDown(self):
        self.patch.stop()
        self.temp.cleanup()

    def test_overview_and_crud(self):
        overview = self.client.get("/api/design-brain/team").json()
        self.assertEqual(len(overview["bots"]), 5)
        self.assertEqual(len(overview["groups"]), 1)
        self.assertIn("limits", overview)

        created = self.client.post("/api/design-brain/bots",
                                   json={"name": "排版 BOT", "capabilities": ["pack.read"]},
                                   headers=self.headers)
        self.assertEqual(created.status_code, 200, created.text)
        bot_id = created.json()["id"]

        patched = self.client.patch(f"/api/design-brain/bots/{bot_id}",
                                    json={"role": "详情页排版"}, headers=self.headers)
        self.assertEqual(patched.json()["role"], "详情页排版")

        group = self.client.post("/api/design-brain/groups",
                                 json={"name": "详情页项目", "members": ["bot_director", bot_id]},
                                 headers=self.headers)
        self.assertEqual(group.status_code, 200, group.text)
        chat_id = group.json()["chat"]["id"]

        sent = self.client.post(f"/api/design-brain/chats/{chat_id}/messages",
                                json={"text": "先出一版详情页"},
                                headers=self.headers)
        self.assertEqual(sent.status_code, 200, sent.text)
        self.assertEqual(sent.json()["cursor"], 1)

        page = self.client.get(f"/api/design-brain/chats/{chat_id}/messages?after=0").json()
        self.assertEqual(page["messages"][0]["text"], "先出一版详情页")

    def test_duplicate_name_returns_conflict(self):
        response = self.client.post("/api/design-brain/bots", json={"name": "设计总监"},
                                    headers=self.headers)
        self.assertEqual(response.status_code, 409)
        self.assertEqual(response.json()["code"], "bot_name_duplicate")

    def test_cross_origin_write_rejected(self):
        response = self.client.post("/api/design-brain/bots", json={"name": "外部 BOT"},
                                    headers={"origin": "http://evil.example"})
        self.assertEqual(response.status_code, 403)


if __name__ == "__main__":
    unittest.main()
