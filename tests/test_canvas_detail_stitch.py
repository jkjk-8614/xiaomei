"""Verify detail-page stitching with isolated media and no application data."""
import ast
import asyncio
import math
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
        names = {"CanvasDetailStitchRequest", "_compose_vertical_canvas", "_detail_stitch_dimensions", "canvas_detail_stitch"}
        body = [node for node in tree.body if getattr(node, "name", "") in names]
        self.assertEqual(len(body), len(names))
        for node in body:
            if getattr(node, "name", "") == "canvas_detail_stitch":
                node.decorator_list = []
        self.ns = {
            "BaseModel": BaseModel, "List": List, "Image": Image, "ImageOps": ImageOps, "math": math,
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

    def _stitch(self, urls, allow_compatible_portrait=False):
        payload = self.ns["CanvasDetailStitchRequest"](
            urls=urls, allow_compatible_portrait=allow_compatible_portrait
        )
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

    def test_scales_long_detail_page_to_single_image_limits(self):
        width, heights, total_height = self.ns["_detail_stitch_dimensions"]([(3072, 5504)] * 9)
        self.assertLess(width, 3072)
        self.assertEqual(len(heights), 9)
        self.assertLessEqual(total_height, 50_000)
        self.assertLessEqual(width * total_height, 120_000_000)

        original = self.ns["_detail_stitch_dimensions"]
        self.ns["_detail_stitch_dimensions"] = lambda sizes: original(sizes, max_pixels=10_000)
        self._image("/assets/output/red.png", (90, 160), (255, 0, 0, 255))
        self._image("/assets/output/blue.png", (90, 160), (0, 0, 255, 255))
        result = self._stitch(["/assets/output/red.png", "/assets/output/blue.png"])
        self.assertLess(result["width"], 90)
        self.assertTrue(result["scaled_down"])
        self.assertLessEqual(result["width"] * result["height"], 10_000)
        with Image.open(self.root / "output" / "detail-page.png") as stitched:
            self.assertEqual(stitched.size, (result["width"], result["height"]))
            self.assertEqual(stitched.getpixel((result["width"] // 2, result["height"] // 4)), (255, 0, 0))
            self.assertEqual(stitched.getpixel((result["width"] // 2, result["height"] * 3 // 4)), (0, 0, 255))

    def test_reports_when_minimum_width_cannot_fit(self):
        with self.assertRaisesRegex(ValueError, "减少屏数"):
            self.ns["_detail_stitch_dimensions"]([(1, 50_001)])

    def test_stitches_consistent_portrait_outputs_from_a_nine_sixteen_batch(self):
        urls = []
        for index in range(10):
            url = f"/assets/output/screen-{index + 1}.png"
            urls.append(url)
            self._image(url, (90, 120), (index * 20, 0, 0, 255))
        with self.assertRaises(HTTPException) as caught:
            self._stitch(urls)
        self.assertIn("仅支持 9:16", caught.exception.detail)
        result = self._stitch(urls, allow_compatible_portrait=True)
        self.assertEqual((result["width"], result["height"], result["actual_ratio"]), (90, 1200, "3:4"))
        with Image.open(self.root / "output" / "detail-page.png") as stitched:
            for index in range(10):
                self.assertEqual(stitched.getpixel((45, index * 120 + 60)), (index * 20, 0, 0))
        self.assertEqual(self.registered[0][1]["metadata"]["source_ratio"], "3:4")

    def test_rejects_mixed_portrait_ratios_even_for_batch_fallback(self):
        self._image("/assets/output/three-four.png", (90, 120), (255, 0, 0, 255))
        self._image("/assets/output/nine-sixteen.png", (90, 160), (0, 0, 255, 255))
        with self.assertRaises(HTTPException) as caught:
            self._stitch(["/assets/output/three-four.png", "/assets/output/nine-sixteen.png"], True)
        self.assertEqual(caught.exception.status_code, 422)
        self.assertIn("与第 1 屏", caught.exception.detail)
        self.assertFalse(self.registered)

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
