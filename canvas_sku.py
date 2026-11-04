"""Canvas SKU composition: keep the confirmed template outside editable regions."""
from __future__ import annotations

import asyncio
import hashlib
import io
import json
import time
from pathlib import Path
from threading import Lock
from typing import Literal

from fastapi import APIRouter, HTTPException
from PIL import Image, ImageChops, ImageDraw, ImageFont, ImageOps
from pydantic import BaseModel, Field

from design_brain_visual_rules import cjk_font_path, normalize_layout, normalize_values, render_sku_image


DEFAULT_REGIONS = {
    "product": [0.04, 0.04, 0.64, 0.70],
    "gift_image": [0.72, 0.05, 0.24, 0.58],
}
DEFAULT_LAYOUT = {
    "attributes": {"box": [0.04, 0.78, 0.92, 0.08], "font_px": 32, "color": "#252525", "background": "#F5F1E8"},
    "parameters": {"box": [0.04, 0.88, 0.92, 0.08], "font_px": 26, "color": "#252525", "background": "#F5F1E8"},
    "gifts": {"box": [0.72, 0.65, 0.24, 0.09], "font_px": 26, "color": "#252525", "background": "#F5F1E8"},
}


class SkuComposeRequest(BaseModel):
    template_url: str = Field(min_length=1, max_length=4096)
    product_url: str = Field(default="", max_length=4096)
    gift_url: str = Field(default="", max_length=4096)
    clear_gift: bool = False
    candidate_url: str = Field(default="", max_length=4096)
    mode: Literal["text", "asset", "ai", "studio"] = "text"
    regions: dict = Field(default_factory=lambda: dict(DEFAULT_REGIONS))
    layout: dict = Field(default_factory=lambda: json.loads(json.dumps(DEFAULT_LAYOUT)))
    values: dict = Field(default_factory=dict)
    studio: dict = Field(default_factory=dict)
    copy_text: str = Field(default="", alias="copy", max_length=4000)
    gift_items: list[dict] = Field(default_factory=list)
    background: str = "#F5F1E8"
    name: str = Field(default="SKU", max_length=200)
    project_id: str = Field(default="", max_length=200)


class SkuLayoutRequest(BaseModel):
    regions: dict
    layout: dict
    background: str


class SkuStudioPlanRequest(BaseModel):
    width: int = Field(ge=256, le=12000)
    height: int = Field(ge=256, le=12000)
    copies: list[str]
    gift_names: list[str] = Field(default_factory=list)
    palette: dict = Field(default_factory=dict)


def _studio_box(raw):
    import math
    if not isinstance(raw, list) or len(raw) != 4:
        raise ValueError("样板区域格式无效，请重新制作样板")
    x, y, w, h = map(float, raw)
    if not all(math.isfinite(v) for v in (x, y, w, h)) or not (0 <= x < 1 and 0 <= y < 1 and w > 0 and h > 0 and x+w <= 1.000001 and y+h <= 1.000001):
        raise ValueError("样板区域超出图片，请重新制作样板")
    return x, y, w, h


def _studio_rect(box, size):
    x, y, w, h = _studio_box(box)
    width, height = size
    return tuple(round(v) for v in (x*width, y*height, (x+w)*width, (y+h)*height))


def _studio_lines(text, font, width):
    import math
    draw = ImageDraw.Draw(Image.new("RGB", (1, 1)))
    lines = []
    for paragraph in text.split("\n"):
        paragraph_start = len(lines)
        total_width = draw.textlength(paragraph, font=font)
        line_count = max(1, math.ceil(total_width/width))
        target = total_width/line_count
        line = ""
        for char in paragraph:
            if draw.textlength(char, font=font) > width:
                raise ValueError("SKU 文字超出样板区域，请调整整组排版")
            previous_width = draw.textlength(line, font=font)
            next_width = draw.textlength(line+char, font=font)
            if line and (next_width > width or
                         (len(lines)-paragraph_start < line_count-1 and next_width > target and
                          abs(previous_width-target) <= abs(next_width-target))):
                lines.append(line)
                line = ""
            line += char
        lines.append(line)
    return lines


