import ast
import pathlib
import unittest


class CanvasIndexGuardTests(unittest.TestCase):
    def test_canvas_reads_and_saves_do_not_synchronously_scan_legacy_media(self):
        source_path = pathlib.Path(__file__).resolve().parents[1] / "main.py"
        tree = ast.parse(source_path.read_text(encoding="utf-8"))
        functions = {
            node.name: node
            for node in tree.body
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))
        }

        for name in ("load_canvas", "save_canvas"):
            calls = [
                node.func.id
                for node in ast.walk(functions[name])
                if isinstance(node, ast.Call) and isinstance(node.func, ast.Name)
            ]
            self.assertNotIn(
                "asset_registry_bind_canvas_refs",
                calls,
                f"{name} must remain fast and must not synchronously index all canvas media",
            )

    def test_asset_library_read_normalizer_does_not_write_the_registry(self):
        source_path = pathlib.Path(__file__).resolve().parents[1] / "main.py"
        tree = ast.parse(source_path.read_text(encoding="utf-8"))
        normalizer = next(
            node
            for node in tree.body
            if isinstance(node, ast.FunctionDef) and node.name == "migrate_asset_item_registrations"
        )
        calls = [
            node.func.id
            for node in ast.walk(normalizer)
            if isinstance(node, ast.Call) and isinstance(node.func, ast.Name)
        ]
        self.assertNotIn(
            "asset_registry_register_media",
            calls,
            "loading the asset library must not synchronously index every legacy item",
        )


if __name__ == "__main__":
    unittest.main()
