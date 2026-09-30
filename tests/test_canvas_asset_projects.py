"""Canvas asset indexing keeps each asset tied to its existing project."""

import ast
import hashlib
import json
import os
from pathlib import Path
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[1]
FUNCTIONS = {
    "normalize_canvas_kind", "normalize_canvas_color", "canvas_record",
    "project_record", "canvas_node_title", "extract_canvas_assets", "canvas_assets_index",
}


class CanvasAssetProjectTests(unittest.TestCase):
    def test_assets_follow_canvas_projects_and_project_names(self):
        with tempfile.TemporaryDirectory() as directory:
            canvas_dir = Path(directory)
            fixtures = [
                ("frame", "smart", "default", "/assets/frame.png", False),
                ("wedding", "smart", "wedding", "/assets/wedding.png", False),
                ("classic", "classic", "wedding", "/assets/classic.png", False),
                ("deleted", "smart", "wedding", "/assets/deleted.png", True),
            ]
            for canvas_id, kind, project, url, deleted in fixtures:
                (canvas_dir / f"{canvas_id}.json").write_text(json.dumps({
                    "id": canvas_id, "title": canvas_id, "kind": kind,
                    "project": project, "deleted_at": 1 if deleted else 0,
                    "nodes": [{"id": "image", "type": "image", "url": url}],
                }), encoding="utf-8")
            tree = ast.parse((ROOT / "main.py").read_text(encoding="utf-8"))
            selected = [node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name in FUNCTIONS]
            self.assertEqual(len(selected), len(FUNCTIONS))
            namespace = {
                "os": os, "json": json, "hashlib": hashlib,
                "CANVAS_DIR": str(canvas_dir), "DEFAULT_PROJECT_ID": "default",
                "CANVAS_COLORS": {"", "red", "blue"},
                "cleanup_expired_canvas_trash": lambda: None,
                "load_projects": lambda: [
                    {"id": "wedding", "name": "婚纱相框", "order": 1},
                    {"id": "default", "name": "水晶相框", "order": 0},
                ],
                "iter_canvas_asset_values": lambda node: [("url", node["url"], node["url"])],
                "canvas_asset_kind": lambda raw, url: "image",
                "canvas_asset_name": lambda raw, url, fallback: url.rsplit("/", 1)[-1],
                "_asset_registry_canvas_asset_id": lambda canvas, raw, url: "asset-id",
            }
            exec(compile(ast.Module(body=selected, type_ignores=[]), str(ROOT / "main.py"), "exec"), namespace)

            indexed = namespace["canvas_assets_index"]()
            self.assertEqual([project["name"] for project in indexed["projects"]], ["水晶相框", "婚纱相框"])
            self.assertEqual({canvas["id"]: canvas["project"] for canvas in indexed["canvases"]},
                             {"frame": "default", "wedding": "wedding", "classic": "wedding"})
            self.assertEqual({item["canvas_id"]: item["project"] for item in indexed["items"]},
                             {"frame": "default", "wedding": "wedding", "classic": "wedding"})
            self.assertEqual(next(cat["count"] for cat in indexed["categories"] if cat["id"] == "smart"), 2)


if __name__ == "__main__":
    unittest.main()
