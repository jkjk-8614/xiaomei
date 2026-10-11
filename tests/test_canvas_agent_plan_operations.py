import unittest

import main


class CanvasAgentPlanOperationTests(unittest.TestCase):
    def test_edit_plan_keeps_operations_without_forcing_a_generation_node(self):
        value = {
            "analysis": "修改当前节点",
            "options": [
                {
                    "label": "修改当前提示词",
                    "workflow": {
                        "mode": "edit",
                        "operations": [
                            {
                                "op": "update_node",
                                "node": "current",
                                "changes": {"prompt": "白底产品摄影", "unknown": "drop"},
                            },
                            {"op": "run", "targets": ["current"]},
                        ],
                    },
                }
            ],
        }

        plan = main._normalize_canvas_plan(value, "把当前节点提示词改成白底产品摄影")
        workflow = plan["options"][0]["workflow"]

        self.assertEqual(workflow["mode"], "edit")
        self.assertEqual(workflow["nodes"], [])
        self.assertEqual(workflow["operations"][0]["changes"], {"prompt": "白底产品摄影"})
        self.assertEqual(workflow["operations"][1]["targets"], ["current"])

    def test_invalid_operations_are_removed_and_references_are_bounded(self):
        value = {
            "options": [
                {
                    "workflow": {
                        "mode": "edit",
                        "operations": [
                            {"op": "arbitrary_code", "value": "ignored"},
                            {"op": "disconnect", "from": "a", "to": "b", "kind": "flow"},
                            {"op": "move_node", "node": "a", "x": 999999, "y": -999999},
                        ],
                    }
                }
            ]
        }

        workflow = main._normalize_canvas_plan(value, "调整已有节点")["options"][0]["workflow"]
        self.assertEqual([item["op"] for item in workflow["operations"]], ["disconnect", "move_node"])
        self.assertEqual(workflow["operations"][1]["x"], 100000)
        self.assertEqual(workflow["operations"][1]["y"], -100000)

    def test_persistent_agent_is_downgraded_in_operation_nodes(self):
        value = {
            "options": [
                {
                    "workflow": {
                        "mode": "edit",
                        "operations": [{"op": "create_node", "node": {"type": "smart-agent", "user_prompt": "整理"}}],
                    }
                }
            ]
        }

        operation = main._normalize_canvas_plan(value, "新增一个分析节点")["options"][0]["workflow"]["operations"][0]
        self.assertEqual(operation["node"]["type"], "smart-prompt")
        self.assertEqual(operation["node"]["text"], "整理")
        self.assertNotIn("user_prompt", operation["node"])


if __name__ == "__main__":
    unittest.main()
