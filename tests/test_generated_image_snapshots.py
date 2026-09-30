import asyncio
import os
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch

import main


class GeneratedImageSnapshotTests(unittest.TestCase):
    def test_generated_output_names_sort_in_generation_order(self):
        first = main.generated_output_filename("online_", ".png")
        time.sleep(0.002)
        second = main.generated_output_filename("online_", ".png")

        self.assertRegex(first, r"^\d{8}_\d{6}_\d{6}_online_[0-9a-f]{10}\.png$")
        self.assertRegex(second, r"^\d{8}_\d{6}_\d{6}_online_[0-9a-f]{10}\.png$")
        self.assertLess(first, second)

    def test_local_adapter_results_receive_distinct_immutable_output_urls(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            generated_dir = root / "generated"
            generated_dir.mkdir()
            source = generated_dir / "adapter-output.png"
            original_output_dir = main.OUTPUT_OUTPUT_DIR
            main.OUTPUT_OUTPUT_DIR = str(generated_dir)
            try:
                source.write_bytes(b"first result")
                first_url = asyncio.run(
                    main.save_ai_image_to_output(
                        {"type": "url", "value": "/api/storage-files/generated/adapter-output.png"}
                    )
                )

                source.write_bytes(b"second result")
                second_url = asyncio.run(
                    main.save_ai_image_to_output(
                        {"type": "url", "value": "/api/storage-files/generated/adapter-output.png"}
                    )
                )

                self.assertNotEqual(first_url, second_url)
                self.assertEqual(Path(main.output_file_from_url(first_url)).read_bytes(), b"first result")
                self.assertEqual(Path(main.output_file_from_url(second_url)).read_bytes(), b"second result")
            finally:
                main.OUTPUT_OUTPUT_DIR = original_output_dir

    def test_identical_results_reuse_one_file_and_url(self):
        with tempfile.TemporaryDirectory() as directory:
            with patch.object(main, 'OUTPUT_OUTPUT_DIR', directory):
                first_url, first = main.save_generated_image_bytes(b'identical result')
                second_url, second = main.save_generated_image_bytes(b'identical result')
                self.assertEqual(first_url, second_url)
                self.assertEqual(first, second)
                self.assertEqual(len(list(Path(directory).iterdir())), 1)

    def test_concurrent_identical_saves_create_one_file(self):
        from concurrent.futures import ThreadPoolExecutor
        with tempfile.TemporaryDirectory() as directory:
            with patch.object(main, 'OUTPUT_OUTPUT_DIR', directory):
                with ThreadPoolExecutor(max_workers=4) as pool:
                    results = list(pool.map(lambda _: main.save_generated_image_bytes(b'result'), range(8)))
                self.assertEqual(len(set(path for url, path in results)), 1)
                self.assertEqual(len(list(Path(directory).iterdir())), 1)

    def test_deleting_one_history_keeps_a_reused_image(self):
        import json
        from asset_registry import AssetRegistry
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            history = root / 'history.json'
            with patch.multiple(main, OUTPUT_OUTPUT_DIR=str(root / 'generated'),
                                HISTORY_FILE=str(history), CANVAS_DIR=str(root / 'canvases'),
                                CANVAS_FOLDER_BATCHES=None,
                                ASSET_REGISTRY=AssetRegistry(str(root / 'registry.json'))):
                url, path = main.save_generated_image_bytes(b'shared history result')
                rows = [{'timestamp': stamp, 'images': [url]} for stamp in (1000, 2000)]
                history.write_text(json.dumps(rows), encoding='utf-8')
                result = asyncio.run(main.delete_history(main.DeleteHistoryRequest(timestamp=1000)))
                self.assertTrue(result['success'])
                self.assertTrue(result['retained_asset_ids'])
                self.assertTrue(Path(path).is_file())
                self.assertEqual(len(json.loads(history.read_text(encoding='utf-8'))), 1)

    def test_comfy_download_does_not_create_an_input_copy(self):
        from unittest.mock import MagicMock
        with tempfile.TemporaryDirectory() as directory:
            response = MagicMock()
            response.__enter__.return_value = response
            response.read.return_value = b'comfy image result'
            response.headers = {'Content-Type': 'image/png'}
            with patch.object(main, 'OUTPUT_OUTPUT_DIR', directory), patch.object(main.urllib.request, 'urlopen', return_value=response):
                url = main.download_comfy_output('127.0.0.1:8188', {'filename': 'result.png'})
            self.assertTrue(url.startswith('/api/storage-files/generated/'))
            self.assertEqual(len(list(Path(directory).iterdir())), 1)


if __name__ == "__main__":
    unittest.main()
