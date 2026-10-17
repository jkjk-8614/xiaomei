"""Exercise file operations in isolated Chinese paths without loading user data."""
import ast
import copy
import json
import os
import pathlib
import shutil
import tempfile
import unittest
import urllib.parse
import uuid
from typing import Any, Dict, List

from fastapi import FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.testclient import TestClient

from image_space import replace_ai


MAIN = pathlib.Path(__file__).resolve().parents[1] / "main.py"
FUNCTIONS = {
    "storage_file_path", "_managed_storage_file", "_managed_storage_url",
    "_managed_storage_root", "_managed_storage_target",
    "_managed_storage_folder_location", "_managed_storage_rel_exists",
    "_managed_storage_require_unreferenced", "organize_storage_files",
    "manage_storage_folder", "caption_storage_files", "save_storage_file_caption",
    "classify_storage_files", "upload_generated_storage_files",
    "_storage_folder_order_path", "_storage_folder_orders", "_storage_folder_sort_key",
    "reorder_storage_folders", "_relocate_file_favorites",
}


class StorageFileManagementTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix="素材管理测试-")
        root = pathlib.Path(self.directory.name)
        app = FastAPI()
        records = {}
        blocked = set()
        favorites = {"items": []}
        fail_relocation = set()
        legacy_roots = {}

        def register(url, **kwargs):
            record = records.get(url) or {"id": f"asset_{len(records) + 1}", "kind": kwargs.get("kind") or "image", "metadata": {}}
            record["metadata"].update(kwargs.get("metadata") or {})
            records[url] = record
            return record

        def relocate(old, new):
            if old in fail_relocation:
                raise RuntimeError("模拟索引写入失败")
            record = records.pop(old, None) or register(old)
            records[new] = record
            return record

        def require_unreferenced(ids):
            if set(ids) & blocked:
                raise HTTPException(409, "素材仍被画布引用")

        async def caption(*_args):
            return "中文提示词", "mock-model"

        async def classify(*_args):
            return {"summary": "产品图", "tags": ["商品"], "categories": {"style": ["简约"]}}

        def safe_stem(value):
            return pathlib.Path(str(value or "")).stem.strip() or "素材"

        def safe_folder(value):
            name = str(value or "").strip()
            if not name or "/" in name or "\\" in name or name in {".", ".."}:
                raise HTTPException(400, "文件夹名称无效")
            return name

        def storage_item(kind, base, path):
            rel = pathlib.Path(path).relative_to(base).as_posix()
            return {"id": f"{kind}:{rel}", "rel": rel, "url": f"/api/storage-files/{kind}/{urllib.parse.quote(rel)}"}

        namespace = {
            "app": app, "os": os, "shutil": shutil, "uuid": uuid, "urllib": urllib,
            "json": json, "DATA_DIR": str(root),
            "Any": Any, "Dict": Dict, "List": List, "Request": Request,
            "File": File, "Form": Form, "UploadFile": UploadFile,
            "HTTPException": HTTPException,
            "STORAGE_IMAGE_EXTS": {".png"}, "STORAGE_VIDEO_EXTS": {".mp4"},
            "STORAGE_AUDIO_EXTS": {".mp3"}, "STORAGE_MEDIA_EXTS": {".png", ".mp4", ".mp3"},
            "storage_kind_roots": lambda kind: [str(root / kind)] + ([str(legacy_roots[kind])] if kind in legacy_roots else []),
            "storage_kind_dir": lambda kind: str(root / kind),
            "asset_registry_register_media": register,
            "asset_registry_require_unreferenced_many": require_unreferenced,
            "registry_is_asset_id": lambda value: str(value or "").startswith("asset_"),
            "_asset_registry_relocate_url": relocate,
            "asset_library_media_kind": lambda path: "image" if str(path).endswith(".png") else "video",
            "_local_upload_safe_file_stem": safe_stem,
            "_local_upload_safe_folder_name": safe_folder,
            "ensure_same_origin_request": lambda _request: None,
            "storage_file_item": storage_item,
            "caption_image_with_provider": caption,
            "classify_image_with_provider": classify,
            "image_space_read_generated_classification": lambda path: json.loads(pathlib.Path(path + ".classification.json").read_text(encoding="utf-8")) if pathlib.Path(path + ".classification.json").exists() else None,
            "replace_ai": replace_ai,
            "_normalize_asset_classification_fields": lambda value: value,
            "_atomic_write_json_locked": lambda path, value: pathlib.Path(path).write_text(json.dumps(value, ensure_ascii=False), encoding="utf-8"),
            "_atomic_write_json_file": lambda path, value: pathlib.Path(path).write_text(json.dumps(value, ensure_ascii=False), encoding="utf-8"),
            "_backup_unreadable_data_file": lambda *_args: None,
            "load_asset_favorites": lambda: copy.deepcopy(favorites),
            "save_asset_favorites": lambda value: favorites.update(copy.deepcopy(value)),
        }
        tree = ast.parse(MAIN.read_text(encoding="utf-8"))
        selected = [node for node in tree.body if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node.name in FUNCTIONS]
        self.assertEqual(len(selected), len(FUNCTIONS))
        exec(compile(ast.Module(body=selected, type_ignores=[]), str(MAIN), "exec"), namespace)
        self.root, self.records, self.blocked, self.favorites, self.fail_relocation = root, records, blocked, favorites, fail_relocation
        self.legacy_roots = legacy_roots
        self.client = TestClient(app)

    def tearDown(self):
        self.client.close()
        self.directory.cleanup()

    def test_rename_move_and_sidecars_keep_the_original_until_safe(self):
        upload = self.root / "upload"
        upload.mkdir()
        source = upload / "原图.png"
        source.write_bytes(b"png")
        (upload / "原图.png.classification.json").write_text("{}", encoding="utf-8")
        (upload / "原图.png.caption.txt").write_text("旧提示词", encoding="utf-8")
        created = self.client.post("/api/storage-files/folders", json={"kind": "upload", "action": "create", "name": "产品"})
        self.assertEqual(created.status_code, 200)
        original_url = "/api/storage-files/upload/" + urllib.parse.quote("原图.png")
        self.records[original_url] = {"id": "asset_existing", "kind": "image", "metadata": {"upload_name": "原图.png"}}
        self.favorites["items"].append({"key":"upload:原图.png","kind":"upload","url":original_url,"name":"原图.png","folder":""})
        self.blocked.add("asset_existing")
        conflict = self.client.post("/api/storage-files/organize", json={"kind": "upload", "action": "move", "items": ["原图.png"], "folder": "产品"})
        self.assertEqual(conflict.status_code, 409)
        self.assertTrue(source.exists())
        self.blocked.clear()
        moved = self.client.post("/api/storage-files/organize", json={"kind": "upload", "action": "move", "items": ["原图.png"], "folder": "产品"})
        self.assertEqual(moved.status_code, 200)
        self.assertFalse(source.exists())
        self.assertTrue((upload / "产品" / "原图.png.classification.json").exists())
        self.assertTrue((upload / "产品" / "原图.png.caption.txt").exists())
        self.assertEqual(self.favorites["items"][0]["key"], "upload:产品/原图.png")
        renamed = self.client.post("/api/storage-files/organize", json={"kind": "upload", "action": "rename", "items": ["产品/原图.png"], "name": "新名字.png"})
        self.assertEqual(renamed.status_code, 200)
        self.assertTrue((upload / "产品" / "新名字.png").exists())
        self.assertEqual(self.favorites["items"][0]["key"], "upload:产品/新名字.png")
        self.assertEqual(self.records["/api/storage-files/upload/" + urllib.parse.quote("产品/新名字.png", safe="/")]["metadata"]["upload_name"], "新名字.png")
        folder_rename = self.client.post("/api/storage-files/folders", json={"kind":"upload","action":"rename","folder":"产品","name":"成品"})
        self.assertEqual(folder_rename.status_code, 200)
        self.assertTrue((upload / "成品" / "新名字.png").exists())
        self.assertEqual(self.favorites["items"][0]["key"], "upload:成品/新名字.png")

    def test_generated_upload_caption_classify_and_invalid_path(self):
        uploaded = self.client.post("/api/storage-files/upload", data={"folder": ""}, files={"files": ("商品.png", b"original", "image/png")})
        self.assertEqual(uploaded.status_code, 200)
        rel = uploaded.json()["items"][0]["rel"]
        self.assertEqual((self.root / "generated" / rel).read_bytes(), b"original")
        caption = self.client.post("/api/storage-files/caption", json={"kind": "generated", "items": [rel]})
        self.assertEqual(caption.json()["count"], 1)
        self.assertEqual((self.root / "generated" / (rel + ".caption.txt")).read_text(encoding="utf-8"), "中文提示词")
        saved = self.client.patch("/api/storage-files/caption", json={"kind": "generated", "rel": rel, "caption": "手写提示词"})
        self.assertEqual(saved.status_code, 200)
        classified = self.client.post("/api/storage-files/classify", json={"kind": "generated", "items": [rel]})
        self.assertEqual(classified.json()["count"], 1)
        self.assertEqual(classified.json()["items"][0]["classification"]["tags"], ["商品"])
        invalid = self.client.post("/api/storage-files/organize", json={"kind": "generated", "action": "move", "items": ["../outside.png"], "folder": ""})
        self.assertEqual(invalid.status_code, 400)

    def test_folder_order_is_validated_and_persists_for_both_sources(self):
        for kind in ("upload", "generated"):
            root = self.root / kind
            (root / "甲").mkdir(parents=True)
            (root / "乙").mkdir()
            ordered = self.client.post("/api/storage-files/folders/reorder", json={"kind": kind, "parent": "", "paths": ["乙", "甲"]})
            self.assertEqual(ordered.status_code, 200)
            saved = json.loads((self.root / f"{kind}_asset_folder_order.json").read_text(encoding="utf-8"))
            self.assertEqual(saved[""], ["乙", "甲"])
            invalid = self.client.post("/api/storage-files/folders/reorder", json={"kind": kind, "parent": "", "paths": ["乙", "缺失"]})
            self.assertEqual(invalid.status_code, 409)
            self.assertEqual(self.client.post("/api/storage-files/folders/reorder", json={"kind": kind, "parent": "", "paths": ["../乙", "甲"]}).status_code, 400)

    def test_batch_move_rolls_back_files_and_index_when_one_fails(self):
        root = self.root / "generated"
        target = root / "目标"
        target.mkdir(parents=True)
        for name in ("甲.png", "乙.png"):
            (root / name).write_bytes(b"image")
            (root / (name + ".caption.txt")).write_text(name, encoding="utf-8")
        self.fail_relocation.add("/api/storage-files/generated/" + urllib.parse.quote("乙.png"))
        with self.assertRaises(RuntimeError):
            self.client.post("/api/storage-files/organize", json={"kind":"generated","action":"move","items":["甲.png","乙.png"],"folder":"目标"})
        for name in ("甲.png", "乙.png"):
            self.assertTrue((root / name).exists())
            self.assertTrue((root / (name + ".caption.txt")).exists())
            self.assertFalse((target / name).exists())
            self.assertIn("/api/storage-files/generated/" + urllib.parse.quote(name), self.records)

    def test_legacy_folder_management_and_merged_order(self):
        for kind in ("upload", "generated"):
            current = self.root / kind
            legacy = self.root / f"旧目录-{kind}"
            (current / "当前").mkdir(parents=True)
            (legacy / "旧分类").mkdir(parents=True)
            self.legacy_roots[kind] = legacy
            source = legacy / "旧分类" / "商品.png"
            source.write_bytes(b"image")
            (legacy / "旧分类" / "商品.png.caption.txt").write_text("中文描述", encoding="utf-8")
            created = self.client.post("/api/storage-files/folders", json={"kind": kind, "action": "create", "folder": "旧分类", "name": "子文件夹"})
            self.assertEqual(created.status_code, 200, created.text)
            self.assertTrue((legacy / "旧分类" / "子文件夹").is_dir())
            ordered = self.client.post("/api/storage-files/folders/reorder", json={"kind": kind, "parent": "", "paths": ["旧分类", "当前"]})
            self.assertEqual(ordered.status_code, 200, ordered.text)
            (current / "已占用").mkdir()
            conflict = self.client.post("/api/storage-files/folders", json={"kind": kind, "action": "rename", "folder": "旧分类", "name": "已占用"})
            self.assertEqual(conflict.status_code, 409)
            self.assertTrue(source.exists())
            (current / "已占用").rmdir()
            renamed = self.client.post("/api/storage-files/folders", json={"kind": kind, "action": "rename", "folder": "旧分类", "name": "旧分类改名"})
            self.assertEqual(renamed.status_code, 200, renamed.text)
            self.assertTrue((legacy / "旧分类改名" / "商品.png").exists())
            self.assertTrue((legacy / "旧分类改名" / "商品.png.caption.txt").exists())
            self.assertEqual(json.loads((self.root / f"{kind}_asset_folder_order.json").read_text(encoding="utf-8"))[""], ["旧分类改名", "当前"])
            deleted = self.client.post("/api/storage-files/folders", json={"kind": kind, "action": "delete", "folder": "旧分类改名/子文件夹"})
            self.assertEqual(deleted.status_code, 200, deleted.text)
            self.assertFalse((legacy / "旧分类改名" / "子文件夹").exists())
            orphan = legacy / "旧分类改名" / "孤立.png.caption.txt"
            orphan.write_text("保留", encoding="utf-8")
            blocked = self.client.post("/api/storage-files/folders", json={"kind": kind, "action": "delete", "folder": "旧分类改名"})
            self.assertEqual(blocked.status_code, 409)
            self.assertTrue((legacy / "旧分类改名" / "商品.png").exists())
            self.assertTrue(orphan.exists())

    def test_legacy_move_avoids_hidden_name_and_folder_collisions(self):
        current = self.root / "generated"
        legacy = self.root / "旧生成素材"
        (current / "目标").mkdir(parents=True)
        (legacy / "目标").mkdir(parents=True)
        self.legacy_roots["generated"] = legacy
        (legacy / "商品.png").write_bytes(b"image")
        (legacy / "根目录.png").write_bytes(b"image")
        (legacy / "目标" / "商品.png").write_bytes(b"existing")
        no_op = self.client.post("/api/storage-files/organize", json={"kind": "generated", "action": "move", "items": ["根目录.png"], "folder": ""})
        self.assertEqual(no_op.status_code, 200, no_op.text)
        self.assertEqual(no_op.json()["moved"], 0)
        self.assertTrue((legacy / "根目录.png").exists())
        moved = self.client.post("/api/storage-files/organize", json={"kind": "generated", "action": "move", "items": ["商品.png"], "folder": "目标"})
        self.assertEqual(moved.status_code, 200, moved.text)
        new_rel = moved.json()["items"][0]["to"]
        self.assertNotEqual(new_rel, "目标/商品.png")
        self.assertTrue((current / new_rel).exists())
        self.assertEqual((legacy / "目标" / "商品.png").read_bytes(), b"existing")
        conflict = self.client.post("/api/storage-files/folders", json={"kind": "generated", "action": "rename", "folder": "目标", "name": "其他"})
        self.assertEqual(conflict.status_code, 409)

    def test_generated_upload_uses_legacy_folder(self):
        legacy = self.root / "旧生成素材"
        (legacy / "中文文件夹").mkdir(parents=True)
        self.legacy_roots["generated"] = legacy
        uploaded = self.client.post("/api/storage-files/upload", data={"folder": "中文文件夹"}, files={"files": ("新品.png", b"image", "image/png")})
        self.assertEqual(uploaded.status_code, 200, uploaded.text)
        self.assertTrue((legacy / "中文文件夹" / "新品.png").exists())


if __name__ == "__main__":
    unittest.main()
