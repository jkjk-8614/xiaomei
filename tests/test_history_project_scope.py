import asyncio
import json
import os
import tempfile
import unittest
from unittest import mock

import main


class HistoryProjectScopeTests(unittest.TestCase):
    def test_manager_filters_explicit_and_legacy_canvas_records_by_project(self):
        with tempfile.TemporaryDirectory(prefix="history-project-scope-") as root:
            history_path = os.path.join(root, "history.json")
            canvas_dir = os.path.join(root, "canvases")
            os.makedirs(canvas_dir, exist_ok=True)
            with open(os.path.join(canvas_dir, "canvas-one.json"), "w", encoding="utf-8") as handle:
                json.dump(
                    {
                        "id": "canvas-one",
                        "project": "project-one",
                        "nodes": [{"type": "image", "url": "/api/storage-files/generated/project-one.png"}],
                    },
                    handle,
                )
            with open(history_path, "w", encoding="utf-8") as handle:
                json.dump(
                    [
                        {
                            "timestamp": 2,
                            "prompt": "legacy project image",
                            "images": ["/api/storage-files/generated/project-one.png"],
                            "type": "online",
                            "history_source": "canvas",
                        },
                        {
                            "timestamp": 1,
                            "prompt": "explicit project image",
                            "images": ["/api/storage-files/generated/project-two.png"],
                            "type": "online",
                            "history_source": "canvas",
                            "project_id": "project-two",
                        },
                    ],
                    handle,
                )

            with mock.patch.multiple(main, HISTORY_FILE=history_path, CANVAS_DIR=canvas_dir):
                all_rows = asyncio.run(main.get_history_api(view="manager"))
                project_one_rows = asyncio.run(
                    main.get_history_api(view="manager", project_id="project-one")
                )
                project_two_rows = asyncio.run(
                    main.get_history_api(view="manager", project_id="project-two")
                )

            self.assertEqual([row["prompt"] for row in all_rows], [
                "legacy project image",
                "explicit project image",
            ])
            self.assertEqual([row["prompt"] for row in project_one_rows], ["legacy project image"])
            self.assertEqual([row["prompt"] for row in project_two_rows], ["explicit project image"])
            self.assertEqual(project_one_rows[0]["project_id"], "project-one")
            self.assertEqual(project_two_rows[0]["project_id"], "project-two")

    def test_comfyui_records_are_classified_as_comfyui_even_with_legacy_canvas_source(self):
        with tempfile.TemporaryDirectory(prefix="history-comfyui-source-") as root:
            history_path = os.path.join(root, "history.json")
            with open(history_path, "w", encoding="utf-8") as handle:
                json.dump(
                    [
                        {
                            "timestamp": 2,
                            "prompt": "comfyui result",
                            "images": ["/api/storage-files/generated/comfyui.png"],
                            "type": "comfy-app",
                            "history_source": "canvas",
                            "project_id": "",
                        }
                    ],
                    handle,
                )

            with mock.patch.multiple(
                main,
                HISTORY_FILE=history_path,
                CANVAS_DIR=os.path.join(root, "canvases"),
            ):
                rows = asyncio.run(main.get_history_api(view="manager"))

            self.assertEqual(rows[0]["history_group"], "comfyui")
            self.assertEqual(rows[0]["history_source"], "comfyui")
            self.assertEqual(main.normalize_history_source("comfy-app"), "comfyui")


if __name__ == "__main__":
    unittest.main()
