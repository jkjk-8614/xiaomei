"""Image annotations shared by the asset library and file-based collections."""

import asyncio
import json
from pathlib import Path
import re
from threading import RLock
import time

from fastapi import HTTPException
import httpx

import asset_kernel
import image_space
import media_formats


_DIMENSIONS = {
    "environment": ("环境", "室内、室外、自然环境或商业环境"),
    "scene": ("场景", "棚拍、街景、展陈等具体场景"),
    "space": ("空间", "客厅、展厅、街道等可见空间"),
    "subject": ("主体", "画面主要呈现的人、物品或景观"),
    "model": ("模特", "无人、单人或多人，以及模特在画面中的呈现方式"),
    "people": ("人物", "人物人数、动作及可见范围"),
    "style": ("风格", "纪实摄影、插画、三维渲染等视觉风格"),
    "lighting": ("光影", "主要光源、光线方向与明暗对比"),
    "color": ("色彩", "显著颜色、冷暖与饱和度"),
    "composition": ("构图", "景别、视角及主体在画面中的位置"),
    "mood": ("氛围", "画面呈现的情绪或气氛"),
    "use_case": ("用途", "适合的素材用途，如商品展示或构图参考"),
    "objects": ("物体", "能明确辨认的物体"),
    "materials": ("材质", "可以辨认的表面材质"),
    "quality": ("质量", "清晰度、水印和透明背景等图像特征"),
}
DIMENSION_NAMES = {key: name for key, (name, _) in _DIMENSIONS.items()}
_DEFAULT_STRUCTURE = {
    "summary": "概括画面主要内容",
    "categories": {key: [] for key in _DIMENSIONS},
    "tags": [],
}
DEFAULT_PROMPT = "\n".join((
    "根据图片内容生成素材检索标签。返回一个 JSON 对象，结构如下。",
    json.dumps(_DEFAULT_STRUCTURE, ensure_ascii=False, indent=2),
    "各维度的含义",
    *(f"{key} 表示{description}。" for key, (_, description) in _DIMENSIONS.items()),
    "用中文短语填写标签。每个维度最多 8 项，综合标签最多 20 项。",
    "摘要用一句话。只写图中有依据的内容，无法判断的维度留空。",
    "仅输出 JSON。",
))
_FIELDS = ("summary", "tags", "categories")
_SIDECAR_LOCK = RLock()


def load_prompt(path):
    try:
        value = Path(path).read_text(encoding="utf-8-sig").strip()
    except (OSError, UnicodeError):
        return DEFAULT_PROMPT
    return value or DEFAULT_PROMPT


def prompt_with_details(base, details):
    extra = str(details or "").strip()[:4000]
    return f"{base}\n\n本次分类的补充要求\n{extra}" if extra else base


def validate_prompt(value):
    prompt = str(value or "").strip()
    if not prompt:
        raise HTTPException(400, "分类规则不能为空")
    if len(prompt) > 20000:
        raise HTTPException(400, "分类规则过长")
    return prompt


def _now():
    return time.time_ns() // 1_000_000


def clean_fields(raw):
    record = raw if isinstance(raw, dict) else {}
    timestamp = record.get("updated_at")
    clock = timestamp if type(timestamp) is int and timestamp > 0 else _now()
    result = asset_kernel.clean_labels(record, clock, DIMENSION_NAMES)
    for key in ("model", "provider"):
        if isinstance(record.get(key), str) and record[key].strip():
            result[key] = record[key]
    return result


def normalize(raw):
    value = image_space.merge_classification(raw, clean_fields)
    if isinstance(raw, dict) and type(raw.get("updated_at")) is int and raw["updated_at"] > 0:
        value["updated_at"] = raw["updated_at"]
    return value


def replace_ai(previous, new):
    result = image_space.replace_ai(previous, new, clean_fields)
    result["updated_at"] = _now()
    return result


def edit_manual(previous, manual):
    record = previous if isinstance(previous, dict) else {}
    values = manual or {}
    if set(values) - set(_FIELDS):
        raise HTTPException(400, "分类仅支持说明、标签和分类维度")
    tags = values.get("tags", [])
    if not isinstance(values.get("summary", ""), str) or not _is_tag_list(tags):
        raise HTTPException(400, "说明须为文字，标签须为文字列表")
    groups = values.get("categories", {})
    if not isinstance(groups, dict) or not all(_is_tag_list(tags) for tags in groups.values()):
        raise HTTPException(400, "每个分类维度须为标签列表")
    clean = clean_fields(values)
    manual_fields = {key: clean[key] for key in ("summary", "tags") if key in values}
    if "categories" in values:
        manual_fields["categories"] = {key: clean["categories"].get(key, []) for key in groups if key in DIMENSION_NAMES}
    result = normalize({"ai": record.get("ai", record), "manual": manual_fields})
    result["updated_at"] = _now()
    return result


