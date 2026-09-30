import asyncio
import tempfile
import time
import unittest
from pathlib import Path

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


if __name__ == "__main__":
    unittest.main()
