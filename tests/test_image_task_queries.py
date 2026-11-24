import asyncio
import json
from pathlib import Path
import tempfile
import time
import unittest
from unittest.mock import AsyncMock, patch

from fastapi import HTTPException
import httpx

import image_task_queries
import main


class ImageTaskQueryTests(unittest.IsolatedAsyncioTestCase):
    def test_receipt_prefers_an_explicit_id_and_ignores_trace_numbers(self):
        self.assertEqual(image_task_queries.extract_task_id({
            "id": "gateway-trace", "data": [{"taskId": "paid-task"}],
        }), "paid-task")
        self.assertEqual(image_task_queries.extract_task_id({"id": "B098"}), "B098")
        self.assertIsNone(image_task_queries.extract_task_id({"id": "resp_message", "request_id": "trace"}))
        self.assertEqual(image_task_queries.extract_task_id_from_text("请求失败，task_id：B-100"), "B-100")
        self.assertEqual(image_task_queries.extract_task_id_from_text("gateway_task_id: debug"), "")

    def test_failed_submission_with_an_image_address_is_terminal(self):
        payload = {"task_id": "submitted", "status": "failed", "url": "https://fixture.invalid/stale.png"}
        with self.assertRaises(HTTPException) as failure:
            image_task_queries.validate_submission(payload)
        self.assertTrue(failure.exception.upstream_terminal_error)
        self.assertEqual(failure.exception.upstream_task_id, "submitted")

    async def test_fetch_uses_compatible_get_routes_when_result_lags_status(self):
        provider = {"base_url": "https://images.fixture.invalid/v1", "protocol": "apimart"}
        addresses = image_task_queries.endpoints(provider, "order/图", apimart=True)
        self.assertEqual(addresses[:3], (
            "https://images.fixture.invalid/v1/tasks/order%2F%E5%9B%BE",
            "https://images.fixture.invalid/v1/images/tasks/order%2F%E5%9B%BE",
            "https://images.fixture.invalid/v1/images/generations/order%2F%E5%9B%BE",
        ))
        completed = {"data": {"status": "completed", "images": ["https://images.fixture.invalid/final.png"]}}
        responses = iter((httpx.Response(200, json={"status": "COMPLETED"}), httpx.Response(404),
                          httpx.Response(200, json=completed)))
        requests = []

        def get(request):
            requests.append(request)
            return next(responses)

        async with httpx.AsyncClient(transport=httpx.MockTransport(get)) as client:
            self.assertEqual(await image_task_queries.fetch("order/图", addresses, client.get), completed)
        self.assertEqual([request.method for request in requests], ["GET"] * 3)
        self.assertEqual([str(request.url) for request in requests], list(addresses[:3]))

    async def test_wait_preserves_last_receipt_and_cancels_a_stalled_lookup(self):
        accepted = []
        cancelled = asyncio.Event()
        queued = {"data": [{"status": "running", "url": "https://fixture.invalid/preview.png"}]}
        calls = 0

        async def retrieve():
            nonlocal calls
            calls += 1
            self.assertEqual(accepted, ["paid-task"])
            if calls == 1:
                return queued
            try:
                await asyncio.Event().wait()
            finally:
                cancelled.set()

        with self.assertRaises(HTTPException) as failure:
            await image_task_queries.wait("paid-task", retrieve, timeout=.12, interval=0, on_receipt=accepted.append)
        self.assertEqual(failure.exception.status_code, 504)
        self.assertEqual(failure.exception.upstream_task_id, "paid-task")
        self.assertEqual(failure.exception.upstream_payload, queued)
        self.assertTrue(cancelled.is_set())

    async def test_restarted_task_uses_original_provider_binding_and_only_saves_final_images(self):
        provider = {"id": "fixture-soon", "protocol": "openai", "base_url": "https://fixture.soonstudio.ai"}
        image = "https://images.fixture.invalid/result.png"
        pending = {"status": "OK", "data": [{"task_id": "shared", "status": "running", "url": image}]}
        failure = {"data": [{"task_id": "shared", "status": "failed", "error_message": "上游审核失败", "url": image}]}
        done = {"data": {"task_id": "shared", "status": "succeeded", "error": False, "url": image}}
        responses = iter((pending, failure, done))
        requests = []

        def upstream(request):
            requests.append(request)
            return httpx.Response(200, json=next(responses))

        with tempfile.TemporaryDirectory(prefix="xiaomei-image-task-fixture-") as directory:
            journal = Path(directory) / "已保存任务.json"
            now = time.time()
            tasks = {
                task_id: {"id": task_id, "type": "online-image", "status": "running", "created_at": now,
                          "provider_id": owner, "upstream_task_id": "shared", "client_request_id": task_id}
                for task_id, owner in (("other-binding", "other-provider"), ("saved-binding", provider["id"]))
            }
            journal.write_text(json.dumps({"tasks": tasks}), encoding="utf-8")
            client_type = httpx.AsyncClient
            transport = httpx.ASGITransport(app=main.app, client=("127.0.0.1", 45000))
            async with client_type(
                transport=transport, base_url="http://127.0.0.1:3000",
                headers={main.LOCAL_SESSION_HEADER: main.LOCAL_SESSION_TOKEN, "Origin": "http://127.0.0.1:3000"},
            ) as client:
                with patch.multiple(main, DATA_DIR=directory, CANVAS_TASKS_FILE=str(journal), CANVAS_TASKS={},
                                    GLOBAL_LOOP=None), \
                        patch.object(main, "get_api_provider", return_value=provider), \
                        patch.object(main, "provider_env_key_value", return_value="fixture"), \
                        patch.object(main.httpx, "AsyncClient", side_effect=lambda **kwargs:
                                     client_type(transport=httpx.MockTransport(upstream), **kwargs)), \
                        patch.object(main, "save_ai_image_to_output", new=AsyncMock(return_value="/output/saved.png")) as save, \
                        patch.object(main, "save_to_history") as history:
                    main.load_canvas_task_store()
                    self.assertTrue(main.CANVAS_TASKS["saved-binding"]["restart_interrupted"])
                    results = []
                    for _ in range(3):
                        reply = await client.post("/api/image-task-query", json={"task_id": "shared", "provider_id": provider["id"]})
                        results.append(reply.raise_for_status().json())
                    save.assert_awaited_once()
                    history.assert_called_once()
        self.assertEqual([result["status"] for result in results], ["running", "failed", "succeeded"])
        self.assertEqual(results[1]["error"], "上游审核失败")
        self.assertEqual(results[2]["images"], ["/output/saved.png"])
        self.assertEqual([request.headers["x-studio-task-id"] for request in requests], ["saved-binding"] * 3)
        self.assertEqual([request.method for request in requests], ["GET"] * 3)

    async def test_timed_out_generation_persists_last_response_for_recovery(self):
        provider = {"id": "fixture", "protocol": "openai", "base_url": "https://fixture.invalid",
                    "image_request_mode": "openai", "image_models": ["fixture-image"]}
        queued = {"data": [{"status": "running", "task_id": "already-paid"}]}
        calls = []

        async def upstream(request):
            calls.append(request.method)
            if request.method == "POST":
                return httpx.Response(200, json={"data": [{
                    "taskId": "already-paid", "status": "submitted", "url": "https://fixture.invalid/preview.png",
                }]})
            if len(calls) == 2:
                return httpx.Response(200, json=queued)
            await asyncio.Event().wait()

        client_type = httpx.AsyncClient
        with tempfile.TemporaryDirectory(prefix="xiaomei-image-timeout-") as directory:
            with patch.multiple(main, RUNTIME_ROOT=directory, IMAGE_TASK_TIMEOUT=.2, IMAGE_POLL_INTERVAL=0), \
                    patch.object(main, "get_api_provider", return_value=provider), \
                    patch.object(main, "api_headers", return_value={}), \
                    patch.object(main.httpx, "AsyncClient", side_effect=lambda **kwargs:
                                 client_type(transport=httpx.MockTransport(upstream), **kwargs)):
                with self.assertRaises(HTTPException) as failure:
                    await main.generate_ai_image("生成测试图", "1024x1024", "auto", "fixture-image", provider_id="fixture")
                entry = main.load_unparsed_image_response(failure.exception.recovery_id)
        self.assertEqual(failure.exception.status_code, 504)
        self.assertEqual(entry["task_id"], "already-paid")
        self.assertEqual(entry["raw"]["task_result"], queued)
        self.assertEqual(calls, ["POST", "GET", "GET"])

    async def test_saved_task_result_recovers_final_images_without_generating_again(self):
        preview = "https://fixture.invalid/preview.png"
        final = "https://fixture.invalid/final.png"
        with tempfile.TemporaryDirectory(prefix="xiaomei-image-saved-result-") as directory:
            journal = Path(directory) / "旧恢复记录.jsonl"
            journal.write_bytes(b"\xff\nnull\n")
            transport = httpx.ASGITransport(app=main.app, client=("127.0.0.1", 45000))
            async with httpx.AsyncClient(
                transport=transport, base_url="http://127.0.0.1:3000",
                headers={main.LOCAL_SESSION_HEADER: main.LOCAL_SESSION_TOKEN, "Origin": "http://127.0.0.1:3000"},
            ) as client:
                with patch.object(main, "unparsed_image_response_path", return_value=str(journal)), \
                        patch.object(main, "save_ai_image_to_output", new=AsyncMock(return_value="/output/final.png")) as save, \
                        patch.object(main, "save_to_history") as history, \
                        patch.object(main, "generate_ai_image", new=AsyncMock()) as generate, \
                        patch.object(main, "GLOBAL_LOOP", None):
                    identifiers = [
                        main.save_unparsed_image_response("fixture", "image", {
                            "submission": {"url": preview},
                            "task_result": {"status": status, "output_url": address},
                        }, "original-task")
                        for status, address in (("running", preview), ("succeeded", final))
                    ]
                    pending, completed = [
                        await client.post(f"/api/image-result-recovery/{identifier}") for identifier in identifiers
                    ]
                    generate.assert_not_awaited()
                    save.assert_awaited_once_with(
                        {"type": "url", "value": final}, prefix="recovered_", require_local=True, provider_id="fixture",
                    )
                    history.assert_called_once()
        self.assertEqual(pending.status_code, 502)
        result = completed.raise_for_status().json()
        self.assertEqual(result["images"], ["/output/final.png"])
        self.assertEqual(result["task_id"], "original-task")
        self.assertTrue(result["recovered_without_generation"])


if __name__ == "__main__":
    unittest.main()
