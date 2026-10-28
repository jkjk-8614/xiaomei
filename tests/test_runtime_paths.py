import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from runtime_paths import migrate_legacy_data, resolve_roots, seed_workflows


class RuntimePathsTest(unittest.TestCase):
    def test_current_bundled_workflows_stay_in_app_while_preserved_workflows_import(self):
        with tempfile.TemporaryDirectory() as folder:
            project = Path(folder) / "installed app"
            data = Path(folder) / "user data"
            bundled = project / "workflows" / "template.json"
            bundled.parent.mkdir(parents=True)
            bundled.write_text("bundled template", encoding="utf-8")
            example = project / "API" / ".env.example"
            example.parent.mkdir(parents=True)
            example.write_text("EXAMPLE_KEY=", encoding="utf-8")
            preserved = Path(folder) / "xiaomei-legacy-data-test" / "root"
            custom = preserved / "workflows" / "custom.json"
            custom.parent.mkdir(parents=True)
            custom.write_text("user workflow", encoding="utf-8")

            migrate_legacy_data(project, data, extra_sources=[preserved])

            self.assertEqual(bundled.read_text(encoding="utf-8"), "bundled template")
            self.assertEqual((data / "workflows" / "custom.json").read_text(encoding="utf-8"), "user workflow")
            self.assertFalse((data / "workflows" / "template.json").exists())
            self.assertFalse((data / "API" / ".env.example").exists())

    def test_desktop_roots_keep_code_and_user_data_separate(self):
        with tempfile.TemporaryDirectory() as folder:
            project = Path(folder) / "installed app"
            data = Path(folder) / "user data"
            with patch.dict(os.environ, {
                "XIAOMEI_CANVAS_PROJECT_ROOT": str(project),
                "XIAOMEI_CANVAS_DATA_ROOT": str(data),
            }):
                self.assertEqual(resolve_roots(Path(folder) / "fallback"), (project, data))
            with patch.dict(os.environ, {
                "XIAOMEI_CANVAS_PROJECT_ROOT": "",
                "XIAOMEI_CANVAS_DATA_ROOT": "",
            }):
                self.assertEqual(resolve_roots(project), (project, project))

    def test_legacy_state_is_imported_once_without_overwriting_user_data(self):
        with tempfile.TemporaryDirectory() as folder:
            project = Path(folder) / "installed app"
            data = Path(folder) / "user data"
            examples = {
                "data/canvases/canvas.json": "old canvas",
                "data/agent_skills/custom.md": "old skill",
                "data/api_providers.json": "old model settings",
                "API/.env": "OLD_KEY=example",
                "assets/image.png": "old image",
                "history.json": "old history",
                "ComfyUI/workflows/custom/my-flow.json": "old workflow",
            }
            for relative, value in examples.items():
                source = project / relative
                source.parent.mkdir(parents=True, exist_ok=True)
                source.write_text(value, encoding="utf-8")
            existing = data / "data/api_providers.json"
            existing.parent.mkdir(parents=True, exist_ok=True)
            existing.write_text("new model settings", encoding="utf-8")
            self.assertEqual(migrate_legacy_data(project, data), len(examples) - 1)
            for relative, value in examples.items():
                self.assertEqual((data / relative).read_text(encoding="utf-8"),
                                 "new model settings" if relative == "data/api_providers.json" else value)
            (data / "data/agent_skills/custom.md").unlink()
            self.assertEqual(migrate_legacy_data(project, data), 0)
            self.assertFalse((data / "data/agent_skills/custom.md").exists())

    def test_bundled_workflows_fill_only_missing_templates(self):
        with tempfile.TemporaryDirectory() as folder:
            project = Path(folder) / "installed app"
            data = Path(folder) / "user data"
            source = project / "ComfyUI/workflows"
            target = data / "ComfyUI/workflows"
            source.mkdir(parents=True)
            target.mkdir(parents=True)
            (source / "Z-Image.json").write_text("bundled", encoding="utf-8")
            (source / "other.json").write_text("new template", encoding="utf-8")
            (target / "Z-Image.json").write_text("user edit", encoding="utf-8")
            self.assertEqual(seed_workflows(project, data), 1)
            self.assertEqual((target / "Z-Image.json").read_text(encoding="utf-8"), "user edit")
            self.assertEqual((target / "other.json").read_text(encoding="utf-8"), "new template")


if __name__ == "__main__":
    unittest.main()
