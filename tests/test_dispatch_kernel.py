import asyncio
import unittest

import dispatch_kernel


class DispatchKernelTest(unittest.TestCase):
    def test_provider_and_endpoint(self):
        core = dispatch_kernel.provider_core({"id": "Shop_1", "name": "  商店  ", "base_url": "https://api.example.com/v1/", "protocol": "nope"})
        self.assertEqual(core["id"], "shop_1")
        self.assertEqual(core["protocol"], "openai")
        self.assertEqual(core["base_url"], "https://api.example.com/v1")
        self.assertIn("error", dispatch_kernel.provider_core({"id": "x", "base_url": "ftp://nope"}))
        joined = dispatch_kernel.join_endpoint(
            {"base_url": "https://api.example.com/v1", "image_generation_endpoint": "/v1/images/generations"},
            "image_generation_endpoint",
            "/v1/images/generations",
        )
        self.assertEqual(joined, "https://api.example.com/v1/images/generations")
        self.assertEqual(
            dispatch_kernel.task_lookup_url({"base_url": "https://api.example.com/v1", "protocol": "apimart"}, "abc"),
            "https://api.example.com/v1/tasks/abc",
        )

    def test_status_and_queue(self):
        pending = dispatch_kernel.classify_remote({"data": {"task": {"status": "running"}}})
        self.assertEqual(pending["state"], "pending")
        done = dispatch_kernel.classify_remote({"data": {"status": "succeeded", "images": [{"url": "https://img/a.png"}]}})
        self.assertEqual(done["state"], "succeeded")
        self.assertEqual(done["urls"], ["https://img/a.png"])
        failed = dispatch_kernel.classify_remote({"error": {"code": "bad_response_status_code", "message": "openai_error"}})
        self.assertEqual(failed["state"], "failed")
        self.assertIn("有效图片", failed["message"])
        record = dispatch_kernel.open_task("image", "shop_1", "req-1")
        self.assertEqual(record["status"], "queued")
        finished = dispatch_kernel.observe_task(record, done)
        self.assertEqual(finished["status"], "succeeded")
        self.assertEqual(finished["result"]["urls"], ["https://img/a.png"])

    def test_header_accepts_next_and_keeps_legacy_rollback(self):
        async def run(headers):
            seen = {}

            async def app(scope, receive, send):
                seen["mode"] = dispatch_kernel.MODE.get()

            middleware = dispatch_kernel.DispatchSwitchMiddleware(app)

            async def receive():
                return {"type": "http.request"}

            async def send(message):
                return None

            await middleware({"type": "http", "headers": headers}, receive, send)
            return seen["mode"]

        self.assertEqual(asyncio.run(run([])), "legacy")
        self.assertEqual(asyncio.run(run([(b"x-xiaomei-dispatch", b"next")])), "next")
        self.assertEqual(asyncio.run(run([(b"x-xiaomei-dispatch", b"legacy")])), "legacy")
        self.assertEqual(dispatch_kernel.MODE.get(), "legacy")


if __name__ == "__main__":
    unittest.main()
