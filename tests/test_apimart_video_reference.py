import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock, patch

import main


class ApimartVideoReferenceTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp_dir.cleanup)
        self.video_path = Path(self.temp_dir.name) / "参考视频.mp4"
        self.video_path.write_bytes(b"video fixture")
        self.local_url = "/assets/%E5%8F%82%E8%80%83%E8%A7%86%E9%A2%91.mp4"

    async def test_local_video_uses_existing_cloud_upload(self):
        upload = AsyncMock(return_value={"url": "https://media.example.com/video.mp4"})
        with patch.object(main, "output_file_from_url", return_value=str(self.video_path)), \
             patch.object(main, "local_asset_public_url", return_value=""), \
             patch.object(main, "upload_local_video_to_cloud", upload):
            result = await main.upload_video_for_apimart(None, {}, self.local_url)
        self.assertEqual(result, "https://media.example.com/video.mp4")
        upload.assert_awaited_once_with(self.local_url)

    async def test_loopback_video_is_uploaded_as_local_file(self):
        upload = AsyncMock(return_value={"url": "https://media.example.com/video.mp4"})
        with patch.object(main, "output_file_from_url", return_value=str(self.video_path)), \
             patch.object(main, "local_asset_public_url", return_value=""), \
             patch.object(main, "upload_local_video_to_cloud", upload):
            result = await main.upload_video_for_apimart(None, {}, "http://127.0.0.1:3000/assets/%E5%8F%82%E8%80%83%E8%A7%86%E9%A2%91.mp4")
        self.assertEqual(result, "https://media.example.com/video.mp4")
        upload.assert_awaited_once_with("/assets/参考视频.mp4")

    async def test_public_and_approved_asset_urls_pass_through(self):
        with patch.object(main, "upload_local_video_to_cloud", AsyncMock()) as upload:
            self.assertEqual(await main.upload_video_for_apimart(None, {}, "https://media.example.com/video.mp4"), "https://media.example.com/video.mp4")
            self.assertEqual(await main.upload_video_for_apimart(None, {}, "asset://asset_a"), "asset://asset_a")
        upload.assert_not_awaited()

    async def test_private_url_is_not_sent_to_apimart(self):
        with patch.object(main, "upload_local_video_to_cloud", AsyncMock()) as upload:
            result = await main.upload_video_for_apimart(None, {}, "http://192.168.1.5/video.mp4")
        self.assertTrue(result.startswith("ERR:"))
        upload.assert_not_awaited()

    async def test_cloud_failure_reports_actionable_error(self):
        upload = AsyncMock(side_effect=main.HTTPException(status_code=502, detail="临时文件服务不可用"))
        with patch.object(main, "output_file_from_url", return_value=str(self.video_path)), \
             patch.object(main, "local_asset_public_url", return_value=""), \
             patch.object(main, "upload_local_video_to_cloud", upload):
            result = await main.upload_video_for_apimart(None, {}, self.local_url)
        self.assertIn("临时文件服务不可用", result)
        self.assertIn("检查网络后重试", result)

    async def test_configured_media_url_skips_cloud_upload(self):
        with patch.object(main, "local_asset_public_url", return_value="https://media.example.com/video.mp4"), \
             patch.object(main, "upload_local_video_to_cloud", AsyncMock()) as upload:
            result = await main.upload_video_for_apimart(None, {}, self.local_url)
        self.assertEqual(result, "https://media.example.com/video.mp4")
        upload.assert_not_awaited()

    async def test_canvas_video_submits_uploaded_url(self):
        request_body = {}

        class FakeClient:
            async def __aenter__(self):
                return self

            async def __aexit__(self, *_args):
                return False

            async def post(self, _url, **kwargs):
                request_body.update(kwargs["json"])
                return SimpleNamespace(status_code=200, text="{}", json=lambda: {})

        provider = {"id": "apimart", "name": "APIMart", "protocol": "apimart", "base_url": "https://api.apimart.ai"}
        with patch.object(main, "get_api_provider", return_value=provider), \
             patch.object(main, "provider_env_key_value", return_value="test-key"), \
             patch.object(main, "output_file_from_url", return_value=str(self.video_path)), \
             patch.object(main, "local_asset_public_url", return_value=""), \
             patch.object(main, "upload_local_video_to_cloud", AsyncMock(return_value={"url": "https://media.example.com/video.mp4"})), \
             patch.object(main.httpx, "AsyncClient", return_value=FakeClient()), \
             patch.object(main, "api_headers", return_value={}), \
             patch.object(main, "video_output_urls", return_value=["https://media.example.com/result.mp4"]), \
             patch.object(main, "save_remote_video_to_output", AsyncMock(return_value="/output/result.mp4")), \
             patch.object(main, "save_canvas_video_to_history", Mock(side_effect=lambda _payload, _provider, result: result)):
            result = await main.canvas_video(main.CanvasVideoRequest(
                prompt="商品展示", provider_id="apimart", model="doubao-seedance-2.0", videos=[self.local_url]
            ))
        self.assertEqual(request_body["video_urls"], ["https://media.example.com/video.mp4"])
        self.assertEqual(result["videos"], ["/output/result.mp4"])


if __name__ == "__main__":
    unittest.main()
