import asyncio
import unittest
from unittest.mock import patch

import main


class FakeResponse:
    def __init__(self, payload=None, status_code=200, content=b"", headers=None):
        self._payload = payload
        self.status_code = status_code
        self.content = content
        self.headers = headers or {"Content-Type": "application/json"}
        self.text = "" if payload is None else str(payload)

    def json(self):
        return self._payload

    def raise_for_status(self):
        if self.status_code >= 400:
            raise RuntimeError(f"HTTP {self.status_code}")


class FakeVideoClient:
    def __init__(self, query_payload):
        self.query_payload = query_payload
        self.posts = []
        self.gets = []

    async def post(self, url, **kwargs):
        self.posts.append((url, kwargs))
        return FakeResponse({"id": "task_123", "status": "queued"}, status_code=202)

    async def get(self, url, **kwargs):
        self.gets.append((url, kwargs))
        if url.endswith("/content"):
            return FakeResponse(
                content=b"fake mp4",
                headers={"Content-Type": "video/mp4"},
            )
        return FakeResponse(self.query_payload)


class Api6789VideoAdapterTests(unittest.TestCase):
    provider = {
        "id": "api-6789",
        "name": "6789API",
        "base_url": "https://www.6789api.top",
    }

    def test_6789_uses_current_paths_and_exact_request_body(self):
        payload = main.CanvasVideoRequest(
            prompt="a product turns",
            provider_id="api-6789",
            model="Seedance2.5",
            duration=30,
            aspect_ratio="16:9",
        )
        client = FakeVideoClient({"id": "task_123", "status": "succeeded", "file": "", "download_url": ""})

        async def no_sleep(_):
            return None

        async def run():
            with patch.object(main, "provider_env_key_value", return_value="test-key"), \
                    patch.object(main, "save_video_bytes_to_output", return_value="/assets/generated/test.mp4"), \
                    patch.object(main.asyncio, "sleep", no_sleep):
                return await main.generate_6789_video(client, payload, self.provider)

        result = asyncio.run(run())
        self.assertEqual(client.posts[0][0], "https://www.6789api.top/v1/videos")
        self.assertEqual(
            client.posts[0][1]["json"],
            {
                "model": "seedance2.5",
                "prompt": "a product turns",
                "duration": 30,
                "ratio": "16:9",
                "resolution": "720p",
            },
        )
        self.assertIn("Idempotency-Key", client.posts[0][1]["headers"])
        self.assertEqual(client.gets[0][0], "https://www.6789api.top/v1/videos/task_123")
        self.assertEqual(client.gets[1][0], "https://www.6789api.top/v1/videos/task_123/content")
        self.assertEqual(result["videos"], ["/assets/generated/test.mp4"])

    def test_file_is_preferred_to_download_url(self):
        self.assertEqual(
            main.video_6789_output_urls(
                {
                    "status": "succeeded",
                    "file": "https://cdn.example/file.mp4",
                    "download_url": "https://cdn.example/download.mp4",
                }
            ),
            ["https://cdn.example/file.mp4"],
        )

    def test_model_and_duration_are_checked_against_documented_values(self):
        with self.assertRaises(main.HTTPException):
            main.normalize_6789_video_model("kling-o3")
        with self.assertRaises(main.HTTPException):
            main.normalize_6789_video_duration("seedance2.5", 5)
        self.assertEqual(main.normalize_6789_model_id("Seedance2.5"), "seedance2.5")


if __name__ == "__main__":
    unittest.main()
