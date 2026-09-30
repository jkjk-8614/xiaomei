import asyncio
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import main


class FakeResponse:
    def __init__(self, status_code=200, payload=None):
        self.status_code = status_code
        self.payload = payload

    def raise_for_status(self):
        if self.status_code >= 400:
            raise RuntimeError(f"HTTP {self.status_code}")

    def json(self):
        return self.payload


class ComfyUiStatusTests(unittest.TestCase):
    def test_status_discovers_verified_managed_backend(self):
        with tempfile.TemporaryDirectory() as root:
            runtime = SimpleNamespace(address="127.0.0.1:8190", root=Path(root))
            calls = []

            def fake_get(url, timeout):
                calls.append(url)
                if url.endswith("/xiaomei/app-runtime"):
                    return FakeResponse(payload={"root": str(Path(root).resolve())})
                return FakeResponse()

            with patch.object(main, "COMFYUI_INSTANCES", ["127.0.0.1:8188"]), \
                    patch.object(main, "COMFY_APPS", SimpleNamespace(runtime=runtime)), \
                    patch.object(main.requests, "get", side_effect=fake_get):
                result = asyncio.run(main.comfyui_status())

        self.assertTrue(result["available"])
        by_address = {item["address"]: item for item in result["instances"]}
        self.assertTrue(by_address["127.0.0.1:8188"]["online"])
        self.assertTrue(by_address["127.0.0.1:8190"]["online"])
        self.assertTrue(by_address["127.0.0.1:8190"]["managed"])
        self.assertIn("http://127.0.0.1:8190/xiaomei/app-runtime", calls)
        self.assertIn("http://127.0.0.1:8190/system_stats", calls)

    def test_status_rejects_unverified_service_on_managed_port(self):
        with tempfile.TemporaryDirectory() as root:
            runtime = SimpleNamespace(address="127.0.0.1:8190", root=Path(root))

            def fake_get(url, timeout):
                if url.endswith("/xiaomei/app-runtime"):
                    return FakeResponse(payload={"root": str(Path(root).parent.resolve())})
                return FakeResponse()

            with patch.object(main, "COMFYUI_INSTANCES", []), \
                    patch.object(main, "COMFY_APPS", SimpleNamespace(runtime=runtime)), \
                    patch.object(main.requests, "get", side_effect=fake_get):
                result = asyncio.run(main.comfyui_status())

        self.assertFalse(result["available"])
        self.assertEqual(result["instances"], [{"address": "127.0.0.1:8190", "online": False, "managed": True}])


if __name__ == "__main__":
    unittest.main()
