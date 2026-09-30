import asyncio
import os
import tempfile
import unittest
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

    def test_purge_project_keeps_canvas_and_moves_it_to_default(self):
        root, paths = self._workspace()
        with root, paths:
            project = main.new_project("待删除项目")
            canvas = main.new_canvas("画布", project=project["id"])

            asyncio.run(main.delete_project(project["id"]))
            asyncio.run(main.purge_project(project["id"]))

            self.assertFalse(main.list_deleted_projects())
            self.assertEqual(main.load_canvas_any(canvas["id"])["project"], main.DEFAULT_PROJECT_ID)

    def test_default_project_cannot_enter_trash(self):
        with self.assertRaises(HTTPException) as context:
            asyncio.run(main.delete_project(main.DEFAULT_PROJECT_ID))
        self.assertEqual(context.exception.status_code, 400)


if __name__ == "__main__":
    unittest.main()
