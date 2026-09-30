import unittest

import main


class GptImage25ParameterTests(unittest.TestCase):
    @staticmethod
    def assert_supported_size(test_case, value):
        width, height = main.parse_size_pair(value)
        test_case.assertGreater(width, 0)
        test_case.assertGreater(height, 0)
        test_case.assertEqual(width % 16, 0)
        test_case.assertEqual(height % 16, 0)
        test_case.assertLessEqual(max(width, height), main.GPT_IMAGE2_MAX_EDGE)
        test_case.assertGreaterEqual(width * height, main.GPT_IMAGE2_MIN_PIXELS)
        test_case.assertLessEqual(width * height, main.GPT_IMAGE2_MAX_PIXELS)
        test_case.assertLessEqual(max(width / height, height / width), 3)

    def test_model_family_and_quality_values(self):
        self.assertTrue(main.is_gpt_image_25_model("gpt-image-2.5-flare"))
        self.assertTrue(main.is_gpt_image_25_model("gateway/gpt-image-2.5-sunburst-202609"))
        self.assertFalse(main.is_gpt_image_25_model("gpt-image-2"))
        self.assertEqual(main.normalize_image_quality("xhigh", "gpt-image-2.5-flare"), "xhigh")
        self.assertEqual(main.normalize_image_quality("max", "gpt-image-2.5-sunburst"), "max")
        self.assertEqual(main.normalize_image_quality("auto", "gpt-image-2"), "")

    def test_background_options_are_model_scoped(self):
        self.assertEqual(
            main.gpt_image_25_request_options("gpt-image-2.5-flare", "transparent"),
            {"background": "transparent", "output_format": "png"},
        )
        self.assertEqual(
            main.gpt_image_25_request_options("gpt-image-2", "transparent"),
            {},
        )

    def test_output_size_is_aligned_and_within_limits(self):
        self.assertEqual(main.normalize_gpt_image_2_size("4096x4096"), "2880x2880")
        self.assertEqual(main.normalize_gpt_image_2_size("2448x3264"), "2448x3264")
        for requested in ("1000x1000", "10000x1000", "512x1024"):
            self.assert_supported_size(self, main.normalize_gpt_image_2_size(requested))

    def test_dynamic_schema_exposes_25_only_fields(self):
        current = main.build_image_param_fields("api", {}, "gpt-image-2.5-flare")
        legacy = main.build_image_param_fields("api", {}, "gpt-image-2")
        current_fields = {field["key"]: field for field in current}
        legacy_fields = {field["key"]: field for field in legacy}
        self.assertIn("background", current_fields)
        self.assertEqual(
            [option["value"] for option in current_fields["quality"]["options"]][-2:],
            ["xhigh", "max"],
        )
        self.assertNotIn("background", legacy_fields)
        self.assertNotIn(
            "xhigh",
            [option["value"] for option in legacy_fields["quality"]["options"]],
        )


if __name__ == "__main__":
    unittest.main()
