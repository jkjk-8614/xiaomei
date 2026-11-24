"""Regression tests for Dreamina command execution and task recovery."""

import asyncio
from contextlib import AsyncExitStack
import json
from pathlib import Path
import sys
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import AsyncMock, patch

from fastapi import HTTPException
import httpx

from jimeng_cli import DreaminaCLI, decode_output, parse_reply
from jimeng_login import DeviceLogin
import main


_FIXTURE = r"""
import json
from pathlib import Path
import sys
import time

args = sys.argv[1:]
with open("commands.jsonl", "a", encoding="utf-8") as history:
    history.write(json.dumps(args, ensure_ascii=False) + "\n")

if args == ["login", "--headless"]:
    if Path("legacy").exists():
        print("Error: unknown flag: --headless", file=sys.stderr, flush=True)
        raise SystemExit(1)
    print("verification_uri: https://example.invalid/device", flush=True)
    print("user_code: USER123", flush=True)
    print("device_code: fixture-device-secret", flush=True)
    time.sleep(0.35)
elif args == ["login", "--debug"]:
    print("verification_uri_complete: https://example.invalid/device?user_code=LEGACY", flush=True)
    print("user_code: LEGACY", flush=True)
    print("device_code: fixture-device-secret", flush=True)
elif args[:2] == ["login", "checklogin"]:
    assert args[2] == "--device_code=fixture-device-secret"
    assert args[3].startswith("--poll=")
    Path("linked").touch()
    print("linked fixture-device-secret", flush=True)
elif args == ["user_credit"]:
    if not Path("linked").exists():
        print("not logged in", file=sys.stderr)
        raise SystemExit(1)
    print(json.dumps({"total_credit": 7}))
elif args == ["logout"]:
    Path("linked").unlink(missing_ok=True)
    print("{}")
elif args == ["sleep"]:
    time.sleep(30)
elif args == ["-h"]:
    print("Help uses an interval such as [0, 8]")
else:
    print(json.dumps({"arguments": args}, ensure_ascii=True))
"""


class FixtureCLI(DreaminaCLI):
    def __init__(self, root):
        self.root = root
        self.processes = []
        self.started = asyncio.Event()
        super().__init__(root, lambda name: sys.executable if name == "JIMENG_BIN" else "")
        (root / "fixture.py").write_text(_FIXTURE, encoding="utf-8")

    async def command(self, args, launcher, *, wsl):
        return [launcher, str(self.root / "fixture.py"), *args]

    async def _spawn(self, command):
        process = await super()._spawn(command)
        self.processes.append(process)
        self.started.set()
        return process

    def history(self):
        log = self.root / "commands.jsonl"
        return [json.loads(line) for line in log.read_text(encoding="utf-8").splitlines()] if log.exists() else []


class JimengOutputTests(unittest.TestCase):
    def test_wsl_output_decodes_mixed_encodings_and_keeps_actionable_error(self):
        noise = "wsl: localhost proxy unavailable with NAT\r\n".encode("utf-16-le")
        actual = "无法启动即梦\n".encode()
        out, err = decode_output(b"\xff\xfe" + "Ubuntu\r\nUbuntu-24.04\r\n".encode("utf-16-le"),
                                 noise + actual, wsl=True)
        self.assertEqual(out.splitlines(), ["Ubuntu", "Ubuntu-24.04"])
        self.assertEqual(err, "无法启动即梦")
        _, err = decode_output(b"", "Error: device expired\r\n".encode("utf-16-be"), wsl=True)
        self.assertEqual(err, "Error: device expired")

    def test_cli_json_ignores_embedded_diagnostic_arrays(self):
        self.assertEqual(parse_reply('log interval [0, 8]\n{"submit_id":"job-a","data":{}}\nfinished'),
                         {"submit_id": "job-a", "data": {}})
        self.assertEqual(parse_reply("plain response"), {"text": "plain response"})


class JimengProcessTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.context = AsyncExitStack()
        self.addAsyncCleanup(self.context.aclose)
        self.root = Path(self.context.enter_context(TemporaryDirectory(prefix="即梦命令测试-")))
        self.cli = FixtureCLI(self.root)
        self.login = DeviceLogin(self.cli, initial_wait=0.02)
        self.context.push_async_callback(self.login.close)
        self.context.enter_context(patch.object(main, "JIMENG_LOGIN", self.login))
        self.context.enter_context(patch.object(main, "run_jimeng_cli", self.cli.run))
        transport = httpx.ASGITransport(app=main.app, client=("127.0.0.1", 45000))
        self.api = await self.context.enter_async_context(httpx.AsyncClient(
            transport=transport, base_url="http://127.0.0.1:3000",
            headers={main.LOCAL_SESSION_HEADER: main.LOCAL_SESSION_TOKEN},
        ))

    async def wait_for_login(self):
        for _ in range(60):
            result = (await self.api.get("/api/jimeng/login/status")).raise_for_status().json()
            if result["logged_in"]:
                return result
            await asyncio.sleep(0.04)
        self.fail("The local checklogin command did not complete")

    async def test_device_exchange_continues_after_start_response_and_logout_closes_session(self):
        start = (await self.api.post("/api/jimeng/login/start")).raise_for_status().json()
        self.assertTrue(start["running"])
        status = await self.wait_for_login()
        self.assertFalse(status["running"])
        self.assertEqual(status["verification_uri_complete"], "https://example.invalid/device?user_code=USER123")
        self.assertNotIn("fixture-device-secret", status["text"])
        self.assertEqual(status["raw"]["total_credit"], 7)
        launches = [entry for entry in self.cli.history() if entry[0] == "login"]
        self.assertEqual([entry[:2] for entry in launches], [["login", "--headless"], ["login", "checklogin"]])
        logout = await self.api.post("/api/jimeng/logout")
        self.assertTrue(logout.raise_for_status().json()["success"])
        self.assertFalse((await self.api.get("/api/jimeng/login/status")).raise_for_status().json()["logged_in"])

    async def test_old_cli_switches_to_debug_for_unsupported_headless_flag(self):
        (self.root / "legacy").touch()
        await self.login.start()
        status = await self.wait_for_login()
        self.assertEqual(status["user_code"], "LEGACY")
        self.assertEqual([entry[:2] for entry in self.cli.history() if entry[0] == "login"],
                         [["login", "--headless"], ["login", "--debug"], ["login", "checklogin"]])

    async def test_native_cli_timeout_and_cancellation_reap_processes(self):
        with self.assertRaises(HTTPException) as caught:
            await self.cli.run(["sleep"], timeout=0.08)
        self.assertEqual(caught.exception.status_code, 504)
        self.assertIsNotNone(self.cli.processes[-1].returncode)
        self.cli.started.clear()
        running = asyncio.create_task(self.cli.run(["sleep"], timeout=10))
        await asyncio.wait_for(self.cli.started.wait(), timeout=3)
        running.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await running
        self.assertIsNotNone(self.cli.processes[-1].returncode)

    async def test_raw_help_and_native_argument_boundaries(self):
        result = await self.cli.run(["-h"], raw_text=True)
        self.assertEqual(result["_stdout"], "Help uses an interval such as [0, 8]")
        values = ["商品 中文.png", 'literal "quote"; $(printf test)']
        self.assertEqual((await self.cli.run(values))["arguments"], values)

    async def test_query_preserves_saved_task_id_for_pending_reply_and_returns_results(self):
        identifier = "3f6eb41f425d23a3"
        task = AsyncMock(side_effect=[
            {"data": {"gen_status": "queued", "queue_info": {"queue_idx": 1, "queue_length": 5}}},
            {"result_json": '{"images":[{"url":"https://fixture.invalid/result.png"}]}'},
            {"gen_status": "failed", "fail_reason": "生成失败"},
        ])
        save = AsyncMock(return_value="/output/result.png")
        with patch.object(main, "jimeng_query_result", task), patch.object(main, "jimeng_store_output_value", save):
            async def query():
                return (await self.api.post("/api/jimeng/query-media", json={
                    "submit_id": identifier, "kind": "image",
                })).raise_for_status().json()

            pending = await query()
            self.assertEqual((pending["status"], pending["submit_id"]), ("pending", identifier))
            self.assertEqual(pending["queue_info"], {"queue_idx": 1, "queue_length": 5})
            completed = await query()
            self.assertEqual((completed["status"], completed["urls"]), ("succeeded", ["/output/result.png"]))
            failure = await query()
            self.assertEqual(failure["status"], "failed")
            self.assertIn("生成失败", failure["error"])
        self.assertEqual([call.args for call in task.await_args_list], [(identifier, "image")] * 3)
        save.assert_awaited_once_with("https://fixture.invalid/result.png", "image")

    async def test_query_downloads_to_the_requested_media_directory(self):
        with patch.object(main, "OUTPUT_OUTPUT_DIR", str(self.root)), patch.object(main, "jimeng_cli_path_arg", str):
            for kind, folder in (("image", "图片"), ("video", "视频"), ("audio", "音频")):
                with self.subTest(kind=kind):
                    result = await main.jimeng_query_result("saved-task", kind)
                    destination = self.root / folder
                    self.assertTrue(destination.is_dir())
                    self.assertEqual(result["arguments"], [
                        "query_result", "--submit_id=saved-task", f"--download_dir={destination}",
                    ])
