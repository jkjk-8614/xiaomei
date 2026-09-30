"""Check that GPT CLI model discovery uses the CLI response."""

import ast
import asyncio
from pathlib import Path
import unittest


class FakeHTTPException(Exception):
    def __init__(self, status_code, detail):
        self.status_code = status_code
        self.detail = detail


def load_codex_model_functions():
    source_path = Path(__file__).resolve().parents[1] / "main.py"
    tree = ast.parse(source_path.read_text(encoding="utf-8"))
    wanted = {
        "CODEX_DEFAULT_IMAGE_MODELS", "codex_chat_models_from_app_server",
        "codex_models_payload", "codex_live_models_payload",
    }
    nodes = [
        node
        for node in tree.body
        if (isinstance(node, ast.Assign) and any(
            isinstance(target, ast.Name) and target.id in wanted
            for target in node.targets
        ))
        or (isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node.name in wanted)
    ]
    namespace = {
        "model_list_from_values": lambda values: list(dict.fromkeys(str(value).strip() for value in values if str(value).strip())),
        "is_codex_gpt_image_25_model": lambda _model: False,
        "HTTPException": FakeHTTPException,
    }
    exec(compile(ast.Module(body=nodes, type_ignores=[]), str(source_path), "exec"), namespace)
    return namespace


class CodexModelTests(unittest.TestCase):
    def test_cli_models_replace_old_defaults(self):
        functions = load_codex_model_functions()
        parse_models = functions["codex_chat_models_from_app_server"]
        payload_builder = functions["codex_models_payload"]
        models, names = parse_models([
            {"id": "gpt-6-astra", "model": "gpt-6-astra", "displayName": "GPT-6 Astra", "hidden": False},
            {"id": "gpt-6-sol", "model": "gpt-6-sol", "displayName": "GPT-6 Sol", "hidden": False},
            {"id": "gpt-6-luna", "model": "gpt-6-luna", "hidden": False},
            {"id": "gpt-5.6-sol", "model": "gpt-5.6-sol", "hidden": False},
            {"id": "gpt-5.6-sol", "model": "gpt-5.6-sol", "hidden": False},
            {"id": "retired-model", "model": "retired-model", "hidden": True},
        ])
        payload = payload_builder(models, image_models=["gpt-image-2"], model_names=names)

        self.assertEqual(models, ["gpt-6-astra", "gpt-6-sol", "gpt-6-luna", "gpt-5.6-sol"])
        self.assertEqual(payload["chat_models"], models)
        self.assertEqual(payload["total"], 5)
        self.assertNotIn("gpt-5.5", payload["all"])
        self.assertEqual(payload["model_names"]["gpt-6-sol"], "GPT-6 Sol")

    def test_live_payload_uses_discovered_models(self):
        functions = load_codex_model_functions()

        async def status():
            return {"installed": True, "image_models": ["gpt-image-2"]}

        async def discover():
            return ["gpt-6-sol", "gpt-6-luna"], {"gpt-6-sol": "GPT-6 Sol"}

        functions.update(codex_status=status, fetch_codex_cli_chat_models=discover)
        payload = asyncio.run(functions["codex_live_models_payload"]())
        self.assertEqual(payload["chat_models"], ["gpt-6-sol", "gpt-6-luna"])
        self.assertEqual(payload["all"], ["gpt-image-2", "gpt-6-sol", "gpt-6-luna"])

    def test_live_payload_does_not_return_defaults_when_cli_is_missing(self):
        functions = load_codex_model_functions()

        async def status():
            return {"installed": False}

        functions["codex_status"] = status
        with self.assertRaises(FakeHTTPException) as error:
            asyncio.run(functions["codex_live_models_payload"]())
        self.assertEqual(error.exception.status_code, 400)

    def test_model_list_failure_is_not_replaced_by_defaults(self):
        functions = load_codex_model_functions()

        async def status():
            return {"installed": True, "image_models": ["gpt-image-2"]}

        async def discover():
            raise FakeHTTPException(502, "模型列表读取失败")

        functions.update(codex_status=status, fetch_codex_cli_chat_models=discover)
        with self.assertRaises(FakeHTTPException) as error:
            asyncio.run(functions["codex_live_models_payload"]())
        self.assertEqual(error.exception.status_code, 502)


if __name__ == "__main__":
    unittest.main()
