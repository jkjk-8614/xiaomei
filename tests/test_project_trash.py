import asyncio
import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from fastapi import HTTPException

import main


class ProjectTrashTests(unittest.TestCase):
    def _workspace(self):
        root = tempfile.TemporaryDirectory()
        projects_path = os.path.join(root.name, "projects.json")
        canvases_dir = os.path.join(root.name, "canvases")
        os.makedirs(canvases_dir, exist_ok=True)
        return root, mock.patch.multiple(
            main,
            PROJECTS_PATH=projects_path,
            CANVAS_DIR=canvases_dir,
        )

    def test_deleted_project_is_listed_and_restores_canvas_ownership(self):
        root, paths = self._workspace()
        with root, paths:
            project = main.new_project("校园成长相框")
            canvas = main.new_canvas("校园画布", project=project["id"])

            asyncio.run(main.delete_project(project["id"]))

            deleted = main.list_deleted_projects()
            self.assertEqual([item["id"] for item in deleted], [project["id"]])
            self.assertEqual(main.load_canvas_any(canvas["id"])["project"], project["id"])

            asyncio.run(main.restore_project(project["id"]))

            self.assertTrue(any(item["id"] == project["id"] for item in main.list_projects()))
            self.assertEqual(main.load_canvas_any(canvas["id"])["project"], project["id"])

    def test_purge_project_moves_its_canvas_to_trash_and_allows_recovery(self):
        root, paths = self._workspace()
        with root, paths:
            project = main.new_project("待删除项目")
            canvas = main.new_canvas("画布", project=project["id"])

            asyncio.run(main.delete_project(project["id"]))
            result = asyncio.run(main.purge_project(project["id"]))

            self.assertFalse(main.list_deleted_projects())
            self.assertEqual(result["trashed"], 1)
            self.assertTrue(main.load_canvas_any(canvas["id"])["deleted_at"])
            asyncio.run(main.restore_canvas(canvas["id"]))
            self.assertEqual(main.load_canvas_any(canvas["id"])["project"], main.DEFAULT_PROJECT_ID)

    def test_default_project_cannot_enter_trash(self):
        with self.assertRaises(HTTPException) as context:
            asyncio.run(main.delete_project(main.DEFAULT_PROJECT_ID))
        self.assertEqual(context.exception.status_code, 400)

    def test_project_purge_can_retry_after_a_canvas_write_fails(self):
        root, paths = self._workspace()
        with root, paths:
            project = main.new_project("待重试项目")
            canvas = main.new_canvas("画布", project=project["id"])
            asyncio.run(main.delete_project(project["id"]))
            with mock.patch.object(main, "_atomic_write_json_locked", side_effect=PermissionError):
                with self.assertRaises(HTTPException) as failure:
                    asyncio.run(main.purge_project(project["id"]))
            self.assertEqual(failure.exception.status_code, 503)
            self.assertEqual([item["id"] for item in main.list_deleted_projects()], [project["id"]])
            self.assertFalse(main.load_canvas_any(canvas["id"]).get("deleted_at"))

            self.assertEqual(asyncio.run(main.purge_project(project["id"]))["trashed"], 1)
            self.assertFalse(main.list_deleted_projects())

    def test_automatic_cleanup_retries_expired_project_after_write_failure(self):
        root, paths = self._workspace()
        with root, paths:
            project = main.new_project("待清理项目")
            canvas = main.new_canvas("画布", project=project["id"])
            asyncio.run(main.delete_project(project["id"]))
            future = main.now_ms() + main.CANVAS_TRASH_RETENTION_MS + 1000
            with mock.patch.object(main, "now_ms", return_value=future):
                with mock.patch.object(main, "_atomic_write_json_locked", side_effect=PermissionError):
                    self.assertEqual([item["id"] for item in main.list_deleted_projects()], [project["id"]])
                self.assertFalse(main.list_deleted_projects())
            self.assertTrue(main.load_canvas_any(canvas["id"])["deleted_at"])

    def test_deleting_an_invalid_canvas_preserves_original_bytes(self):
        root, paths = self._workspace()
        with root, paths:
            for payload in (b'{"nodes":', b'[]'):
                with self.subTest(payload=payload):
                    path = Path(main.canvas_path("damaged"))
                    path.write_bytes(payload)
                    self.assertTrue(main.list_canvases()[0]["corrupt"])
                    with self.assertRaises(HTTPException) as failure:
                        main.load_canvas("damaged")
                    self.assertEqual(failure.exception.status_code, 409)
                    result = asyncio.run(main.delete_canvas("damaged"))
                    self.assertFalse(path.exists())
                    self.assertTrue(result["purged"])
                    self.assertEqual(path.with_name(result["backup_file"]).read_bytes(), payload)

    def test_canvas_read_error_does_not_remove_its_file(self):
        root, paths = self._workspace()
        with root, paths:
            canvas = main.new_canvas("无法读取的画布")
            path = Path(main.canvas_path(canvas["id"]))
            original = path.read_bytes()
            with mock.patch.object(main, "open", side_effect=PermissionError, create=True):
                with self.assertRaises(HTTPException) as failure:
                    asyncio.run(main.delete_canvas(canvas["id"]))
            self.assertEqual(failure.exception.status_code, 503)
            self.assertEqual(path.read_bytes(), original)


if __name__ == "__main__":
    unittest.main()
