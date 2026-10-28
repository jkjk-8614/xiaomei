import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from tools.migrate_harness_conversations import migrate


class HarnessConversationMigrationTests(unittest.TestCase):
    def check_import(self, project, runtime, configured_root):
        source = runtime / "data" / "conversations" / "工作区" / "会话.json"
        source.parent.mkdir(parents=True)
        content = json.dumps({"title": "商品分析", "messages": [{"role": "user", "content": "保留原图"}]}, ensure_ascii=False)
        source.write_text(content, encoding="utf-8")
        with patch.dict("os.environ", {"XIAOMEI_CANVAS_PROJECT_ROOT": "", "XIAOMEI_CANVAS_DATA_ROOT": configured_root}):
            result = migrate(project)
        self.assertEqual(result["status"], "complete")
        self.assertEqual(len(result["items"]), 1)
        target = Path(result["workspace"])
        self.assertEqual(target, runtime / ".xiaomei-data" / "deepseek-harness" / "imported-workspace")
        self.assertIn("保留原图", Path(result["items"][0]["output"]).read_text(encoding="utf-8"))
        self.assertEqual(source.read_text(encoding="utf-8"), content)
        if project != runtime:
            self.assertFalse((project / ".xiaomei-data").exists())

    def test_source_launch_reads_data_conversations(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            self.check_import(root, root, "")

    def test_packaged_launch_keeps_imports_in_user_data(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            self.check_import(root / "安装目录", root / "用户数据", str(root / "用户数据"))

    def test_relative_data_root_uses_shared_path_resolution(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            self.check_import(root, root / "用户数据", "用户数据")

    def test_missing_conversations_create_only_an_empty_runtime_manifest(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            project, runtime = root / "安装目录", root / "用户数据"
            with patch.dict("os.environ", {"XIAOMEI_CANVAS_PROJECT_ROOT": "", "XIAOMEI_CANVAS_DATA_ROOT": str(runtime)}):
                result = migrate(project)
            self.assertEqual(result["status"], "empty")
            self.assertTrue((runtime / ".xiaomei-data/deepseek-harness/conversation-migration.json").is_file())
            self.assertFalse(project.exists())


if __name__ == "__main__":
    unittest.main()
