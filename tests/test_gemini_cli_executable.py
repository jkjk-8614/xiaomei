import ast
import os
from pathlib import Path
import shutil
import tempfile
import unittest
from unittest.mock import Mock, patch


class GeminiCliExecutableTests(unittest.TestCase):
    def setUp(self):
        source = Path(__file__).resolve().parents[1] / "main.py"
        tree = ast.parse(source.read_text(encoding="utf-8-sig"))
        names = {"gemini_cli_executable"}
        module = ast.Module(body=[node for node in tree.body if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node.name in names], type_ignores=[])
        self.env = Mock(return_value="")
        self.scope = {"os": os, "shutil": shutil, "gemini_cli_env_value": self.env,
                      "antigravity_cli_winget_candidates": Mock(return_value=[])}
        exec(compile(module, str(source), "exec"), self.scope)
        self.resolve = self.scope["gemini_cli_executable"]

    def test_existing_configured_path_with_chinese_and_spaces(self):
        with tempfile.TemporaryDirectory(prefix="小美 CLI ") as directory:
            executable = Path(directory) / "agy.exe"
            executable.touch()
            self.env.side_effect = lambda key: f'"{executable}"' if key == "AGY_BIN" else ""
            with patch.object(shutil, "which", side_effect=lambda value: value if os.path.isfile(value) else None):
                self.assertEqual(self.resolve(), str(executable))

    def test_stale_config_uses_current_path_installation(self):
        self.env.return_value = "C:/removed/agy.exe"
        with patch.object(shutil, "which", side_effect=lambda value: "C:/current/agy.exe" if value == "agy" else None):
            self.assertEqual(self.resolve(), "C:/current/agy.exe")

    def test_stale_config_and_missing_path_use_winget(self):
        self.env.return_value = "C:/removed/agy.exe"
        self.scope["antigravity_cli_winget_candidates"].return_value = ["C:/winget/agy.exe"]
        with patch.object(shutil, "which", return_value=None):
            self.assertEqual(self.resolve(), "C:/winget/agy.exe")

    def test_missing_installation_returns_empty(self):
        self.env.return_value = "C:/removed/agy.exe"
        with patch.object(shutil, "which", return_value=None):
            self.assertEqual(self.resolve(), "")


if __name__ == "__main__":
    unittest.main()
