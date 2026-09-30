import asyncio
import os
import tempfile
import unittest
from unittest.mock import AsyncMock, patch

import main
from starlette.requests import Request


class CommerceAnalysisResourceTests(unittest.TestCase):
    def test_detail_long_image_cache_reuses_generated_file_across_jobs_and_signatures(self):
        result = {
            "detail": {"images": ["https://example.com/detail-1.png"]},
        }
        equivalent_result = {
            "detail": {"images": ["https://example.com/detail-2.png"]},
        }
        with tempfile.TemporaryDirectory() as cache_dir, \
                patch.object(main, "COMMERCE_ANALYSIS_DETAIL_CACHE_DIR", cache_dir), \
                patch.object(main, "_commerce_analysis_build_detail_long_image", return_value=b"png") as build:
            cache_path, inline_content = main._commerce_analysis_get_detail_long_image_payload(result, "job-cache")
            self.assertTrue(cache_path)
            self.assertIsNone(inline_content)
            self.assertTrue(os.path.isfile(cache_path))
            self.assertEqual(main._commerce_analysis_get_detail_long_image(result, "job-cache"), b"png")
            same_input_path, _ = main._commerce_analysis_get_detail_long_image_payload(result, "another-job")
            self.assertEqual(same_input_path, cache_path)
            equivalent_output_path, _ = main._commerce_analysis_get_detail_long_image_payload(
                equivalent_result, "different-input-job"
            )
            self.assertEqual(equivalent_output_path, cache_path)
            self.assertEqual(build.call_count, 2)

    def test_detail_download_streams_cached_file(self):
        with tempfile.NamedTemporaryFile(suffix=".png", delete=False) as handle:
            handle.write(b"png")
            cache_path = handle.name
        result = {
            "product": {"id": "product-1", "title": "测试商品"},
            "resources": [{"id": "detail", "downloadable": True}],
        }
        try:
            with patch.object(main, "_commerce_analysis_get_job", return_value={"result": result}), \
                    patch.object(main, "_commerce_analysis_attach_contract", return_value=result), \
                    patch.object(main, "_commerce_analysis_get_detail_long_image_payload", return_value=(cache_path, None)):
                response = asyncio.run(main.commerce_analysis_download_media_resource("job-cache", "detail"))
            self.assertIsInstance(response, main.FileResponse)
            self.assertEqual(response.path, cache_path)
            self.assertEqual(response.headers.get("cache-control"), "private, max-age=3600")
        finally:
            os.remove(cache_path)

    def test_detail_reference_indexes_are_evenly_bounded(self):
        indexes = main._commerce_analysis_detail_reference_indices(24, 6)

        self.assertEqual(len(indexes), 6)
        self.assertEqual(indexes[0], 0)
        self.assertEqual(indexes[-1], 23)
        self.assertEqual(indexes, sorted(set(indexes)))

    def test_detail_reference_indexes_keep_all_small_inputs(self):
        self.assertEqual(main._commerce_analysis_detail_reference_indices(3, 6), [0, 1, 2])

    def test_commerce_history_link_images_are_capped(self):
        record = {
            "role": "user",
            "mode": "commerce-analysis",
            "link_resource_ids": ["images", "detail_more"],
            "link_images": [f"https://example.com/{index}.png" for index in range(20)],
        }

        images = main._commerce_analysis_link_images_from_record(record)

        self.assertEqual(len(images), main.COMMERCE_CHAT_MAX_INLINE_IMAGES)

    def test_commerce_stream_reports_first_token_timeout(self):
        class NeverRespondingResponse:
            status_code = 200

            async def __aenter__(self):
                return self

            async def __aexit__(self, exc_type, exc, traceback):
                return False

            def aiter_lines(self):
                async def lines():
                    await asyncio.sleep(1)
                    yield "data: {}"

                return lines()

        class NeverRespondingClient:
            def __init__(self, *args, **kwargs):
                pass

            async def __aenter__(self):
                return self

            async def __aexit__(self, exc_type, exc, traceback):
                return False

            def stream(self, *args, **kwargs):
                return NeverRespondingResponse()

        payload = main.ChatRequest(
            message="分析这个商品",
            mode="commerce-analysis",
            provider="test-provider",
            model="test-model",
        )
        request = Request({
            "type": "http",
            "method": "POST",
            "path": "/api/chat/stream",
            "headers": [],
            "query_string": b"",
        })

        async def collect_events():
            response = await main.chat_stream(payload, request, "test-user")
            return [chunk async for chunk in response.body_iterator]

        with patch.object(main, "COMMERCE_CHAT_FIRST_TOKEN_TIMEOUT", 0.01), \
                patch.object(main, "_prepare_link_context", new=AsyncMock(return_value={
                    "context_text": "商品资料",
                    "images": [],
                    "links": [],
                    "job_ids": [],
                    "resource_ids": [],
                    "page_context": {},
                })), \
                patch.object(main, "new_conversation", return_value={"id": "conversation-test", "messages": []}), \
                patch.object(main, "save_conversation"), \
                patch.object(main, "get_api_provider", return_value={}), \
                patch.object(main, "resolve_chat_provider", return_value=("https://test.invalid", {}, "test-model")), \
                patch.object(main, "chat_system_prompt", return_value="system"), \
                patch.object(main.httpx, "AsyncClient", NeverRespondingClient):
            events = asyncio.run(collect_events())

        joined = "".join(str(chunk) for chunk in events)
        self.assertIn("没有返回首段文字", joined)
        self.assertNotIn("300 秒内没有完成回复", joined)

    def test_partial_sku_list_keeps_real_rows_selectable(self):
        result = {
            "status": "partial",
            "source": "electron-commerce-network",
            "originalUrl": "https://item.taobao.com/item.htm?id=10001",
            "collection": {
                "source": "electron-commerce-network",
                "receivedAt": "2026-09-15T04:02:58.398Z",
                "modules": {"sku": {"status": "partial", "totalCount": 4}},
            },
            "product": {
                "id": "10001",
                "title": "测试相框商品名称",
                "skuCount": 4,
            },
            "sku": {
                "specs": [{
                    "name": "尺寸",
                    "values": [{"name": "30 x 40 cm", "id": "-1"}],
                }],
                "items": [
                    {
                        "id": "sku-1",
                        "propPath": "-1:-1",
                        "specs": [{"name": "尺寸", "value": "30 x 40 cm"}],
                    },
                    {
                        "id": "sku-2",
                        "propPath": "-1:-2",
                        "specs": [{"name": "尺寸", "value": "40 x 50 cm"}],
                    },
                    {
                        "id": "sku-3",
                        "propPath": "-1:-3",
                        "specs": [{"name": "尺寸", "value": "50 x 70 cm"}],
                    },
                ],
                "totalCount": 4,
            },
        }

        contract = main._commerce_analysis_attach_contract(result, job_id="job-10001", mode="electron")
        resource = next(item for item in contract["resources"] if item["id"] == "sku_list")
        headers, rows = main._commerce_analysis_resource_rows(contract, "sku_list")

        self.assertEqual(resource["status"], "partial")
        self.assertEqual(resource["sampleCount"], 3)
        self.assertEqual(resource["totalCount"], 4)
        self.assertFalse(resource["matrixComplete"])
        self.assertTrue(resource["downloadable"])
        self.assertEqual(len(headers), 10)
        self.assertEqual(len(rows), 3)


if __name__ == "__main__":
    unittest.main()
