"""P0 测试：Bot 工作区功能开关、防旧版 5-Bot 自动种入与本地数据备份。"""
import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from fastapi import FastAPI
from fastapi.testclient import TestClient

import bot_workspace_config as cfg
import design_brain_team_api
from design_brain_team import TeamStore
from scripts.backup_bot_workspace_data import backup_user_data


class BotWorkspaceConfigTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="小美开关测试-")
        self.data_dir = Path(self.tmp.name)

    def tearDown(self):
        self.tmp.cleanup()

    def test_feature_flag_precedence_and_persistence(self):
        with mock.patch.dict(os.environ, {}, clear=False):
            os.environ.pop(cfg.FEATURE_FLAG_ENV, None)
            self.assertTrue(cfg.is_bot_workspace_enabled(self.data_dir))
            self.assertFalse(cfg.should_seed_legacy_design_team(self.data_dir))

            saved = cfg.write_feature_flags(self.data_dir, False)
            self.assertFalse(saved["enabled"])
            self.assertEqual(saved["source"], "file")
            self.assertTrue(cfg.should_seed_legacy_design_team(self.data_dir))

            with mock.patch.dict(os.environ, {cfg.FEATURE_FLAG_ENV: "1"}):
                flags = cfg.read_feature_flags(self.data_dir)
                self.assertTrue(flags["enabled"])
                self.assertEqual(flags["source"], "env")
                self.assertTrue(flags["env_locked"])
                self.assertFalse(cfg.should_seed_legacy_design_team(self.data_dir))

    def test_new_mode_prevents_legacy_five_bot_auto_seed(self):
        store = TeamStore(self.data_dir)
        app = FastAPI()
        app.include_router(design_brain_team_api.router)
        client = TestClient(app)

        with mock.patch.dict(os.environ, {cfg.FEATURE_FLAG_ENV: "1"}):
            with mock.patch.object(design_brain_team_api, "TEAM", store):
                resp = client.get("/api/design-brain/bots")
                self.assertEqual(resp.status_code, 200)
                self.assertEqual(resp.json()["bots"], [])
                self.assertFalse((self.data_dir / "design_brain" / "team" / "bots.json").exists())

        with mock.patch.dict(os.environ, {cfg.FEATURE_FLAG_ENV: "0"}):
            with mock.patch.object(design_brain_team_api, "TEAM", store):
                resp = client.get("/api/design-brain/bots")
                self.assertEqual(resp.status_code, 200)
                self.assertEqual(len(resp.json()["bots"]), 5)

    def test_backup_preserves_source_and_writes_manifest(self):
        team_dir = self.data_dir / "design_brain" / "team"
        team_dir.mkdir(parents=True, exist_ok=True)
        bots_file = team_dir / "bots.json"
        original_content = json.dumps({"bots": [{"id": "bot_custom", "name": "中文测试"}]}, ensure_ascii=False)
        bots_file.write_text(original_content, encoding="utf-8")

        manifest = backup_user_data(self.data_dir, label="unit")
        backup_dir = Path(manifest["backup_dir"])
        self.assertTrue((backup_dir / "backup_manifest.json").is_file())
        copied = backup_dir / "design_brain" / "team" / "bots.json"
        self.assertTrue(copied.is_file())
        self.assertEqual(copied.read_text(encoding="utf-8"), original_content)
        # 源文件未被修改
        self.assertEqual(bots_file.read_text(encoding="utf-8"), original_content)


if __name__ == "__main__":
    unittest.main()
