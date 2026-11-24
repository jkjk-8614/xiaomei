"""Exercise the image draft and confirmation flow through the chat API."""

import asyncio
import base64
from contextlib import AsyncExitStack
from io import BytesIO
import json
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import AsyncMock, patch

import httpx
from PIL import Image

import main


class ChatImageRequestTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        stack = AsyncExitStack()
        self.addAsyncCleanup(stack.aclose)
        root = Path(stack.enter_context(TemporaryDirectory(prefix="小美聊天生图-")))
        assets = root / "素材"
        self.output = assets / "output"
        self.output.mkdir(parents=True)
        self.history = root / "history.json"
        self.chat = {"id": "chat", "protocol": "openai", "chat_models": ["chat-fixture"]}
        primary = {"id": "primary", "primary": True, "image_models": ["primary-image"]}
        requested = {"id": "images", "image_models": ["requested-image"]}
        disabled = {"id": "disabled", "enabled": False, "image_models": ["disabled-image"]}
        self.router = AsyncMock(return_value={"choices": [{"message": {"content": "unparseable reply"}}]})
        self.text = AsyncMock(return_value={"role": "assistant", "content": "图片分析"})
        self.generate = AsyncMock()
        stack.enter_context(patch.multiple(
            main, ASSETS_DIR=str(assets), OUTPUT_OUTPUT_DIR=str(self.output), OUTPUT_DIR=str(root / "legacy-output"),
            CONVERSATION_DIR=str(root / "conversations"), HISTORY_FILE=str(self.history),
            asset_registry_register_history_record=lambda record: None,
            load_api_providers=lambda: [self.chat, primary, requested, disabled],
            get_api_provider=lambda name: self.chat,
            resolve_chat_provider=lambda *args: ("https://fixture.invalid/v1", {}, "chat-fixture"),
            _prepare_link_context=AsyncMock(return_value={}),
            build_chat_design_plan=AsyncMock(return_value=None),
            request_chat_agent_completion=self.router,
            build_chat_text_reply=self.text,
            generate_ai_image=self.generate,
        ))
        origin = "http://127.0.0.1:3000"
        transport = httpx.ASGITransport(app=main.app, client=("127.0.0.1", 45000))
        self.client = await stack.enter_async_context(httpx.AsyncClient(
            transport=transport, base_url=origin,
            headers={"Origin": origin, main.LOCAL_SESSION_HEADER: main.LOCAL_SESSION_TOKEN, "X-User-Id": "fixture"},
        ))

    async def send(self, message, **fields):
        return await self.client.post("/api/chat/agent", json={"message": message, "provider": "chat", **fields})

    async def test_undelivered_image_can_be_recovered_into_the_original_message(self):
        with BytesIO() as stream:
            Image.new("RGB", (12, 12), "red").save(stream, format="PNG")
            encoded = base64.b64encode(stream.getvalue()).decode()
        self.generate.return_value = ({"type": "b64", "value": encoded}, {})
        journal = self.history.parent / "recovery.jsonl"
        with patch.object(main, "unparsed_image_response_path", return_value=str(journal)):
            with patch.object(main, "_write_generated_snapshot", side_effect=PermissionError("disk write denied")):
                response = await self.client.post("/api/chat", json={"message": "生成一张图", "provider": "chat", "mode": "image"})
                created = response.raise_for_status().json()
            message = created["message"]
            recovery_id = message["image_recoveries"][0]["id"]
            self.assertEqual(message["image_url"], "")
            conversation_id = created["conversation"]["id"]
            response = await self.client.post(f"/api/chat/image-result-recovery/{conversation_id}/{message['id']}/{recovery_id}")
            saved = response.raise_for_status().json()["conversation"]
        restored = next(row for row in saved["messages"] if row["id"] == message["id"])
        self.assertEqual(restored["image_recoveries"], [])
        self.assertTrue(Path(main.output_file_from_url(restored["image_url"])).is_file())
        self.assertEqual(json.loads(self.history.read_text(encoding="utf-8"))[0]["history_source"], "chat")
        self.generate.assert_awaited_once()

    async def test_batch_uses_confirmed_prompt_and_saved_provider(self):
        results = []
        for color in ("black", "white"):
            with BytesIO() as stream:
                Image.new("RGB", (16, 16), color).save(stream, format="PNG")
                results.append(({"type": "b64", "value": base64.b64encode(stream.getvalue()).decode()}, {}))
        self.generate.side_effect = results
        suggestion = json.dumps({"action": "chat", "prompt": "红色和蓝色的海报"}, ensure_ascii=False)
        self.router.return_value = {"choices": [{"message": {"content": "JSON:\n" + suggestion}}]}
        first = (await self.send("生成两张海报", image_provider=" images ")).raise_for_status().json()
        draft = first["message"]
        self.assertEqual(draft["type"], "image_draft")
        self.assertEqual(draft["draft_action"], "generate_image")
        self.assertEqual(draft["draft_prompt"], "红色和蓝色的海报")
        self.assertEqual(draft["image_count"], 2)
        self.assertEqual(draft["image_provider"], "images")
        self.generate.assert_not_called()

        confirmation = {
            "conversation_id": first["conversation"]["id"],
            "generation_draft_id": draft["id"],
            "confirm_image_generation": True,
            "image_provider": "primary",
        }
        completed = (await self.send(
            "黑色和白色的海报", generation_prompt="黑色和白色的海报", **confirmation,
        )).raise_for_status().json()["message"]
        self.assertEqual(completed["prompts"], ["黑色的海报", "白色的海报"])
        self.assertEqual([call.args[0] for call in self.generate.await_args_list], completed["prompts"])
        self.assertEqual([call.args[5] for call in self.generate.await_args_list], ["images", "images"])
        self.assertEqual([call.args[3] for call in self.generate.await_args_list], ["requested-image", "requested-image"])
        self.assertEqual(len(completed["image_urls"]), 2)
        for url in completed["image_urls"]:
            self.assertTrue(Path(main.output_file_from_url(url)).is_file())
        history = json.loads(self.history.read_text(encoding="utf-8"))[0]
        self.assertEqual(history["history_source"], "chat")
        self.assertEqual(history["images"], completed["image_urls"])
        self.assertEqual((await self.send("继续", **confirmation)).status_code, 409)
        self.assertEqual(self.generate.await_count, 2)

    async def test_edit_uses_last_saved_image_and_real_local_dimensions(self):
        previous = self.output / "上一张.png"
        Image.new("RGB", (802, 612)).save(previous)
        previous_url = main.output_url_for(previous.name)
        conversation = main.new_conversation("fixture")
        conversation["messages"] = [
            {"role": "assistant", "type": "image", "image_url": "/assets/output/earlier.png"},
            {"role": "assistant", "type": "image", "image_url": previous_url, "content": "上次生成"},
            {"role": "assistant", "type": "text", "content": "后来补充的文字"},
        ]
        path = Path(main.CONVERSATION_DIR) / "fixture" / (conversation["id"] + ".json")
        main._atomic_write_json_file(path, conversation)
        result = (await self.send(
            "把上一张换成白色背景", conversation_id=conversation["id"], image_provider="disabled",
        )).raise_for_status().json()["message"]
        self.assertEqual(result["draft_action"], "edit_image")
        self.assertEqual(result["draft_prompt"], "把上一张换成白色背景")
        self.assertEqual(result["used_references"], [{"url": previous_url, "name": "上次生成", "role": "source"}])
        self.assertEqual(result["size"], "816x624")
        self.assertEqual(result["image_count"], 1)
        self.assertEqual(result["image_provider"], "primary")
        self.generate.assert_not_called()

    async def test_image_analysis_skips_routing_and_generation(self):
        result = (await self.send(
            "只分析这张图，不要生成图片",
            reference_images=[{"url": "/assets/output/fixture.png", "kind": "image"}],
        )).raise_for_status().json()
        self.assertEqual(result["message"]["agent_action"], "chat")
        self.text.assert_awaited_once()
        self.router.assert_not_called()
        self.generate.assert_not_called()

    async def test_concurrent_confirmation_only_calls_the_image_model_once(self):
        draft_result = (await self.send("生成一张图片")).raise_for_status().json()
        draft = draft_result["message"]
        confirmation = {
            "conversation_id": draft_result["conversation"]["id"],
            "confirm_image_generation": True,
            "generation_draft_id": draft["id"],
        }
        entered = asyncio.Event()
        release = asyncio.Event()
        with BytesIO() as stream:
            Image.new("RGB", (8, 8)).save(stream, format="PNG")
            encoded = base64.b64encode(stream.getvalue()).decode()

        async def generate(*args):
            entered.set()
            await release.wait()
            return {"type": "b64", "value": encoded}, {}

        self.generate.side_effect = generate
        first = asyncio.create_task(self.send("确认生图", **confirmation))
        try:
            await asyncio.wait_for(entered.wait(), timeout=5)
            duplicate = await self.send("确认生图", **confirmation)
            self.assertEqual(duplicate.status_code, 409)
        finally:
            release.set()
            result = (await first).raise_for_status().json()
        self.generate.assert_awaited_once()
        records = result["conversation"]["messages"]
        self.assertEqual(records[1]["draft_status"], "generated")
        self.assertEqual(records[3]["generation_draft_id"], draft["id"])

    async def test_generated_media_reaches_history_when_the_conversation_was_deleted(self):
        initial = (await self.send("生成一张图片")).raise_for_status().json()
        conversation_id = initial["conversation"]["id"]
        path = "/api/conversations/" + conversation_id
        with BytesIO() as stream:
            Image.new("RGB", (8, 8)).save(stream, format="PNG")
            encoded = base64.b64encode(stream.getvalue()).decode()

        async def generate(*args):
            (await self.client.delete(path)).raise_for_status()
            return {"type": "b64", "value": encoded}, {}

        self.generate.side_effect = generate
        completed = await self.send(
            "确认生图", conversation_id=conversation_id,
            confirm_image_generation=True, generation_draft_id=initial["message"]["id"],
        )
        self.assertEqual(completed.status_code, 404)
        self.assertEqual((await self.client.get(path)).status_code, 404)
        history = json.loads(self.history.read_text(encoding="utf-8"))
        self.assertEqual(len(history), 1)
        self.assertTrue(Path(main.output_file_from_url(history[0]["images"][0])).is_file())
