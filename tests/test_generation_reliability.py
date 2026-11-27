import asyncio
import base64
import copy
from io import BytesIO
import json
import tempfile
import time
import unittest
from pathlib import Path
from unittest import mock

import httpx
from PIL import Image

import main


class GenerationReliabilityTests(unittest.TestCase):
    def test_gpt_replica_sends_aligned_size_and_saves_exact_output_pixels(self):
        async def scenario(root):
            provider = {"id": "api-6789", "name": "6789API", "base_url": "https://fixture.invalid",
                        "protocol": "openai", "image_request_mode": "openai"}
            reference = Path(root, "ref.png")
            Image.new("RGB", (1464, 600), "red").save(reference)
            buffer = BytesIO()
            Image.new("RGB", (120, 120), "blue").save(buffer, format="PNG")
            requests = []

            def respond(request):
                requests.append(request)
                return httpx.Response(200, json={"data": [{"b64_json": base64.b64encode(buffer.getvalue()).decode("ascii")}]})

            client_type = httpx.AsyncClient
            with mock.patch.multiple(
                main, get_api_provider=mock.Mock(return_value=provider), api_headers=mock.Mock(return_value={}),
                OUTPUT_OUTPUT_DIR=root, CANVAS_TASKS_FILE=str(Path(root, "tasks.json")), CANVAS_TASKS={},
                CANVAS_IMAGE_BACKGROUND_TASKS={}, save_to_history=mock.Mock(), GLOBAL_LOOP=None,
            ), mock.patch.object(main.httpx, "AsyncClient", side_effect=lambda **options: client_type(
                transport=httpx.MockTransport(respond), **options,
            )):
                async with client_type(transport=httpx.ASGITransport(app=main.app), base_url="http://127.0.0.1") as client:
                    response = await client.post("/api/canvas-image-tasks", json={
                        "prompt": "复刻版式", "provider_id": "api-6789", "model": "gpt-image-2-high",
                        "size": "1464x600", "output_size": "1464x600", "aspect_ratio": "61:25",
                        "reference_images": [{"url": "/output/ref.png"}], "history_source": "canvas",
                    })
                    self.assertEqual(response.status_code, 200, response.text)
                    task_id = response.json()["task_id"]
                    await main.CANVAS_IMAGE_BACKGROUND_TASKS[task_id]
                    task = (await client.get(f"/api/canvas-image-tasks/{task_id}")).json()
                    self.assertEqual(task["status"], "succeeded", task.get("error"))
                    result = task["result"]
                    item = result["image_items"][0]
                    self.assertEqual((item["natural_w"], item["natural_h"]), (1464, 600))
                    with Image.open(main.output_file_from_url(item["url"])) as saved:
                        self.assertEqual(saved.size, (1464, 600))
                    self.assertEqual(result["params"]["output_size"], "1464x600")
                    self.assertEqual(main.save_to_history.call_args.args[0]["params"]["output_size"], "1464x600")

            self.assertEqual(len(requests), 1)
            self.assertEqual(requests[0].url.path, "/v1/images/edits")
            self.assertIn(b'name="size"\r\n\r\n1472x608\r\n', requests[0].content)
            self.assertNotIn(b'name="output_size"', requests[0].content)

        with tempfile.TemporaryDirectory() as root:
            asyncio.run(scenario(root))

    def test_soonstudio_image_requests_use_the_resolved_resolution(self):
        async def scenario():
            provider = {"id": "soon-fixture", "name": "SoonStudio", "base_url": "https://api.soonstudio.ai",
                        "protocol": "openai", "image_request_mode": "openai"}
            bodies = []

            def respond(request):
                bodies.append(json.loads(request.content))
                return httpx.Response(200, json={"data": [{"url": "https://fixture.invalid/result.png"}]})

            client_type = httpx.AsyncClient
            with mock.patch.object(main, "get_api_provider", return_value=provider), \
                 mock.patch.object(main, "api_headers", return_value={}), \
                 mock.patch.object(main.httpx, "AsyncClient", side_effect=lambda **kwargs: client_type(
                     transport=httpx.MockTransport(respond), **kwargs
                 )):
                await main.generate_ai_image("产品图", "2560x1440", "auto", "gpt-image-2")
                await main.generate_ai_image("产品图", "2560x1440", "auto", "nano-banana", resolution="4K", size_is_resolved=True)
                with self.assertRaises(main.HTTPException) as error:
                    await main.generate_ai_image("产品图", "2560x1440", "auto", "gpt-image-2-1k")
                self.assertEqual(error.exception.status_code, 400)
            self.assertEqual([body["image_size"] for body in bodies], ["2K", "4K"])

        asyncio.run(scenario())

    def test_svg_author_retry_requires_an_explicit_rejection_before_task_creation(self):
        error = {"code": "ERR-FIXTURE", "message": "Bad request to openai: SVG generation requires '***.model'."}
        for status, payload, expected in (
            (400, {"error": error}, True),
            (422, {"error": {"code": "missing_required_parameter", "param": "svg.model"}}, True),
            (400, {"error": error, "task_id": "accepted-job"}, False),
            (500, {"error": error}, False),
            (400, {"error": {"message": "Bad request to openai: Invalid svg.model."}}, False),
        ):
            with self.subTest(status=status, payload=payload):
                self.assertEqual(main.svg_author_model_required(httpx.Response(status, json=payload)), expected)

    def test_svg_reference_routes_retry_explicit_rejection_and_stop_on_raster_result(self):
        async def scenario(root):
            model = "gpt-image-2.6-sunburst"
            provider = {"id": "fixture", "name": "Fixture", "base_url": "https://images.test",
                        "protocol": "openai", "image_request_mode": "openai", "image_models": [model]}
            reference = Path(root, "ref.png")
            Image.new("RGB", (24, 16), "red").save(reference)
            raster = reference.read_bytes()
            svg = b'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 16"><path d="M0 0H24V16Z"/></svg>'
            requests = []

            def respond(request):
                requests.append(request)
                if len(requests) == 1:
                    return httpx.Response(400, json={"error": {
                        "code": "ERR-FIXTURE", "message": "Bad request to openai: SVG generation requires '***.model'.",
                    }})
                content = svg if len(requests) == 2 else raster
                return httpx.Response(200, json={"data": [{"b64_json": base64.b64encode(content).decode("ascii")}]})

            payload = main.OnlineImageRequest(provider_id="fixture", model=model, output_format="svg",
                                              reference_images=[{"url": "/output/ref.png"}]).model_dump()
            client_type = httpx.AsyncClient
            with mock.patch.multiple(
                main,
                get_api_provider=mock.Mock(return_value=provider), api_headers=mock.Mock(return_value={}),
                OUTPUT_OUTPUT_DIR=root, CANVAS_TASKS_FILE=str(Path(root, "tasks.json")), CANVAS_TASKS={},
                save_to_history=mock.Mock(), GLOBAL_LOOP=None,
            ), mock.patch.object(main.httpx, "AsyncClient", side_effect=lambda **options: client_type(
                transport=httpx.MockTransport(respond), **options,
            )):
                async with client_type(transport=httpx.ASGITransport(app=main.app), base_url="http://127.0.0.1") as client:
                    response = await client.post("/api/online-image", json={**payload, "history_source": "commerce"})
                    self.assertEqual(response.status_code, 200, response.text)
                    image = response.json()["image_items"][0]
                    self.assertEqual(image["format"], "svg")
                    self.assertEqual(Path(main.output_file_from_url(image["url"])).read_bytes(), svg)

                    response = await client.post("/api/canvas-image-tasks", json=payload)
                    self.assertEqual(response.status_code, 200, response.text)
                    task_id = response.json()["task_id"]
                    await main.CANVAS_IMAGE_BACKGROUND_TASKS[task_id]
                    task = (await client.get(f"/api/canvas-image-tasks/{task_id}")).json()
                    self.assertEqual(task["status"], "failed")
                    self.assertTrue(task["upstream_terminal_error"])
                    self.assertIn("Fixture 的参考图编辑接口未返回 SVG", task["error"])
                    main.save_to_history.assert_called_once()

            self.assertEqual(len(requests), 3)
            for request in requests:
                self.assertEqual(request.url.path, "/v1/images/edits")
                self.assertIn(b'name="output_format"\r\n\r\nsvg\r\n', request.content)
                self.assertIn(raster, request.content)
            self.assertNotIn(b'name="svg[model]"', requests[0].content)
            self.assertIn(b'name="svg[model]"\r\n\r\ngpt-6-astra\r\n', requests[1].content)

        with tempfile.TemporaryDirectory(prefix="svg-reference-generation-") as root:
            asyncio.run(scenario(root))

    def test_partial_batch_keeps_successes_and_records_failure(self):
        async def scenario():
            calls = 0

            async def generate(*args, **kwargs):
                nonlocal calls
                calls += 1
                number = calls
                await asyncio.sleep(0)
                if number == 2:
                    raise main.HTTPException(status_code=502, detail="one image failed")
                return {"url": f"image-{number}"}, {"task_id": f"upstream-{number}"}

            async def save(item, **kwargs):
                return item["url"]

            with mock.patch.multiple(
                main,
                get_api_provider=lambda _: {"id": "test", "image_models": ["test-image"]},
                generate_ai_image=generate,
                extract_images=lambda raw: [{"url": raw["task_id"]}],
                save_ai_image_to_output=save,
                image_output_meta=lambda url, _: {"url": url},
                save_to_history=mock.Mock(),
                GLOBAL_LOOP=None,
            ):
                result = await main.build_online_image_result(main.OnlineImageRequest(prompt="test", n=3))
                self.assertEqual(result["images"], ["upstream-1", "upstream-3"])
                self.assertEqual(result["partial_failures"][0]["error"], "one image failed")
                main.save_to_history.assert_called_once_with(result)

        asyncio.run(scenario())

    def test_outpaint_keeps_the_saved_model_image_and_marks_detected_redraw(self):
        async def scenario():
            async def generate(*args, **kwargs):
                self.assertEqual(len(args[4]), 1)
                self.assertEqual(args[4][0]['url'], '/base.png')
                self.assertTrue(args[4][0]['outpaint_canvas'])
                return {'url': '/remote.png'}, {'id': 'upstream'}

            with mock.patch.multiple(
                main,
                get_api_provider=lambda _: {'id': 'test', 'image_models': ['test-image']},
                generate_ai_image=generate,
                extract_images=lambda raw: [{'url': '/remote.png'}],
                save_ai_image_to_output=mock.AsyncMock(return_value='/raw-model.png'),
                image_output_meta=lambda url, _: {'url': url, 'width': 2880, 'height': 2880},
                _outpaint_original_redrawn=lambda url, preserve: True,
                save_to_history=mock.Mock(),
                GLOBAL_LOOP=None,
            ):
                payload = main.OnlineImageRequest(
                    prompt='expand', provider_id='test', model='test-image', size='3840x3840',
                    outpaint_mode=True, reference_images=[{'url': '/base.png'}],
                    outpaint_preserve={'sourceUrl': '/source.png', 'canvasW': 3840, 'canvasH': 3840,
                                       'sourceW': 2565, 'sourceH': 2565, 'x': 645, 'y': 645},
                )
                result = await main.build_online_image_result(payload)
                self.assertEqual(result['images'], ['/raw-model.png'])
                self.assertEqual(result['image_items'], [{'url': '/raw-model.png', 'width': 2880,
                                                          'height': 2880, 'outpaint_original_redrawn': True}])
                main.save_to_history.assert_called_once_with(result)

        asyncio.run(scenario())

    def test_upstream_id_is_persisted_before_poll_and_survives_restart(self):
        async def scenario():
            with tempfile.TemporaryDirectory(prefix="generation-recovery-") as root:
                journal = Path(root) / "tasks.json"
                with mock.patch.multiple(main, DATA_DIR=root, CANVAS_TASKS_FILE=str(journal), CANVAS_TASKS={}):
                    main.add_canvas_task("local", {"id": "local", "status": "running", "created_at": time.time()})

                    async def fetch(*args):
                        stored = json.loads(journal.read_text(encoding="utf-8"))["tasks"]["local"]
                        self.assertEqual(stored["upstream_task_id"], "upstream")
                        raise main.httpx.ConnectError("connection lost")

                    callback_token = main.IMAGE_TASK_UPSTREAM_CALLBACK.set(
                        lambda value: main.update_canvas_task("local", {"upstream_task_id": value})
                    )
                    try:
                        with mock.patch.object(main, "fetch_image_task_payload", fetch):
                            with self.assertRaises(main.httpx.ConnectError):
                                await main.wait_for_image_task(None, "upstream", {"id": "test"})
                    finally:
                        main.IMAGE_TASK_UPSTREAM_CALLBACK.reset(callback_token)
                    main.load_canvas_task_store()
                    restored = main.CANVAS_TASKS["local"]
                    self.assertEqual(restored["upstream_task_id"], "upstream")
                    self.assertEqual(restored["status"], "failed")
                    self.assertIn("请勿重复生成", restored["error"])

        asyncio.run(scenario())

    def test_long_asset_operation_preserves_upload_delete_rename_and_move(self):
        old = main.default_asset_library()
        category = old["libraries"][0]["categories"][0]
        category["items"] = [{"id": "deleted"}, {"id": "moved", "name": "old"}]
        incoming = copy.deepcopy(old)
        added = {"id": "derived"}
        incoming["libraries"][0]["categories"][0]["items"].append(added)
        latest = copy.deepcopy(old)
        latest["libraries"][0]["categories"][0]["name"] = "renamed"
        latest["libraries"][0]["categories"][0]["items"] = [{"id": "uploaded"}]
        latest["libraries"][0]["categories"][1]["items"] = [{"id": "moved", "name": "renamed image"}]

        with tempfile.TemporaryDirectory(prefix="asset-concurrency-") as root:
            target = Path(root) / "library.json"
            target.write_text(json.dumps(latest), encoding="utf-8")
            with mock.patch.multiple(main, ASSET_LIBRARY_PATH=str(target), GLOBAL_LOOP=None):
                main.save_asset_library(incoming, merge_items=[added])
            saved = json.loads(target.read_text(encoding="utf-8"))
        cats = saved["libraries"][0]["categories"]
        self.assertEqual(cats[0]["name"], "renamed")
        self.assertEqual({item["id"] for item in cats[0]["items"]}, {"uploaded", "derived"})
        self.assertEqual([(item["id"], item["name"]) for item in cats[1]["items"]], [("moved", "renamed image")])
        self.assertEqual(incoming["libraries"], saved["libraries"])

    def test_removed_destination_is_not_recreated(self):
        incoming = main.default_asset_library()
        added = {"id": "derived"}
        incoming["libraries"][0]["categories"][0]["items"].append(added)
        latest = main.default_asset_library()
        latest["libraries"][0]["categories"].pop(0)
        merged = main._merge_asset_library_additions(latest, incoming, [added])
        self.assertNotIn("characters", [cat["id"] for cat in merged["libraries"][0]["categories"]])

    def test_soonstudio_seedream_models_preserve_data_urls_and_use_seedream_schema(self):
        async def scenario(root):
            provider = {
                "id": "soon-fixture",
                "name": "SoonStudio",
                "base_url": "https://api.soonstudio.ai/v1",
                "protocol": "openai",
                "image_request_mode": "openai",
            }
            ref_a = Path(root, "ref_a.png")
            ref_b = Path(root, "ref_b.jpg")
            Image.new("RGB", (64, 48), "red").save(ref_a)
            Image.new("RGB", (64, 48), "blue").save(ref_b)
            captured = []

            def respond(request):
                captured.append((request.url.path, request.url.query.decode("ascii"), json.loads(request.content)))
                return httpx.Response(200, json={"data": [{"url": "https://fixture.invalid/result.png"}]})

            client_type = httpx.AsyncClient
            with mock.patch.multiple(main, OUTPUT_OUTPUT_DIR=root), \
                 mock.patch.object(main, "get_api_provider", return_value=provider), \
                 mock.patch.object(main, "api_headers", return_value={}), \
                 mock.patch.object(main.httpx, "AsyncClient", side_effect=lambda **kwargs: client_type(
                     transport=httpx.MockTransport(respond), **kwargs
                 )):
                await main.generate_ai_image(
                    "产品图", "2160x3840", "auto", "seedream-v5.5",
                    reference_images=[{"url": "/output/ref_a.png"}, {"url": "/output/ref_b.jpg"}],
                    aspect_ratio="9:16", background="opaque", resolution="4K", size_is_resolved=True,
                )
                await main.generate_ai_image(
                    "纯底图", "2160x3840", "auto", "seedream-v5.5",
                    reference_images=[],
                    aspect_ratio="9:16", background="auto", resolution="4K", size_is_resolved=True,
                )
                await main.generate_ai_image(
                    "海报", "2048x2048", "auto", "seedream-v5-pro",
                    reference_images=[{"url": "/output/ref_a.png"}],
                    resolution="4K", size_is_resolved=True,
                )
                await main.generate_ai_image(
                    "详情图", "2048x2048", "auto", "doubao-seedream-5-0-260128",
                    reference_images=[{"url": "/output/ref_a.png"}],
                    resolution="2K", size_is_resolved=True,
                )
                with self.assertRaises(main.HTTPException) as missing_ref:
                    await main.generate_ai_image(
                        "缺失图", "2048x2048", "auto", "seedream-v5.5",
                        reference_images=[{"url": "/api/storage-files/missing.png"}],
                        resolution="2K", size_is_resolved=True,
                    )
                self.assertEqual(missing_ref.exception.status_code, 400)

            self.assertEqual(len(captured), 4)

            path, query, body = captured[0]
            self.assertEqual((path, query), ("/v1/images/edits", "async=true"))
            self.assertEqual(body["model"], "seedream-v5.5")
            self.assertEqual(body["mode"], "image-to-image")
            self.assertEqual(body["resolution"], "2K")
            self.assertEqual(body["outputFormat"], "png")
            self.assertEqual(body["background"], "opaque")
            self.assertEqual(body["watermark"], "false")
            self.assertEqual(body["optimizePromptMode"], "standard")
            self.assertNotIn("image", body)
            self.assertNotIn("image_size", body)
            self.assertEqual(len(body["images"]), 2)
            self.assertTrue(body["images"][0].startswith("data:image/png;base64,"))
            self.assertTrue(body["images"][1].startswith("data:image/jpeg;base64,"))

            path, query, body = captured[1]
            self.assertEqual((path, query), ("/v1/images/generations", "async=true"))
            self.assertEqual(body["mode"], "text-to-image")
            self.assertEqual((body["width"], body["height"]), (2160, 3840))
            self.assertNotIn("resolution", body)
            self.assertNotIn("images", body)

            path, query, body = captured[2]
            self.assertEqual((path, query), ("/v1/images/edits", "async=true"))
            self.assertEqual(body["resolution"], "2k")
            self.assertTrue(body["images"][0].startswith("data:image/png;base64,"))

            path, query, body = captured[3]
            self.assertEqual((path, query), ("/v1/images/generations", "async=true"))
            self.assertEqual(body["size"], "2048x2048")
            self.assertTrue(body["image"].startswith("data:image/png;base64,"))

        with tempfile.TemporaryDirectory() as root:
            asyncio.run(scenario(root))

    def test_history_cache_refreshes_after_atomic_write(self):
        with tempfile.TemporaryDirectory(prefix="history-cache-") as root:
            target = Path(root) / "history.json"
            with mock.patch.object(main, "HISTORY_FILE", str(target)):
                main._write_history_file_locked([{"images": ["first"]}])
                self.assertEqual(main._read_history_api_rows()[0]["images"], ["first"])
                main._write_history_file_locked([{"images": ["second"]}])
                self.assertEqual(main._read_history_api_rows()[0]["images"], ["second"])


if __name__ == "__main__":
    unittest.main()
