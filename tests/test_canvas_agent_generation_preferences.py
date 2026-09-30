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


if __name__ == "__main__":
    unittest.main()
