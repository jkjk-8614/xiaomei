import asyncio
import tempfile
import unittest
from pathlib import Path

import main
from fastapi import HTTPException


class MerchantAgentLedgerTests(unittest.TestCase):
    def setUp(self):
        self.tempdir = tempfile.TemporaryDirectory()
        root = Path(self.tempdir.name)
        self.originals = {
            "data": main.COMMERCE_ANALYSIS_DATA_DIR,
            "snapshot": main.COMMERCE_ANALYSIS_SNAPSHOT_DIR,
            "db": main.COMMERCE_ANALYSIS_DB_FILE,
        }
        main.COMMERCE_ANALYSIS_DATA_DIR = str(root / "commerce_analysis")
        main.COMMERCE_ANALYSIS_SNAPSHOT_DIR = str(root / "commerce_analysis" / "snapshots")
        main.COMMERCE_ANALYSIS_DB_FILE = str(root / "commerce_analysis" / "analysis.sqlite3")
        job = main._commerce_analysis_create_job("https://item.taobao.com/item.htm?id=10001", browser=False)
        self.job_id = job["id"]
        self.snapshot = {
            "status": "ready",
            "product": {
                "id": "10001",
                "title": "测试保温杯",
                "price": "99",
                "description": "不锈钢保温杯",
            },
            "metrics": {"rating": "4.9", "reviewCount": "120"},
            "mainImages": ["https://example.com/product.jpg"],
            "reviews": [{"content": "保温效果好"}],
            "moduleStatus": {"product": {"status": "ready"}, "images": {"status": "ready"}},
        }
        main._commerce_analysis_update_job(
            self.job_id,
            status="ready",
            stage="done",
            result_json=main._commerce_analysis_json(self.snapshot),
        )

    def tearDown(self):
        main.COMMERCE_ANALYSIS_DATA_DIR = self.originals["data"]
        main.COMMERCE_ANALYSIS_SNAPSHOT_DIR = self.originals["snapshot"]
        main.COMMERCE_ANALYSIS_DB_FILE = self.originals["db"]
        self.tempdir.cleanup()

    def session(self, resources=None):
        return {
            "conversation_id": "conversation-test",
            "read_job_ids": {self.job_id},
            "job_resource_scopes": {self.job_id: set(resources or {"product", "images"})},
        }

    def visual_proposal(self):
        return {
            "kind": "visual_plan",
            "job_id": self.job_id,
            "proposal": {
                "workflow": "detail",
                "title": "保温杯主图方案",
                "summary": "突出保温与容量",
                "segments": [{"title": "首图", "purpose": "突出核心卖点", "prompt": "白底保温杯，突出 12 小时保温"}],
            },
        }

    def test_stage_approve_apply_uses_a_pending_ledger_first(self):
        change = main._merchant_stage_change(self.session(), self.visual_proposal())

        self.assertEqual(change["status"], "pending")
        self.assertEqual(change["kind"], "visual_plan")
        self.assertTrue(change["evidence"])
        self.assertTrue(change["after"]["segments"])

        change = main._merchant_update_change(change["id"], status="approved", approved_at=main._commerce_analysis_now())
        result = main._merchant_apply_change(change)

        self.assertEqual(result["change"]["status"], "applied")
        self.assertEqual(result["handoff"]["change_id"], change["id"])
        self.assertEqual(result["handoff"]["target"], "commerce")

    def test_snapshot_change_invalidates_an_old_approval(self):
        change = main._merchant_stage_change(self.session(), self.visual_proposal())
        change = main._merchant_update_change(change["id"], status="approved", approved_at=main._commerce_analysis_now())

        updated_snapshot = dict(self.snapshot)
        updated_product = dict(self.snapshot["product"])
        updated_product["title"] = "测试保温杯（新款）"
        updated_snapshot["product"] = updated_product
        main._commerce_analysis_update_job(self.job_id, result_json=main._commerce_analysis_json(updated_snapshot))

        self.assertEqual(main._merchant_get_change(change["id"])["status"], "pending")

        with self.assertRaises(HTTPException) as caught:
            main._merchant_apply_change(change)
        self.assertEqual(caught.exception.status_code, 409)
        refreshed = main._merchant_get_change(change["id"])
        self.assertEqual(refreshed["status"], "pending")

    def test_resource_tool_cannot_expand_the_session_scope(self):
        session = self.session({"product"})
        with self.assertRaises(HTTPException) as caught:
            asyncio.run(
                main._merchant_tool_get_product_resources(
                    session,
                    {"job_id": self.job_id, "resource_ids": ["images"]},
                )
            )
        self.assertEqual(caught.exception.status_code, 403)


if __name__ == "__main__":
    unittest.main()
