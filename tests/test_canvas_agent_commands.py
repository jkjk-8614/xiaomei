import unittest

import canvas_agent_commands as commands
import main


class CanvasAgentCommandContractTests(unittest.TestCase):
    def test_action_alias_uses_shared_registry(self):
        value = commands.normalize_operation({"tool": "cutout", "target": "current", "args": {}})
        self.assertEqual(value["tool"], "image.remove_background")
        self.assertEqual(value["target"], "current")

    def test_batch_operation_requires_confirmation(self):
        value = commands.normalize_operation({
            "tool": "image.remove_background",
            "args": {"batch": True, "all_images": True, "preserve_source": True},
        })
        self.assertEqual(value["confirmation"], "required")

    def test_invalid_tool_and_rotation_are_rejected(self):
        with self.assertRaises(ValueError):
            commands.normalize_operation({"tool": "run_shell", "args": {}})
        with self.assertRaises(ValueError):
            commands.normalize_operation({"tool": "image.rotate", "args": {"degrees": 45}})

    def test_read_only_request_does_not_trigger_fast_path(self):
        self.assertIsNone(commands.tool_request("只分析这张图，不要生成"))
        self.assertEqual(main._canvas_agent_deterministic_operations("用抠图工具把当前图片变成透明底" )[0]["tool"], "image.remove_background")
        self.assertEqual(main._canvas_agent_deterministic_operations("只分析如何用抠图工具，不要执行"), [])

    def test_commerce_reference_plan_separates_product_and_style(self):
        message = "参考淘宝链接，根据产品图生成相似风格淘宝主图"
        intent = commands.commerce_intent(message + " https://example.com/item")
        self.assertEqual(intent["platform"], "taobao")
        self.assertTrue(intent["reference"])
        plan = commands.commerce_plan(
            message + " https://example.com/item",
            {"references": [
                {"role": "product", "node_id": "product-1", "image_index": 0},
                {"role": "style", "link_job_id": "job-1"},
            ]},
            {},
        )
        workflow = plan["options"][0]["workflow"]
        self.assertEqual(workflow["commerce"]["platform"], "taobao")
        self.assertEqual(workflow["commerce"]["main_count"], 5)
        self.assertEqual(workflow["nodes"][1]["settings"]["ratio"], "square")
        self.assertEqual(workflow["nodes"][-1]["settings"]["ratio"], "square")
        self.assertTrue(workflow["nodes"][1]["requires_product_review"])
        self.assertEqual(workflow["nodes"][1]["reference_roles"][1]["role"], "style")

    def test_main_action_uses_shared_validation(self):
        result = main._canvas_agent_action_result(
            '{"operations":[{"tool":"image.rotate","args":{"degrees":45}}]}',
            message="rotate image",
        )
        self.assertFalse(result["can_apply"])
        self.assertEqual(result["operations"], [])


if __name__ == "__main__":
    unittest.main()
