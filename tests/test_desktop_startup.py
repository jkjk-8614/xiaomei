"""Check the startup handshake without loading user configuration or data."""
import ast
import os
from pathlib import Path
import unittest
from unittest.mock import patch


class DesktopStartupTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        source = Path(__file__).resolve().parents[1] / "main.py"
        tree = ast.parse(source.read_text(encoding="utf-8"))
        function = next(node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name == "app_info")
        function.decorator_list = []
        cls.scope = {
            "os": os,
            "current_app_version": lambda: "test-version",
            "read_local_update_notes": lambda version: [],
        }
        for name in ("GITHUB_REPO_URL", "GITHUB_VERSION_URL", "GITHUB_TREE_URL", "GITHUB_UPDATE_NOTES_URL", "MODELSCOPE_REPO_URL", "MODELSCOPE_VERSION_URL", "MODELSCOPE_TREE_URL", "MODELSCOPE_UPDATE_NOTES_URL"):
            cls.scope[name] = "https://example.com/"
        exec(compile(ast.Module(body=[function], type_ignores=[]), str(source), "exec"), cls.scope)

    def test_desktop_backend_returns_the_launch_session(self):
        with patch.dict(os.environ, {"XIAOMEI_CANVAS_SESSION_ID": "desktop-launch-session"}):
            result = self.scope["app_info"]()
        self.assertEqual(result["desktop_session_id"], "desktop-launch-session")
        self.assertEqual(result["version"], "test-version")
        self.assertIn("sources", result)

    def test_manual_backend_has_no_desktop_session(self):
        with patch.dict(os.environ):
            os.environ.pop("XIAOMEI_CANVAS_SESSION_ID", None)
            self.assertEqual(self.scope["app_info"]()["desktop_session_id"], "")


if __name__ == "__main__":
    unittest.main()