def _is_tag_list(value):
    return isinstance(value, list) and all(isinstance(tag, str) for tag in value)


def decode_classification(reply, *, provider, model):
    decoder = json.JSONDecoder()
    text = str(reply or "")
    for marker in re.finditer(r"\{", text):
        try:
            record, _ = decoder.raw_decode(text, marker.start())
        except json.JSONDecodeError:
            continue
        if not isinstance(record, dict):
            continue
        data = record.get("ai", record)
        if isinstance(data, dict) and set(_FIELDS).intersection(data):
            shapes = {"summary": str, "categories": dict, "tags": list}
            if all(key not in data or isinstance(data[key], shape) for key, shape in shapes.items()):
                result = normalize({**data, "provider": provider, "model": model})
                return result
    raise HTTPException(502, "模型没有返回可读取的分类结果。请检查分类规则后重试。")


def read_classification(path, *, updating=False):
    try:
        with Path(path).open(encoding="utf-8-sig") as handle:
            raw = json.load(handle)
        if not isinstance(raw, dict):
            raise ValueError("Expected an annotation object")
        manual = raw.get("manual")
        if manual is not None and not isinstance(manual, dict):
            raise ValueError("Invalid manual annotation")
        if manual and manual.get("categories") is not None and not isinstance(manual["categories"], dict):
            raise ValueError("Invalid manual categories")
        return normalize(raw)
    except FileNotFoundError:
        return None
    except (OSError, ValueError, TypeError) as exc:
        if updating:
            raise HTTPException(409, "现有分类文件无法读取，请检查文件后重试。") from exc
        return None


def save_file_classification(sidecar, update, write_json):
    with _SIDECAR_LOCK:
        value = update(read_classification(sidecar, updating=True))
        write_json(sidecar, value)
    return value


def _stamp(path):
    try:
        stat = Path(path).stat()
        return stat.st_dev, stat.st_ino, stat.st_size, stat.st_mtime_ns
    except FileNotFoundError:
        return None


def _check_media(media, before):
    if before is None or _stamp(media) != before:
        raise HTTPException(409, "分析期间素材已移动、删除或替换。请刷新后重试。")


async def classify_file(media, sidecar, classify, write_json):
    before = _stamp(media)
    result = await classify(media)
    with _SIDECAR_LOCK:
        _check_media(media, before)
        return save_file_classification(sidecar, lambda previous: replace_ai(previous, result), write_json)


async def caption_file(media, sidecar, caption, write_text):
    media_stamp = _stamp(media)
    sidecar_stamp = _stamp(sidecar)
    text, model = await caption(media)
    with _SIDECAR_LOCK:
        _check_media(media, media_stamp)
        if _stamp(sidecar) != sidecar_stamp:
            raise HTTPException(409, "分析期间提示词已修改。请刷新后重试。")
        write_text(sidecar, text)
    return text, model


def save_manual_caption(sidecar, text, write_text):
    with _SIDECAR_LOCK:
        write_text(sidecar, text)


async def batch(entries, field, annotate, *, defaults=None, failure=""):
    results = []
    for entry in entries:
        row = {field: entry, "ok": False, **(defaults or {})}
        try:
            row.update(await annotate(entry))
            row["ok"] = True
        except Exception as exc:
            detail = exc.detail if isinstance(exc, HTTPException) else exc
            row["error"] = str(detail or "") or failure
        results.append(row)
    return {"count": sum(row["ok"] for row in results), "items": results}


async def request_caption(path, prompt, endpoint, headers, model, *, timeout, non_streaming=False):
    image = await asyncio.to_thread(media_formats.reference_data_url, path, 1024, media_formats.content_type(path))
    parts = [{"type": "text", "text": prompt}, {"type": "image_url", "image_url": {"url": image}}]
    body = {"model": model, "messages": [{"role": "user", "content": parts}]}
    if non_streaming:
        body["stream"] = False
    async with httpx.AsyncClient(timeout=timeout) as client:
        response = await client.post(endpoint, headers=headers, json=body)
        response.raise_for_status()
        return response.json()
