import asyncio
import unittest
from unittest import mock

import main


class CanvasAgentReferenceTests(unittest.TestCase):
    def setUp(self):
        self.images = [f"https://images.invalid/ref-{index}.png" for index in range(25)]

    def test_action_sends_all_numbered_images_to_upstream(self):
        client = mock.AsyncMock()
        client.__aenter__.return_value = client
        client.post.return_value = main.httpx.Response(200, json={
            "choices": [{"message": {"content": '{"summary":"已分析","prompt":"","settings":{}}'}}],
        })
        payload = main.CanvasAgentActionRequest(
            message="只分析所有参考图，不要生成", images=self.images,
            provider="fixture", model="vision-test",
        )
        with mock.patch.object(main.httpx, "AsyncClient", return_value=client), \
                mock.patch.object(main, "canvas_vision_image_url", new=mock.AsyncMock(side_effect=lambda value, client: value)), \
                mock.patch.object(main, "media_reference_to_url", side_effect=lambda value, **kwargs: value), \
                mock.patch.object(main, "resolve_canvas_skill_request", return_value=(None, "")), \
                mock.patch.object(main, "get_api_provider", return_value={"id": "fixture", "protocol": "openai"}), \
                mock.patch.object(main, "resolve_chat_provider", return_value=("https://model.invalid", {}, "vision-test")), \
                mock.patch.object(main, "canvas_llm_model_candidates", return_value=["vision-test"]):
            result = asyncio.run(main.canvas_agent_action(payload))
        content = client.post.call_args.kwargs["json"]["messages"][-1]["content"]
        self.assertEqual([part["image_url"]["url"] for part in content if part["type"] == "image_url"], self.images)
        self.assertIn("共 25 张", content[0]["text"])
        self.assertIn("图25", content[-2]["text"])
        self.assertEqual(result["vision_input"]["submitted"], 25)
        self.assertTrue(result["no_generation"])

    def test_unreadable_image_is_reported_without_dropping_later_references(self):
        async def prepare(value, client):
            return "" if value == self.images[2] else value

        with mock.patch.object(main, "canvas_vision_image_url", new=prepare):
            refs, counts = asyncio.run(main.prepare_canvas_vision_images(self.images))
        self.assertEqual(refs, self.images[:2] + self.images[3:])
        self.assertEqual(counts, {"requested": 25, "submitted": 24, "normalized": 0, "skipped": 1})

    def test_link_context_preserves_all_explicit_references_before_link_images(self):
        context = {"images": self.images[:8] + ["https://images.invalid/link.png"], "link_count": 1}
        with mock.patch.object(main, "_prepare_link_context", new=mock.AsyncMock(return_value=context)):
            result = asyncio.run(main.enrich_canvas_message_with_links("分析 https://example.com/item", self.images))
        self.assertEqual(result["images"], self.images + ["https://images.invalid/link.png"])

    def test_cli_reference_preparation_accepts_all_canvas_images(self):
        async def prepare(value):
            return value, []

        with mock.patch.object(main, "codex_prepare_local_media", new=prepare):
            refs = [{"url": image} for image in self.images]
            for convert in (main.codex_reference_paths, main.gemini_cli_reference_paths):
                paths, temporary = asyncio.run(convert(refs, max_images=None))
                self.assertEqual(paths, self.images)
                self.assertEqual(temporary, [])

    def test_local_image_import_does_not_truncate_selected_paths(self):
        paths = [f"D:/图片/素材-{index}.png" for index in range(25)]
        request = main.Request({
            "type": "http", "scheme": "http", "path": "/api/ai/import-local-image",
            "headers": [(b"host", b"127.0.0.1:3000"), (b"origin", b"http://127.0.0.1:3000")],
        })
        with mock.patch.object(main, "normalize_local_image_path", side_effect=lambda path: path), \
                mock.patch.object(main, "import_local_image_file", side_effect=lambda path: {"url": path}):
            result = asyncio.run(main.import_local_ai_reference(main.LocalImageImportRequest(paths=paths), request))
        self.assertEqual([item["url"] for item in result["files"]], paths)


if __name__ == "__main__":
    unittest.main()
