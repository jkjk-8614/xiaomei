import json
import sqlite3
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from runtime_paths import (
    migrate_legacy_data,
    migrate_pending_bulk_data,
    repair_orphan_projects,
)


def write_json(path: Path, payload) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")


def read_json(path: Path):
    return json.loads(path.read_text(encoding="utf-8-sig"))


class LegacyMigrationTest(unittest.TestCase):
    def test_nested_legacy_data_is_flattened_and_merged(self):
        with tempfile.TemporaryDirectory() as folder:
            install = Path(folder) / "installed app" / "resources" / "app"
            data_root = Path(folder) / "user data"
            install.mkdir(parents=True)

            # The old broken copy left a second data layer.
            write_json(install / "data" / "data" / "canvases" / "c1.json", {
                "id": "c1", "title": "旧画布", "project": "old-project", "nodes": [1, 2],
            })
            write_json(install / "data" / "data" / "projects.json", {
                "projects": [
                    {"id": "default", "name": "旧默认", "order": 0},
                    {"id": "old-project", "name": "旧项目", "order": 1},
                ],
            })
            write_json(install / "data" / "data" / "api_providers.json", [
                {
                    "id": "custom-api",
                    "name": "旧平台名",
                    "base_url": "https://old.example/v1",
                    "protocol": "openai",
                    "image_models": ["old-image-model"],
                    "chat_models": ["old-chat-model"],
                    "model_names": {"old-chat-model": "旧模型"},
                },
                {"id": "source-only", "name": "仅旧版", "protocol": "openai"},
            ])
            write_json(install / "data" / "data" / "api_key_profiles.json", {
                "version": 1,
                "providers": {
                    "custom-api": {
                        "active_id": "old-key",
                        "profiles": [
                            {"id": "old-key", "name": "旧账号"},
                            {"id": "target-wins", "name": "不应覆盖"},
                        ],
                    },
                },
            })
            (install / "API").mkdir(parents=True)
            (install / "API" / ".env").write_text(
                "OLD_KEY=legacy\nSHARED_KEY=legacy-value\nFIXED_KEY=legacy-overwrite\n",
                encoding="utf-8",
            )
            write_json(install / "history.json", [
                {"id": "legacy-history", "url": "/output/old.png"},
            ])
            # A first-level canvas must survive too.
            write_json(install / "data" / "canvases" / "c2.json", {
                "id": "c2", "title": "一层画布", "project": "default",
            })

            # The new installation already has a default project and an empty
            # provider entry for the same provider, which is what made the old
            # model list invisible.
            write_json(data_root / "data" / "projects.json", {
                "projects": [
                    {"id": "default", "name": "现在的默认项目", "order": 0},
                ],
            })
            write_json(data_root / "data" / "api_providers.json", [
                {
                    "id": "custom-api",
                    "name": "现在的平台名",
                    "enabled": False,
                    "image_models": [],
                    "chat_models": [],
                },
            ])
            write_json(data_root / "data" / "api_key_profiles.json", {
                "version": 1,
                "providers": {
                    "custom-api": {
                        "active_id": "target-key",
                        "profiles": [{"id": "target-wins", "name": "现在账号"}],
                    },
                },
            })
            (data_root / "API").mkdir(parents=True)
            (data_root / "API" / ".env").write_text(
                "SHARED_KEY=\nFIXED_KEY=current-value\nOTHER_KEY=keep\n",
                encoding="utf-8",
            )
            write_json(data_root / "history.json", [
                {"id": "current-history", "url": "/output/new.png"},
            ])
            # Simulate a nested target left by the old migration as well.
            write_json(data_root / "data" / "data" / "canvases" / "target-nested.json", {
                "id": "target-nested", "title": "目标嵌套画布", "project": "default",
            })

            migrated = migrate_legacy_data(install, data_root)
            self.assertGreater(migrated, 0)

            self.assertTrue((data_root / "data" / "canvases" / "c1.json").is_file())
            self.assertTrue((data_root / "data" / "canvases" / "c2.json").is_file())
            self.assertTrue((data_root / "data" / "canvases" / "target-nested.json").is_file())
            self.assertFalse((data_root / "data" / "data").exists())

            projects = read_json(data_root / "data" / "projects.json")["projects"]
            names = {item["id"]: item["name"] for item in projects}
            self.assertEqual(names["default"], "现在的默认项目")
            self.assertEqual(names["old-project"], "旧项目")

            providers = {item["id"]: item for item in read_json(data_root / "data" / "api_providers.json")}
            self.assertEqual(providers["custom-api"]["name"], "现在的平台名")
            self.assertFalse(providers["custom-api"]["enabled"])
            self.assertEqual(providers["custom-api"]["image_models"], ["old-image-model"])
            self.assertEqual(providers["custom-api"]["chat_models"], ["old-chat-model"])
            self.assertEqual(providers["custom-api"]["model_names"], {"old-chat-model": "旧模型"})
            self.assertEqual(providers["source-only"]["name"], "仅旧版")

            profiles = read_json(data_root / "data" / "api_key_profiles.json")["providers"]["custom-api"]
            self.assertEqual(profiles["active_id"], "target-key")
            self.assertEqual(
                [item["id"] for item in profiles["profiles"]],
                ["target-wins", "old-key"],
                "target profile must win and only the missing legacy profile is appended",
            )

            env_text = (data_root / "API" / ".env").read_text(encoding="utf-8")
            self.assertIn("OLD_KEY=legacy", env_text)
            self.assertIn("SHARED_KEY=legacy-value", env_text)
            self.assertIn("FIXED_KEY=current-value", env_text)
            self.assertNotIn("FIXED_KEY=legacy-overwrite", env_text)
            self.assertIn("OTHER_KEY=keep", env_text)

            history_ids = {item["id"] for item in read_json(data_root / "history.json")}
            self.assertEqual(history_ids, {"current-history", "legacy-history"})

            # A second run must not duplicate records or resurrect data.
            (data_root / "data" / "canvases" / "c1.json").unlink()
            self.assertEqual(migrate_legacy_data(install, data_root), 0)
            self.assertFalse((data_root / "data" / "canvases" / "c1.json").exists())
            self.assertEqual(
                len(read_json(data_root / "data" / "projects.json")["projects"]), 2
            )

    def test_preservation_sibling_and_pointer_are_scanned(self):
        with tempfile.TemporaryDirectory() as folder:
            install_root = Path(folder) / "Programs" / "小美画布"
            install = install_root / "resources" / "app"
            install.mkdir(parents=True)
            data_root = Path(folder) / "LocalAppData" / "小美画布"
            data_root.mkdir(parents=True)

            preserve = install_root.parent / "xiaomei-legacy-data-20261026120000"
            write_json(preserve / "app" / "data" / "canvases" / "saved.json", {
                "id": "saved", "title": "升级前画布", "project": "default",
            })
            write_json(preserve / "app" / "data" / "projects.json", {
                "projects": [{"id": "default", "name": "默认项目", "order": 0}],
            })
            # The installer writes UTF-16LE without a BOM.
            pointer_dir = data_root / ".legacy-install-paths"
            pointer_dir.mkdir(parents=True)
            (pointer_dir / "20261026120000.txt").write_bytes(
                str(preserve).encode("utf-16-le")
            )

            migrate_legacy_data(install, data_root)
            self.assertTrue((data_root / "data" / "canvases" / "saved.json").is_file())

    def test_nested_and_first_level_collections_are_both_merged(self):
        with tempfile.TemporaryDirectory() as folder:
            install = Path(folder) / "install"
            data_root = Path(folder) / "data root"
            install.mkdir()
            write_json(install / "data" / "projects.json", {
                "projects": [{"id": "first", "name": "一层项目", "order": 0}],
            })
            write_json(install / "data" / "data" / "projects.json", {
                "projects": [{"id": "nested", "name": "嵌套项目", "order": 1}],
            })
            write_json(install / "data" / "api_providers.json", [
                {"id": "p", "name": "平台", "image_models": ["first-model"]},
            ])
            write_json(install / "data" / "data" / "api_providers.json", [
                {
                    "id": "p",
                    "chat_models": ["nested-chat"],
                    "image_models": ["nested-image"],
                },
            ])
            migrate_legacy_data(install, data_root)

            projects = {
                item["id"]: item["name"]
                for item in read_json(data_root / "data" / "projects.json")["projects"]
            }
            self.assertEqual(projects["first"], "一层项目")
            self.assertEqual(projects["nested"], "嵌套项目")

            provider = read_json(data_root / "data" / "api_providers.json")[0]
            self.assertEqual(provider["image_models"], ["first-model", "nested-image"])
            self.assertEqual(provider["chat_models"], ["nested-chat"])

    def test_prompt_favorites_asset_library_and_model_lists_are_merged(self):
        with tempfile.TemporaryDirectory() as folder:
            install = Path(folder) / "install"
            data_root = Path(folder) / "data root"
            install.mkdir()

            write_json(install / "data" / "prompt_libraries.json", {
                "active_library_id": "system",
                "libraries": [
                    {
                        "id": "system",
                        "name": "系统提示词库",
                        "type": "prompt",
                        "readonly": False,
                        "system": True,
                        "categories": [
                            {"id": "custom", "name": "我的"},
                            {"id": "newcat", "name": "新分类"},
                        ],
                        "items": [
                            {
                                "id": "builtin1", "name": "内置模板",
                                "positive": "old-positive", "negative": "",
                                "category": "custom", "favorite": True,
                            },
                            {
                                "id": "user1", "name": "用户模板",
                                "positive": "user-positive",
                                "category": "newcat", "favorite": True,
                            },
                        ],
                    },
                    {
                        "id": "userlib", "name": "我的提示词库", "type": "prompt",
                        "categories": [],
                        "items": [{"id": "u2", "name": "库项", "positive": "x", "favorite": False}],
                    },
                ],
            })
            write_json(data_root / "data" / "prompt_libraries.json", {
                "active_library_id": "system",
                "libraries": [{
                    "id": "system",
                    "name": "现在的系统库",
                    "type": "prompt",
                    "system": True,
                    "categories": [{"id": "custom", "name": "我的分组"}],
                    "items": [{
                        "id": "builtin1", "name": "内置模板",
                        "positive": "new-positive", "negative": "new-negative",
                        "category": "custom", "favorite": False,
                    }],
                }],
            })

            write_json(install / "data" / "prompt_cases.json", {
                "version": 1,
                "categories": [{"id": "pc_new", "name": "新案例组"}],
                "cases": [{
                    "id": "case_old", "title": "旧案例", "category": "pc_new",
                    "favorite": True,
                    "prompt": {"display": "display-old", "request": "request-old"},
                    "variants": [{"url": "/assets/prompt_cases/case_old/a.png", "name": "a"}],
                    "media_mode": "copy", "created_at": 1, "updated_at": 1,
                }],
            })
            write_json(data_root / "data" / "prompt_cases.json", {
                "version": 1,
                "categories": [{"id": "product", "name": "商品主图"}],
                "cases": [],
            })

            write_json(install / "data" / "asset_favorites.json", {
                "version": 1,
                "items": [
                    {"key": "generated:a.png", "name": "旧A", "kind": "generated", "added_at": 1},
                    {"key": "generated:b.png", "name": "B", "kind": "generated", "added_at": 2},
                ],
            })
            write_json(data_root / "data" / "asset_favorites.json", {
                "version": 1,
                "items": [
                    {"key": "generated:a.png", "name": "新A", "kind": "generated", "added_at": 3},
                ],
            })

            write_json(install / "data" / "asset_library.json", {
                "active_library_id": "lib1",
                "libraries": [
                    {
                        "id": "lib1", "name": "素材库", "type": "asset",
                        "categories": [
                            {
                                "id": "cat1", "name": "分组1", "dir": "cat1",
                                "items": [
                                    {"id": "item1", "name": "旧A", "favorite": True},
                                    {"id": "item2", "name": "B", "favorite": False},
                                ],
                            },
                            {
                                "id": "cat2", "name": "分组2", "dir": "cat2",
                                "items": [{"id": "item3", "name": "C"}],
                            },
                        ],
                    },
                    {"id": "lib2", "name": "新库", "type": "asset", "categories": []},
                ],
                "categories": [
                    {"id": "topcat", "name": "顶层组", "items": [{"id": "topitem", "name": "T"}]},
                ],
            })
            write_json(data_root / "data" / "asset_library.json", {
                "active_library_id": "lib1",
                "libraries": [{
                    "id": "lib1", "name": "素材库", "type": "asset",
                    "categories": [{
                        "id": "cat1", "name": "分组1改", "dir": "cat1",
                        "items": [{"id": "item1", "name": "新A", "favorite": False}],
                    }],
                }],
                "categories": [],
            })

            write_json(install / "data" / "api_providers.json", [{
                "id": "p", "name": "P",
                "vision_models": ["vision-model"],
                "model_input_modalities": {"chat-model": ["text", "image"]},
                "model_selection_managed": True,
            }])
            write_json(data_root / "data" / "api_providers.json", [{
                "id": "p", "name": "P",
                "image_models": [], "chat_models": [],
            }])
            write_json(install / "data" / "harness_model_modalities.json", {
                "updatedAt": 1,
                "providers": {"p": {"chat-model": ["text", "image"]}},
            })
            write_json(data_root / "data" / "harness_model_modalities.json", {
                "updatedAt": 2, "providers": {},
            })

            migrate_legacy_data(install, data_root)

            libraries = {
                item["id"]: item
                for item in read_json(data_root / "data" / "prompt_libraries.json")["libraries"]
            }
            system = libraries["system"]
            self.assertEqual(system["name"], "现在的系统库")
            builtin = next(item for item in system["items"] if item["id"] == "builtin1")
            self.assertEqual(builtin["positive"], "new-positive")
            self.assertEqual(builtin["negative"], "new-negative")
            self.assertTrue(builtin["favorite"])
            self.assertEqual(
                {item["id"] for item in system["items"]},
                {"builtin1", "user1"},
            )
            self.assertIn("newcat", {item["id"] for item in system["categories"]})
            self.assertIn("userlib", libraries)
            self.assertTrue(
                next(item for item in system["items"] if item["id"] == "user1")["favorite"]
            )

            cases = read_json(data_root / "data" / "prompt_cases.json")
            self.assertEqual({item["id"] for item in cases["categories"]}, {"product", "pc_new"})
            self.assertEqual([item["id"] for item in cases["cases"]], ["case_old"])
            self.assertTrue(cases["cases"][0]["favorite"])
            self.assertEqual(cases["cases"][0]["category"], "pc_new")

            favorites = read_json(data_root / "data" / "asset_favorites.json")["items"]
            self.assertEqual(
                {item["key"] for item in favorites},
                {"generated:a.png", "generated:b.png"},
            )
            self.assertEqual(
                next(item for item in favorites if item["key"] == "generated:a.png")["name"],
                "新A",
            )

            asset_libraries = {
                item["id"]: item
                for item in read_json(data_root / "data" / "asset_library.json")["libraries"]
            }
            self.assertIn("lib2", asset_libraries)
            cat1 = next(item for item in asset_libraries["lib1"]["categories"] if item["id"] == "cat1")
            self.assertEqual(cat1["name"], "分组1改")
            item1 = next(item for item in cat1["items"] if item["id"] == "item1")
            self.assertEqual(item1["name"], "新A")
            self.assertTrue(item1["favorite"])
            self.assertEqual({item["id"] for item in cat1["items"]}, {"item1", "item2"})
            self.assertEqual(
                {item["id"] for item in asset_libraries["lib1"]["categories"]},
                {"cat1", "cat2"},
            )
            top_categories = read_json(data_root / "data" / "asset_library.json")["categories"]
            self.assertEqual([item["id"] for item in top_categories], ["topcat"])

            provider = read_json(data_root / "data" / "api_providers.json")[0]
            self.assertEqual(provider["vision_models"], ["vision-model"])
            self.assertEqual(provider["model_input_modalities"], {"chat-model": ["text", "image"]})
            self.assertTrue(provider["model_selection_managed"])
            modalities = read_json(data_root / "data" / "harness_model_modalities.json")
            self.assertEqual(modalities["providers"]["p"]["chat-model"], ["text", "image"])

    def test_inspiration_catalog_favorites_are_merged(self):
        with tempfile.TemporaryDirectory() as folder:
            install = Path(folder) / "install"
            data_root = Path(folder) / "data root"
            source_db = install / "data" / "inspiration_library.sqlite3"
            target_db = data_root / "data" / "inspiration_library.sqlite3"
            source_db.parent.mkdir(parents=True)
            target_db.parent.mkdir(parents=True)
            schema = (
                "CREATE TABLE cases ("
                "id TEXT PRIMARY KEY, title TEXT NOT NULL, favorite INTEGER NOT NULL DEFAULT 0"
                ")"
            )
            connection = sqlite3.connect(source_db)
            try:
                connection.execute(schema)
                connection.executemany(
                    "INSERT INTO cases (id, title, favorite) VALUES (?, ?, ?)",
                    [("same", "旧标题", 1), ("legacy-only", "旧收藏", 1)],
                )
                connection.commit()
            finally:
                connection.close()
            connection = sqlite3.connect(target_db)
            try:
                connection.execute(schema)
                connection.execute(
                    "INSERT INTO cases (id, title, favorite) VALUES (?, ?, ?)",
                    ("same", "新标题", 0),
                )
                connection.commit()
            finally:
                connection.close()

            migrate_legacy_data(install, data_root)

            connection = sqlite3.connect(target_db)
            try:
                rows = {
                    row[0]: (row[1], row[2])
                    for row in connection.execute(
                        "SELECT id, title, favorite FROM cases ORDER BY id"
                    )
                }
            finally:
                connection.close()
            self.assertEqual(rows["same"], ("新标题", 1))
            self.assertEqual(rows["legacy-only"], ("旧收藏", 1))

    def test_design_reference_favorites_are_merged(self):
        with tempfile.TemporaryDirectory() as folder:
            install = Path(folder) / "install"
            data_root = Path(folder) / "data root"
            source_path = install / "data" / "design_brain" / "references" / "reference_items.json"
            target_path = data_root / "data" / "design_brain" / "references" / "reference_items.json"
            write_json(source_path, {
                "version": 1,
                "items": [
                    {"id": "ref1", "hash": "a" * 64, "title": "旧标题", "favorite": True},
                    {"id": "ref2", "hash": "b" * 64, "title": "旧收藏", "favorite": True},
                ],
            })
            write_json(target_path, {
                "version": 1,
                "items": [
                    {"id": "ref1", "hash": "a" * 64, "title": "新标题", "favorite": False},
                ],
            })
            migrate_legacy_data(install, data_root)
            items = {
                item["id"]: item
                for item in read_json(target_path)["items"]
            }
            self.assertEqual(items["ref1"]["title"], "新标题")
            self.assertTrue(items["ref1"]["favorite"])
            self.assertEqual(items["ref2"]["title"], "旧收藏")
            self.assertTrue(items["ref2"]["favorite"])

    def test_orphan_canvas_project_record_is_repaired(self):
        with tempfile.TemporaryDirectory() as folder:
            data_root = Path(folder) / "data root"
            write_json(data_root / "data" / "projects.json", {
                "projects": [{"id": "default", "name": "默认项目", "order": 0}],
            })
            write_json(data_root / "data" / "canvases" / "orphan.json", {
                "id": "orphan", "title": "孤立画布", "project": "lost-project",
            })
            self.assertEqual(repair_orphan_projects(data_root), 1)
            projects = read_json(data_root / "data" / "projects.json")["projects"]
            self.assertIn("lost-project", {item["id"] for item in projects})

    def test_existing_harness_directory_is_deferred_and_merged(self):
        with tempfile.TemporaryDirectory() as folder:
            project = Path(folder) / "install"
            data_root = Path(folder) / "user data"
            source = project / ".xiaomei-data"
            target = data_root / ".xiaomei-data"
            source.mkdir(parents=True)
            target.mkdir(parents=True)
            (source / "old.txt").write_text("old", encoding="utf-8")
            (source / "same.txt").write_text("old", encoding="utf-8")
            (target / "same.txt").write_text("current", encoding="utf-8")
            migrate_legacy_data(project, data_root)
            self.assertFalse((target / "old.txt").exists())
            self.assertTrue((data_root / ".legacy-bulk-pending.json").exists())
            migrate_pending_bulk_data(project, data_root)
            self.assertEqual((target / "old.txt").read_text(encoding="utf-8"), "old")
            self.assertEqual((target / "same.txt").read_text(encoding="utf-8"), "current")

    def test_deferred_bulk_copy_can_be_resumed(self):
        with tempfile.TemporaryDirectory() as folder:
            data_root = Path(folder) / "data root"
            data_root.mkdir(parents=True)
            source = Path(folder) / "legacy output"
            (source / "nested").mkdir(parents=True)
            (source / "a.png").write_bytes(b"a")
            (source / "nested" / "b.png").write_bytes(b"b")
            target = data_root / "output"
            pending = data_root / ".legacy-bulk-pending.json"
            pending.write_text(
                json.dumps([{"source": str(source), "target": str(target)}]),
                encoding="utf-8",
            )
            self.assertEqual(migrate_pending_bulk_data(data_root, data_root), 0)
            # data_root == project_root means the helper is disabled.
            self.assertTrue(pending.exists())
            project = Path(folder) / "install"
            project.mkdir()
            self.assertGreaterEqual(migrate_pending_bulk_data(project, data_root), 1)
            self.assertEqual((target / "a.png").read_bytes(), b"a")
            self.assertEqual((target / "nested" / "b.png").read_bytes(), b"b")
            self.assertFalse(pending.exists())

    def test_active_canvas_files_are_never_replaced(self):
        with tempfile.TemporaryDirectory() as folder:
            install = Path(folder) / "install"
            data_root = Path(folder) / "data root"
            install.mkdir()
            write_json(install / "data" / "canvases" / "same.json", {
                "id": "same", "title": "旧标题", "project": "default",
            })
            write_json(data_root / "data" / "canvases" / "same.json", {
                "id": "same", "title": "新标题", "project": "default",
            })
            migrate_legacy_data(install, data_root)
            self.assertEqual(
                read_json(data_root / "data" / "canvases" / "same.json")["title"],
                "新标题",
            )


if __name__ == "__main__":
    unittest.main()
