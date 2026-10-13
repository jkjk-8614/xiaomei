import asyncio
import hashlib
from pathlib import Path
import subprocess
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch
import uuid
import xml.etree.ElementTree as ET

import httpx
from fastapi import FastAPI
from PIL import Image, ImageDraw

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import image_vectorizer as vectorizer


class VectorizerTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="矢量测试_")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.source = self.root / "彩色图标.png"
        self.output = self.root / "生成素材"
        self.output.mkdir()
        image = Image.new("RGBA", (96, 72), (0, 0, 0, 0))
        draw = ImageDraw.Draw(image)
        draw.rectangle((10, 10, 42, 62), fill="#e54535")
        draw.ellipse((48, 12, 88, 58), fill="#2080c0")
        image.save(self.source)

        def resolve(url):
            if url == "/assets/彩色图标.png":
                return str(self.source)
            clean = url.split("?", 1)[0]
            if clean.startswith("/output/") and Path(clean).name == clean[len("/output/"):]:
                return str(self.output / Path(clean).name)
            return None

        self.host = SimpleNamespace(
            _request_host_is_loopback=lambda address: address in ("127.0.0.1", "::1"),
            _request_is_share_gateway=lambda request: request.headers.get("x-share-test") == "1",
            local_media_path_from_url=resolve,
            generated_output_filename=lambda prefix, ext: "20261013_090000_123456_" + prefix + uuid.uuid4().hex[:10] + ext,
            output_path_for=lambda filename, category: str(self.output / filename),
            output_url_for=lambda filename, category: "/output/" + filename,
        )
        self.app = FastAPI()
        vectorizer.install_image_vectorizer(self.app, self.host)
        self.client = httpx.AsyncClient(transport=httpx.ASGITransport(app=self.app, client=("127.0.0.1", 123)), base_url="http://localhost")
        self.addAsyncCleanup(self.client.aclose)

    async def convert(self, **values):
        return await self.client.post("/api/image/vectorize", json={"source_url":"/assets/彩色图标.png", "name":"中文 Logo.png", **values})

    async def test_real_color_conversion_is_paths_preserves_alpha_and_source(self):
        digest = hashlib.sha256(self.source.read_bytes()).hexdigest()
        response = await self.convert()
        self.assertEqual(response.status_code, 200, response.text)
        result = response.json()
        self.assertEqual((result["width"], result["height"]), (96, 72))
        self.assertEqual(result["name"], "中文 Logo_矢量.svg")
        svg = ET.parse(self.output / Path(result["url"]).name).getroot()
        self.assertEqual(svg.get("viewBox"), "0 0 96 72")
        self.assertGreater(result["path_count"], 0)
        self.assertFalse(list(svg.iter(f"{{{vectorizer.SVG_NAMESPACE}}}image")))
        # The transparent border must not become a full-canvas white rectangle.
        self.assertNotIn("#ffffff", [element.get("fill", "").lower() for element in svg.iter()])
        self.assertFalse(result["paid_api"])
        self.assertEqual(hashlib.sha256(self.source.read_bytes()).hexdigest(), digest)

    async def test_presets_and_binary_trace_use_real_engine(self):
        for preset, detail, color_mode in (("logo", "simple", "binary"), ("illustration", "fine", "color")):
            response = await self.convert(preset=preset, detail=detail, color_mode=color_mode)
            self.assertEqual(response.status_code, 200, response.text)
            self.assertEqual(response.json()["color_mode"], color_mode)
        self.assertEqual(len(list(self.output.glob("*.svg"))), 2)

    async def test_invalid_and_missing_sources_do_not_write_results(self):
        response = await self.convert(source_url="https://example.com/image.png")
        self.assertEqual(response.status_code, 400)
        response = await self.convert(preset="arbitrary")
        self.assertEqual(response.status_code, 422)
        self.source.write_bytes(b"broken raster")
        response = await self.convert()
        self.assertEqual(response.status_code, 422)
        self.assertEqual(list(self.output.iterdir()), [])

    async def test_fully_transparent_failure_is_clean_and_readable(self):
        Image.new("RGBA", (24, 24), (0, 0, 0, 0)).save(self.source)
        response = await self.convert()
        self.assertEqual(response.status_code, 422)
        self.assertIn("完全透明", response.json()["detail"])
        self.assertEqual(list(self.output.iterdir()), [])

    async def test_timeout_removes_partial_svg(self):
        def timeout(command, **kwargs):
            Path(command[4]).write_text("partial", encoding="utf-8")
            raise subprocess.TimeoutExpired(command, kwargs["timeout"])
        with patch.object(vectorizer.subprocess, "run", side_effect=timeout):
            response = await self.convert()
        self.assertEqual(response.status_code, 504)
        self.assertEqual(list(self.output.iterdir()), [])

    async def test_missing_dependency_and_parallel_conversion(self):
        with patch.object(vectorizer, "vectorizer_status", return_value={"vtracer_ready":False}):
            self.assertEqual((await self.convert()).status_code, 503)
        started = asyncio.Event()
        release = __import__('threading').Event()
        loop = asyncio.get_running_loop()
        def held(*args):
            loop.call_soon_threadsafe(started.set)
            release.wait(5)
            return {"url":"/output/test.svg"}
        with patch.object(vectorizer, "convert_image", side_effect=held):
            task = asyncio.create_task(self.convert())
            await asyncio.wait_for(started.wait(), 5)
            try:
                self.assertEqual((await self.convert()).status_code, 409)
            finally:
                release.set()
                self.assertEqual((await task).status_code, 200)

    async def test_status_only_reports_conversion_engine(self):
        response = await self.client.get("/api/image-vectorizer/status")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), {"vtracer_ready":True, "paid_api":False})
        self.assertEqual(set(self.app.openapi()["paths"]),
                         {"/api/image-vectorizer/status", "/api/image/vectorize"})

    async def test_shared_and_remote_clients_cannot_use_local_tools(self):
        for path, method, body in (("/api/image-vectorizer/status", "GET", None), ("/api/image/vectorize", "POST", {"source_url":"/assets/彩色图标.png"})):
            response = await self.client.request(method, path, headers={"x-share-test":"1"}, json=body)
            self.assertEqual(response.status_code, 403)
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=self.app, client=("192.168.1.20", 123)), base_url="http://localhost") as remote:
            self.assertEqual((await remote.get("/api/image-vectorizer/status")).status_code, 403)


if __name__ == "__main__":
    unittest.main()
