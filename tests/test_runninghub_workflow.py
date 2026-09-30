import asyncio
import unittest
from unittest.mock import patch

import main


class RunningHubWorkflowReferenceTests(unittest.TestCase):
    workflow_id = "2101298116241743873"

    def test_normalize_workflow_page_and_run_urls(self):
        page_url = (
            "https://www.runninghub.cn/call-api/api-detail/"
            f"{self.workflow_id}?apiType=5"
        )
        self.assertEqual(
            main.normalize_runninghub_reference_id(page_url, "workflow"),
            self.workflow_id,
        )
        self.assertEqual(
            main.normalize_runninghub_reference_id(
                f"/run/workflow/{self.workflow_id}", "workflow"
            ),
            self.workflow_id,
        )
        self.assertEqual(
            main.runninghub_workflow_store_key(page_url),
            self.workflow_id,
        )

    def test_normalize_entry_keeps_workflow_id_and_metadata(self):
        entry = main.normalize_runninghub_entry(
            {
                "workflowId": f"/call-api/api-detail/{self.workflow_id}?apiType=5",
                "title": "照片光影重构十种风格",
                "fields": [{"nodeId": "1", "fieldName": "prompt", "fieldValue": ""}],
            },
            "workflow",
        )
        self.assertEqual(entry["workflowId"], self.workflow_id)
        self.assertEqual(entry["title"], "照片光影重构十种风格")
        self.assertEqual(len(entry["fields"]), 1)

    def test_workflow_submit_defaults_to_default_machine(self):
        payload = main.RunningHubWorkflowSubmitRequest(workflowId=self.workflow_id)
        self.assertEqual(payload.instanceType, "default")

    def test_workflow_submit_passes_machine_and_node_info(self):
        page_url = (
            "https://www.runninghub.cn/call-api/api-detail/"
            f"{self.workflow_id}?apiType=5"
        )

        class Response:
            status_code = 200

            @staticmethod
            def json():
                return {"code": 0, "data": {"taskId": "task-1"}}

        class Client:
            def __init__(self):
                self.body = None

            async def __aenter__(self):
                return self

            async def __aexit__(self, *_args):
                return False

            async def post(self, _url, headers=None, json=None):
                self.body = json
                return Response()

        client = Client()
        payload = main.RunningHubWorkflowSubmitRequest(
            workflowId=page_url,
            instanceType="ultra",
            nodeInfoList=[{"nodeId": "1", "fieldName": "prompt", "fieldValue": "test"}],
        )
        with patch.object(main, "runninghub_provider", return_value={}), \
             patch.object(main, "runninghub_api_key", return_value="test-key"), \
             patch.object(main, "runninghub_endpoint_url", return_value="https://runninghub.invalid/task/openapi/create"), \
             patch.object(main, "runninghub_app_headers", return_value={}), \
             patch.object(main.httpx, "AsyncClient", return_value=client):
            result = asyncio.run(main.runninghub_workflow_submit(payload))

        self.assertEqual(result["data"]["taskId"], "task-1")
        self.assertEqual(client.body["workflowId"], self.workflow_id)
        self.assertEqual(client.body["instanceType"], "ultra")
        self.assertEqual(client.body["nodeInfoList"][0]["fieldName"], "prompt")


if __name__ == "__main__":
    unittest.main()
