"""Run the production task limiters without loading user data or calling models."""
import ast
import asyncio
import contextvars
from pathlib import Path
from threading import Lock
from typing import Any, Dict, List
import unittest

from pydantic import BaseModel, Field, ValidationError


class AIReference(BaseModel):
    url: str = ""


class CanvasBatchConcurrencyTests(unittest.TestCase):
    def setUp(self):
        source = Path(__file__).resolve().parents[1] / "main.py"
        names = {"OnlineImageRequest", "canvas_image_task_semaphore", "gpt_image_2_edit_semaphore", "run_canvas_image_task"}
        tree = ast.parse(source.read_text(encoding="utf-8"))
        body = [node for node in tree.body if getattr(node, "name", "") in names]
        self.assertEqual(len(body), len(names))
        self.ns = dict(globals(), ONLINE_IMAGE_PROMPT_MAX_LENGTH=10000,
                       CANVAS_IMAGE_TASK_CONCURRENCY=2, GPT_IMAGE2_EDIT_CONCURRENCY=2,
                       CANVAS_IMAGE_TASK_SEMAPHORES={}, CANVAS_IMAGE_TASK_SEMAPHORES_LOCK=Lock(),
                       CANVAS_TASK_LOCK=Lock(), CANVAS_TASKS={},
                       GPT_IMAGE2_EDIT_SEMAPHORES={}, GPT_IMAGE2_EDIT_SEMAPHORES_LOCK=Lock(),
                       CANVAS_IMAGE_BATCH_CONCURRENCY=contextvars.ContextVar("fixture_batch_concurrency", default=0))
        exec(compile(ast.Module(body=body, type_ignores=[]), str(source), "exec"), self.ns)

    def test_all_ten_screens_pass_both_local_limiters_before_any_finishes(self):
        async def scenario():
            started = []
            release = asyncio.Event()
            all_started = asyncio.Event()

            async def generate(task_id, payload):
                async with self.ns["gpt_image_2_edit_semaphore"]("fixture", "gpt-image-2"):
                    started.append(task_id)
                    self.assertEqual(self.ns["CANVAS_IMAGE_BATCH_CONCURRENCY"].get(), 10)
                    if len(started) == 10:
                        all_started.set()
                    await release.wait()

            self.ns["_run_canvas_image_task"] = generate
            request = self.ns["OnlineImageRequest"](prompt="test", canvas_batch_concurrency=10)
            tasks = [asyncio.create_task(self.ns["run_canvas_image_task"](str(index), request)) for index in range(10)]
            try:
                await asyncio.wait_for(all_started.wait(), 1)
                self.assertEqual(len(started), 10)
            finally:
                release.set()
                await asyncio.gather(*tasks)
            self.assertEqual(self.ns["CANVAS_IMAGE_BATCH_CONCURRENCY"].get(), 0)

        asyncio.run(scenario())

    def test_ordinary_generation_keeps_its_existing_limits_during_a_batch(self):
        async def scenario():
            normal_canvas = self.ns["canvas_image_task_semaphore"]()
            normal_edit = self.ns["gpt_image_2_edit_semaphore"]("fixture", "gpt-image-2")
            token = self.ns["CANVAS_IMAGE_BATCH_CONCURRENCY"].set(10)
            try:
                batch_canvas = self.ns["canvas_image_task_semaphore"]()
                batch_edit = self.ns["gpt_image_2_edit_semaphore"]("fixture", "gpt-image-2")
                self.assertIsNot(batch_canvas, normal_canvas)
                self.assertIsNot(batch_edit, normal_edit)
            finally:
                self.ns["CANVAS_IMAGE_BATCH_CONCURRENCY"].reset(token)
            self.assertIs(self.ns["canvas_image_task_semaphore"](), normal_canvas)
            self.assertIs(self.ns["gpt_image_2_edit_semaphore"]("fixture", "gpt-image-2"), normal_edit)
            for semaphore in (normal_canvas, normal_edit):
                await semaphore.acquire()
                await semaphore.acquire()
                self.assertTrue(semaphore.locked(), "ordinary tasks still have two slots")
                semaphore.release()
                semaphore.release()

        asyncio.run(scenario())

    def test_batch_context_resets_after_failure_and_cancellation(self):
        async def scenario():
            async def fail(*_args):
                self.assertEqual(self.ns["CANVAS_IMAGE_BATCH_CONCURRENCY"].get(), 3)
                raise RuntimeError("fixture failure")

            request = self.ns["OnlineImageRequest"](prompt="test", canvas_batch_concurrency=3)
            self.ns["_run_canvas_image_task"] = fail
            with self.assertRaisesRegex(RuntimeError, "fixture failure"):
                await self.ns["run_canvas_image_task"]("failed", request)
            self.assertEqual(self.ns["CANVAS_IMAGE_BATCH_CONCURRENCY"].get(), 0)

            started = asyncio.Event()

            async def block(*_args):
                started.set()
                await asyncio.Event().wait()

            async def wrapper():
                try:
                    await self.ns["run_canvas_image_task"]("cancelled", request)
                finally:
                    self.assertEqual(self.ns["CANVAS_IMAGE_BATCH_CONCURRENCY"].get(), 0)

            self.ns["_run_canvas_image_task"] = block
            task = asyncio.create_task(wrapper())
            await started.wait()
            task.cancel()
            with self.assertRaises(asyncio.CancelledError):
                await task

        asyncio.run(scenario())

    def test_concurrency_accepts_the_screen_range_and_rejects_invalid_values(self):
        request = self.ns["OnlineImageRequest"]
        self.assertEqual(request(prompt="test").canvas_batch_concurrency, 0)
        self.assertEqual(request(prompt="test", canvas_batch_concurrency=100).canvas_batch_concurrency, 100)
        for value in (-1, 101):
            with self.subTest(value=value), self.assertRaises(ValidationError):
                request(prompt="test", canvas_batch_concurrency=value)

    def test_existing_image_entry_payloads_use_default_scheduling(self):
        for source in ("online", "canvas", "commerce", "chat"):
            with self.subTest(source=source):
                request = self.ns["OnlineImageRequest"](prompt="test", provider_id="dynamic-provider", model="dynamic-model",
                                                       history_source=source, n=2, reference_images=[{"url": "/output/reference.png"}])
                self.assertEqual(request.canvas_batch_concurrency, 0)
                self.assertEqual(request.n, 2)
                self.assertEqual(request.history_source, source)
                self.assertEqual(request.reference_images[0].url, "/output/reference.png")


if __name__ == "__main__":
    unittest.main()
