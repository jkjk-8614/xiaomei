import asyncio
import copy
import json
import tempfile
import time
import unittest
from pathlib import Path
from unittest import mock

import main


class GenerationReliabilityTests(unittest.TestCase):
    def test_partial_batch_keeps_successes_and_records_failure(self):
        async def scenario():
            calls = 0

            async def generate(*args):
                nonlocal calls
                calls += 1
                number = calls
                await asyncio.sleep(0)
                if number == 2:
                    raise main.HTTPException(status_code=502, detail="one image failed")
                return {"url": f"image-{number}"}, {"task_id": f"upstream-{number}"}

            async def save(item, **kwargs):
                return item["url"]

            with mock.patch.multiple(
                main,
                get_api_provider=lambda _: {"id": "test", "image_models": ["test-image"]},
                generate_ai_image=generate,
                extract_images=lambda raw: [{"url": raw["task_id"]}],
                save_ai_image_to_output=save,
                image_output_meta=lambda url, _: {"url": url},
                preserve_outpaint_centers=mock.AsyncMock(side_effect=lambda urls, items, _: (urls, items)),
                save_to_history=mock.Mock(),
                GLOBAL_LOOP=None,
            ):
                result = await main.build_online_image_result(main.OnlineImageRequest(prompt="test", n=3))
                self.assertEqual(result["images"], ["upstream-1", "upstream-3"])
                self.assertEqual(result["partial_failures"][0]["error"], "one image failed")
                main.save_to_history.assert_called_once_with(result)

        asyncio.run(scenario())

    def test_upstream_id_is_persisted_before_poll_and_survives_restart(self):
        async def scenario():
            with tempfile.TemporaryDirectory(prefix="generation-recovery-") as root:
                journal = Path(root) / "tasks.json"
                with mock.patch.multiple(main, DATA_DIR=root, CANVAS_TASKS_FILE=str(journal), CANVAS_TASKS={}):
                    main.add_canvas_task("local", {"id": "local", "status": "running", "created_at": time.time()})

                    async def fetch(*args):
                        stored = json.loads(journal.read_text(encoding="utf-8"))["tasks"]["local"]
                        self.assertEqual(stored["upstream_task_id"], "upstream")
                        raise main.httpx.ConnectError("connection lost")

                    callback_token = main.IMAGE_TASK_UPSTREAM_CALLBACK.set(
                        lambda value: main.update_canvas_task("local", {"upstream_task_id": value})
                    )
                    try:
                        with mock.patch.object(main, "fetch_image_task_payload", fetch):
                            with self.assertRaises(main.httpx.ConnectError):
                                await main.wait_for_image_task(None, "upstream", {"id": "test"})
                    finally:
                        main.IMAGE_TASK_UPSTREAM_CALLBACK.reset(callback_token)
                    main.load_canvas_task_store()
                    restored = main.CANVAS_TASKS["local"]
                    self.assertEqual(restored["upstream_task_id"], "upstream")
                    self.assertEqual(restored["status"], "failed")
                    self.assertIn("请勿重复生成", restored["error"])

        asyncio.run(scenario())

    def test_long_asset_operation_preserves_upload_delete_rename_and_move(self):
        old = main.default_asset_library()
        category = old["libraries"][0]["categories"][0]
        category["items"] = [{"id": "deleted"}, {"id": "moved", "name": "old"}]
        incoming = copy.deepcopy(old)
        added = {"id": "derived"}
        incoming["libraries"][0]["categories"][0]["items"].append(added)
        latest = copy.deepcopy(old)
        latest["libraries"][0]["categories"][0]["name"] = "renamed"
        latest["libraries"][0]["categories"][0]["items"] = [{"id": "uploaded"}]
        latest["libraries"][0]["categories"][1]["items"] = [{"id": "moved", "name": "renamed image"}]

        with tempfile.TemporaryDirectory(prefix="asset-concurrency-") as root:
            target = Path(root) / "library.json"
            target.write_text(json.dumps(latest), encoding="utf-8")
            with mock.patch.multiple(main, ASSET_LIBRARY_PATH=str(target), GLOBAL_LOOP=None):
                main.save_asset_library(incoming, merge_items=[added])
            saved = json.loads(target.read_text(encoding="utf-8"))
        cats = saved["libraries"][0]["categories"]
        self.assertEqual(cats[0]["name"], "renamed")
        self.assertEqual({item["id"] for item in cats[0]["items"]}, {"uploaded", "derived"})
        self.assertEqual([(item["id"], item["name"]) for item in cats[1]["items"]], [("moved", "renamed image")])
        self.assertEqual(incoming["libraries"], saved["libraries"])

    def test_removed_destination_is_not_recreated(self):
        incoming = main.default_asset_library()
        added = {"id": "derived"}
        incoming["libraries"][0]["categories"][0]["items"].append(added)
        latest = main.default_asset_library()
        latest["libraries"][0]["categories"].pop(0)
        merged = main._merge_asset_library_additions(latest, incoming, [added])
        self.assertNotIn("characters", [cat["id"] for cat in merged["libraries"][0]["categories"]])

    def test_history_cache_refreshes_after_atomic_write(self):
        with tempfile.TemporaryDirectory(prefix="history-cache-") as root:
            target = Path(root) / "history.json"
            with mock.patch.object(main, "HISTORY_FILE", str(target)):
                main._write_history_file_locked([{"images": ["first"]}])
                self.assertEqual(main._read_history_api_rows()[0]["images"], ["first"])
                main._write_history_file_locked([{"images": ["second"]}])
                self.assertEqual(main._read_history_api_rows()[0]["images"], ["second"])


if __name__ == "__main__":
    unittest.main()
