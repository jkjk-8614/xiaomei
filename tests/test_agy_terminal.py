"""Verify the Windows agy terminal handoff without starting a real console."""
import ast
import asyncio
import copy
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, Mock


class SimpleHTTPException(Exception):
    def __init__(self, status_code, detail):
        self.status_code = status_code
        self.detail = detail


class AgyTerminalTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        source = Path(__file__).resolve().parents[1] / "main.py"
        names = {"open_agy_terminal", "finish_cli_install", "verify_cli_install", "gemini_cli_terminal"}
        tree = ast.parse(source.read_text(encoding="utf-8-sig"))
        body = [copy.deepcopy(node) for node in tree.body if getattr(node, "name", "") in names]
        assert len(body) == len(names)
        for node in body:
            node.decorator_list = []
        cls.code = compile(ast.Module(body=body, type_ignores=[]), str(source), "exec")

    def make_scope(self):
        popen = Mock()
        scope = {
            "os": SimpleNamespace(name="nt", environ={"EXISTING": "yes"}),
            "shutil": SimpleNamespace(which=Mock(return_value="C:/Windows/powershell.exe")),
            "subprocess": SimpleNamespace(Popen=popen, CREATE_NEW_CONSOLE=16),
            "BASE_DIR": "D:/小美画布",
            "is_antigravity_cli": lambda exe: str(exe).lower().endswith("agy.exe"),
            "CLI_INSTALL_SPECS": {"gemini-cli": {"label": "Antigravity CLI", "done_message": "安装完成。"}},
            "CLI_INSTALL_STATES": {"gemini-cli": {}},
            "cli_install_executable": Mock(return_value="C:/用户 目录/agy.exe"),
            "cli_local_version": AsyncMock(return_value=("1.3.3", "agy 1.3.3")),
            "run_cli_installer": Mock(return_value=0),
            "asyncio": asyncio,
            "Request": object,
            "HTTPException": SimpleHTTPException,
            "cli_install_require_local": Mock(),
            "gemini_cli_executable": Mock(return_value="C:/用户 目录/agy.exe"),
        }
        exec(self.code, scope)
        return scope, popen

    def test_opens_interactive_console_with_unicode_path(self):
        scope, popen = self.make_scope()
        scope["open_agy_terminal"]("C:/用户 目录/agy.exe")
        args, kwargs = popen.call_args
        self.assertEqual(args[0][-2:], ["-Command", "& $env:XIAOMEI_AGY_BIN"])
        self.assertEqual(kwargs["env"]["XIAOMEI_AGY_BIN"], "C:/用户 目录/agy.exe")
        self.assertEqual(kwargs["env"]["EXISTING"], "yes")
        self.assertEqual(kwargs["creationflags"], 16)
        self.assertIn("-NoExit", args[0])

    def test_rejects_missing_agy(self):
        scope, popen = self.make_scope()
        with self.assertRaisesRegex(RuntimeError, "未找到可运行的 agy"):
            scope["open_agy_terminal"]("C:/other/gemini.exe")
        popen.assert_not_called()

    def test_successful_install_opens_terminal(self):
        scope, popen = self.make_scope()
        asyncio.run(scope["finish_cli_install"]("gemini-cli", ["installer"], "install.log"))
        self.assertEqual(scope["CLI_INSTALL_STATES"]["gemini-cli"]["status"], "succeeded")
        self.assertIn("已打开 agy 终端", scope["CLI_INSTALL_STATES"]["gemini-cli"]["message"])
        popen.assert_called_once()

    def test_terminal_failure_preserves_install_success(self):
        scope, popen = self.make_scope()
        popen.side_effect = OSError("console unavailable")
        asyncio.run(scope["finish_cli_install"]("gemini-cli", ["installer"], "install.log"))
        state = scope["CLI_INSTALL_STATES"]["gemini-cli"]
        self.assertEqual(state["status"], "succeeded")
        self.assertIn("未能打开 agy 终端", state["message"])

    def test_fallback_gemini_does_not_count_as_agy_install(self):
        scope, popen = self.make_scope()
        scope["cli_install_executable"].return_value = "C:/other/gemini.exe"
        asyncio.run(scope["finish_cli_install"]("gemini-cli", ["installer"], "install.log"))
        self.assertEqual(scope["CLI_INSTALL_STATES"]["gemini-cli"]["status"], "failed")
        popen.assert_not_called()

    def test_manual_endpoint_opens_terminal(self):
        scope, popen = self.make_scope()
        result = asyncio.run(scope["gemini_cli_terminal"](object()))
        self.assertTrue(result["ok"])
        scope["cli_install_require_local"].assert_called_once()
        popen.assert_called_once()

    def test_manual_endpoint_reports_missing_agy(self):
        scope, popen = self.make_scope()
        scope["gemini_cli_executable"].return_value = ""
        with self.assertRaises(SimpleHTTPException) as caught:
            asyncio.run(scope["gemini_cli_terminal"](object()))
        self.assertEqual(caught.exception.status_code, 404)
        popen.assert_not_called()


if __name__ == "__main__":
    unittest.main()
