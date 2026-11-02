import asyncio
import json
import os
import tempfile
import unittest
from contextlib import ExitStack
from pathlib import Path
from unittest.mock import patch

import main


class CommerceSnapshotPathTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="小美商品采集-")
        self.addCleanup(self.temp.cleanup)
        self.patches = ExitStack()
        self.addCleanup(self.patches.close)
        root = Path(self.temp.name)
        self.runtime = root / "用户数据"
        self.project = root / "程序目录"
        # Windows 上固定使用另一个盘符，覆盖安装目录与用户目录跨盘的实际场景。
        if os.name == "nt":
            self.project = Path("Z:/小美画布安装目录" if root.drive.upper() != "Z:" else "Y:/小美画布安装目录")
        self.snapshots = self.runtime / "data" / "commerce_analysis" / "snapshots"
        for key, value in {
            "PROJECT_ROOT": str(self.project),
            "RUNTIME_ROOT": str(self.runtime),
            "COMMERCE_ANALYSIS_DATA_DIR": str(self.snapshots.parent),
            "COMMERCE_ANALYSIS_SNAPSHOT_DIR": str(self.snapshots),
            "COMMERCE_ANALYSIS_DB_FILE": str(self.snapshots.parent / "analysis.sqlite3"),
        }.items():
            self.patches.enter_context(patch.object(main, key, value))
        self.prewarm = self.patches.enter_context(patch.object(main, "_commerce_analysis_schedule_detail_cache_prewarm"))
        self.url = "https://detail.tmall.com/item.htm?id=123456789"

    def import_snapshot(self, data):
        return asyncio.run(main.commerce_analysis_import_result(main.CommerceAnalysisImportRequest(
            url=self.url, data={"backend": "electron", **data}, filename="electron-commerce-network.json",
        )))

    def test_cross_drive_import_persists_resources_and_completed_job(self):
        result = self.import_snapshot({
            "ok": True,
            "source": "electron-commerce-network",
            "product": {"id": "123456789", "title": "创意照片定制拼贴相框"},
            "mainImages": ["https://example.com/main.jpg"],
            "detail": {"images": ["https://example.com/detail.jpg"]},
            "collection": {"requestedModule": "base"},
        })
        self.assertIn(result["status"], {"ready", "partial"})
        resources = {item["id"]: item for item in result["resources"]}
        self.assertEqual(resources["product"]["status"], "ready")
        self.assertEqual(resources["images"]["status"], "ready")
        snapshot = Path(result["collection"]["snapshotPath"])
        self.assertTrue(snapshot.is_absolute())
        self.assertEqual(snapshot.parent.parent, self.snapshots)
        self.assertEqual(json.loads(snapshot.read_text(encoding="utf-8"))["product"]["title"], "创意照片定制拼贴相框")
        self.assertTrue(snapshot.with_name("collection.json").is_file())
        job = main._commerce_analysis_get_job(result["jobId"])
        self.assertIn(job["status"], {"ready", "partial"})
        self.assertEqual(job["stage"], "completed")
        self.assertEqual(job["result"]["product"]["title"], "创意照片定制拼贴相框")
        self.prewarm.assert_called_once()

    def test_cross_drive_auth_snapshot_preserves_failure_state(self):
        result = self.import_snapshot({
            "ok": False, "status": "login_required", "message": "请在商品页完成登录",
        })
        self.assertEqual(result["status"], "login_required")
        self.assertTrue(Path(result["collection"]["snapshotPath"]).is_file())
        job = main._commerce_analysis_get_job(result["jobId"])
        self.assertEqual(job["stage"], "completed")
        self.assertEqual(job["result"]["status"], "login_required")
        self.prewarm.assert_not_called()

    def test_title_recovery_reads_absolute_and_legacy_relative_snapshots(self):
        # 已有记录保留相对安装目录的路径，读取逻辑也应接受新写入的绝对路径。
        local_project = Path(self.temp.name) / "旧程序目录"
        collection_dir = local_project / "data" / "commerce_analysis" / "snapshots" / "old-job"
        collection_dir.mkdir(parents=True)
        (collection_dir / "collection.json").write_text(
            json.dumps({"import": {"collection": {"title": "测试相框"}}}, ensure_ascii=False), encoding="utf-8",
        )
        for snapshot_path in [
            str(collection_dir / "snapshot.json"),
            "data/commerce_analysis/snapshots/old-job/snapshot.json",
        ]:
            with self.subTest(path=snapshot_path), patch.object(main, "PROJECT_ROOT", str(local_project)):
                job = main._commerce_analysis_row_to_job({
                    "id": "old-job", "url": self.url,
                    "result_json": json.dumps({
                        "product": {"id": "123456789", "title": "图文详情"},
                        "collection": {"snapshotPath": snapshot_path},
                    }),
                })
                self.assertEqual(job["result"]["product"]["title"], "测试相框")


if __name__ == "__main__":
    unittest.main()
