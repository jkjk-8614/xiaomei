"""Exercise the installer without importing app startup or installing packages."""
import ast
import asyncio
import ipaddress
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest
import uuid
from unittest.mock import AsyncMock, Mock, patch

from fastapi import FastAPI, HTTPException, Request


def load_install_functions():
    names = {
        "codex_cli_executable", "codex_install_require_local", "run_codex_installer",
        "finish_codex_install", "codex_install_status", "codex_install",
        "_request_host_is_loopback", "_request_is_share_gateway",
    }
    source = Path(__file__).resolve().parents[1] / "main.py"
    tree = ast.parse(source.read_text(encoding="utf-8"))
    nodes = [node for node in tree.body if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node.name in names]
    namespace = dict(
        asyncio=asyncio, os=os, shutil=shutil, subprocess=subprocess, uuid=uuid,
        ipaddress=ipaddress, app=FastAPI(), Request=Request, HTTPException=HTTPException,
        BASE_DIR=str(source.parent), CODEX_INSTALL_STATE={"status": "idle", "message": ""},
        CODEX_INSTALL_TASK=None, CODEX_IMAGE_CAPABILITY_CACHE={"expires_at": 100, "result": {}},
        codex_env_value=Mock(return_value=""), cli_local_version=AsyncMock(return_value=("1.2.3", "codex 1.2.3")),
    )
    exec(compile(ast.Module(body=nodes, type_ignores=[]), str(source), "exec"), namespace)
    return namespace


def request(host="127.0.0.1", origin="http://127.0.0.1:3000", share=False):
    headers = [(b"host", b"127.0.0.1:3000"), (b"origin", origin.encode())]
    if share:
        headers.append((b"x-xiaomei-share-gateway", b"1"))
    return Request({"type": "http", "method": "POST", "scheme": "http", "path": "/api/codex/install",
                    "query_string": b"", "headers": headers, "client": (host, 1234), "server": ("127.0.0.1", 3000)})


class CodexInstallTests(unittest.TestCase):
    def setUp(self):
        self.ns = load_install_functions()

    def test_remote_cross_origin_and_shared_requests_rejected(self):
        for req in [request(host="192.168.1.10"), request(origin="https://example.com"), request(share=True)]:
            with self.assertRaises(HTTPException) as error:
                self.ns["codex_install_require_local"](req)
            self.assertEqual(error.exception.status_code, 403)
        self.ns["codex_install_require_local"](request())

    @unittest.skipUnless(os.name == "nt", "Windows installation")
    def test_detects_install_without_restarting_path_and_preserves_override(self):
        with tempfile.TemporaryDirectory(prefix="小美 CLI ") as directory:
            exe = Path(directory) / "Programs/OpenAI/Codex/bin/codex.exe"
            exe.parent.mkdir(parents=True)
            exe.touch()
            with patch.dict(os.environ, {"LOCALAPPDATA": directory}), patch.object(shutil, "which", return_value=None):
                self.assertEqual(self.ns["codex_cli_executable"](), str(exe))
                self.ns["codex_env_value"].return_value = "D:/custom/codex.exe"
                self.assertEqual(self.ns["codex_cli_executable"](), "D:/custom/codex.exe")

    def test_success_requires_working_cli_and_invalidates_capability_cache(self):
        self.ns["run_codex_installer"] = Mock(return_value=0)
        self.ns["codex_cli_executable"] = Mock(return_value="codex.exe")
        asyncio.run(self.ns["finish_codex_install"]([], "unused.log"))
        self.assertEqual(self.ns["CODEX_INSTALL_STATE"]["status"], "succeeded")
        self.assertEqual(self.ns["CODEX_IMAGE_CAPABILITY_CACHE"]["expires_at"], 0)
        self.ns["cli_local_version"].side_effect = RuntimeError("version failed")
        asyncio.run(self.ns["finish_codex_install"]([], "unused.log"))
        self.assertEqual(self.ns["CODEX_INSTALL_STATE"]["status"], "failed")

    def test_failed_installer_does_not_claim_success_with_existing_cli(self):
        self.ns["run_codex_installer"] = Mock(return_value=1)
        asyncio.run(self.ns["finish_codex_install"]([], "unused.log"))
        self.assertEqual(self.ns["CODEX_INSTALL_STATE"]["status"], "failed")
        self.ns["cli_local_version"].assert_not_awaited()

    def test_path_refresh_exit_code_2_with_working_cli_is_recovered(self):
        self.ns["run_codex_installer"] = Mock(return_value=2)
        self.ns["codex_cli_executable"] = Mock(return_value="C:/Users/test/AppData/Local/Programs/OpenAI/Codex/bin/codex.exe")
        asyncio.run(self.ns["finish_codex_install"]([], "unused.log"))
        self.assertEqual(self.ns["CODEX_INSTALL_STATE"]["status"], "succeeded")
        self.assertIn("PATH 尚未刷新", self.ns["CODEX_INSTALL_STATE"]["message"])
        self.ns["cli_local_version"].assert_awaited_once()

    @unittest.skipUnless(os.name == "nt", "Windows installation")
    def test_background_job_deduplicates_and_survives_status_refresh(self):
        async def scenario(directory):
            self.ns["BASE_DIR"] = directory
            script = Path(directory) / "CLI/windows/openai/install_openai_codex_cli.ps1"
            script.parent.mkdir(parents=True)
            script.touch()
            gate = asyncio.Event()
            async def finish(*_args):
                await gate.wait()
            self.ns["finish_codex_install"] = AsyncMock(side_effect=finish)
            with patch.object(shutil, "which", return_value="powershell.exe"):
                first = await self.ns["codex_install"](request())
                second = await self.ns["codex_install"](request())
                restored = await self.ns["codex_install_status"](request())
            self.assertEqual(first, second)
            self.assertEqual(restored["status"], "running")
            self.assertEqual(first["log_path"], restored["log_path"])
            gate.set()
            await self.ns["CODEX_INSTALL_TASK"]
            self.ns["finish_codex_install"].assert_awaited_once()
        with tempfile.TemporaryDirectory(prefix="小美 CLI ") as directory:
            asyncio.run(scenario(directory))

    @unittest.skipUnless(os.name == "nt", "Windows installation")
    def test_timeout_terminates_installer_tree(self):
        process = Mock(pid=123, wait=Mock(side_effect=[subprocess.TimeoutExpired("installer", 900), 1]))
        with tempfile.TemporaryDirectory() as directory, patch.object(subprocess, "Popen", return_value=process), patch.object(subprocess, "run") as stop:
            with self.assertRaisesRegex(RuntimeError, "15 分钟"):
                self.ns["run_codex_installer"](["powershell.exe"], str(Path(directory) / "install.log"))
            self.assertEqual(stop.call_args.args[0], ["taskkill.exe", "/PID", "123", "/T", "/F"])


if __name__ == "__main__":
    unittest.main()
