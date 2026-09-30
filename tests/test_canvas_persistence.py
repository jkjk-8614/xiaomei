import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import main


class CanvasPersistenceTests(unittest.TestCase):
    def test_failed_serialization_keeps_last_complete_canvas(self):
        with tempfile.TemporaryDirectory(prefix="canvas-persistence-test-") as root:
            target = Path(root) / "canvas.json"
            target.write_text(json.dumps({"version": 1}), encoding="utf-8")

            with mock.patch.object(main.json, "dump", side_effect=RuntimeError("simulated failure")):
                with self.assertRaises(RuntimeError):
                    main._atomic_write_json_locked(str(target), {"version": 2})

            self.assertEqual(json.loads(target.read_text(encoding="utf-8")), {"version": 1})
            main._atomic_write_json_locked(str(target), {"version": 2})
            self.assertEqual(json.loads(target.read_text(encoding="utf-8")), {"version": 2})
            self.assertEqual(list(Path(root).glob("*.tmp")), [])


if __name__ == "__main__":
    unittest.main()
