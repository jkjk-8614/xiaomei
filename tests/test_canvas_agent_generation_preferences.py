import json
import pathlib
import shutil
import subprocess
import unittest


class CanvasAgentGenerationPreferenceTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.node = shutil.which("node")
        if not cls.node:
            raise unittest.SkipTest("Node.js is required to exercise the browser-side generation preference parser")
        source = (pathlib.Path(__file__).resolve().parents[1] / "static" / "js" / "canvas-agent.js").read_text(encoding="utf-8")
        start = source.index("    function generationRatioGcd(")
        end = source.index("    function requestedPlanNodeSettings(", start)
        cls.parser_source = source[start:end]
        target_end = source.index("    function applyGenerationPreferencesToCurrentNode(", start)
        cls.target_source = source[start:target_end]

    def parse_preferences(self, text):
        script = f"{self.parser_source}\nconsole.log(JSON.stringify(requestedGenerationPreferences({json.dumps(text)})));"
        result = subprocess.run(
            [self.node, "-e", script],
            check=True,
            capture_output=True,
            text=True,
            encoding="utf-8",
        )
        return json.loads(result.stdout)

    def normalize_custom_ratio(self, width="", height="", ratio=""):
        script = (
            f"{self.parser_source}\n"
            "console.log(JSON.stringify(normalizeGenerationCustomRatio({"
            f"customRatioWidth:{json.dumps(width)},"
            f"customRatioHeight:{json.dumps(height)},"
            f"customRatio:{json.dumps(ratio)}"
            "})));"
        )
        result = subprocess.run(
            [self.node, "-e", script],
            check=True,
            capture_output=True,
            text=True,
            encoding="utf-8",
        )
        return json.loads(result.stdout)

    def map_custom_ratio_to_canvas_target(self, width="", height="", ratio=""):
        script = (
            f"{self.target_source}\n"
            "const target={};"
            "ratioForCanvasTarget(target,'custom',null,{"
            f"customRatioWidth:{json.dumps(width)},"
            f"customRatioHeight:{json.dumps(height)},"
            f"customRatio:{json.dumps(ratio)}"
            "});"
            "console.log(JSON.stringify(target));"
        )
        result = subprocess.run(
            [self.node, "-e", script],
            check=True,
            capture_output=True,
            text=True,
            encoding="utf-8",
        )
        return json.loads(result.stdout)

    def test_reference_object_square_does_not_override_the_selected_canvas_ratio(self):
        text = "参考图2的相框是正方形，尺寸是30cm×30cm；按右侧选择的比例生成场景。"

        self.assertEqual(self.parse_preferences(text), {})

    def test_explicit_output_ratio_is_still_applied(self):
        self.assertEqual(
            self.parse_preferences("输出图片比例为 3:4，生成一张商品场景图。"),
            {"media": "image", "count": 1, "ratio": "portrait43", "ratioLabel": "3:4"},
        )

    def test_explicit_square_output_is_still_applied(self):
        self.assertEqual(
            self.parse_preferences("生成一张正方形图片。"),
            {"media": "image", "count": 1, "ratio": "square", "ratioLabel": "1:1"},
        )

    def test_explicit_arbitrary_output_ratio_is_applied(self):
        self.assertEqual(
            self.parse_preferences("输出图片比例为 710:229，生成一张超宽横图。"),
            {
                "media": "image",
                "count": 1,
                "ratio": "custom",
                "ratioLabel": "710:229",
                "customRatio": "710:229",
                "customRatioWidth": 710,
                "customRatioHeight": 229,
            },
        )

    def test_custom_ratio_fields_are_kept_for_agent_generation(self):
        self.assertEqual(
            self.normalize_custom_ratio(ratio="710:229"),
            {"customRatio": "710:229", "customRatioWidth": "710", "customRatioHeight": "229"},
        )

    def test_incomplete_custom_ratio_is_not_treated_as_valid(self):
        self.assertEqual(
            self.normalize_custom_ratio(width="710"),
            {"customRatio": "", "customRatioWidth": "710", "customRatioHeight": ""},
        )

    def test_custom_ratio_is_written_to_canvas_generation_settings(self):
        self.assertEqual(
            self.map_custom_ratio_to_canvas_target(width="710", height="229"),
            {
                "ratio": "custom",
                "customRatio": "710:229",
                "customRatioWidth": "710",
                "customRatioHeight": "229",
            },
        )


if __name__ == "__main__":
    unittest.main()
