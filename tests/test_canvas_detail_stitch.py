"""Verify detail-page stitching with isolated media and no application data."""
import ast
import asyncio
import os
from pathlib import Path
import tempfile
from typing import List
import unittest

from fastapi import HTTPException
from PIL import Image, ImageOps
from pydantic import BaseModel


class CanvasDetailStitchTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.paths = {}
        self.registered = []
        source = Path(__file__).resolve().parents[1] / "main.py"
        tree = ast.parse(source.read_text(encoding="utf-8"))
        names = {"CanvasDetailStitchRequest", "_compose_vertical_canvas", "canvas_detail_stitch"}
        body = [node for node in tree.body if getattr(node, "name", "") in names]
        self.assertEqual(len(body), len(names))
        for node in body:
            if getattr(node, "name", "") == "canvas_detail_stitch":
                node.decorator_list = []
        self.ns = {
            "BaseModel": BaseModel, "List": List, "Image": Image, "ImageOps": ImageOps,
            "HTTPException": HTTPException, "Request": object, "asyncio": asyncio, "os": os,
            "image_has_alpha": lambda image: image.mode in {"RGBA", "LA"} or image.mode == "P" and "transparency" in image.info,
            "output_file_from_url": lambda url: str(self.paths[url]) if url in self.paths else None,
            "generated_output_filename": lambda *_args: "detail-page.png",
            "output_path_for": lambda name, _category: str(self.root / "output" / name),
            "output_url_for": lambda name, _category: f"/assets/output/{name}",
            "asset_registry_register_media": self._register,
            "_share_request_media_access": lambda _request, _url: None,
            "_share_editor_asset_mutation_allowed": lambda share: share.get("role") == "editor" and share.get("allow_assets") is not False,
        }
        exec(compile(ast.Module(body=body, type_ignores=[]), str(source), "exec"), self.ns)

    def _register(self, url, **kwargs):
        self.registered.append((url, kwargs))
        return {"id": "asset_detail_page"}

    def _image(self, url, size, color):
        path = self.root / f"screen-{len(self.paths) + 1}.png"
        Image.new("RGBA", size, color).save(path)
        self.paths[url] = path

    def _stitch(self, urls):
        payload = self.ns["CanvasDetailStitchRequest"](urls=urls)
        return asyncio.run(self.ns["canvas_detail_stitch"](payload, None))

    def test_stitches_in_request_order_without_cropping_and_registers_asset(self):
        self._image("/assets/output/red.png", (900, 1600), (255, 0, 0, 255))
        self._image("/assets/output/blue.png", (450, 800), (0, 0, 255, 255))
        result = self._stitch(["/assets/output/red.png", "/assets/output/blue.png"])
        self.assertEqual((result["width"], result["height"]), (450, 1600))
        self.assertEqual(result["asset_ref_id"], "asset_detail_page")
        with Image.open(self.root / "output" / "detail-page.png") as stitched:
            self.assertEqual(stitched.size, (450, 1600))
            self.assertEqual(stitched.getpixel((225, 400)), (255, 0, 0))
            self.assertEqual(stitched.getpixel((225, 1200)), (0, 0, 255))
        self.assertEqual(self.registered[0][1]["derived_from"], ["/assets/output/red.png", "/assets/output/blue.png"])

    def test_rejects_wrong_ratio_without_saving_or_registering(self):
        self._image("/assets/output/portrait.png", (450, 800), (255, 0, 0, 255))
        self._image("/assets/output/square.png", (500, 500), (0, 0, 255, 255))
        with self.assertRaises(HTTPException) as caught:
            self._stitch(["/assets/output/portrait.png", "/assets/output/square.png"])
        self.assertEqual(caught.exception.status_code, 422)
        self.assertIn("第 2 屏", caught.exception.detail)
        self.assertFalse((self.root / "output" / "detail-page.png").exists())
        self.assertFalse(self.registered)

    def test_rejects_unavailable_and_incomplete_sources(self):
        self._image("/assets/output/portrait.png", (450, 800), (255, 0, 0, 255))
        for urls, expected in [
            (["/assets/output/portrait.png"], "2–100"),
            (["/assets/output/portrait.png", "https://example.com/image.png"], "第 2 屏"),
        ]:
            with self.subTest(urls=urls), self.assertRaises(HTTPException) as caught:
                self._stitch(urls)
            self.assertEqual(caught.exception.status_code, 422)
            self.assertIn(expected, caught.exception.detail)
        self.assertFalse(self.registered)

    def test_rejects_shared_viewer_and_restricted_asset_links(self):
        self._image("/assets/output/red.png", (450, 800), (255, 0, 0, 255))
        self._image("/assets/output/blue.png", (450, 800), (0, 0, 255, 255))
        for share in ({"role": "viewer", "allow_assets": True}, {"role": "editor", "allow_assets": False}):
            with self.subTest(share=share):
                self.ns["_share_request_media_access"] = lambda _request, _url: share
                with self.assertRaises(HTTPException) as caught:
                    self._stitch(["/assets/output/red.png", "/assets/output/blue.png"])
                self.assertEqual(caught.exception.status_code, 403)
        self.assertFalse((self.root / "output" / "detail-page.png").exists())
        self.assertFalse(self.registered)


if __name__ == "__main__":
    unittest.main()
