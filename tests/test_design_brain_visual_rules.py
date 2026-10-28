"""User visual standards: structured gates, unlimited detail continuation and exact SKU pixels."""
import asyncio
import io
import sys
import tempfile
import unittest
from copy import deepcopy
from pathlib import Path
from unittest.mock import Mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from PIL import Image, ImageChops, ImageDraw

from tests.test_design_brain_bots import (
    DesignBotOrchestratorTestBase, FakeHost, DIRECTOR_CREATE, PLANNER_TWO_SHOTS, sku_plan,
)
from tests.test_design_brain_batch import BatchHost
from design_brain_store import AgentTaskStore, DesignBrainError, apply_ecommerce_plan, image_requirements, normalize_agent_task
from design_brain_visual_rules import (
    ECOMMERCE_RULES, DEFAULT_LAYOUT, VisualRuleError, render_sku_image, normalize_layout,
    normalize_values, validate_framework, default_visual_framework, default_sku_scene, sku_series_mode, CTR_TEST_SCHEDULE,
)


def visual_plan(count):
    return {**deepcopy(PLANNER_TWO_SHOTS), "visual_framework": sku_plan()["visual_framework"],
        "shots": [{**deepcopy(PLANNER_TWO_SHOTS["shots"][0]), "id": f"s{i}",
                   "copy": {"title": "轻松看清细节", "subtitle": "保留真实产品质感", "body": "真实材质与细节展示"}}
                  for i in range(count)]}


class EcommercePipelineTest(DesignBotOrchestratorTestBase):
    def test_main_set_is_five_with_click_and_conversion_roles(self):
        director = deepcopy(DIRECTOR_CREATE)
        director["brief"]["task_type"] = "main_image"
        host = FakeHost(director=director, planner=visual_plan(5))
        orch = self.make_orchestrator(host)
        async def scenario():
            response = await orch.chat(task_id="", message="做一组主图", product_images=[],
                                       models=self.chat_models(), auto_confirm=False)
            task = await self.drive_until(orch, response["task_id"], {"awaiting_confirmation", "failed"})
            self.assertEqual(task["status"], "awaiting_confirmation", task["error"])
            self.assertEqual(task["brief"]["image_count"], 5)
            self.assertEqual([s["role"] for s in task["plan"]["shots"]], ["ctr"] + ["conversion"] * 4)
            self.assertEqual([s["aspect_ratio"] for s in task["plan"]["shots"]], ["1:1"] + ["2:3"] * 4)
            self.assertEqual(task["plan"]["test_schedule"], CTR_TEST_SCHEDULE)
            self.assertFalse(host.created)
            orch.tasks.patch(task["id"], lambda t: t.update(status="executing"))
            task = await self.drive_until(orch, task["id"], {"delivered", "failed"})
            self.assertEqual(task["status"], "delivered", task["error"])
            self.assertEqual(len(host.created), 5)
        asyncio.run(scenario())

    def test_short_main_plan_fails_before_paid_generation(self):
        host = FakeHost(planner=visual_plan(2))
        orch = self.make_orchestrator(host)
        async def scenario():
            response = await orch.chat(task_id="", message="做主图", product_images=[], models=self.chat_models(), auto_confirm=True)
            task = await self.drive_until(orch, response["task_id"], {"delivered", "failed"})
            self.assertEqual(task["status"], "failed")
            self.assertIn("5", task["error"])
            self.assertFalse(host.created)
        asyncio.run(scenario())

    def test_sixty_detail_screens_keep_order_and_portrait_ratio(self):
        host = BatchHost(60)
        host.plan = visual_plan(60)
        orch = self.make_orchestrator(host)
        async def scenario():
            response = await orch.chat(task_id="", message="规划60屏详情页，2K", product_images=[], models=self.chat_models(), auto_confirm=False)
            task = await self.drive_until(orch, response["task_id"], {"awaiting_confirmation", "failed"}, timeout=60)
            self.assertEqual(task["status"], "awaiting_confirmation", task["error"])
            shots = task["plan"]["shots"]
            self.assertEqual(len(shots), 60)
            self.assertEqual([s["role"] for s in shots[:5]], ["product", "selling_point", "benefit", "attention", "reinforce"])
            self.assertTrue(all(s["aspect_ratio"] == "9:16" for s in shots))
            self.assertEqual(len({s["size"].split("x")[0] for s in shots}), 1)
            self.assertEqual(len(AgentTaskStore(self._tmp.name).get(task["id"])["plan"]["shots"]), 60)
            self.assertFalse(host.created)
        asyncio.run(scenario())

    def test_detail_append_preserves_previous_outputs_and_waits_for_confirmation(self):
        host = BatchHost(4)
        host.plan = visual_plan(4)
        orch = self.make_orchestrator(host)
        async def scenario():
            response = await orch.chat(task_id="", message="生成4屏详情页", product_images=[], models=self.chat_models(), auto_confirm=True)
            task = await self.drive_until(orch, response["task_id"], {"delivered", "failed"})
            self.assertEqual(task["status"], "delivered", task["error"])
            old_outputs = deepcopy(task["execution"]["shots"])
            host.plan = visual_plan(25)
            orch.append_detail_screens(task["id"], 21, "继续解释原有核心利益点")
            task = await self.drive_until(orch, task["id"], {"awaiting_confirmation", "failed"}, timeout=60)
            self.assertEqual(task["status"], "awaiting_confirmation", task["error"])
            self.assertEqual(len(task["plan"]["shots"]), 25)
            self.assertEqual(task["execution"]["shots"], old_outputs)
            self.assertEqual(len(host.created), 4)
            self.assertTrue(all(s["role"] == "reinforce" for s in task["plan"]["shots"][4:]))
            orch.tasks.patch(task["id"], lambda t: t.update(status="executing"))
            task = await self.drive_until(orch, task["id"], {"delivered", "failed"}, timeout=60)
            self.assertEqual(task["status"], "delivered", task["error"])
            self.assertEqual(len(host.created), 25, "追加时只生成新增屏")
            self.assertEqual(task["execution"]["shots"][:4], old_outputs)
        asyncio.run(scenario())


