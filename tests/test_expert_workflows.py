import asyncio
import json
import tempfile
import unittest
from pathlib import Path

from fastapi import HTTPException

from expert_workflows import ExpertRunRequest, ExpertWorkflowRuns


def workflow(*, pause=False):
    return {
        "name": "商品视觉协作",
        "experts": [
            {"id": "analysis", "name": "商品分析", "skill_id": "product", "provider": "chat",
             "model": "model-1", "instruction": "分析产品", "output_format": "卖点清单",
             "pause_after": pause, "x": 300, "y": 200},
            {"id": "writer", "name": "文案成稿", "skill_id": "copy", "provider": "chat",
             "model": "model-1", "instruction": "整理成文案", "output_format": "最终提示词"},
        ],
        "edges": [
            {"from": "input", "to": "analysis"},
            {"from": "analysis", "to": "writer"},
            {"from": "writer", "to": "output"},
        ],
    }


def request(**overrides):
    data = {
        "canvas_id": "canvas-a",
        "node_id": "node-a",
        "workflow": workflow(),
        "message": "为这张商品图写主图提示词",
        "images": ["/assets/product.png"],
    }
    data.update(overrides)
    return ExpertRunRequest(**data)


class ExpertWorkflowTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.calls = []
        self.fail_writer = False
        self.skill_context = {"product": "规则：product", "copy": "规则：copy"}

        async def invoke(payload):
            self.calls.append(payload)
            if self.fail_writer and "文案成稿" in payload["system_prompt"]:
                self.fail_writer = False
                raise HTTPException(status_code=503, detail="上游暂时不可用")
            return {"text": "结果 " + str(len(self.calls)), "model": payload["model"]}

        def save_json(path, value):
            target = Path(path)
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(json.dumps(value, ensure_ascii=False), encoding="utf-8")

        self.service = ExpertWorkflowRuns(
            Path(self.temp.name) / "runs",
            invoke_llm=invoke,
            resolve_skill=lambda skill_id: ({"id": skill_id, "name": skill_id}, self.skill_context[skill_id]),
            model_choices=lambda provider: ["model-1"] if provider == "chat" else [],
            request_factory=lambda **payload: payload,
            save_json=save_json,
        )

    async def wait_status(self, run_id, statuses):
        for _ in range(100):
            run = self.service.get(run_id)
            if run["status"] in statuses:
                return run
            await asyncio.sleep(0.01)
        self.fail("专家协作运行没有结束")

    async def test_runs_each_skill_in_connection_order_and_persists_result(self):
        run = await self.service.start(request())
        done = await self.wait_status(run["id"], {"completed"})
        self.assertEqual([item["id"] for item in done["steps"]], ["analysis", "writer"])
        self.assertIn("规则：product", self.calls[0]["system_prompt"])
        self.assertIn("上一位专家「商品分析」的结果：\n结果 1", self.calls[1]["message"])
        self.assertEqual(self.calls[0]["images"], ["/assets/product.png"])
        self.assertEqual(done["output"], "结果 2")
        self.assertTrue((Path(self.temp.name) / "runs" / (run["id"] + ".json")).exists())

    async def test_connections_define_execution_order_independent_of_card_order(self):
        configured = workflow()
        configured["experts"].reverse()
        run = await self.service.start(request(workflow=configured))
        done = await self.wait_status(run["id"], {"completed"})
        self.assertEqual([item["id"] for item in done["steps"]], ["analysis", "writer"])
        self.assertIn("规则：product", self.calls[0]["system_prompt"])

    async def test_pauses_for_review_then_continues_with_edited_result(self):
        paused = await self.service.start(request(workflow=workflow(pause=True)))
        paused = await self.wait_status(paused["id"], {"paused"})
        self.assertEqual(len(self.calls), 1)
        continued = await self.service.start(request(
            workflow=workflow(pause=True),
            resume_from=paused["id"], resume_after_step=0,
            edited_output="人工确认后的卖点",
        ))
        done = await self.wait_status(continued["id"], {"completed"})
        self.assertEqual(done["steps"][0]["status"], "reused")
        self.assertIn("人工确认后的卖点", self.calls[1]["message"])
        self.assertEqual(len(self.calls), 2)

    async def test_failed_step_can_retry_without_repeating_completed_step(self):
        self.fail_writer = True
        failed = await self.service.start(request())
        failed = await self.wait_status(failed["id"], {"failed"})
        self.assertEqual(failed["steps"][0]["status"], "completed")
        self.assertEqual(failed["steps"][1]["status"], "failed")
        self.assertIn("上游暂时不可用", failed["error"])
        retry = await self.service.start(request(resume_from=failed["id"], resume_after_step=0))
        done = await self.wait_status(retry["id"], {"completed"})
        self.assertEqual(done["steps"][0]["status"], "reused")
        self.assertEqual(len(self.calls), 3)

    async def test_rejects_unconnected_flow_and_unavailable_model_before_billing(self):
        invalid = workflow()
        invalid["edges"] = [{"from": "input", "to": "analysis"}]
        with self.assertRaises(HTTPException) as graph_error:
            await self.service.start(request(workflow=invalid))
        self.assertEqual(graph_error.exception.status_code, 422)
        unavailable = workflow()
        unavailable["experts"][0]["model"] = "not-listed"
        with self.assertRaises(HTTPException) as model_error:
            await self.service.start(request(workflow=unavailable))
        self.assertEqual(model_error.exception.status_code, 422)
        self.assertEqual(self.calls, [])

    async def test_resume_rejects_changed_input_or_skill_before_running_more_steps(self):
        paused = await self.service.start(request(workflow=workflow(pause=True)))
        paused = await self.wait_status(paused["id"], {"paused"})
        with self.assertRaises(HTTPException) as changed_input:
            await self.service.start(request(
                workflow=workflow(pause=True), message="新的任务",
                resume_from=paused["id"], resume_after_step=0,
            ))
        self.assertEqual(changed_input.exception.status_code, 409)
        self.skill_context["product"] = "更新后的规则"
        with self.assertRaises(HTTPException) as changed_skill:
            await self.service.start(request(
                workflow=workflow(pause=True),
                resume_from=paused["id"], resume_after_step=0,
            ))
        self.assertEqual(changed_skill.exception.status_code, 409)
        self.assertEqual(len(self.calls), 1)

    async def test_cancellation_persists_and_does_not_run_remaining_experts(self):
        started = asyncio.Event()

        async def hold_first(payload):
            self.calls.append(payload)
            started.set()
            await asyncio.Future()

        self.service.invoke_llm = hold_first
        run = await self.service.start(request())
        await started.wait()
        self.service.cancel(run["id"])
        cancelled = await self.wait_status(run["id"], {"cancelled"})
        self.assertEqual(cancelled["steps"][0]["status"], "cancelled")
        self.assertEqual(cancelled["steps"][1]["status"], "waiting")
        self.assertEqual(len(self.calls), 1)

    async def test_loading_an_active_record_after_restart_marks_it_interrupted(self):
        run_id = "a" * 32
        saved = Path(self.temp.name) / "runs" / (run_id + ".json")
        saved.parent.mkdir(parents=True, exist_ok=True)
        saved.write_text(json.dumps({"id": run_id, "status": "running", "error": "", "steps": []}), encoding="utf-8")
        loaded = self.service.get(run_id)
        self.assertEqual(loaded["status"], "interrupted")
        self.assertIn("服务重启", loaded["error"])


if __name__ == "__main__":
    unittest.main()