def _studio_text(draw, text, rect, font, color, padding, title_font=None):
    if not text.strip():
        return rect[1]
    left, top, right, bottom = rect
    y = top + padding
    for index, paragraph in enumerate(text.strip().splitlines()):
        current = title_font if index == 0 and title_font else font
        ascent, descent = current.getmetrics()
        step = ascent + descent + max(2, round(current.size*.28))
        for line in _studio_lines(paragraph, current, right-left-2*padding):
            if y + ascent + descent > bottom-padding:
                raise ValueError("SKU 文案超出样板区域，请缩短文案后重新制作整组样板")
            draw.text((left+padding, y), line, font=current, fill=color, anchor="lt")
            y += step
        if index == 0 and title_font:
            y += padding
    return y + padding


def studio_plan(payload):
    import re
    if payload.width*payload.height > 40_000_000:
        raise ValueError("SKU 单图超过4000万像素，请降低清晰度")
    if not payload.copies or any(not isinstance(v, str) or len(v) > 4000 for v in payload.copies):
        raise ValueError("请先完成每款的文案分析，再制作样板")
    if any(not isinstance(v, str) or not v.strip() or len(v) > 160 for v in payload.gift_names):
        raise ValueError("请为每张赠品图片填写名称，可同时填写已确认的数量")
    palette = {"text": "#252525", "panel": "#FAF8F3", "accent": "#91714E"}
    for key in palette:
        if key in payload.palette:
            color = payload.palette[key]
            if not isinstance(color, str) or not re.fullmatch(r"#[0-9a-fA-F]{6}", color):
                raise ValueError("样板配色格式无效，请重新分析模板")
            palette[key] = color.upper()
    if palette["text"] == palette["panel"]:
        raise ValueError("样板文字色与底色相同，请重新分析模板")
    count = len(payload.gift_names)
    columns = min(count, 4) if count else 0
    rows = (count+columns-1)//columns if count else 0
    gift_height = rows*.18
    if gift_height > .54:
        raise ValueError("赠品图片过多，无法在样板中清晰展示，请合并为图片组后重试")
    content_bottom = .94-gift_height-(.03 if count else 0)
    plan = {"version": 1, "width": payload.width, "height": payload.height,
            "product": [.04, .06, .59, content_bottom-.06],
            "copy": [.67, .06, .29, content_bottom-.06],
            "gifts": [.04, content_bottom+.03, .92, gift_height] if count else None,
            "gift_names": [v.strip() for v in payload.gift_names], "columns": columns,
            "font_px": 27, "title_px": 38, "palette": palette}
    # Check every SKU before a paid background request; one font size serves the series.
    font_path = str(cjk_font_path())
    scale = payload.width/750
    font = ImageFont.truetype(font_path, max(1, round(plan["font_px"]*scale)))
    title = ImageFont.truetype(font_path, max(1, round(plan["title_px"]*scale)))
    draw = ImageDraw.Draw(Image.new("RGB", (1, 1)))
    copy_rect = _studio_rect(plan["copy"], (payload.width, payload.height))
    copy_bottom = max(_studio_text(draw, copy, copy_rect, font, palette["text"],
                                  max(2, round(12*scale)), title) for copy in payload.copies)
    plan["copy"][3] = min(plan["copy"][3], max(.12, (copy_bottom-copy_rect[1])/payload.height))
    if count:
        cell_width = round(.92*payload.width)//columns
        label_height = round(48*scale)
        for name in plan["gift_names"]:
            _studio_text(draw, name, (0, 0, cell_width, label_height), font, palette["text"], max(2, round(3*scale)))
    return plan


