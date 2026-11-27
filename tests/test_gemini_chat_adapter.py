"""Verify Google Gemini OpenAI-compatible chat routing, auth headers, and non-chat model filtering."""

import json
import unittest
from unittest.mock import AsyncMock, patch

from fastapi import HTTPException
import httpx

import canvas_agent_transport
import chat_errors
import dispatch_kernel
import main
import provider_discovery


class GeminiChatAdapterTests(unittest.IsolatedAsyncioTestCase):
    def _gemini_provider(self, base_url="https://generativelanguage.googleapis.com/v1beta"):
        return {
            "id": "generativelanguage-googleapis-com",
            "name": "Google Gemini",
            "protocol": "gemini",
            "base_url": base_url,
            "chat_models": ["gemini-3.8-flash-tts", "gemini-4-argon", "gemini-4-hydrogen"],
            "image_models": ["gemini-3.1-flash-image-preview"],
        }

    def test_resolve_chat_provider_uses_openai_compat_endpoint_and_bearer_auth_for_gemini(self):
        for raw_base in (
            "https://generativelanguage.googleapis.com",
            "https://generativelanguage.googleapis.com/v1beta",
            "https://generativelanguage.googleapis.com/v1beta/openai",
        ):
            provider = self._gemini_provider(raw_base)
            with (
                self.subTest(base_url=raw_base),
                patch.object(main, "get_api_provider", return_value=provider),
                patch.object(main, "provider_env_key_value", return_value="fixture-gemini-key"),
            ):
                base, headers, model = main.resolve_chat_provider(provider["id"], "", "")
            self.assertEqual(base, "https://generativelanguage.googleapis.com/v1beta/openai")
            self.assertEqual(headers["Authorization"], "Bearer fixture-gemini-key")
            self.assertNotIn("x-goog-api-key", headers)
            self.assertEqual(model, "gemini-4-argon")

    def test_resolve_chat_provider_strips_models_prefix_and_rejects_tts_with_suggestion(self):
        provider = self._gemini_provider()
        with (
            patch.object(main, "get_api_provider", return_value=provider),
            patch.object(main, "provider_env_key_value", return_value="fixture-gemini-key"),
        ):
            _, _, stripped = main.resolve_chat_provider(provider["id"], "models/gemini-4-hydrogen", "")
            self.assertEqual(stripped, "gemini-4-hydrogen")
            with self.assertRaises(HTTPException) as ctx:
                main.resolve_chat_provider(provider["id"], "gemini-3.8-flash-tts", "")
        self.assertEqual(ctx.exception.status_code, 400)
        self.assertIn("gemini-3.8-flash-tts", ctx.exception.detail)
        self.assertIn("gemini-4-argon", ctx.exception.detail)

    def test_native_gemini_image_headers_and_endpoint_remain_native(self):
        provider = self._gemini_provider("https://generativelanguage.googleapis.com/v1beta/openai")
        with patch.object(main, "provider_env_key_value", return_value="fixture-gemini-key"):
            headers = main.api_headers(provider=provider, model="gemini-3.1-flash-image-preview")
        self.assertEqual(headers["x-goog-api-key"], "fixture-gemini-key")
        self.assertNotIn("Authorization", headers)
        endpoint = dispatch_kernel.join_endpoint(
            provider, "image_generation_endpoint", "/v1beta/models/gemini-3.1-flash-image-preview:generateContent",
        )
        self.assertEqual(
            endpoint,
            "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-image-preview:generateContent",
        )

    def test_mixed_openai_gateway_keeps_v1_chat_route_and_bearer_auth(self):
        provider = {
            "id": "comfly",
            "name": "comfly",
            "protocol": "openai",
            "base_url": "https://ai.comfly.org",
            "chat_models": ["gemini-3.8-flash"],
            "model_protocols": {"gemini-3.8-flash": "gemini"},
        }
        with (
            patch.object(main, "get_api_provider", return_value=provider),
            patch.object(main, "provider_env_key_value", return_value="fixture-openai-key"),
        ):
            base, headers, model = main.resolve_chat_provider("comfly", "gemini-3.8-flash", "")
        self.assertEqual(base, "https://ai.comfly.org/v1")
        self.assertEqual(headers["Authorization"], "Bearer fixture-openai-key")
        self.assertNotIn("x-goog-api-key", headers)
        self.assertEqual(model, "gemini-3.8-flash")

    def test_openai_protocol_preserves_explicit_v1beta_openai_base(self):
        provider = {
            "id": "google-openai",
            "name": "Google OpenAI",
            "protocol": "openai",
            "base_url": "https://generativelanguage.googleapis.com/v1beta/openai",
            "chat_models": ["gemini-4-argon"],
        }
        with (
            patch.object(main, "get_api_provider", return_value=provider),
            patch.object(main, "provider_env_key_value", return_value="fixture-gemini-key"),
        ):
            base, headers, _ = main.resolve_chat_provider("google-openai", "gemini-4-argon", "")
        self.assertEqual(base, "https://generativelanguage.googleapis.com/v1beta/openai")
        self.assertEqual(headers["Authorization"], "Bearer fixture-gemini-key")
        self.assertEqual(
            provider_discovery.models_url(provider["base_url"], "openai"),
            "https://generativelanguage.googleapis.com/v1beta/openai/models",
        )
        self.assertEqual(
            provider_discovery.models_url(provider["base_url"], "gemini"),
            "https://generativelanguage.googleapis.com/v1beta/models",
        )

    def test_model_candidates_skips_non_chat_models_for_fallback(self):
        provider = self._gemini_provider()
        candidates = canvas_agent_transport.model_candidates(provider, "gemini-4-argon", 5)
        self.assertEqual(candidates, ["gemini-4-argon", "gemini-4-hydrogen"])

    def test_chat_errors_parses_google_array_error_payloads(self):
        auth_error = json.dumps([{
            "error": {
                "code": 400,
                "message": "Missing or invalid Authorization header.",
                "status": "INVALID_ARGUMENT",
            }
        }])
        self.assertIn("API Key", chat_errors.friendly_detail(auth_error, "gemini-4-argon", status_code=400))

        transient_error = json.dumps([{
            "error": {
                "code": 503,
                "message": "The service is currently unavailable.",
                "status": "UNAVAILABLE",
            }
        }])
        self.assertTrue(chat_errors.is_transient(transient_error, 503))

        tts_error = json.dumps([{
            "error": {
                "code": 400,
                "message": "Model does not support the requested response modalities: text",
                "status": "INVALID_ARGUMENT",
            }
        }])
        self.assertIn("TTS", chat_errors.friendly_detail(tts_error, "gemini-3.8-flash-tts", status_code=400))

    async def test_canvas_llm_reverse_prompt_sends_bearer_auth_to_gemini_openai_endpoint(self):
        provider = self._gemini_provider()
        seen = []
        client_type = httpx.AsyncClient

        def handle(request):
            seen.append((request.method, str(request.url), dict(request.headers), json.loads(request.content)))
            return httpx.Response(200, json={
                "choices": [{"message": {"content": "一只放在原木桌面上的白色陶瓷杯，柔光棚拍"}}],
                "usage": {"total_tokens": 25},
            })

        transport = httpx.ASGITransport(app=main.app, client=("127.0.0.1", 41000))
        async with client_type(transport=transport, base_url="http://127.0.0.1:3000") as browser:
            with (
                patch.object(main, "get_api_provider", return_value=provider),
                patch.object(main, "provider_env_key_value", return_value="fixture-gemini-key"),
                patch.object(main, "resolve_canvas_skill_request", return_value=(None, "")),
                patch.object(main, "enrich_canvas_message_with_links", AsyncMock(return_value={})),
                patch.object(main.httpx, "AsyncClient", side_effect=lambda **options:
                             client_type(transport=httpx.MockTransport(handle), **options)),
            ):
                response = await browser.post("/api/canvas-llm", json={
                    "provider": provider["id"],
                    "model": "gemini-4-argon",
                    "message": "反推提示词",
                })
        data = response.raise_for_status().json()
        self.assertEqual(data["text"], "一只放在原木桌面上的白色陶瓷杯，柔光棚拍")
        self.assertEqual(len(seen), 1)
        method, url, headers, body = seen[0]
        self.assertEqual(method, "POST")
        self.assertEqual(url, "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions")
        self.assertEqual(headers.get("authorization"), "Bearer fixture-gemini-key")
        self.assertNotIn("x-goog-api-key", headers)
        self.assertEqual(body["model"], "gemini-4-argon")


if __name__ == "__main__":
    unittest.main()
