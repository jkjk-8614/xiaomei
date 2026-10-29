"""Gemini 原生生图的上游限流与断连文案测试（不加载用户数据、不调用真实模型）。"""
import ast
import asyncio
import contextvars
import time
from pathlib import Path
from threading import Lock
import unittest

import httpx


class GeminiImageUpstreamLimitTests(unittest.TestCase):
    def setUp(self):
        source = Path(__file__).resolve().parents[1] / "main.py"
        names = {
            "gemini_image_slot_key",
            "gemini_image_semaphore",
            "acquire_gemini_image_slot",
            "release_gemini_image_slot",
            "friendly_image_network_error_detail",
            "post_gemini_image_with_retry",
        }
        tree = ast.parse(source.read_text(encoding="utf-8"))
        body = [node for node in tree.body if getattr(node, "name", "") in names]
        self.assertEqual(len(body), len(names), "main.py 里找不到全部被测函数")
        self.ns = dict(
            globals(),
            httpx=httpx,
            asyncio=asyncio,
            time=time,
            Lock=Lock,
            GEMINI_IMAGE_CONCURRENCY=1,
            GEMINI_IMAGE_MIN_INTERVAL=0.0,
            GEMINI_IMAGE_SEMAPHORES={},
            GEMINI_IMAGE_SEMAPHORES_LOCK=Lock(),
            GEMINI_IMAGE_LAST_REQUEST={},
            CANVAS_IMAGE_BATCH_CONCURRENCY=contextvars.ContextVar("fixture_batch_concurrency", default=0),
            GEMINI_IMAGE_REQUEST_TIMEOUT=0.03,
            GEMINI_IMAGE_TRANSPORT_RETRIES=2,
        )
        exec(compile(ast.Module(body=body, type_ignores=[]), str(source), "exec"), self.ns)

    def test_same_provider_is_serialized_by_default(self):
        async def scenario():
            acquire = self.ns["acquire_gemini_image_slot"]
            release = self.ns["release_gemini_image_slot"]
            order = []

            async def worker(index):
                slot = await acquire("api-6789", "nano-banana-2.1")
                try:
                    order.append(("start", index))
                    await asyncio.sleep(0.05)
                    order.append(("end", index))
                finally:
                    release(slot)

            await asyncio.gather(worker(1), worker(2))
            # 第二个请求必须等第一个结束，上游才不会掐连接
            self.assertEqual(order, [("start", 1), ("end", 1), ("start", 2), ("end", 2)])

        asyncio.run(scenario())

    def test_different_models_do_not_block_each_other(self):
        async def scenario():
            acquire = self.ns["acquire_gemini_image_slot"]
            release = self.ns["release_gemini_image_slot"]
            order = []

            async def worker(model):
                slot = await acquire("api-6789", model)
                try:
                    order.append(("start", model))
                    await asyncio.sleep(0.05)
                    order.append(("end", model))
                finally:
                    release(slot)

            await asyncio.gather(worker("nano-banana-2.1"), worker("gemini-3.1-flash-image"))
            self.assertEqual(order[0], ("start", "nano-banana-2.1"))
            self.assertEqual(order[1], ("start", "gemini-3.1-flash-image"))

        asyncio.run(scenario())

    def test_batch_concurrency_setting_overrides_the_default_limit(self):
        async def scenario():
            acquire = self.ns["acquire_gemini_image_slot"]
            release = self.ns["release_gemini_image_slot"]
            token = self.ns["CANVAS_IMAGE_BATCH_CONCURRENCY"].set(2)
            try:
                slots = [await acquire("api-6789", "nano-banana-2.1") for _ in range(2)]
                self.assertEqual(len(slots), 2)
                for slot in slots:
                    release(slot)
            finally:
                self.ns["CANVAS_IMAGE_BATCH_CONCURRENCY"].reset(token)

        asyncio.run(scenario())

    def test_minimum_interval_delays_the_next_submission(self):
        async def scenario():
            self.ns["GEMINI_IMAGE_MIN_INTERVAL"] = 0.4
            acquire = self.ns["acquire_gemini_image_slot"]
            release = self.ns["release_gemini_image_slot"]
            slot = await acquire("api-6789", "nano-banana-2.1")
            release(slot)
            first = time.monotonic()
            slot = await acquire("api-6789", "nano-banana-2.1")
            release(slot)
            self.assertGreaterEqual(time.monotonic() - first, 0.4 - 0.05)

        asyncio.run(scenario())

    def test_without_event_loop_the_limiter_is_a_no_op(self):
        self.assertIsNone(self.ns["gemini_image_semaphore"]("api-6789", "nano-banana-2.1"))

    def test_disconnect_is_reported_as_an_upstream_side_problem(self):
        detail = self.ns["friendly_image_network_error_detail"](
            httpx.RemoteProtocolError("Server disconnected without sending a response."),
            "6789API",
            "nano-banana-2.1",
        )
        self.assertIn("6789API", detail)
        self.assertIn("并发", detail)
        self.assertIn("CANVAS_IMAGE_TASK_CONCURRENCY=1", detail)
        self.assertNotIn("Server disconnected", detail)

    def test_timeout_and_connect_error_get_their_own_hints(self):
        timeout = self.ns["friendly_image_network_error_detail"](
            httpx.ReadTimeout("timed out"), "6789API", "nano-banana-2.1"
        )
        self.assertIn("超时", timeout)
        connect = self.ns["friendly_image_network_error_detail"](
            httpx.ConnectError("connection refused"), "6789API", "nano-banana-2.1"
        )
        self.assertIn("连接失败", connect)

    def test_unknown_transport_error_keeps_a_generic_message(self):
        detail = self.ns["friendly_image_network_error_detail"](
            httpx.LocalProtocolError("bad local state"), "6789API", "nano-banana-2.1"
        )
        self.assertIn("请求上游生图接口失败", detail)

    def test_unresponsive_submission_times_out_once_and_releases_its_slot(self):
        async def scenario():
            calls = []
            cancelled = asyncio.Event()

            class Client:
                async def post(self, endpoint, **kwargs):
                    calls.append((endpoint, kwargs))
                    try:
                        await asyncio.Event().wait()
                    finally:
                        cancelled.set()

            slot = await self.ns["acquire_gemini_image_slot"]("fixture", "image")
            try:
                with self.assertRaisesRegex(httpx.ReadTimeout, "等待超过"):
                    await self.ns["post_gemini_image_with_retry"](Client(), "/image", {}, {"prompt": "test"})
            finally:
                self.ns["release_gemini_image_slot"](slot)
            self.assertTrue(cancelled.is_set(), "the stalled HTTP request is cancelled")
            self.assertEqual(len(calls), 1, "timeouts must not repeat a possibly billed POST")
            next_slot = await asyncio.wait_for(self.ns["acquire_gemini_image_slot"]("fixture", "image"), 0.1)
            self.ns["release_gemini_image_slot"](next_slot)

        asyncio.run(scenario())

    def test_successful_submission_preserves_payload_and_response(self):
        async def scenario():
            expected = object()
            calls = []

            class Client:
                async def post(self, endpoint, **kwargs):
                    calls.append((endpoint, kwargs))
                    return expected

            result = await self.ns["post_gemini_image_with_retry"](
                Client(), "/image", {"request-id": "fixture"}, {"prompt": "test"}
            )
            self.assertIs(result, expected)
            self.assertEqual(calls, [("/image", {"headers": {"request-id": "fixture"}, "json": {"prompt": "test"}})])

        asyncio.run(scenario())


if __name__ == "__main__":
    unittest.main()
