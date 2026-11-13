"""Build RunningHub request inputs from model definitions and saved workflow fields."""

import math
import random
import re
from decimal import Decimal, InvalidOperation
from functools import cmp_to_key

from fastapi import HTTPException


MEDIA_FIELDS = ("image", "video", "audio")
_FIELD_TYPES = {
    "IMAGE": "image", "VIDEO": "video", "AUDIO": "audio",
    "SLIDER": "slider", "BOOLEAN": "boolean", "BOOL": "boolean",
    "NUMBER": "number", "FLOAT": "number", "INTEGER": "number", "INT": "number",
}
_MEDIA_PATTERNS = (
    ("image", r"\b(image|img|mask|photo|picture)\b|\.(png|jpe?g|webp|gif|bmp)(\?|$)"),
    ("video", r"\b(video|movie|mp4)\b|\.(mp4|webm|mov|m4v|mkv)(\?|$)"),
    ("audio", r"\b(audio|sound|music|voice)\b|\.(mp3|wav|ogg|m4a|flac|aac)(\?|$)"),
)
_PROMPT_FIELD = re.compile(r"prompt|positive|negative|text|caption|description|关键词|提示词|正向|负向", re.I)
_SEED_FIELD = re.compile(r"seed|noise|随机|种子|噪", re.I)
_MAX_SEED = (1 << 32) - 1
_FIRST_FRAME = ("firstFrameUrl", "first_frame_url", "firstFrameImage", "first_frame_image")
_LAST_FRAME = ("lastFrameUrl", "last_frame_url", "lastFrameImage", "last_frame_image")


def _name(field, key):
    return str(field.get(key) or "").strip()


def _choices(field):
    values = (entry.get("value") if isinstance(entry, dict) else entry for entry in field.get("options") or [])
    return [str(value) for value in values if value is not None and value != ""]


def _option(field, value):
    choices = _choices(field)
    preferred = str(value).strip() if value is not None else ""
    if preferred and (not choices or preferred in choices):
        return preferred
    default = field.get("defaultValue")
    if default is not None and default != "":
        return default
    return choices[0] if choices else preferred


class ModelInputs:
    def __init__(self, parameters, prompt):
        self.fields = [field for field in parameters if isinstance(field, dict)]
        self.body = {"prompt": prompt}

    def find(self, *aliases):
        wanted = {key.lower() for key in aliases}
        return next((field for field in self.fields
                     if wanted.intersection(_name(field, key).lower() for key in ("fieldKey", "label"))), None)

    def set(self, key, value, *, option=True):
        field = self.find(key)
        if field is not None:
            self.body[_name(field, "fieldKey") or key] = _option(field, value) if option else value
        return field is not None

    def references(self, field, urls, *, fallback=""):
        key = _name(field or {}, "fieldKey") or fallback
        if urls and key and key not in self.body:
            self.body[key] = urls if key.endswith("s") or (field or {}).get("multipleInputs") is True else urls[0]
        return key

    def finish(self):
        for field in self.fields:
            key = _name(field, "fieldKey")
            if not key or key in self.body:
                continue
            value = field.get("defaultValue")
            if value is None or value == "":
                choices = _choices(field)
                if field.get("required") is not True or not choices:
                    continue
                value = choices[0]
            kind = _name(field, "type").upper()
            convert = {"INT": int, "INTEGER": int, "FLOAT": float}.get(kind)
            if kind == "BOOLEAN":
                value = value.lower() == "true" if isinstance(value, str) else bool(value)
            elif convert is not None:
                try:
                    value = convert(value)
                except (TypeError, ValueError, OverflowError):
                    pass
            self.body[key] = value
        return self.body