def compose_studio(payload, resolve):
    import re
    plan = payload.studio
    if plan.get("version") != 1:
        raise ValueError("样板排版版本无效，请重新制作样板")
    size = (int(plan.get("width", 0)), int(plan.get("height", 0)))
    if min(size) < 256 or max(size) > 12000 or size[0]*size[1] > 40_000_000:
        raise ValueError("样板尺寸无效，请重新制作样板")
    boxes = [plan.get("product"), plan.get("copy")]
    if plan.get("gifts"):
        boxes.append(plan["gifts"])
    normalized = [_studio_box(box) for box in boxes]
    for i, (x, y, w, h) in enumerate(normalized):
        for a, b, c, d in normalized[i+1:]:
            if x < a+c and a < x+w and y < b+d and b < y+h:
                raise ValueError("样板的商品、文案与赠品区域重叠，请重新制作样板")
    palette = plan.get("palette", {})
    if set(palette) != {"text", "panel", "accent"} or any(not isinstance(v, str) or not re.fullmatch(r"#[0-9a-fA-F]{6}", v) for v in palette.values()):
        raise ValueError("样板配色无效，请重新制作样板")
    if palette["text"].upper() == palette["panel"].upper():
        raise ValueError("样板文字色与底色相同，请重新制作样板")
    names = plan.get("gift_names", [])
    if not isinstance(names, list) or len(names) != len(payload.gift_items) or any(not isinstance(n, str) or not n.strip() or len(n) > 160 for n in names):
        raise ValueError("赠品与样板不一致，请重新制作样板")
    if bool(names) != bool(plan.get("gifts")):
        raise ValueError("样板缺少赠品区域，请重新制作样板")

    def open_image(url):
        path = resolve(url)
        if not path or not Path(path).is_file():
            raise ValueError("SKU 图片不可读取，请重新选择对应素材")
        with Image.open(path) as source:
            if source.width*source.height > 40_000_000:
                raise ValueError("SKU 单图超过4000万像素，请缩小后重试")
            return ImageOps.exif_transpose(source).convert("RGBA")

    with open_image(payload.template_url) as background:
        if background.size != size:
            raise ValueError("背景实际尺寸与样板不一致，请重新制作样板")
        result = background.convert("RGB")
    before = result.copy()
    try:
        def place(url, rect):
            with open_image(url) as original:
                bounds = original.getchannel("A").getbbox()
                if not bounds:
                    raise ValueError("SKU 素材完全透明，请重新选择图片")
                trimmed = original.crop(bounds)
                fitted = ImageOps.contain(trimmed, (rect[2]-rect[0], rect[3]-rect[1]), Image.Resampling.LANCZOS)
                at = (rect[0]+(rect[2]-rect[0]-fitted.width)//2, rect[1]+(rect[3]-rect[1]-fitted.height)//2)
                result.paste(fitted, at, fitted)
                fitted.close()
                trimmed.close()

        if not payload.product_url:
            raise ValueError("请选择本款产品图后重试")
        place(payload.product_url, _studio_rect(plan["product"], size))
        scale = size[0]/750
        font_path = str(cjk_font_path())
        sizes = [float(plan.get(k, 0)) for k in ("font_px", "title_px")]
        if not all(20 <= v <= 80 for v in sizes):
            raise ValueError("样板字号无效，请重新制作样板")
        font, title = [ImageFont.truetype(font_path, max(1, round(v*scale))) for v in sizes]
        padding = max(2, round(12*scale))
        draw = ImageDraw.Draw(result)
        if payload.copy_text.strip():
            rect = _studio_rect(plan["copy"], size)
            draw.rounded_rectangle((rect[0], rect[1], rect[2]-1, rect[3]-1), radius=round(12*scale), fill=palette["panel"])
            _studio_text(draw, payload.copy_text, rect, font, palette["text"], padding, title)
        if names:
            left, top, right, bottom = _studio_rect(plan["gifts"], size)
            columns = int(plan.get("columns", 0))
            if not 1 <= columns <= 4:
                raise ValueError("赠品排版无效，请重新制作样板")
            rows = (len(names)+columns-1)//columns
            cell_w, cell_h = (right-left)//columns, (bottom-top)//rows
            for i, (name, item) in enumerate(zip(names, payload.gift_items)):
                if item.get("name") != name or not item.get("url"):
                    raise ValueError("赠品名称与图片绑定已改变，请重新制作样板")
                x, y = left+(i%columns)*cell_w, top+(i//columns)*cell_h
                label_height = round(48*scale)
                rect = (x+padding, y, x+cell_w-padding, y+cell_h-label_height)
                if rect[3]-rect[1] < 1:
                    raise ValueError("赠品区域过小，请调整画幅后重新制作样板")
                place(item["url"], rect)
                label_rect = (x, y+cell_h-label_height, x+cell_w, y+cell_h)
                draw.rounded_rectangle((label_rect[0], label_rect[1], label_rect[2]-1, label_rect[3]-1), radius=round(6*scale), fill=palette["panel"])
                _studio_text(draw, name, label_rect, font, palette["text"], max(2, round(3*scale)))
        mask = Image.new("L", size, 255)
        for box in boxes:
            l, t, r, b = _studio_rect(box, size)
            ImageDraw.Draw(mask).rectangle((l, t, r-1, b-1), fill=0)
        diff = ImageChops.difference(before, result)
        if ImageChops.multiply(diff, Image.merge("RGB", (mask, mask, mask))).getbbox():
            raise ValueError("成图超出固定区域，已停止保存，请重新制作样板")
        buffer = io.BytesIO()
        result.save(buffer, "PNG")
        return buffer.getvalue(), {"width": size[0], "height": size[1], "fixed_outside_regions": True,
                "checks": {"layout": "passed", "copy": "passed", "gift_bindings": "passed", "product_source": "original"},
                "review_required": True}
    finally:
        result.close()
        before.close()


def validate_composition(payload):
    import math
    import re

    layout = normalize_layout(payload.layout)
    values = normalize_values(payload.values)
    if set(payload.regions) != set(DEFAULT_REGIONS):
        raise ValueError("样板缺少商品或赠品图片区，请重新识别样板")
    regions = {}
    for name, raw in payload.regions.items():
        if not isinstance(raw, list) or len(raw) != 4:
            raise ValueError("AI 返回的区域格式不完整，请重新识别样板")
        x, y, w, h = map(float, raw)
        if not all(math.isfinite(v) for v in (x, y, w, h)) or not (
            0 <= x < 1 and 0 <= y < 1 and w > 0 and h > 0 and x+w <= 1.000001 and y+h <= 1.000001
        ):
            raise ValueError("AI 判断的区域超出样板，请重新识别样板")
        regions[name] = [x, y, w, h]
    boxes = list(regions.values()) + [v["box"] for v in layout.values()]
    for i, (x, y, w, h) in enumerate(boxes):
        for a, b, c, d in boxes[i+1:]:
            if x < a+c-1e-8 and a < x+w-1e-8 and y < b+d-1e-8 and b < y+h-1e-8:
                raise ValueError("商品、赠品与文字区域重叠，请重新识别样板")
    if not re.fullmatch(r"#[0-9a-fA-F]{6}", payload.background):
        raise ValueError("AI 判断的区域底色无效，请重新识别样板")
    colors = {payload.background.upper()}
    colors.update(spec[key].upper() for spec in layout.values() for key in ("color", "background"))
    if len(colors) > 3:
        raise ValueError("SKU 文字和区域底色合计最多使用三种设计配色")
    if payload.mode == "asset" and not payload.product_url:
        raise ValueError("替换产品图时，请选择本款的产品素材")
    if payload.mode == "ai" and not payload.candidate_url:
        raise ValueError("本款换款图片尚未完成，请先等待生成或重试")
    return regions, layout, values


def compose_sku(payload, resolve):
    if payload.mode == "studio":
        return compose_studio(payload, resolve)
    regions, layout, values = validate_composition(payload)

    def open_local(url):
        path = resolve(url)
        if not path or not Path(path).is_file():
            raise ValueError("SKU 图片不可读取，请重新上传或从画布中选择图片")
        with Image.open(path) as source:
            if source.width * source.height > 40_000_000:
                raise ValueError("SKU 单图超过4000万像素，请缩小后重试")
            oriented = ImageOps.exif_transpose(source)
            try:
                return oriented.convert("RGBA")
            finally:
                if oriented is not source:
                    oriented.close()

    with open_local(payload.template_url) as template:
        result = template.convert("RGB")
    try:
        width, height = result.size

        def rectangle(box):
            x, y, w, h = box
            return tuple(round(v) for v in (x*width, y*height, (x+w)*width, (y+h)*height))

        if payload.clear_gift:
            result.paste(payload.background, rectangle(regions["gift_image"]))

        if payload.mode == "ai":
            with open_local(payload.candidate_url) as candidate:
                if abs(candidate.width/candidate.height - width/height) > (width/height)*0.01:
                    raise ValueError("换款图与样板比例不同，请使用与样板相同的画幅重新生成")
                scaled = candidate.convert("RGB").resize(result.size, Image.Resampling.LANCZOS)
                try:
                    box = rectangle(regions["product"])
                    result.paste(scaled.crop(box), box[:2])
                finally:
                    scaled.close()
        for region, url in (("product", payload.product_url if payload.mode == "asset" else ""),
                            ("gift_image", payload.gift_url)):
            if not url:
                continue
            box = rectangle(regions[region])
            size = (box[2]-box[0], box[3]-box[1])
            if min(size) < 1:
                raise ValueError("替换区域过小，请放大区域后重试")
            with open_local(url) as source:
                fitted = ImageOps.contain(source, size, Image.Resampling.LANCZOS)
                try:
                    result.paste(payload.background, box)
                    at = (box[0]+(size[0]-fitted.width)//2, box[1]+(size[1]-fitted.height)//2)
                    result.paste(fitted, at, fitted)
                finally:
                    fitted.close()
        buffer = io.BytesIO()
        result.save(buffer, "PNG")
        buffer.seek(0)
        content = render_sku_image(buffer, layout, values)
        return content, {"width": width, "height": height, "fixed_outside_regions": True}
    finally:
        result.close()


def create_sku_router(resolve, save_image, register_media, save_history):
    router = APIRouter(prefix="/api/canvas-sku", tags=["canvas-sku"])
    lock = Lock()
    slots = asyncio.Semaphore(2)

    @router.get("/defaults")
    async def defaults():
        return {"regions": DEFAULT_REGIONS, "layout": DEFAULT_LAYOUT, "background": "#F5F1E8"}

    @router.post("/validate-layout")
    async def validate_layout(payload: SkuLayoutRequest):
        try:
            if set(payload.layout) != {"parameters", "gifts", "attributes"}:
                raise ValueError("AI 判断的文字区域不完整，请重新识别样板")
            regions, layout, _ = validate_composition(SkuComposeRequest(
                template_url="layout-validation", **payload.model_dump(),
                values={"parameters": "", "gifts": "", "attributes": ""},
            ))
            return {"regions": regions, "layout": layout, "background": payload.background}
        except (ValueError, TypeError, KeyError) as exc:
            raise HTTPException(422, str(exc) if isinstance(exc, ValueError) else "AI 判断的版式数据无效，请重新识别样板") from exc

    @router.post("/studio-plan")
    async def plan_studio(payload: SkuStudioPlanRequest):
        try:
            return await asyncio.to_thread(studio_plan, payload)
        except (ValueError, TypeError, KeyError, OSError) as exc:
            raise HTTPException(422, str(exc) if isinstance(exc, ValueError) else "样板排版失败，请检查素材和文案后重试") from exc

    def render(payload):
        content, report = compose_sku(payload, resolve)
        digest = hashlib.sha256(content + payload.project_id.encode("utf-8")).hexdigest()
        # The deterministic filename also makes a lost HTTP response safe to retry.
        with lock:
            filename = "sku_" + digest + ".png"
            with Image.open(io.BytesIO(content)) as image:
                url = save_image(image, filename, cached=True)
            existing = register_media(url, name=payload.name+".png", kind="image", source="generated",
                                      derived_from=list(filter(None, [payload.template_url, payload.product_url,
                                                                     payload.gift_url, payload.candidate_url, *[item.get("url") for item in payload.gift_items]])),
                                      metadata={"operation": "sku-template", "paid_api": False}) or {}
            result = {"url": url, "name": payload.name+".png", "kind": "image",
                      "asset_ref_id": existing.get("id", ""), **report}
            # Persist once alongside the output, including history identity for response recovery.
            output_path = resolve(url)
            receipt = Path(output_path).with_suffix(".sku.json") if output_path else None
            if receipt and receipt.is_file():
                return json.loads(receipt.read_text(encoding="utf-8"))
            record = {"type": "canvas", "history_source": "canvas", "project_id": payload.project_id,
                      "prompt": payload.name, "model": "sku-template", "images": [url],
                      "image_items": [result], "timestamp": time.time(),
                      "params": {"operation": "sku-template", **payload.model_dump(by_alias=True), "paid_api": False}}
            save_history(record)
            result["history_timestamp"] = record["timestamp"]
            if receipt:
                receipt.write_text(json.dumps(result, ensure_ascii=False), encoding="utf-8")
            return result

    @router.post("/compose")
    async def compose(payload: SkuComposeRequest):
        try:
            async with slots:
                return await asyncio.to_thread(render, payload)
        except (ValueError, OSError) as exc:
            message = str(exc)
            if "文案超出固定信息位" in message:
                message = "SKU 文案超出样板区域，请缩短文案，或重新选择样板让 AI 重新判断排版"
            raise HTTPException(422, message) from exc

    return router