class VisualRulesTest(unittest.TestCase):
    def test_document_methods_are_in_runtime_standard(self):
        for method in ("三三原则", "FABE", "E为情感吸引力", "七天测图", "TOP10", "20至50张", "原料", "工厂", "九维", "HSB", "70%", "3秒", "09:00"):
            self.assertIn(method, ECOMMERCE_RULES)
        self.assertEqual([s["day"] for s in CTR_TEST_SCHEDULE], list(range(1, 8)))

    def test_detail_counter_does_not_treat_first_three_as_total(self):
        self.assertEqual(image_requirements("做60屏详情页，前三屏先说好处")["image_count"], 60)
        self.assertNotIn("image_count", image_requirements("详情页前三屏最重要"))

    def test_new_main_standard_does_not_rewrite_historical_task_quantity(self):
        task = normalize_agent_task({"status": "delivered", "brief": {"task_type": "main_image", "image_count": 2}})
        self.assertEqual(task["brief"]["image_count"], 2)

    def test_sku_rejects_product_changes_and_overlapping_layout(self):
        with self.assertRaises(VisualRuleError):
            normalize_values({"parameters": "20W", "gifts": "袋子", "attributes": "标准款", "product_color": "换蓝色"})
        layout = deepcopy(DEFAULT_LAYOUT)
        layout["gifts"]["box"] = layout["parameters"]["box"]
        with self.assertRaises(VisualRuleError):
            normalize_layout(layout)

    def test_sku_only_changes_fixed_information_rectangles(self):
        with tempfile.TemporaryDirectory(prefix="SKU像素验证-") as tmp:
            template = Path(tmp) / "模板.png"
            base = Image.new("RGB", (750, 750), "#e6d0b2")
            ImageDraw.Draw(base).rectangle((120, 80, 560, 490), fill="#653d22", outline="#242020", width=16)
            base.save(template)
            values = {"parameters": "容量20L", "gifts": "送收纳袋", "attributes": "月光白"}
            first = Image.open(io.BytesIO(render_sku_image(template, DEFAULT_LAYOUT, values))).convert("RGB")
            second = Image.open(io.BytesIO(render_sku_image(template, DEFAULT_LAYOUT,
                {**values, "parameters": "容量30L", "attributes": "曜石黑"}))).convert("RGB")
            self.assertIsNotNone(ImageChops.difference(first, second).getbbox())
            mask = Image.new("L", base.size, 255)
            draw = ImageDraw.Draw(mask)
            for spec in DEFAULT_LAYOUT.values():
                x, y, w, h = spec["box"]
                draw.rectangle((round(x * 750), round(y * 750), round((x+w)*750)-1, round((y+h)*750)-1), fill=0)
            self.assertIsNone(ImageChops.multiply(ImageChops.difference(first, base), mask.convert("RGB")).getbbox())
            self.assertIsNone(ImageChops.multiply(ImageChops.difference(first, second), mask.convert("RGB")).getbbox())

    def test_sku_overflow_fails_without_shrinking_font(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "template.png"
            Image.new("RGB", (750, 750), "white").save(path)
            with self.assertRaisesRegex(VisualRuleError, "不会单独缩小字号"):
                render_sku_image(path, DEFAULT_LAYOUT, {"parameters": "长文案" * 80, "gifts": "", "attributes": "标准款"})

    def test_bad_fonts_colors_and_small_type_are_rejected(self):
        framework = sku_plan()["visual_framework"]
        for bad in ({"palette": ["#111111"] * 4}, {"fonts": ["a", "b", "c", "d"]},
                    {"typography": {"title_pt": 40, "subtitle_pt": 24, "body_pt": 18, "line_extra_px": 10}}):
            with self.subTest(bad=bad), self.assertRaises(VisualRuleError):
                validate_framework({**framework, **bad})

    def test_missing_framework_can_be_completed_without_hiding_invalid_frameworks(self):
        framework = default_visual_framework(
            {"goal": "制作相框展示图", "style_direction": "米白与深灰，高端简洁"},
            {"direction": "统一正面机位", "rationale": "保持真实材质"},
        )
        self.assertEqual(framework["palette"], ["#F5F1E8", "#252525"])
        self.assertEqual(framework["brand"], "无Logo")
        self.assertEqual(validate_framework(framework)["product_pose"], "统一正面机位")
        with self.assertRaises(VisualRuleError):
            validate_framework({"palette": ["#F5F1E8"], "fonts": []})

    def test_missing_sku_scene_uses_product_constraints(self):
        scene = default_sku_scene({
            "product": {"name": "立体装裱相框", "constraints": ["米白色厚卡纸", "45度斜切开窗", "内嵌式装裱"]},
            "style_direction": "高端、简洁商业摄影",
        })
        self.assertIn("45度斜切开窗", scene)
        self.assertIn("同一背景、构图、机位、角度、光线", scene)

    def test_appearance_sku_is_not_mistaken_for_text_template(self):
        brief = {"series_mode": "sku", "goal": "15张SKU", "source_text": "原木、黑、浅木三种框色，内芯照片选自图5-9"}
        self.assertEqual(sku_series_mode(brief), "sku_variants")


if __name__ == "__main__":
    unittest.main()
