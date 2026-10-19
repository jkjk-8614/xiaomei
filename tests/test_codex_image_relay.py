"""GPT CLI image routing with fixture credentials and an isolated local relay."""
import ast
import asyncio
import base64
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from io import BytesIO
import json
import os
from pathlib import Path
import re
import shutil
import glob
import tempfile
import threading
import unittest
import urllib.parse
from unittest.mock import AsyncMock, Mock, patch

from fastapi import FastAPI, HTTPException
from PIL import Image


class CodexImageRelayTests(unittest.IsolatedAsyncioTestCase):
    @classmethod
    def setUpClass(cls):
        cls.source = Path(__file__).resolve().parents[1] / "main.py"
        names = {
            "gpt_image_2_skill_executable", "gpt_image_2_skill_auth_file",
            "gpt_image_2_skill_auth_json", "gpt_image_2_skill_access_token",
            "gpt_image_2_skill_api_key", "gpt_image_2_skill_openai_args",
            "gpt_image_2_skill_provider_args", "gpt_image_2_skill_failure_message",
            "parse_gpt_image_2_skill_output", "codex_decode_output",
            "generate_codex_provider_image_via_gpt_image_2_skill",
            "generate_codex_provider_image", "codex_status",
        }
        tree = ast.parse(cls.source.read_text(encoding="utf-8"))
        nodes = [node for node in tree.body if getattr(node, "name", "") in names]
        assert len(nodes) == len(names)
        cls.code = compile(ast.Module(body=nodes, type_ignores=[]), str(cls.source), "exec")

    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="小美 CLI 中转 ")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.codex_home = self.root / "独立 Codex"
        self.codex_home.mkdir()
        self.auth_file = self.codex_home / "auth.json"
        self.auth_file.write_text(json.dumps({"auth_mode": "apikey", "OPENAI_API_KEY": "fixture-auth-key"}), encoding="utf-8")
        self.env = {"CODEX_HOME": str(self.codex_home)}
        self.ns = dict(
            asyncio=asyncio, os=os, json=json, re=re, shutil=shutil, glob=glob,
            urllib=urllib, HTTPException=HTTPException, app=FastAPI(),
            BASE_DIR=str(self.root), OUTPUT_OUTPUT_DIR=str(self.root),
            CODEX_DEFAULT_IMAGE_MODELS=["gpt-image-2"],
            codex_env_value=lambda key: self.env.get(key, ""),
            codex_timeout=lambda: 15,
            generated_output_filename=lambda *_: "fixture-result.png",
            gpt_image_2_skill_model_arg=lambda model, _: model,
            gpt_image_2_skill_size_arg=lambda size, *_: size,
            gpt_image_2_skill_prompt_arg=lambda prompt, *_: prompt,
            codex_postprocess_image_to_requested_size=lambda *_: "",
            codex_output_url_from_path=lambda path: "/output/" + Path(path).name,
            codex_reference_paths=AsyncMock(return_value=([], [])),
            is_codex_gpt_image_25_model=lambda _: False,
            generate_codex_provider_image_via_codex_cli=AsyncMock(),
            codex_cli_executable=lambda: "fixture-codex.exe",
            detect_codex_image_capabilities=AsyncMock(return_value={"probe_ok": True, "message": "fixture capability", "image_models": ["gpt-image-2"]}),
        )
        exec(self.code, self.ns)

    def write_config(self, base="https://relay.example/v1", extra="", provider="relay"):
        (self.codex_home / "config.toml").write_text(
            f'model_provider = {json.dumps(provider)}\n[model_providers.{provider}]\n'
            + (f'base_url = {json.dumps(base)}\n' if base else "")
            + extra,
            encoding="utf-8-sig",
        )

    def options(self):
        args, provider = self.ns["gpt_image_2_skill_provider_args"](str(self.auth_file))
        return dict(zip(args[::2], args[1::2])), provider

    async def test_api_key_and_base_follow_selected_codex_provider(self):
        self.write_config(extra='experimental_bearer_token = "fixture-provider-key"\n')
        options, provider = self.options()
        self.assertEqual(provider, "openai")
        self.assertEqual(options["--api-key"], "fixture-provider-key")
        self.assertEqual(options["--openai-api-base"], "https://relay.example/v1")
        self.assertEqual(self.ns["gpt_image_2_skill_auth_file"](), str(self.auth_file))

    async def test_env_key_and_explicit_api_override_keep_their_own_base(self):
        self.write_config(extra='env_key = "FIXTURE_RELAY_KEY"\n')
        self.env["FIXTURE_RELAY_KEY"] = "fixture-env-key"
        self.assertEqual(self.options()[0]["--api-key"], "fixture-env-key")
        self.env.update(GPT_IMAGE_2_SKILL_API_KEY="fixture-official-key")
        options, _ = self.options()
        self.assertEqual(options["--api-key"], "fixture-official-key")
        self.assertEqual(options["--openai-api-base"], "https://api.openai.com/v1")
        self.env["GPT_IMAGE_2_SKILL_OPENAI_API_BASE"] = "https://explicit.example/v1/"
        self.assertEqual(self.options()[0]["--openai-api-base"], "https://explicit.example/v1")

    async def test_oauth_login_keeps_codex_auth_without_api_routing(self):
        self.write_config(extra='experimental_bearer_token = "fixture-provider-key"\n')
        self.auth_file.write_text(json.dumps({"tokens": {"access_token": "fixture-access-token"}}), encoding="utf-8")
        options, provider = self.options()
        self.assertEqual(provider, "codex")
        self.assertEqual(options["--auth-file"], str(self.auth_file))
        self.assertNotIn("--api-key", options)
        self.assertNotIn("--openai-api-base", options)

    async def test_invalid_config_never_sends_relay_key_to_default_endpoint(self):
        for contents in ('model_provider = "relay"\n[model_providers.relay]\n', 'invalid = [', 'model_provider = "relay"\n[model_providers.relay]\nbase_url = "https://user:secret@relay.example/v1"\n'):
            (self.codex_home / "config.toml").write_text(contents, encoding="utf-8")
            with self.assertRaises(HTTPException) as error:
                self.options()
            self.assertEqual(error.exception.status_code, 400)
            self.assertNotIn("secret", error.exception.detail)
        self.write_config(extra='env_key = "MISSING_FIXTURE_KEY"\n')
        with self.assertRaises(HTTPException) as error:
            self.options()
        self.assertIn("MISSING_FIXTURE_KEY", error.exception.detail)
        self.write_config(base="http://[invalid-host")
        with self.assertRaises(HTTPException) as error:
            self.options()
        self.assertEqual(error.exception.status_code, 400)

    async def test_auth_failure_is_not_reported_as_missing_helper_and_redacts_key(self):
        self.write_config()
        self.ns["gpt_image_2_skill_executable"] = lambda: "fixture-helper.exe"
        error_output = json.dumps({"error": {"message": "401 Incorrect API key provided: fixture-auth-key"}}).encode()
        proc = Mock(returncode=1, communicate=AsyncMock(return_value=(error_output, b"")))
        with patch.object(asyncio, "create_subprocess_exec", AsyncMock(return_value=proc)):
            with self.assertRaises(HTTPException) as error:
                await self.ns["generate_codex_provider_image"]("fixture prompt", "1024x1024", "gpt-image-2")
        self.assertEqual(error.exception.status_code, 401)
        self.assertIn("鉴权失败", error.exception.detail)
        self.assertIn("401", error.exception.detail)
        self.assertNotIn("fixture-auth-key", error.exception.detail)
        self.assertNotIn("未安装", error.exception.detail)
        self.ns["generate_codex_provider_image_via_codex_cli"].assert_not_awaited()

    async def test_api_network_and_quota_failures_preserve_source_and_reason(self):
        self.write_config()
        self.ns["gpt_image_2_skill_executable"] = lambda: "fixture-helper.exe"
        for message in ("error sending request: network_error", "429 Rate limit exceeded for API key"):
            proc = Mock(returncode=1, communicate=AsyncMock(return_value=(json.dumps({"error": {"message": message}}).encode(), b"")))
            with patch.object(asyncio, "create_subprocess_exec", AsyncMock(return_value=proc)):
                with self.assertRaises(HTTPException) as error:
                    await self.ns["generate_codex_provider_image"]("fixture prompt", "1024x1024", "gpt-image-2")
            self.assertEqual(error.exception.status_code, 502)
            self.assertIn(message, error.exception.detail)
            self.assertNotIn("未安装", error.exception.detail)
        self.ns["generate_codex_provider_image_via_codex_cli"].assert_not_awaited()

    async def test_helper_http_error_preserves_upstream_detail_and_redacts_key(self):
        self.write_config()
        self.ns["gpt_image_2_skill_executable"] = lambda: "fixture-helper.exe"
        message = "The model 'gpt-image-2-codex' does not support the 'input_fidelity' parameter. fixture-auth-key"
        for detail in (json.dumps({"error": {"message": message}}), {"error": {"message": message}}, message):
            with self.subTest(detail_type=type(detail).__name__):
                output = json.dumps({"ok": False, "error": {"code": "http_error", "message": "HTTP 400", "detail": detail}}, indent=2).encode()
                proc = Mock(returncode=1, communicate=AsyncMock(return_value=(output, b"")))
                with patch.object(asyncio, "create_subprocess_exec", AsyncMock(return_value=proc)):
                    with self.assertRaises(HTTPException) as error:
                        await self.ns["generate_codex_provider_image"]("fixture prompt", "2160x3840", "gpt-image-2")
                self.assertIn("HTTP 400", error.exception.detail)
                self.assertIn("does not support the 'input_fidelity' parameter", error.exception.detail)
                self.assertNotIn("fixture-auth-key", error.exception.detail)
        self.ns["generate_codex_provider_image_via_codex_cli"].assert_not_awaited()

    async def test_missing_helper_reports_install_action(self):
        self.ns["gpt_image_2_skill_executable"] = lambda: ""
        with self.assertRaises(HTTPException) as error:
            await self.ns["generate_codex_provider_image"]("fixture prompt", "1024x1024", "gpt-image-2")
        self.assertEqual(error.exception.status_code, 400)
        self.assertIn("安装 / 更新", error.exception.detail)

    async def test_status_reports_effective_image_base_without_credentials(self):
        self.write_config(extra='experimental_bearer_token = "fixture-provider-key"\n')
        self.ns["gpt_image_2_skill_executable"] = lambda: "fixture-helper.exe"
        proc = Mock(returncode=0, communicate=AsyncMock(return_value=(b"codex 1.0", b"")))
        with patch.object(asyncio, "create_subprocess_exec", AsyncMock(return_value=proc)):
            status = await self.ns["codex_status"]()
        self.assertTrue(status["installed"])
        self.assertEqual(status["image_connection"], {"provider": "openai", "api_base": "https://relay.example/v1"})
        self.assertIn("https://relay.example/v1", status["message"])
        self.assertNotIn("fixture-provider-key", json.dumps(status))

    async def test_installed_helper_generates_and_edits_through_local_fixture_relay(self):
        executable = self.ns["gpt_image_2_skill_executable"]()
        if not executable or (os.name == "nt" and not executable.lower().endswith(".exe")):
            self.skipTest("Native GPT Image helper is not installed")
        image_buffer = BytesIO()
        Image.new("RGB", (32, 32), "teal").save(image_buffer, format="PNG")
        fixture_image = image_buffer.getvalue()
        requests = []

        class Relay(BaseHTTPRequestHandler):
            def do_POST(self):
                requests.append((self.path, {key.lower(): value for key, value in self.headers.items()}, self.rfile.read(int(self.headers.get("Content-Length", 0)))))
                if b'input_fidelity' in requests[-1][2]:
                    body = json.dumps({"error": {"message": "The model 'gpt-image-2' does not support the 'input_fidelity' parameter."}}).encode()
                    self.send_response(400)
                else:
                    body = json.dumps({"created": 1, "data": [{"b64_json": base64.b64encode(fixture_image).decode()}]}).encode()
                    self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def log_message(self, *_):
                pass

        server = ThreadingHTTPServer(("127.0.0.1", 0), Relay)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        self.write_config(base=f"http://127.0.0.1:{server.server_port}/v1", extra='experimental_bearer_token = "fixture-provider-key"\n')
        prompt = "中文商品参考图，保持包装 🌷"
        reference = self.root / "中文参考图.png"
        reference.write_bytes(fixture_image)
        try:
            for references, expected_route in (([], "/v1/images/generations"), ([str(reference), str(reference)], "/v1/images/edits")):
                result = await self.ns["generate_codex_provider_image_via_gpt_image_2_skill"](prompt, "2160x3840", "gpt-image-2", references)
                self.assertEqual(result[0]["value"], "/output/fixture-result.png")
                self.assertNotIn("fixture-provider-key", json.dumps(result))
                self.assertEqual(requests[-1][0], expected_route)
                self.assertEqual(requests[-1][1]["authorization"], "Bearer fixture-provider-key")
                self.assertNotIn(b"input_fidelity", requests[-1][2])
                if references:
                    self.assertIn(prompt.encode(), requests[-1][2])
                    self.assertIn(b"gpt-image-2", requests[-1][2])
                    self.assertIn(b"2160x3840", requests[-1][2])
                    self.assertEqual(requests[-1][2].count(b"filename="), 2)
                else:
                    body = json.loads(requests[-1][2])
                    self.assertEqual(body["prompt"], prompt)
                    self.assertEqual(body["model"], "gpt-image-2")
                self.assertEqual((self.root / "fixture-result.png").read_bytes(), fixture_image)
                (self.root / "fixture-result.png").unlink()
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=2)


if __name__ == "__main__":
    unittest.main()
