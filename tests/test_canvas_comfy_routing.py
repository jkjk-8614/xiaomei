import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import main


class FakeAppLibrary:
    def __init__(self, root):
        self.root = Path(root)
        self.backend_calls = []

    def read(self, app_id):
        path = self.root / app_id / "app.json"
        if not path.exists():
            raise main.HTTPException(404, "应用不存在")
        return json.loads(path.read_text(encoding="utf-8"))

    def backend(self, item, *, start=False):
        assert start, 'Canvas execution must recover its prepared runtime'
        self.backend_calls.append(item["id"])
        return "127.0.0.1:8190", {}


class CanvasComfyRoutingTests(unittest.TestCase):
    def _make_app(self, root):
        app_id = "a" * 32
        workflow = f"custom/app_{app_id}.json"
        app_dir = Path(root) / app_id
        app_dir.mkdir(parents=True)
        (app_dir / "app.json").write_text(json.dumps({
            "id": app_id,
            "workflow": workflow,
            "managed": True,
        }), encoding="utf-8")
        return app_id, workflow

    def test_managed_canvas_app_is_pinned_to_runtime(self):
        with tempfile.TemporaryDirectory() as root:
            app_id, workflow = self._make_app(root)
            library = FakeAppLibrary(root)
            payload = main.GenerateRequest(workflow_json=workflow, app_id=app_id)
            with patch.object(main, "COMFY_APPS", library):
                prepared = main._prepare_canvas_comfy_payload(payload)

        self.assertEqual(prepared.preferred_backend, "127.0.0.1:8190")
        self.assertTrue(prepared.local_only)
        self.assertEqual(library.backend_calls, [app_id])

    def test_legacy_canvas_app_is_resolved_from_workflow_name(self):
        with tempfile.TemporaryDirectory() as root:
            app_id, workflow = self._make_app(root)
            library = FakeAppLibrary(root)
            payload = main.GenerateRequest(workflow_json=workflow)
            with patch.object(main, "COMFY_APPS", library):
                prepared = main._prepare_canvas_comfy_payload(payload)

        self.assertEqual(prepared.preferred_backend, "127.0.0.1:8190")
        self.assertTrue(prepared.local_only)
        self.assertEqual(library.backend_calls, [app_id])

    def test_regular_canvas_workflow_keeps_default_backend_selection(self):
        library = FakeAppLibrary(tempfile.gettempdir())
        payload = main.GenerateRequest(workflow_json="Z-Image.json")
        with patch.object(main, "COMFY_APPS", library):
            prepared = main._prepare_canvas_comfy_payload(payload)

        self.assertIs(prepared, payload)
        self.assertEqual(prepared.preferred_backend, "")
        self.assertFalse(prepared.local_only)
        self.assertEqual(library.backend_calls, [])


if __name__ == "__main__":
    unittest.main()
