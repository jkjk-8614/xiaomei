"""Upload directory files are classified from canvas references and saved scope metadata."""

import ast
import os
import pathlib
import unittest
import urllib.parse


ROOT = pathlib.Path(__file__).resolve().parents[1]


class UploadAssetScopeTests(unittest.TestCase):
    def test_aliases_shared_canvas_refs_and_unassigned_count(self):
        tree = ast.parse((ROOT / "main.py").read_text(encoding="utf-8"))
        names = {"upload_media_key", "prepare_upload_scopes"}
        selected = [node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name in names]
        self.assertEqual(len(selected), len(names))
        namespace = {"os": os, "urllib": urllib}
        exec(compile(ast.Module(body=selected, type_ignores=[]), str(ROOT / "main.py"), "exec"), namespace)

        upload_media_key = namespace["upload_media_key"]
        prepare_upload_scopes = namespace["prepare_upload_scopes"]
        self.assertEqual(upload_media_key("/assets/input/ai_ref_a%20b.png?cache=1"), "ai_ref_a b.png")
        self.assertEqual(upload_media_key("http://127.0.0.1:3000/output/input/ai_ref_a%20b.png"), "ai_ref_a b.png")
        self.assertEqual(upload_media_key("https://cdn.example.com/ai_ref_a.png"), "")

        index = {
            "projects": [
                {"id": "p1", "name": "项目一"},
                {"id": "p2", "name": "项目二"},
            ],
            "canvases": [
                {"id": "c1", "project": "p1", "title": "画布一"},
                {"id": "c2", "project": "p2", "title": "画布二"},
            ],
            "by_file": {
                "shared.png": [
                    {"project_id": "p1", "canvas_id": "c1", "canvas_title": "画布一"},
                    {"project_id": "p2", "canvas_id": "c2", "canvas_title": "画布二"},
                ],
            },
        }
        items = [
            {"url": "/api/storage-files/upload/shared.png", "upload_project_id": "", "upload_canvas_id": ""},
            {"url": "/api/storage-files/upload/manual.png", "upload_project_id": "p1", "upload_canvas_id": ""},
            {"url": "/api/storage-files/upload/orphan.png", "upload_project_id": "", "upload_canvas_id": ""},
        ]
        scopes = prepare_upload_scopes(items, index)
        self.assertEqual(items[0]["project_ids"], ["p1", "p2"])
        self.assertEqual(items[0]["canvas_ids"], ["c1", "c2"])
        self.assertEqual(items[1]["project_ids"], ["p1"])
        self.assertEqual(scopes["unassigned_count"], 1)
        self.assertEqual({item["id"]: item["count"] for item in scopes["projects"]}, {"p1": 2, "p2": 1})
        self.assertEqual({item["count"] for item in scopes["canvases"]}, {1, 1})


if __name__ == "__main__":
    unittest.main()