def size_hints(size, dimensions, *, aspect_default="1:1", resolution_default="2k"):
    width, height = dimensions
    if width and height:
        scale = math.gcd(width, height)
        pixels = max(width, height)
        return f"{width // scale}:{height // scale}", "4k" if pixels >= 3200 else "2k" if pixels >= 1400 else "1k"
    text = str(size or "").strip().lower()
    aspect = text.replace(" ", "") if re.fullmatch(r"(auto|\d+\s*:\s*\d+)", text) else aspect_default
    choices = {"1k", "2k", "4k", "480p", "720p", "1080p", "native1080p"}
    return aspect, text if text in choices else resolution_default


def model_image_body(parameters, prompt, size, dimensions, urls):
    request = ModelInputs(parameters, prompt)
    aspect, resolution = size_hints(size, dimensions)
    if not request.set("aspectRatio", aspect):
        request.set("ratio", aspect)
    request.set("resolution", resolution)
    if all(dimensions):
        request.set("width", dimensions[0], option=False)
        request.set("height", dimensions[1], option=False)
    request.set("quality", "medium")
    request.references(request.find("imageUrls", "imageUrl", "images", "image"), urls, fallback="imageUrls")
    return request.finish()


def image_to_video(*names):
    for name in names:
        mode = re.sub(r"[\s_/]+", "-", str(name or "").strip().lower())
        if "image-to-video" in mode or "-i2v" in mode or mode.endswith("i2v"):
            return True
    return False


def model_video_body(parameters, payload, refs, needs_image):
    request = ModelInputs(parameters, str(payload.prompt or ""))
    aspect = str(payload.aspect_ratio or "").strip() or "16:9"
    dimensions = {"9:16": "720x1280", "1:1": "1024x1024", "4:3": "1024x768", "3:4": "768x1024"}
    request.set("aspectRatio", aspect)
    request.set("ratio", aspect)
    request.set("size", dimensions.get(aspect, "1280x720"))
    request.set("duration", max(1, min(60, int(payload.duration or 5))))
    request.set("resolution", str(payload.resolution or "720p").lower())
    request.set("generateAudio", bool(payload.generate_audio), option=False)
    request.set("watermark", bool(payload.watermark), option=False)

    urls = [url for url, _ in refs]
    first_field = request.find(*_FIRST_FRAME)
    last_field = request.find(*_LAST_FRAME)
    if urls:
        first = next((url for url, role in refs if role in {"first", "first_frame"}), urls[0])
        last = next((url for url, role in refs if role in {"last", "last_frame"}), urls[1] if len(urls) > 1 else "")
        if first_field is not None:
            request.body[_name(first_field, "fieldKey")] = first
        if last_field is not None and last:
            request.body[_name(last_field, "fieldKey")] = last
        image_field = request.find("imageUrls", "image_urls", "imageUrl", "image_url", "referenceImages", "referenceImageUrls")
        bound = request.references(image_field, urls)
        if not bound and needs_image:
            request.body.setdefault("firstFrameUrl", first)
    if (first_field is not None or needs_image) and not urls:
        raise HTTPException(status_code=400, detail="当前 RunningHub 模型是图生视频，需要连接一张首帧图片后再生成。")
    return request.finish()


def _field_kind(field):
    field_type = _name(field, "fieldType").upper()
    known = _FIELD_TYPES.get(field_type)
    if known:
        return known
    name = _name(field, "fieldName")
    if field_type == "TEXT" and _PROMPT_FIELD.search(name):
        return "text"
    text = name + " " + _name(field, "fieldValue")
    return next((kind for kind, pattern in _MEDIA_PATTERNS if re.search(pattern, text, re.I)), "text")


def _image_order(field):
    try:
        return int(field.get("imageOrder") or 0) or 9999
    except (TypeError, ValueError, OverflowError):
        return 9999


def _compare_fields(left, right):
    image_left = _field_kind(left) == "image"
    image_right = _field_kind(right) == "image"
    if image_left != image_right:
        return -1 if image_left else 1
    if image_left:
        order = _image_order(left) - _image_order(right)
        if order:
            return order
    a, b = _name(left, "nodeId"), _name(right, "nodeId")
    if a.isdigit() and b.isdigit():
        order = int(a) - int(b)
    else:
        order = (a > b) - (a < b)
    if order:
        return order
    a, b = _name(left, "fieldName"), _name(right, "fieldName")
    return (a > b) - (a < b)


