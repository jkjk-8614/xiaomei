import base64
import json
import tempfile
import unittest
from contextlib import AsyncExitStack
from io import BytesIO
from pathlib import Path
from unittest.mock import AsyncMock, patch

import httpx
from PIL import Image

import main


PROVIDER = {"id": "apimart", "name": "APIMart", "protocol": "apimart",
            "base_url": "https://fixture.apimart.invalid/v1"}
VIDEO_ROUTE = "/api/canvas-video"
OUTPUT_URL = "https://media.example.com/result.mp4"


def sample_png():
    with BytesIO() as buffer:
        Image.new("RGB", (16, 16), "white").save(buffer, "PNG")
        return buffer.getvalue()


class ApimartAdapterTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.context = AsyncExitStack()
        self.addAsyncCleanup(self.context.aclose)
        self.directory = Path(self.context.enter_context(tempfile.TemporaryDirectory(prefix="xiaomei-apimart-")))
        self.context.enter_context(patch.object(main, "get_api_provider", return_value=PROVIDER))
        self.context.enter_context(patch.object(main, "provider_env_key_value", return_value="fixture-key"))
        self.context.enter_context(patch.object(main, "ASSETS_DIR", str(self.directory)))
        self.context.enter_context(patch.object(main, "local_asset_public_url", return_value=""))
        self.context.enter_context(patch.object(main, "save_remote_video_to_output", AsyncMock(return_value="/output/result.mp4")))
        self.history = self.context.enter_context(patch.object(
            main, "save_canvas_video_to_history", side_effect=lambda _payload, _provider, result: result,
        ))
        transport = httpx.ASGITransport(app=main.app, client=("127.0.0.1", 45000))
        self.api = await self.context.enter_async_context(httpx.AsyncClient(
            transport=transport, base_url="http://127.0.0.1:3000",
            headers={main.LOCAL_SESSION_HEADER: main.LOCAL_SESSION_TOKEN, "Origin": "http://127.0.0.1:3000"},
        ))

    def use_upstream(self, handler):
        client = httpx.AsyncClient
        self.context.enter_context(patch.object(httpx, "AsyncClient", side_effect=lambda **kwargs:
                                   client(transport=httpx.MockTransport(handler), **kwargs)))

    async def test_lite_image_uses_apimart_submission_polling_and_history(self):
        model = "gemini-3.1-flash-lite-image-ext"
        provider = {**PROVIDER, "id": "apimart-ai", "protocol": "openai",
                    "base_url": "https://api.apimart.ai/v1", "model_protocols": {model: "gemini"}}
        self.context.enter_context(patch.multiple(
            main, get_api_provider=lambda _: provider, APIMART_IMAGE_INITIAL_POLL_DELAY=0,
            OUTPUT_OUTPUT_DIR=str(self.directory), HISTORY_FILE=str(self.directory / "history.json"),
            CANVAS_TASKS_FILE=str(self.directory / "tasks.json"),
            CANVAS_TASKS={}, CANVAS_IMAGE_BACKGROUND_TASKS={}, GLOBAL_LOOP=None,
        ))
        encoded = base64.b64encode(sample_png()).decode("ascii")
        reference = "data:image/png;base64," + encoded
        submitted = []
        polled = []

        def upstream(request):
            self.assertEqual(request.headers["Authorization"], "Bearer fixture-key")
            self.assertNotIn("x-goog-api-key", request.headers)
            if request.method == "POST":
                self.assertEqual(request.url.path, "/v1/images/generations")
                submitted.append(json.loads(request.content))
                task_id = f"task-{len(submitted)}"
                return httpx.Response(200, json={"code": 200, "data": [{"task_id": task_id, "status": "submitted"}]})
            polled.append(request.url.path)
            return httpx.Response(200, json={"data": {"status": "completed", "result": {
                "images": [{"b64_json": encoded}],
            }}})

        self.use_upstream(upstream)
        payload = {"provider_id": provider["id"], "model": model, "prompt": "测试",
                   "size": "1008x1344", "reference_images": [{"url": reference, "kind": "image"}]}
        online = await self.api.post("/api/online-image", json={**payload, "history_source": "online"})
        self.assertTrue(online.raise_for_status().json()["images"])
        for source in ("canvas", "commerce"):
            response = await self.api.post("/api/canvas-image-tasks", json={**payload, "history_source": source})
            task_id = response.raise_for_status().json()["task_id"]
            pending = main.CANVAS_IMAGE_BACKGROUND_TASKS.get(task_id)
            if pending:
                await pending
            task = (await self.api.get(f"/api/canvas-image-tasks/{task_id}")).raise_for_status().json()
            self.assertEqual(task["status"], "succeeded", task.get("error"))
        self.assertEqual(polled, [f"/v1/tasks/task-{index}" for index in range(1, 4)])
        self.assertEqual(submitted, [{
            "model": model, "prompt": "测试", "n": 1, "size": "3:4", "resolution": "1K",
            "image_urls": [reference],
        }] * 3)
        history = (await self.api.get("/api/history")).raise_for_status().json()
        self.assertEqual({item["history_source"] for item in history}, {"online", "canvas", "commerce"})

    def test_apimart_protocol_default_preserves_other_gemini_routes(self):
        model = "nano-banana-2"
        self.assertEqual(main.effective_protocol(PROVIDER, model), "apimart")
        for base_url in ("https://apib.ai", "https://api.apib.ai/v1"):
            self.assertEqual(main.effective_protocol({"base_url": base_url}, model), "apimart")
        for base_url in ("https://apimart.ai.example.invalid", "https://generativelanguage.googleapis.com"):
            self.assertEqual(main.effective_protocol({"base_url": base_url}, model), "gemini")
        custom = {**PROVIDER, "model_protocols": {model: "gemini"}}
        self.assertEqual(main.effective_protocol(custom, model), "gemini")
        self.assertEqual(main.apimart_size_resolution("8:1", lite=True), ("21:9", "1k"))

    async def test_seedance_uploads_references_and_queries_the_saved_task_id(self):
        picture = sample_png()
        (self.directory / "参考.png").write_bytes(picture)
        sound = b"reference audio fixture"
        (self.directory / "voice.wav").write_bytes(sound)
        calls = []

        def upstream(request):
            route = request.url.path
            calls.append((request.method, route))
            self.assertEqual(request.headers["Authorization"], "Bearer fixture-key")
            if route == "/v1/uploads/images":
                self.assertIn(picture, request.content)
                return httpx.Response(201, json={"id": "upload-receipt", "data": {"file_url": "https://media.example.com/input.png"}})
            if route == "/v1/uploads/audios":
                return httpx.Response(404)
            if route == "/v1/uploads/files":
                self.assertIn(sound, request.content)
                return httpx.Response(200, json={"data": {"asset_id": "audio-1"}})
            if request.method == "POST":
                self.assertEqual(route, "/v1/videos/generations")
                body = json.loads(request.content)
                self.assertEqual(body["image_urls"], ["https://media.example.com/input.png"])
                self.assertEqual(body["video_urls"], ["asset://video-1"])
                self.assertEqual(body["audio_urls"], ["asset://audio-1"])
                self.assertEqual(body["prompt"], "沿用图片1\n参考素材：视频1，音频1。")
                self.assertEqual((body["duration"], body["size"], body["seed"]), (15, "adaptive", 0))
                self.assertTrue(body["return_last_frame"])
                self.assertFalse(body["generate_audio"])
                return httpx.Response(200, json={"code": 200, "data": [{"task_id": "task-1", "status": "submitted"}]})
            self.assertEqual(route, "/v1/tasks/task-1")
            self.assertEqual(request.url.params["language"], "zh")
            return httpx.Response(200, json={"data": {"status": "completed", "result": {"videos": [{"url": [OUTPUT_URL]}]}}})

        self.use_upstream(upstream)
        response = (await self.api.post(VIDEO_ROUTE, json={
            "provider_id": "apimart", "model": "doubao-seedance-2.0", "prompt": "沿用图片1",
            "images": [{"url": "http://127.0.0.1:3000/assets/%E5%8F%82%E8%80%83.png"}],
            "videos": ["", "asset://video-1"], "audios": ["/assets/voice.wav"],
            "trusted_asset": True, "seed": 0, "duration": 30, "aspect_ratio": "keep_ratio", "return_last_frame": True,
        })).raise_for_status().json()
        self.assertEqual(response["videos"], ["/output/result.mp4"])
        self.assertEqual(response["task_id"], "task-1")
        self.assertEqual(calls[-1], ("GET", "/v1/tasks/task-1"))
        self.history.assert_called_once()

    async def test_veo_frame_roles_aliases_and_rejection_before_submission(self):
        submitted = []
        image_attempts = 0
        png = sample_png()
        inline = "data:image/png;base64," + base64.b64encode(png).decode("ascii")

        def upstream(request):
            nonlocal image_attempts
            if request.url.path == "/v1/uploads/images":
                image_attempts += 1
                if image_attempts == 1:
                    raise httpx.ReadError("fixture TLS interruption", request=request)
                self.assertIn(png, request.content)
                return httpx.Response(200, json={"data": [{"url": "https://media.example.com/frame.png"}]})
            submitted.append(json.loads(request.content))
            return httpx.Response(200, json={"videos": [{"url": OUTPUT_URL}]})

        self.use_upstream(upstream)
        images = [{"url": inline, "role": "first_frame"}, {"url": "https://media.example.com/last.png", "role": "last_frame"}]
        request = {"provider_id": "apimart", "model": "veo3.1-pro", "prompt": "frame motion", "images": images,
                   "aspect_ratio": "1:1", "resolution": "1080", "duration": 15}
        (await self.api.post(VIDEO_ROUTE, json=request)).raise_for_status()
        self.assertEqual(submitted[0], {
            "model": "veo3.1-quality", "prompt": "frame motion", "duration": 8, "aspect_ratio": "16:9",
            "resolution": "1080p", "official_fallback": False, "generation_type": "frame",
            "image_urls": ["https://media.example.com/frame.png", "https://media.example.com/last.png"],
        })
        for bad in ({**request, "model": "veo3.1-lite"}, {**request, "audios": ["asset://audio-1"]},
                    {**request, "model": "doubao-seedance-2.0", "videos": ["asset://video-1"]}):
            self.assertEqual((await self.api.post(VIDEO_ROUTE, json=bad)).status_code, 400)
        self.assertEqual(len(submitted), 1)
        self.assertEqual(image_attempts, 2)

    async def test_asset_review_uses_approved_entries_and_keeps_legacy_receipts(self):
        item = {"id": "asset-1", "url": "https://media.example.com/portrait.png", "kind": "image", "name": "人像"}
        library = {"libraries": [{"id": "lib-1", "categories": [{"items": [item]}]}]}
        usable = []

        def upstream(request):
            if request.method == "POST":
                self.assertEqual(request.url.path, "/v1/seedance2/private-avatar")
                self.assertEqual(json.loads(request.content), {
                    "project_name": "studio", "asset_type": "Image", "group": {"name": "Portraits"},
                    "assets": [{"url": item["url"], "name": "人像"}],
                })
                return httpx.Response(201, json={"code": 200, "data": {"id": "review-1", "status": "processing"}})
            self.assertEqual(request.url.path, "/v1/tasks/review-1")
            return httpx.Response(200, json={"data": {"status": "completed", "result": {
                "assets": [{"asset_id": "rejected", "status": "Failed"}], "usable_assets": usable,
            }}})

        self.use_upstream(upstream)
        body = {"provider_id": "apimart", "library_id": "lib-1", "project_name": "studio", "group_name": "Portraits"}
        endpoint = "/api/asset-library/items/asset-1"
        with patch.object(main, "load_asset_library", return_value=library), patch.object(main, "save_asset_library"):
            created = (await self.api.post(endpoint + "/register-avatar", json=body)).raise_for_status().json()
            self.assertEqual(created["item"]["registrations"]["apimart"]["task_id"], "review-1")
            checked = (await self.api.post(endpoint + "/avatar-status", json=body)).raise_for_status().json()
            self.assertEqual(checked["item"]["registrations"]["apimart"]["status"], "Failed")
            usable.append({"asset_url": "asset://approved", "status": "Active"})
            checked = (await self.api.post(endpoint + "/avatar-status", json=body)).raise_for_status().json()
        self.assertEqual(checked["item"]["registrations"]["apimart"]["asset_uri"], "asset://approved")

    async def test_cloud_storage_reference_falls_back_to_second_host(self):
        clip = self.directory / "视频.mp4"
        clip.write_bytes(b"video fixture")
        routes = []

        def upstream(request):
            routes.append(request.url.host)
            self.assertIn(b"video fixture", request.content)
            self.assertNotIn("Authorization", request.headers)
            if request.url.host == "upload-one.invalid":
                self.assertIn(b'name="fileToUpload"', request.content)
                return httpx.Response(200, text="")
            self.assertEqual(request.url.host, "upload-two.invalid")
            self.assertIn(b'name="file"', request.content)
            return httpx.Response(200, text="https://media.example.com/temporary.mp4\n")

        self.use_upstream(upstream)
        address = "/api/storage-files/video/clip.mp4"
        with patch.object(main, "output_file_from_url", return_value=str(clip)), patch.dict(main.os.environ, {
            "LITTERBOX_UPLOAD_URL": "https://upload-one.invalid/upload", "TEMP_SH_UPLOAD_URL": "https://upload-two.invalid/upload",
        }):
            result = (await self.api.post("/api/cloud-video/upload", json={"url": address})).raise_for_status().json()
        self.assertEqual(result["source"], address)
        self.assertEqual(result["service"], "temp.sh")
        self.assertEqual(result["url"], "https://media.example.com/temporary.mp4")
        self.assertEqual(routes, ["upload-one.invalid", "upload-two.invalid"])
