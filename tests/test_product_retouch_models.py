import asyncio
import base64
from io import BytesIO
from pathlib import Path
import tempfile
import unittest
from unittest import mock

import httpx
from PIL import Image

import main


class ProductRetouchModelTests(unittest.TestCase):
    def test_retouch_options_include_seedream_and_gpt_image_26_with_no_store(self):
        providers = [
            {
                "id": "api-6789",
                "name": "6789API",
                "enabled": True,
                "protocol": "openai",
                "image_request_mode": "openai",
                "base_url": "https://www.6789api.top",
                "image_models": [
                    "gemini-3.1-flash-image-preview",
                    "gpt-image-2",
                    "gpt-image-2-high",
                    "gpt-image-2-medium",
                    "gpt-image-2.5-flare",
                    "gpt-image-2.6-flare",
                    "nano-banana-2",
                    "nano-banana-2.1",
                    "seedream-5.5",
                ],
                "model_protocols": {
                    "gemini-3.1-flash-image-preview": "gemini",
                    "nano-banana-2": "gemini",
                    "nano-banana-2.1": "gemini",
                },
            },
            {
                "id": "volcengine",
                "name": "火山引擎",
                "enabled": True,
                "protocol": "volcengine",
                "image_request_mode": "openai",
                "base_url": "https://ark.cn-beijing.volces.com/api/v3",
                "image_models": ["doubao-seedream-5-0-260128", "doubao-seedream-3-0-t2i-250415"],
                "model_protocols": {},
            },
            {
                "id": "soon",
                "name": "soon",
                "enabled": True,
                "protocol": "openai",
                "image_request_mode": "openai",
                "base_url": "https://api.soonstudio.ai/v1",
                "image_models": ["gpt-image-2-1k"],
                "model_protocols": {},
            },
        ]

        async def scenario():
            client_type = httpx.AsyncClient
            with (
                mock.patch.object(main, "detect_codex_image_capabilities", new=mock.AsyncMock(return_value={"image_models": []})),
                mock.patch.object(main, "public_api_providers", new=mock.AsyncMock(return_value=providers)),
            ):
                async with client_type(transport=httpx.ASGITransport(app=main.app), base_url="http://127.0.0.1") as client:
                    response = await client.get("/api/product-retouch/options")
                    self.assertEqual(response.status_code, 200, response.text)
                    self.assertIn("no-store", response.headers.get("cache-control", ""))
                    models = response.json()["models"]

            by_provider = {}
            for entry in models:
                by_provider.setdefault(entry["provider_id"], {})[entry["model"]] = entry["resolutions"]

            self.assertEqual(
                list(by_provider["api-6789"].keys()),
                providers[0]["image_models"],
            )
            self.assertEqual(by_provider["api-6789"]["seedream-5.5"], ["1k", "2k", "4k"])
            self.assertEqual(by_provider["api-6789"]["gpt-image-2.6-flare"], ["1k", "2k", "4k"])
            self.assertEqual(list(by_provider["volcengine"].keys()), ["doubao-seedream-5-0-260128"])
            self.assertEqual(by_provider["soon"]["gpt-image-2-1k"], ["1k"])

        asyncio.run(scenario())

    def test_seedream_product_retouch_preserves_source_aspect_ratio_and_finishes(self):
        async def scenario(root):
            provider = {
                "id": "api-6789",
                "name": "6789API",
                "enabled": True,
                "protocol": "openai",
                "image_request_mode": "openai",
                "base_url": "https://www.6789api.top",
                "image_models": ["seedream-5.5", "gpt-image-2.6-flare"],
                "model_protocols": {},
            }
            source_path = Path(root, "product.png")
            Image.new("RGB", (800, 1000), (210, 180, 140)).save(source_path)

            out_buf = BytesIO()
            Image.new("RGB", (1632, 2048), (212, 182, 142)).save(out_buf, format="PNG")
            out_b64 = base64.b64encode(out_buf.getvalue()).decode("ascii")
            requests = []

            def respond(request):
                requests.append(request)
                return httpx.Response(200, json={"data": [{"b64_json": out_b64}]})

            client_type = httpx.AsyncClient
            with (
                mock.patch.multiple(
                    main,
                    get_api_provider=mock.Mock(return_value=provider),
                    get_api_provider_exact=mock.Mock(return_value=provider),
                    api_headers=mock.Mock(return_value={}),
                    _ready_background_removal_model=mock.AsyncMock(side_effect=main.HTTPException(status_code=503, detail="no matte")),
                    OUTPUT_OUTPUT_DIR=root,
                    CANVAS_TASKS_FILE=str(Path(root, "tasks.json")),
                    CANVAS_TASKS={},
                    CANVAS_IMAGE_BACKGROUND_TASKS={},
                    save_to_history=mock.Mock(),
                    GLOBAL_LOOP=None,
                ),
                mock.patch.object(
                    main.httpx,
                    "AsyncClient",
                    side_effect=lambda **options: client_type(transport=httpx.MockTransport(respond), **options),
                ),
            ):
                async with client_type(transport=httpx.ASGITransport(app=main.app), base_url="http://127.0.0.1") as client:
                    response = await client.post(
                        "/api/canvas-image-tasks",
                        json={
                            "prompt": "产品精修",
                            "provider_id": "api-6789",
                            "model": "seedream-5.5",
                            "n": 1,
                            "size": "1632x2048",
                            "resolution": "2k",
                            "aspect_ratio": "source",
                            "reference_images": [{"url": "/output/product.png"}],
                            "product_retouch": {"category": "general", "background": "original"},
                            "history_source": "canvas",
                        },
                    )
                    self.assertEqual(response.status_code, 200, response.text)
                    task_id = response.json()["task_id"]
                    await main.CANVAS_IMAGE_BACKGROUND_TASKS[task_id]
                    task = (await client.get(f"/api/canvas-image-tasks/{task_id}")).json()
                    self.assertEqual(task["status"], "succeeded", task.get("error"))
                    self.assertEqual(task["result"]["model"], "seedream-5.5")
                    self.assertEqual(len(task["result"]["product_retouch"]), 1)
                    self.assertEqual(task["result"]["params"]["size"], "1632x2048")

            self.assertEqual(len(requests), 1)
            self.assertEqual(requests[0].url.path, "/v1/images/edits")
            self.assertIn(b'name="model"\r\n\r\nseedream-5.5\r\n', requests[0].content)
            self.assertIn(b'name="size"\r\n\r\n1632x2048\r\n', requests[0].content)

        with tempfile.TemporaryDirectory(prefix="retouch-seedream-") as root:
            asyncio.run(scenario(root))


if __name__ == "__main__":
    unittest.main()
