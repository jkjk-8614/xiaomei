"""旧版设计大脑团队数据（data/design_brain/team/）非破坏性幂等迁移测试。"""
from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from bot_workspace_config import MANAGER_BOT_ID
from bot_workspace_migration import LEGACY_DEFAULT_BOT_IDS, MIGRATION_ID, migrate_legacy_design_team
from bot_workspace_store import BotWorkspaceStore


def _write_json(path: Path, data: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")


def _write_jsonl(path: Path, rows: list[dict]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("\n".join(json.dumps(r, ensure_ascii=False) for r in rows) + "\n", encoding="utf-8")


class BotWorkspaceMigrationTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.data_dir = Path(self.tmp.name) / "中文迁移目录"
        self.store = BotWorkspaceStore(data_dir=self.data_dir)

    def tearDown(self):
        self.tmp.cleanup()

    def test_fresh_install_without_legacy_data(self):
        result = migrate_legacy_design_team(self.data_dir, self.store, create_backup=True)
        self.assertEqual(result["status"], "fresh_install")
        self.assertFalse(result["migrated"])
        bots = self.store.list_bots(include_archived=True)
        self.assertEqual([b["bot_id"] for b in bots], [MANAGER_BOT_ID])

    def test_non_destructive_idempotent_legacy_migration(self):
        team_dir = self.data_dir / "design_brain" / "team"
        # 构造旧版 5 个默认 Bot + 1 个用户自建专业 Bot
        legacy_bots = [
            {
                "id": "bot_director",
                "name": "设计总监",
                "role": "统筹",
                "model": {"provider_id": "prov_old", "model": "old-director-model"},
                "capabilities": ["pack.read", "pack.plan"],
                "status": "active",
            },
            {"id": "bot_reference", "name": "参考分析师", "role": "参考分析", "capabilities": ["pack.read"], "status": "active"},
            {"id": "bot_planner", "name": "设计策划师", "role": "方案规划", "capabilities": ["pack.plan"], "status": "active"},
            {"id": "bot_executor", "name": "生成执行师", "role": "生图执行", "capabilities": ["pack.execute"], "status": "active"},
            {"id": "bot_reviewer", "name": "视觉质检师", "role": "质量检查", "capabilities": ["pack.review"], "status": "active"},
            {
                "id": "bot_custom_tea",
                "name": "茶叶视觉顾问",
                "role": "专攻茶饮与东方礼盒包装",
                "instructions": "始终保留东方留白与纸质肌理。",
                "model": {"provider_id": "prov_tea", "model": "tea-chat-v1"},
                "capabilities": ["pack.read", "pack.plan", "pack.memory"],
                "status": "active",
            },
        ]
        _write_json(team_dir / "bots.json", {"version": 1, "bots": legacy_bots})
        _write_json(team_dir / "groups.json", {"version": 1, "groups": [{"id": "grp_default", "name": "设计团队", "archived": False}]})

        # 旧私聊与旧群聊消息
        _write_json(team_dir / "chats" / "dm_bot_director" / "chat.json", {"id": "dm_bot_director", "kind": "dm", "bot_id": "bot_director", "title": "设计总监"})
        _write_jsonl(team_dir / "chats" / "dm_bot_director" / "messages.jsonl", [
            {"id": "m1", "seq": 1, "role": "user", "text": "帮我分析夏季冷泡茶卖点", "at": 1700000001000},
            {"id": "m2", "seq": 2, "role": "bot", "bot_id": "bot_director", "text": "建议突出冰萃清透感", "at": 1700000002000},
        ])
        _write_json(team_dir / "chats" / "dm_bot_custom_tea" / "chat.json", {"id": "dm_bot_custom_tea", "kind": "dm", "bot_id": "bot_custom_tea", "title": "茶叶视觉顾问"})
        _write_jsonl(team_dir / "chats" / "dm_bot_custom_tea" / "messages.jsonl", [
            {"id": "t1", "seq": 1, "role": "user", "text": "礼盒用宣纸质感", "at": 1700000003000},
        ])
        _write_json(team_dir / "chats" / "grp_default" / "chat.json", {"id": "grp_default", "kind": "group", "title": "设计团队"})
        _write_jsonl(team_dir / "chats" / "grp_default" / "messages.jsonl", [
            {"id": "g1", "seq": 1, "role": "user", "text": "大家一起出 4 张主图", "at": 1700000004000},
            {"id": "g2", "seq": 2, "role": "bot", "bot_id": "bot_planner", "text": "我已拆解 4 个场景", "at": 1700000005000},
        ])

        # 旧记忆（含一条疑似密钥，应自动过滤）
        (team_dir / "memory" / "bots" / "bot_director").mkdir(parents=True, exist_ok=True)
        (team_dir / "memory" / "bots" / "bot_director" / "MEMORY.md").write_text(
            "- 品牌偏好低饱和莫兰迪青灰 [source: 用户; added: 2026-10-01]\n"
            "- 误粘贴 sk-1234567890abcdefghijklmnop [source: 用户; added: 2026-10-02]\n",
            encoding="utf-8",
        )
        (team_dir / "memory" / "bots" / "bot_custom_tea").mkdir(parents=True, exist_ok=True)
        (team_dir / "memory" / "bots" / "bot_custom_tea" / "MEMORY.md").write_text(
            "- 茶叶礼盒优先竖版 3:4 构图 [source: 用户; added: 2026-10-03]\n",
            encoding="utf-8",
        )
        (team_dir / "memory" / "team").mkdir(parents=True, exist_ok=True)
        (team_dir / "memory" / "team" / "MEMORY.md").write_text(
            "- 全店禁用廉价爆炸贴纸 [source: 总监; added: 2026-10-04]\n",
            encoding="utf-8",
        )

        # 保留参考素材与审美档案确保迁移不动原目录
        profile_file = self.data_dir / "design_brain" / "profile.json"
        _write_json(profile_file, {"brand": "清茶社"})
        bots_before = (team_dir / "bots.json").read_text(encoding="utf-8")

        # 第一次迁移
        res1 = migrate_legacy_design_team(self.data_dir, self.store, create_backup=True)
        self.assertEqual(res1["status"], "completed")
        self.assertTrue(res1["backup_path"])
        self.assertTrue(Path(res1["backup_path"]).is_dir())
        self.assertEqual(res1["custom_bots_active"], 1)
        self.assertEqual(res1["legacy_defaults_archived"], 4)
        self.assertEqual(res1["messages_imported"], 5)
        self.assertEqual(res1["memories_imported"], 3)  # 密钥行被过滤

        # 活跃列表只包含 bot_manager + 用户自建茶叶顾问，不包含旧默认 4 个专业 Bot
        active_bots = self.store.list_bots(include_archived=False)
        active_ids = [b["bot_id"] for b in active_bots]
        self.assertEqual(active_ids, [MANAGER_BOT_ID, "bot_custom_tea"])

        # bot_manager 继承了旧总监的模型与历史记忆
        mgr = self.store.get_bot(MANAGER_BOT_ID)
        self.assertEqual(mgr["chat_model"]["model"], "old-director-model")
        mgr_mems = [m["content"] for m in self.store.list_memories(MANAGER_BOT_ID)]
        self.assertIn("品牌偏好低饱和莫兰迪青灰", mgr_mems)
        self.assertIn("全店禁用廉价爆炸贴纸", mgr_mems)
        self.assertFalse(any("sk-123456" in c for c in mgr_mems))

        # 旧默认 4 Bot 以 archived 形式保留（可恢复）
        all_bots = {b["bot_id"]: b for b in self.store.list_bots(include_archived=True)}
        for legacy_id in LEGACY_DEFAULT_BOT_IDS - {"bot_director"}:
            self.assertIn(legacy_id, all_bots)
            self.assertEqual(all_bots[legacy_id]["status"], "archived")
            self.assertTrue(all_bots[legacy_id]["legacy_default"])

        # 旧群聊与旧私聊历史保留
        mgr_sessions = self.store.list_sessions(MANAGER_BOT_ID, include_archived=True)
        self.assertTrue(any(s["kind"] == "legacy_group" for s in mgr_sessions))
        self.assertTrue(any(s["legacy_chat_id"] == "dm_bot_director" for s in mgr_sessions))

        # 原目录完全未被破坏
        self.assertEqual((team_dir / "bots.json").read_text(encoding="utf-8"), bots_before)
        self.assertTrue(profile_file.is_file())

        # 第二次重复执行迁移必须严格幂等（零重复导入）
        res2 = migrate_legacy_design_team(self.data_dir, self.store, create_backup=True)
        self.assertEqual(res2["bots_imported"], 0)
        self.assertEqual(res2["sessions_imported"], 0)
        self.assertEqual(res2["messages_imported"], 0)
        self.assertEqual(res2["memories_imported"], 0)
        self.assertIsNotNone(self.store.get_migration(MIGRATION_ID))

    def test_corrupt_legacy_json_rolls_back_and_keeps_legacy_intact(self):
        team_dir = self.data_dir / "design_brain" / "team"
        team_dir.mkdir(parents=True, exist_ok=True)
        bad_file = team_dir / "bots.json"
        bad_file.write_text("{broken json", encoding="utf-8")

        with self.assertRaises(ValueError):
            migrate_legacy_design_team(self.data_dir, self.store, create_backup=False)

        # 旧文件原封不动，且 bot_manager 仍可用
        self.assertEqual(bad_file.read_text(encoding="utf-8"), "{broken json")
        bots = self.store.list_bots(include_archived=True)
        self.assertEqual([b["bot_id"] for b in bots], [MANAGER_BOT_ID])


if __name__ == "__main__":
    unittest.main()
