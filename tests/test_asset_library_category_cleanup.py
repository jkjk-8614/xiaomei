import asyncio
import copy
import unittest
from unittest.mock import patch

import main


class AssetLibraryCategoryCleanupTests(unittest.TestCase):
    def run_delete(self, library, *, ids, category_id=""):
        saved = []
        source = copy.deepcopy(library)

        def load_library():
            return copy.deepcopy(source)

        def save_library(value, *args, **kwargs):
            saved.append(copy.deepcopy(value))

        def registry_record(item):
            return {"id": item["id"]}

        def trash_item(_library, _category, item, **kwargs):
            return item["id"]

        with patch.object(main, "load_asset_library", side_effect=load_library), \
                patch.object(main, "save_asset_library", side_effect=save_library), \
                patch.object(main, "_asset_library_item_registry_record", side_effect=registry_record), \
                patch.object(main, "asset_registry_require_unreferenced"), \
                patch.object(main, "_trash_asset_library_item", side_effect=trash_item):
            result = asyncio.run(main.batch_delete_asset_library_items(
                main.AssetLibraryBatchDeleteRequest(
                    library_id="default",
                    ids=ids,
                    remove_empty_category_id=category_id,
                )
            ))
        self.assertEqual(len(saved), 1)
        return result, saved[-1]

    @staticmethod
    def library_with_items(*items):
        return {
            "active_library_id": "default",
            "libraries": [{
                "id": "default",
                "categories": [{
                    "id": "crystal",
                    "name": "水晶相框",
                    "type": "image",
                    "items": [{"id": item_id} for item_id in items],
                }],
            }],
        }

    def test_successful_move_removes_empty_source_category(self):
        result, library = self.run_delete(
            self.library_with_items("one", "two"),
            ids=["one", "two"],
            category_id="crystal",
        )
        self.assertEqual(result["removed_category_id"], "crystal")
        self.assertEqual(library["libraries"][0]["categories"], [])

    def test_failed_move_leaves_source_category_with_remaining_items(self):
        result, library = self.run_delete(
            self.library_with_items("one", "two"),
            ids=["one"],
            category_id="crystal",
        )
        self.assertEqual(result["removed_category_id"], "")
        category = library["libraries"][0]["categories"][0]
        self.assertEqual([item["id"] for item in category["items"]], ["two"])

    def test_normal_delete_does_not_remove_empty_category(self):
        result, library = self.run_delete(
            self.library_with_items("one"),
            ids=["one"],
        )
        self.assertEqual(result["removed_category_id"], "")
        self.assertEqual(len(library["libraries"][0]["categories"]), 1)
        self.assertEqual(library["libraries"][0]["categories"][0]["items"], [])


if __name__ == "__main__":
    unittest.main()
