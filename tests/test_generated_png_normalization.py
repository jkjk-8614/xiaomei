import asyncio
import base64
import tempfile
import unittest
from io import BytesIO
from pathlib import Path

from PIL import Image

import main


class GeneratedPngNormalizationTests(unittest.TestCase):
    def test_jpeg_generation_result_is_saved_as_a_real_png(self):
        with tempfile.TemporaryDirectory() as directory:
            output_dir = Path(directory)
            original_output_dir = main.OUTPUT_OUTPUT_DIR
            source = BytesIO()
            Image.new("RGB", (19, 13), (238, 126, 44)).save(source, format="JPEG", quality=90)
            encoded = base64.b64encode(source.getvalue()).decode("ascii")
            main.OUTPUT_OUTPUT_DIR = str(output_dir)
            try:
                url = asyncio.run(
                    main.save_ai_image_to_output(
                        {"type": "b64", "value": encoded, "mime_type": "image/jpeg"},
                        prefix="online_",
                    )
                )
                path = Path(main.output_file_from_url(url))
                self.assertEqual(path.suffix.lower(), ".png")
                with Image.open(path) as image:
                    self.assertEqual(image.format, "PNG")
                    self.assertEqual(image.size, (19, 13))
            finally:
                main.OUTPUT_OUTPUT_DIR = original_output_dir


if __name__ == "__main__":
    unittest.main()
