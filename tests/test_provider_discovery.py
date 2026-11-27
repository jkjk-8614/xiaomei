"""Exercise provider settings endpoints against isolated gateway fixtures."""

from contextlib import AsyncExitStack
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import AsyncMock, patch

import httpx

import main


_FETCH = "/api/providers/fetch-models"
_CONNECTION = "/api/providers/test-connection"
_PROBE = "/api/providers/probe-async"
_ARK_TASKS = "/api/v3/contents/generations/tasks"


class ProviderDiscoveryTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.context = AsyncExitStack()
        self.addAsyncCleanup(self.context.aclose)
        self.context.enter_context(patch.object(main, "prefetch_provider_icon", AsyncMock()))
        self.client_type = httpx.AsyncClient
        self.requests = []
        transport = httpx.ASGITransport(app=main.app, client=("127.0.0.1", 45000))
        self.api = await self.context.enter_async_context(self.client_type(
            transport=transport, base_url="http://127.0.0.1:3000",
            headers={main.LOCAL_SESSION_HEADER: main.LOCAL_SESSION_TOKEN},
        ))

    async def test_saved_catalog_preserves_model_lists_and_legacy_ark_settings(self):
        catalog = [
            {"id": "comfly", "image_models": ["fetched-image", "fetched-image"], "chat_models": ["fetched-chat"]},
            {"id": "codex-custom", "protocol": "codex", "model_selection_managed": True, "image_models": []},
            {"id": "legacy-ark", "protocol": "volcengine", "base_url": "https://ark.fixture.invalid/api/v3",
             "image_models": ["ark-image"], "video_models": ["ark-video"]},
        ]
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "api_providers.json"
            original = json.dumps(catalog).encode("utf-8")
            path.write_bytes(original)
            with (
                patch.object(main, "API_PROVIDERS_FILE", str(path)),
                patch.object(main, "detect_codex_image_capabilities", AsyncMock(return_value={"image_models": ["gpt-image-2"]})),
                patch.object(main, "ensure_key_profile_store_for_providers", return_value={"providers": {}}),
            ):
                reply = await self.api.get("/api/providers")
            self.assertEqual(path.read_bytes(), original)
        rows = reply.raise_for_status().json()["providers"]
        self.assertEqual([row["id"] for row in rows], ["comfly", "codex-custom", "legacy-ark", "volcengine"])
        self.assertEqual(rows[0]["image_models"], ["fetched-image"])
        self.assertEqual(rows[0]["chat_models"], ["fetched-chat"])
        self.assertEqual(rows[1]["image_models"], [])
        self.assertTrue(rows[1]["model_selection_managed"])
        self.assertEqual(rows[-1]["base_url"], "https://ark.fixture.invalid/api/v3")
        self.assertEqual(rows[-1]["image_models"], ["ark-image"])
        self.assertEqual(rows[-1]["video_models"], ["ark-video"])

    def upstream(self, handler):
        def observe(request):
            self.requests.append(request)
            return handler(request)

        def client(**options):
            return self.client_type(transport=httpx.MockTransport(observe), **options)

        self.context.enter_context(patch.object(httpx, "AsyncClient", side_effect=client))

    async def send(self, route, **values):
        return await self.api.post(route, json={
            "base_url": "https://provider.example/v1", "protocol": "openai", "api_key": "Bearer fixture", **values,
        })

    async def test_catalog_is_shared_by_saved_unsaved_connection_and_protocol_routes(self):
        base = "https://www.6789api.top/v1"

        def gateway(request):
            self.assertEqual(request.headers["Authorization"], "Bearer fixture")
            if request.url.path.startswith("/v1/tasks/"):
                return httpx.Response(404, json={"error": "Unknown path"})
            self.assertEqual((request.method, request.url.path), ("GET", "/v1/models"))
            return httpx.Response(200, json={"data": [
                {"id": "Seedance2.5"}, {"name": "seedance2.5"}, {"model": "gpt-image-fixture"},
                "gpt-chat-fixture", {"id": "seedance2.0", "status": "retired"},
                {"id": "missing-video", "available": "off"}, {"id": "other-chat", "disabled": True},
            ]})

        self.upstream(gateway)
        self.context.enter_context(patch.object(main, "get_api_provider_exact", return_value={
            "id": "api-6789", "name": "6789API", "base_url": base, "protocol": "openai",
        }))
        self.context.enter_context(patch.object(main, "provider_env_key_value", return_value="fixture"))
        saved = await self.api.get("/api/providers/api-6789/fetch-models")
        form = await self.send(_FETCH, base_url=base)
        connected = await self.send(_CONNECTION, base_url=base)
        protocol = await self.send(_PROBE, base_url=base)
        expected = {
            "video_models": ["seedance2.5"], "image_models": ["gpt-image-fixture"],
            "chat_models": ["gpt-chat-fixture"], "all": ["gpt-chat-fixture", "gpt-image-fixture", "seedance2.5"],
        }
        for response in (saved, form, connected, protocol):
            result = response.raise_for_status().json()
            self.assertEqual({key: result[key] for key in expected}, expected)
            self.assertEqual(result.get("model_count", result.get("total")), 3)
        self.assertIn("no-store", saved.headers["Cache-Control"])
        self.assertIn("no-store", form.headers["Cache-Control"])
        self.assertTrue(connected.json()["ok"])
        self.assertEqual(protocol.json()["protocol"], "openai")

    async def test_gemini_uses_native_header_and_strips_model_resource_prefix(self):
        def gateway(request):
            self.assertEqual(request.url.path, "/v1beta/models")
            self.assertEqual(request.headers["x-goog-api-key"], "fixture")
            self.assertNotIn("Authorization", request.headers)
            return httpx.Response(200, json={"models": [
                {"name": "models/gemini-chat-fixture", "supportedGenerationMethods": ["generateContent"]},
                {"name": "models/gemini-3.8-flash-tts", "supportedGenerationMethods": ["generateContent"]},
                {"name": "models/text-embedding-004", "supportedGenerationMethods": ["embedContent"]},
                {"name": "models/aqa", "supportedGenerationMethods": ["generateAnswer"]},
                {"name": "models/imagen-fixture", "supportedGenerationMethods": ["predict"]},
            ]})

        self.upstream(gateway)
        response = await self.send(_FETCH, protocol="gemini", base_url="https://provider.example/", api_key="fixture")
        result = response.raise_for_status().json()
        self.assertEqual(result["image_models"], ["imagen-fixture"])
        self.assertEqual(result["chat_models"], ["gemini-chat-fixture"])
        self.assertEqual(result["all"], ["gemini-chat-fixture", "imagen-fixture"])

    async def test_generic_404_does_not_switch_protocol_to_ark(self):
        def gateway(request):
            return httpx.Response(404, json={"error": {
                "code": "NotFound", "message": f"Unknown path {request.url.path}",
            }})

        self.upstream(gateway)
        protocol = (await self.send(_PROBE)).raise_for_status().json()
        self.assertFalse(protocol["ok"])
        self.assertEqual(protocol["protocol"], "openai")
        self.assertEqual((await self.send(_FETCH)).status_code, 404)
        connected = (await self.send(_CONNECTION)).raise_for_status().json()
        self.assertFalse(connected["ok"])
        self.assertEqual(connected["status"], 404)

    async def test_ark_read_only_probe_excludes_returned_task_content(self):
        def gateway(request):
            if request.url.path == _ARK_TASKS:
                self.assertEqual(request.method, "GET")
                self.assertEqual(dict(request.url.params), {
                    "page_size": "1", "filter.task_ids": "cgt-20000101000000-00000",
                })
                return httpx.Response(200, json={"total": 1, "items": [{"id": "private-history"}]})
            return httpx.Response(404)

        self.upstream(gateway)
        explicit = await self.send(_PROBE, protocol="volcengine", base_url="https://provider.example/api/v3")
        self.assertEqual(len(self.requests), 1)
        result = explicit.raise_for_status().json()
        self.assertTrue(result["ok"])
        self.assertEqual(result["protocol"], "volcengine")
        self.assertEqual(result["raw"], {"task_probe": {"total": 1}})
        detected = (await self.send(_PROBE, base_url="https://provider.example")).raise_for_status().json()
        self.assertTrue(detected["ok"])
        self.assertEqual(detected["protocol"], "volcengine")
        fetch = (await self.send(_FETCH, base_url="https://provider.example")).raise_for_status().json()
        self.assertEqual((fetch["protocol"], fetch["total"]), ("volcengine", 0))

    async def test_ark_proxy_can_use_structured_task_lookup_error(self):
        def gateway(request):
            self.assertEqual(request.method, "GET")
            if request.url.path == _ARK_TASKS:
                return httpx.Response(405)
            self.assertTrue(request.url.path.startswith(_ARK_TASKS + "/"))
            return httpx.Response(404, json={"error": {"code": "ResourceNotFound", "message": "Video task does not exist"}})

        self.upstream(gateway)
        result = (await self.send(_PROBE, protocol="volcengine", base_url="https://provider.example")).raise_for_status().json()
        self.assertTrue(result["ok"])
        self.assertEqual(result["protocol"], "volcengine")
        self.assertEqual(len(self.requests), 2)

    async def test_openai_proxy_without_catalog_can_verify_empty_chat_probe(self):
        def gateway(request):
            if request.method == "POST":
                self.assertEqual(request.url.path, "/v1/chat/completions")
                self.assertEqual(json.loads(request.content), {"messages": []})
                return httpx.Response(400, json={"error": {"message": "Model is required"}})
            return httpx.Response(404)

        self.upstream(gateway)
        result = (await self.send(_PROBE)).raise_for_status().json()
        self.assertTrue(result["ok"])
        self.assertEqual((result["protocol"], result["model_count"]), ("openai", 0))
        self.assertEqual(len(self.requests), 3)

    async def test_apimart_validates_task_path_without_generation(self):
        def gateway(request):
            self.assertEqual(request.method, "GET")
            self.assertTrue(request.url.path.startswith("/v1/tasks/"))
            return httpx.Response(400, json={"error": {"message": "无效的任务ID"}})

        self.upstream(gateway)
        result = (await self.send(_PROBE)).raise_for_status().json()
        self.assertTrue(result["ok"])
        self.assertEqual((result["protocol"], result["status_code"]), ("apimart", 400))
        self.assertEqual(len(self.requests), 1)

    async def test_redirects_and_login_pages_return_usable_errors(self):
        def gateway(request):
            if request.url.host == "redirect.example":
                return httpx.Response(302, headers={"Location": "https://login.example/"})
            self.assertEqual(request.url.host, "html.example")
            return httpx.Response(200, text="\ufeff  <!DOCTYPE html><title>Sign in</title>")

        self.upstream(gateway)
        for base, keyword in (("https://redirect.example", "跳转"), ("https://html.example", "HTML")):
            with self.subTest(base=base):
                fetch = await self.send(_FETCH, base_url=base)
                self.assertEqual(fetch.status_code, 400)
                self.assertIn(keyword, fetch.json()["detail"])
                connect = (await self.send(_CONNECTION, base_url=base)).raise_for_status().json()
                self.assertFalse(connect["ok"])
                self.assertIn(keyword, connect["message"])
        self.assertEqual(len(self.requests), 4)


    async def test_bad_base_is_rejected_before_a_network_call(self):
        self.upstream(lambda request: self.fail(f"Unexpected request to {request.url.host}"))
        for route in (_CONNECTION, _PROBE, _FETCH):
            response = await self.send(route, base_url="https://provider.example:invalid")
            self.assertEqual(response.status_code, 400)
            self.assertIn("端口", response.json()["detail"])
        self.assertEqual(self.requests, [])

    async def test_agnes_only_uses_model_fallback_for_empty_catalog(self):
        host = "https://apihub.agnes-ai.com"
        catalogs = iter([{"data": []}, {"data": [{"id": "agnes-video-v2.0", "enabled": False}]}])
        self.upstream(lambda request: httpx.Response(200, json=next(catalogs)))
        empty = (await self.send(_FETCH, base_url=host)).raise_for_status().json()
        self.assertEqual(empty["video_models"], ["agnes-video-v2.0"])
        self.assertEqual(empty["image_request_mode"], "openai-json")
        disabled = (await self.send(_FETCH, base_url=host)).raise_for_status().json()
        self.assertEqual(disabled["video_models"], [])
        self.assertEqual(disabled["total"], 0)
