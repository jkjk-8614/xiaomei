import asyncio
import unittest
from unittest import mock

import main


class CanvasAgentActionTests(unittest.TestCase):
    def test_plain_visual_prompt_is_recovered_as_executable_prompt(self):
        raw = (
            "基于图1的相框层叠场景进行改图，在原有相框最上方叠加图2的直角胡桃木相框，"
            "内衬保持纯白底面，保留温暖木质与自然光影。"
        )

        result = main._canvas_agent_action_result(raw, message="根据图片修改并生成")

        self.assertTrue(result["can_apply"])
        self.assertEqual(result["prompt"], raw)
        self.assertEqual(result["settings"]["count"], 1)

    def test_plain_acknowledgement_is_not_written_as_a_prompt(self):
        result = main._canvas_agent_action_result(
            "好的，我会根据你的需求生成图片。",
            message="生成图片",
        )

        self.assertFalse(result["can_apply"])
        self.assertEqual(result["prompt"], "")

    def test_explicit_no_generation_still_blocks_plain_prompt_fallback(self):
        result = main._canvas_agent_action_result(
            "参考图1，生成白底产品摄影画面。",
            no_generation=True,
            message="只分析这张图，不要生成",
        )

        self.assertFalse(result["can_apply"])
        self.assertEqual(result["prompt"], "")

    def test_prompt_in_summary_is_recovered(self):
        result = main._canvas_agent_action_result(
            '{"summary":"参考图1，生成白底产品摄影画面。","settings":{}}',
            message="修改并生成",
        )

        self.assertTrue(result["can_apply"])
        self.assertEqual(result["prompt"], "参考图1，生成白底产品摄影画面。")

    def test_selected_skill_keeps_the_canvas_action_contract(self):
        async def fake_canvas_llm(payload):
            self.assertEqual(payload.skill_id, "")
            self.assertIn("最终必须只返回可被 JSON.parse 解析的对象", payload.system_prompt)
            return {"text": "参考图1，生成白底产品摄影画面。", "model": "test-model"}

        payload = main.CanvasAgentActionRequest(
            message="修改图片并生成",
            skill_id="gpt-image",
            provider="test-provider",
            model="test-model",
        )
        with mock.patch.object(
            main,
            "resolve_canvas_skill_request",
            return_value=({"id": "gpt-image", "name": "gpt-image"}, "Skill 任务规则"),
        ), mock.patch.object(main, "canvas_llm", new=fake_canvas_llm):
            result = asyncio.run(main.canvas_agent_action(payload))

        self.assertTrue(result["can_apply"])
        self.assertEqual(result["skill_id"], "gpt-image")
        self.assertEqual(result["prompt"], "参考图1，生成白底产品摄影画面。")


if __name__ == "__main__":
    unittest.main()