def _default(field):
    value = field.get("fieldValue")
    if isinstance(value, list):
        value = next(iter(value), None)
    return "" if value is None or isinstance(value, dict) else str(value)


def _seed_name(*parts):
    return any(_SEED_FIELD.search(str(value or "")) for value in parts)


def _safe_seed(value):
    if isinstance(value, bool):
        return value
    try:
        number = Decimal(str(value).strip())
        if not number.is_finite() or not math.isfinite(float(number)):
            return value
        integer = int(number)
    except (InvalidOperation, TypeError, ValueError, OverflowError):
        return value
    if 0 <= integer <= _MAX_SEED:
        return value
    bounded = 1 + (abs(integer) - 1) % _MAX_SEED
    return str(bounded) if isinstance(value, str) else bounded


def sanitize_workflow(value, parent=""):
    if isinstance(value, dict):
        return {key: sanitize_workflow(item, key) for key, item in value.items()}
    if isinstance(value, list):
        return [sanitize_workflow(item, parent) for item in value]
    return _safe_seed(value) if _seed_name(parent) else value


def sanitize_fields(items):
    sanitized = []
    for item in items or []:
        if isinstance(item, dict):
            field = item.copy()
            if _seed_name(*(field.get(key) for key in ("fieldName", "label", "note"))):
                field["fieldValue"] = _safe_seed(field.get("fieldValue"))
            sanitized.append(field)
    return sanitized


def _float_or(value, fallback):
    try:
        number = float(value)
        return number if math.isfinite(number) else fallback
    except (TypeError, ValueError, OverflowError):
        return fallback


def _random_value(field):
    seed = _seed_name(*(field.get(key) for key in ("fieldName", "label", "note")))
    upper = float(_MAX_SEED if seed else 999999)
    low = _float_or(field.get("min"), 0.0)
    high = _float_or(field.get("max"), upper)
    if seed:
        low, high = max(0.0, min(low, upper)), max(0.0, min(high, upper))
    low, high = sorted((low, high))
    step = _float_or(field.get("step"), 1.0)
    value = random.uniform(low, high)
    if step > 0:
        value = min(high, low + round((value - low) / step) * step)
    return str(int(round(value)) if step.is_integer() and low.is_integer() and high.is_integer() else value)


def workflow_image_fields(fields, files, prompt, size, dimensions):
    selected = sorted((field for field in fields if isinstance(field, dict) and field.get("enabled") is True),
                      key=cmp_to_key(_compare_fields))
    aspect, resolution = size_hints(size, dimensions, aspect_default="", resolution_default="")
    size_values = {"width": dimensions[0], "height": dimensions[1], "resolution": resolution,
                   "aspectratio": aspect, "aspect_ratio": aspect, "ratio": aspect}
    values = iter(files)
    output = []
    for field in selected:
        node_id, field_name = _name(field, "nodeId"), _name(field, "fieldName")
        if not node_id or not field_name:
            continue
        kind = _field_kind(field)
        if kind == "image":
            value = next(values, "") or (_default(field) if field.get("required") is True else "")
            if not value:
                continue
        elif kind in MEDIA_FIELDS:
            continue
        elif kind == "number" and field.get("random_enabled") is True:
            value = _random_value(field)
        elif kind == "text" and _PROMPT_FIELD.search(" ".join(_name(field, key) for key in ("fieldName", "label", "group"))):
            value = str(prompt or "").strip() or _default(field)
        else:
            names = {_name(field, key).lower() for key in ("fieldName", "fieldKey", "label")}
            value = next((preferred for key, preferred in size_values.items() if key in names and preferred), None)
            if value is None:
                value = _default(field)
            elif isinstance(value, str):
                value = _option(field, value)
        output.append({"nodeId": node_id, "fieldName": field_name, "fieldValue": value})
    return output
