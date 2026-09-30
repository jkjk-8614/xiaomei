import asyncio
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import main


class GeminiCliImageCountTests(unittest.TestCase):
    def test_concurrent_cli_requests_keep_one_distinct_image_each(self):
        with tempfile.TemporaryDirectory() as directory:
            output_dir = Path(directory)
            original_output_dir = main.OUTPUT_OUTPUT_DIR
            call_count = 0

            async def fake_run_gemini_cli(*_args, **_kwargs):
                nonlocal call_count
                call_count += 1
                (output_dir / f"result-{call_count}-a.png").write_bytes(b"first")
                (output_dir / f"result-{call_count}-b.png").write_bytes(b"second")
                return {"text": "done", "raw": {}}

            async def fake_local_ai_upscale(path, _size):
                return path, {"status": "skipped", "engine": "SeedVR2", "message": "ComfyUI 未启动"}

            main.OUTPUT_OUTPUT_DIR = str(output_dir)
            try:
                with patch.object(main, "gemini_cli_executable", return_value="C:\\Users\\test\\agy.exe"), patch.object(
                    main, "run_gemini_cli", fake_run_gemini_cli
                ), patch.object(main, "gemini_cli_local_ai_upscale_image", fake_local_ai_upscale):
                    async def generate_batch():
                        return await asyncio.gather(
                            *[
                                main.generate_gemini_cli_provider_image(
                                    "生成一张图片", "1024x1024", "auto"
                                )
                                for _ in range(4)
                            ]
                        )

                    results = asyncio.run(generate_batch())
            finally:
                main.OUTPUT_OUTPUT_DIR = original_output_dir

            image_lists = [metadata["images"] for _image, metadata in results]
            self.assertEqual(call_count, 4)
            self.assertTrue(all(len(images) == 1 for images in image_lists))
            self.assertEqual(len({images[0] for images in image_lists}), 4)


if __name__ == "__main__":
    unittest.main()
