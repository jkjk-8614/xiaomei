import asyncio
import unittest
from unittest.mock import patch

import main


class FakeResponse:
    status_code = 200
    text = '{}'

    def json(self):
        return {"id": "task-123"}

    def raise_for_status(self):
        pass


class FakeClient:
    def __init__(self):
        self.posts = []

    async def __aenter__(self):
        return self

    async def __aexit__(self, *_):
        return False

    async def post(self, url, **kwargs):
        self.posts.append((url, kwargs))
        return FakeResponse()


class VolcengineVideoAdapterTests(unittest.TestCase):
    provider = {
        "id": "volcengine", "name": "火山引擎", "protocol": "volcengine",
        "base_url": "https://ark.cn-beijing.volces.com",
    }

    def test_reference_video_uses_official_content_item(self):
        expected = [{
            "type": "video_url", "video_url": {"url": "https://cdn.example/reference.mp4"},
            "role": "reference_video",
        }]
        self.assertEqual(
            asyncio.run(main.volcengine_video_reference_content_items("https://cdn.example/reference.mp4")),
            expected,
        )
        with patch.object(main, "local_video_path_for_cloud_upload", return_value="reference.mp4"), \
                patch.object(main.os.path, "getsize", return_value=100), \
                patch.object(main, "upload_local_video_to_cloud", return_value={"url": "https://cdn.example/reference.mp4"}):
            self.assertEqual(
                asyncio.run(main.volcengine_video_reference_content_items("/assets/reference.mp4")),
                expected,
            )

    def test_fast_model_rejects_1080p_before_submit(self):
        with self.assertRaises(main.HTTPException) as error:
            main.validate_volcengine_video_settings("doubao-seedance-2-0-fast-260128", 5, "1080p")
        self.assertEqual(error.exception.status_code, 400)
        main.validate_volcengine_video_settings("doubao-seedance-2-0-fast-260128", 5, "720p")
        main.validate_volcengine_video_settings("doubao-seedance-2-0-260128", 5, main.volcengine_video_resolution("4k"))

    def test_canvas_video_submits_video_without_extracting_frames(self):
        payload = main.CanvasVideoRequest(
            prompt="Change the words in the reference video", provider_id="volcengine",
            model="doubao-seedance-2-0-fast-260128", duration=5,
            resolution="720p", videos=["/assets/reference.mp4"], generate_audio=False,
            camerafixed=True,
        )
        client = FakeClient()
        with patch.object(main, "get_api_provider", return_value=self.provider), \
                patch.object(main, "provider_env_key_value", return_value="test-key"), \
                patch.object(main.httpx, "AsyncClient", return_value=client), \
                patch.object(main, "local_video_path_for_cloud_upload", return_value="reference.mp4"), \
                patch.object(main.os.path, "getsize", return_value=100), \
                patch.object(main, "upload_local_video_to_cloud", return_value={"url": "https://cdn.example/reference.mp4"}), \
                patch.object(main, "video_output_urls", return_value=["https://cdn.example/result.mp4"]), \
                patch.object(main, "save_remote_video_to_output", return_value="/assets/result.mp4"), \
                patch.object(main, "save_canvas_video_to_history", return_value={"ok": True}):
            asyncio.run(main.canvas_video(payload))
        self.assertEqual(client.posts[0][0], "https://ark.cn-beijing.volces.com/api/v3/contents/generations/tasks")
        body = client.posts[0][1]["json"]
        self.assertEqual(body["content"][1], {
            "type": "video_url", "video_url": {"url": "https://cdn.example/reference.mp4"},
            "role": "reference_video",
        })
        self.assertEqual(body["generate_audio"], False)
        self.assertNotIn("camerafixed", body)
        self.assertNotIn("camera_fixed", body)


if __name__ == "__main__":
    unittest.main()
