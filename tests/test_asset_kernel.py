import asyncio
import unittest

import asset_kernel


class AssetKernelTest(unittest.TestCase):
    def test_paths_stay_inside_the_root(self):
        self.assertEqual(asset_kernel.relative_path("folder/a.png")["rel"], "folder/a.png")
        self.assertIn("error", asset_kernel.relative_path("../secret"))
        self.assertIn("error", asset_kernel.relative_path("folder/../../secret"))
        self.assertEqual(asset_kernel.relative_path("/etc/passwd")["rel"], "etc/passwd")
        held = asset_kernel.contained("/data/local", "nested/a.png")
        self.assertTrue(held["path"].endswith("/data/local/nested/a.png"))
        self.assertIn("error", asset_kernel.contained("/data/local", "../secret"))
        self.assertEqual(asset_kernel.storage_bucket("generated")["bucket"], "generated")
        self.assertEqual(asset_kernel.storage_bucket("nope")["status"], 404)

    def test_catalog_round_trip(self):
        catalog = asset_kernel.normalize_catalog({
            "categories": [{
                "id": "scenes",
                "name": "场景",
                "type": "image",
                "items": [
                    {"id": "b", "name": "b", "created_at": 2, "platform": "volcengine", "asset_uri": "asset://b"},
                    {"id": "a", "name": "a", "created_at": 9},
                ],
            }]
        }, 10)
        self.assertEqual(catalog["active_library_id"], "default")
        self.assertEqual(catalog["libraries"][0]["categories"][0]["items"][0]["id"], "a")
        folded = catalog["libraries"][0]["categories"][0]["items"][1]
        self.assertEqual(folded["registrations"]["volcengine"]["asset_uri"], "asset://b")
        self.assertNotIn("platform", folded)
        self.assertTrue(any(group.get("type") == "workflow" for group in catalog["libraries"][0]["categories"]))

        created = asset_kernel.spawn_library("新品", "lib_new", "cat_new", "wf_new")
        catalog["libraries"].append(created)
        moved = asset_kernel.move_items(catalog, ["a"], "default", "lib_new", "cat_new")
        self.assertEqual(moved["moved"], 1)
        self.assertEqual(catalog["libraries"][1]["categories"][0]["items"][0]["id"], "a")
        blocked = asset_kernel.removal_plan(catalog, "workflows", "default")
        self.assertEqual(blocked["status"], 400)
        self.assertNotIn("error", asset_kernel.drop_library(catalog, "lib_new"))
        self.assertEqual(asset_kernel.drop_library(catalog, "default")["status"], 400)

    def test_labels_crop_and_filters(self):
        labels = asset_kernel.clean_labels({
            "summary": "  白底  ",
            "tags": ["#棉", "#棉", "麻"],
            "categories": {"color": "白，白、蓝"},
        }, 5, {"color": "色彩"})
        self.assertEqual(labels["tags"], ["棉", "麻"])
        self.assertEqual(labels["categories"]["color"], ["白", "蓝"])
        self.assertEqual(labels["flat"][0]["label"], "色彩")
        self.assertEqual(asset_kernel.center_box(400, 200), (100, 0, 300, 200))
        self.assertIsNone(asset_kernel.center_box(0, 10))
        self.assertTrue(asset_kernel.matches(
            {"name": "白衬衫", "kind": "image", "width": 400, "height": 200, "classification": labels},
            {"query": "衬衫", "shape": "landscape", "color": "白"},
        ))
        self.assertFalse(asset_kernel.matches({"name": "白衬衫", "kind": "image", "width": 400, "height": 200}, {"shape": "portrait"}))
        self.assertEqual(asset_kernel.upload_stem("照片.png", "file", ".png", already_stem=True), "照片")
        self.assertTrue(asset_kernel.same_members(["a", "b"], ["b", "a"]))
        self.assertFalse(asset_kernel.same_members(["a"], ["a", "a"]))

    def test_header_accepts_next_and_keeps_legacy_rollback(self):
        async def run(headers):
            seen = {}

            async def app(scope, receive, send):
                seen["mode"] = asset_kernel.MODE.get()

            middleware = asset_kernel.AssetSwitchMiddleware(app)

            async def receive():
                return {"type": "http.request"}

            async def send(message):
                return None

            await middleware({"type": "http", "headers": headers}, receive, send)
            return seen["mode"]

        self.assertEqual(asyncio.run(run([])), "legacy")
        self.assertEqual(asyncio.run(run([(b"x-xiaomei-assets", b"next")])), "next")
        self.assertEqual(asyncio.run(run([(b"x-xiaomei-assets", b"legacy")])), "legacy")
        self.assertEqual(asset_kernel.MODE.get(), "legacy")


if __name__ == "__main__":
    unittest.main()
