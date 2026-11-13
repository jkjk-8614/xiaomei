"""Translate canvas dimensions and reference images to an Ark image request."""

from dataclasses import dataclass
import math
import re

from fastapi import HTTPException

from gpt_image_dimensions import parse_size_pair


@dataclass(frozen=True)
class ImageLimits:
    minimum: int
    maximum: int
    references: int


_STANDARD = ImageLimits(3_686_400, 16_777_216, 14)
_COMPACT = ImageLimits(921_600, 4_624_220, 10)
_MODEL = re.compile(r"(?:doubao-)?seedream-(5-0(?:-pro|-flash|-lite)?|4-5|4-0)(?:-\d{6})?")
_LIMITS = {
    "5-0": _STANDARD, "5-0-lite": _STANDARD, "4-5": _STANDARD,
    "5-0-pro": _COMPACT, "5-0-flash": _COMPACT,
    "4-0": ImageLimits(921_600, 16_777_216, 14),
}
_SQUARES = {"1k": 1024, "1.5k": 1536, "2k": 2048, "3k": 3072, "4k": 4096}
_RATIO_LIMIT = 16


def _limits(model):
    key = re.sub(r"[^a-z0-9]+", "-", str(model or "").strip().lower()).strip("-")
    match = _MODEL.fullmatch(key)
    return _LIMITS[match[1]] if match else None


def reference_limit(model, application_limit):
    limits = _limits(model)
    return min(application_limit, limits.references) if limits else application_limit


def _fit(width, height, limits):
    large, small = max(width, height), min(width, height)
    pixels = width * height
    if limits.minimum <= pixels <= limits.maximum and large <= _RATIO_LIMIT * small:
        return width, height

    ratio = min(large / small, _RATIO_LIMIT)
    area = max(limits.minimum, min(limits.maximum, pixels))
    lower = math.ceil(math.sqrt(limits.minimum / ratio))
    upper = math.floor(math.sqrt(limits.maximum / ratio))
    short_edge = max(lower, min(upper, round(math.sqrt(area / ratio))))
    long_floor = max(short_edge, (limits.minimum + short_edge - 1) // short_edge)
    long_ceiling = min(_RATIO_LIMIT * short_edge, limits.maximum // short_edge)
    long_edge = max(long_floor, min(long_ceiling, round(short_edge * ratio)))
    return (long_edge, short_edge) if width >= height else (short_edge, long_edge)


def output_size(value, model=""):
    limits = _limits(model)
    width, height = parse_size_pair(value)
    if not width or not height:
        hint = str(value or "").strip().lower()
        if limits or hint in {"2k", "4k"}:
            width = height = _SQUARES.get(hint, 2048)
        elif "seedream" in str(model or "").lower():
            return "2048x2048"
        else:
            return value or "1024x1024"
    if limits:
        width, height = _fit(width, height, limits)
    return f"{width}x{height}"


def request_body(prompt, size, model, references, *, encode, application_limit):
    body = dict(model=model, prompt=prompt, size=output_size(size, model), response_format="url")
    images = [address for ref in (references or ())[:application_limit] if (address := encode(ref, max_size=1536))]
    maximum = reference_limit(model, application_limit)
    if len(images) > maximum:
        raise HTTPException(400, f"当前方舟模型最多支持 {maximum} 张参考图，请减少参考图后重试。")
    if images:
        body["image"] = images
    return body
