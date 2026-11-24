"""Exercise image delivery failures without contacting a paid provider."""

import errno
import io
import tempfile
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch
from uuid import uuid4

import httpx
from PIL import Image

import main
import network_diagnostics


def png():
    data = io.BytesIO()
    Image.new("RGB", (3, 3), "red").save(data, "PNG")
    return data.getvalue()


class ImageNetworkTests(unittest.IsolatedAsyncioTestCase):
    async def test_platform_available_but_image_times_out_without_leaking_link(self):
        provider = {"id": uuid4().hex, "base_url": "https://api.example.test", "protocol": "openai"}
        requests = []

        def respond(request):
            requests.append((request.method, request.url.host, request.url.path))
            if request.url.host == "api.example.test":
                return httpx.Response(200, json={"data": [{"id": "image"}]})
            raise httpx.ReadTimeout("download interrupted", request=request)

        real_client = httpx.AsyncClient
        transport = httpx.MockTransport(respond)
        url = "https://cdn.example.test/result.png?signature=private-value"
        image = {"type": "url", "value": url}
        with tempfile.TemporaryDirectory() as directory, \
                patch.object(main, "get_api_provider_exact", return_value=provider), \
                patch.object(main, "api_key_from_payload", return_value="private-key"), \
                patch.object(main, "unparsed_image_response_path", return_value=str(Path(directory) / "recover.jsonl")), \
                patch.object(main.httpx, "AsyncClient", side_effect=lambda **kwargs: real_client(transport=transport, **kwargs)), \
                patch.dict(main.os.environ, {"AI_IMAGE_DOWNLOAD_RETRIES": "1"}):
            await main.check_image_network(provider["id"])
            url, recovery = await main.save_chat_delivery(provider, "image", image, {})
            report = await main.read_image_network(provider["id"])
        self.assertEqual(url, "")
        self.assertEqual(report["checks"]["provider"]["status"], "ok")
        self.assertEqual(report["checks"]["download"]["code"], "timeout")
        self.assertEqual(report["checks"]["download"]["origin"], "https://cdn.example.test")
        self.assertEqual(report["checks"]["download"]["recovery_id"], recovery["id"])
        self.assertNotIn("private", str(report))
        self.assertEqual(requests, [
            ("GET", "api.example.test", "/v1/models"), ("GET", "cdn.example.test", "/result.png"),
        ])

    async def test_write_failure_is_local_and_does_not_redownload(self):
        provider_id = uuid4().hex
        url = "https://images.example.test/generated"
        image = {"type": "url", "value": url}
        calls = []

        def download(request):
            calls.append(request.url)
            return httpx.Response(200, content=png(), headers={"Content-Type": "image/png"})

        real_client = httpx.AsyncClient
        with patch.object(main.httpx, "AsyncClient", side_effect=lambda **kwargs: real_client(transport=httpx.MockTransport(download), **kwargs)), \
                patch.object(main, "_write_generated_snapshot", side_effect=OSError(errno.ENOSPC, "disk full")), \
                patch.object(main, "save_unparsed_image_response", return_value="img-123"):
            await main.save_chat_delivery({"id": provider_id}, "image", image, {})
        report = network_diagnostics.image_status(provider_id)["checks"]
        self.assertEqual(report["download"]["status"], "ok")
        self.assertEqual(report["save"]["code"], "disk_full")
        self.assertEqual(len(calls), 1)

    async def test_proxy_comparison_does_not_change_settings_or_send_credentials(self):
        real_client = httpx.AsyncClient
        called = []

        def routed_client(*, trust_env, **kwargs):
            def respond(request):
                called.append((trust_env, request.url.path, request.headers.get("Authorization")))
                if trust_env:
                    raise httpx.ProxyError("proxy unavailable", request=request)
                return httpx.Response(404)
            return real_client(transport=httpx.MockTransport(respond), trust_env=trust_env, **kwargs)

        with patch.object(network_diagnostics.httpx, "AsyncClient", side_effect=routed_client):
            report = await network_diagnostics.compare_proxy_routes("https://images.example.test")
        self.assertEqual(report["configured"]["code"], "proxy")
        self.assertEqual(report["no_proxy"]["status"], "ok")
        self.assertCountEqual(called, [(True, "/", None), (False, "/", None)])

    async def test_partial_delivery_recovers_only_missing_image_and_keeps_history_unique(self):
        provider = {"id": uuid4().hex, "base_url": "https://api.example.test", "image_models": ["image"]}
        complete = "https://cdn.example.test/complete.png"
        expired = "https://cdn.example.test/expired.png"
        fresh = "https://cdn.example.test/new.png"
        receipt = {"id": "existing-task", "data": [{"url": complete}, {"url": expired}]}
        old = main.ImageResultDownloadError(code="http_403", status=403)
        saved_urls = {
            complete: "/output/first.png", fresh: "/output/second.png",
        }

        async def save(item, **kwargs):
            if item["value"] == expired:
                raise old
            return saved_urls[item["value"]]

        with tempfile.TemporaryDirectory() as directory, \
                patch.object(main, "get_api_provider", return_value=provider), \
                patch.object(main, "unparsed_image_response_path", return_value=str(Path(directory) / "recover.jsonl")), \
                patch.object(main, "HISTORY_FILE", str(Path(directory) / "history.json")), \
                patch.object(main, "asset_registry_register_history_record"), \
                patch.object(main, "output_file_from_url", return_value=str(Path(directory) / "image.png")), \
                patch.object(main, "generate_ai_image", new=AsyncMock(return_value=({"type": "url", "value": complete}, receipt))) as generate, \
                patch.object(main, "save_ai_image_to_output", new=AsyncMock(side_effect=save)) as materialize, \
                patch.object(main, "refresh_recovery_image_addresses", new=AsyncMock(return_value=[
                    {"type": "url", "value": complete}, {"type": "url", "value": fresh},
                ])):
            result = await main.build_online_image_result(main.OnlineImageRequest(prompt="test", history_source="canvas"))
            self.assertEqual(result["images"], [saved_urls[complete]])
            self.assertIn("1/2", result["partial_failures"][0]["error"])
            recovery_id = result["partial_failures"][0]["recovery_id"]
            first = await main.recover_unparsed_image_result(recovery_id, "canvas", "")
            again = await main.recover_unparsed_image_result(recovery_id, "canvas", "")
            self.assertEqual(first, again)
            self.assertEqual(first["images"], [saved_urls[fresh]])
            self.assertEqual(len(main._load_history_for_update_locked()), 2)
            self.assertEqual([call.args[0]["value"] for call in materialize.await_args_list], [complete, expired, expired, fresh])
            generate.assert_awaited_once()
