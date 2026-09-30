import os
import tempfile
import unittest
from unittest import mock

from asset_registry import AssetRegistry


class AssetRegistryTests(unittest.TestCase):
    def test_register_alias_search_and_trash_lifecycle(self):
        with tempfile.TemporaryDirectory() as directory:
            path = os.path.join(directory, "asset_registry.json")
            registry = AssetRegistry(path)

            first = registry.register(
                url="/assets/library/product.png?cache=1",
                requested_id="asset_product001",
                name="商品主图",
                kind="image",
                source="asset_library",
            )
            self.assertEqual(first["id"], "asset_product001")
            self.assertEqual(registry.find_by_url("/assets/library/product.png")["id"], first["id"])

            moved = registry.register(
                url="/api/storage-files/local/product-renamed.png",
                requested_id=first["id"],
                name="商品主图新版",
                kind="image",
                source="local_upload",
            )
            self.assertEqual(moved["id"], first["id"])
            self.assertEqual(registry.find_by_url("/assets/library/product.png")["id"], first["id"])
            self.assertEqual(registry.find_by_url("/api/storage-files/local/product-renamed.png")["id"], first["id"])
            self.assertEqual(registry.list(query="新版")["total"], 1)

            registry.trash(first["id"])
            self.assertEqual(registry.list()["total"], 0)
            self.assertEqual(registry.list(include_deleted=True)["total"], 1)
            registry.restore(first["id"])
            self.assertEqual(registry.stats()["active"], 1)
            self.assertTrue(registry.purge(first["id"]))
            self.assertIsNone(registry.get(first["id"]))

    def test_repeat_registration_does_not_rewrite_index(self):
        with tempfile.TemporaryDirectory() as directory:
            path = os.path.join(directory, "asset_registry.json")
            registry = AssetRegistry(path)
            values = {
                "url": "/output/repeat.png",
                "requested_id": "asset_repeat001",
                "name": "重复登记素材",
                "kind": "image",
                "source": "generated",
                "metadata": {"origin": "test"},
            }
            registry.register(**values)

            with mock.patch.object(registry, "_write_locked", wraps=registry._write_locked) as write:
                repeated = registry.register(**values)

            self.assertEqual(repeated["id"], "asset_repeat001")
            write.assert_not_called()


if __name__ == "__main__":
    unittest.main()
