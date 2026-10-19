import copy
import unittest
from unittest.mock import patch

import main


class CanvasReferenceLimitsTests(unittest.TestCase):
    def test_limits_follow_runtime_configuration_and_dynamic_models(self):
        providers = [{"id": "fixture", "protocol": "openai", "image_models": ["custom-image"]}]
        original = copy.deepcopy(providers)
        with patch.object(main, "ONLINE_IMAGE_REFERENCE_MAX", 7):
            limits = main.canvas_reference_image_limits(providers)
        self.assertEqual(limits, {"default": 7, "models": {"fixture": {"custom-image": 7}}})
        self.assertEqual(providers, original)

    def test_known_direct_model_uses_existing_capability_limit(self):
        providers = [{"id": "fixture", "protocol": "openai", "base_url": "https://api.openai.com/v1", "image_models": ["gpt-image-2"]}]
        with patch.object(main, "ONLINE_IMAGE_REFERENCE_MAX", 20):
            limits = main.canvas_reference_image_limits(providers)
        self.assertEqual(limits["models"]["fixture"]["gpt-image-2"], 16)

    def test_antigravity_uses_its_existing_three_image_transport(self):
        providers = [{"id": "fixture", "protocol": "gemini-cli", "image_models": ["cli-image"]}]
        with patch.object(main, "ONLINE_IMAGE_REFERENCE_MAX", 20), \
                patch.object(main, "gemini_cli_executable", return_value="agy.exe"):
            limits = main.canvas_reference_image_limits(providers)
        self.assertEqual(limits["models"]["fixture"]["cli-image"], 3)

    def test_platforms_without_image_models_do_not_gain_models(self):
        limits = main.canvas_reference_image_limits([{"id": "video-only", "protocol": "openai", "video_models": ["video-model"]}])
        self.assertEqual(limits["models"], {"video-only": {}})


if __name__ == "__main__":
    unittest.main()
