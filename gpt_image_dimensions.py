"""Pixel dimensions and aspect ratios shared by the canvas image routes."""

import math
import re


GPT_IMAGE2_MAX_EDGE = 3840
GPT_IMAGE2_MAX_PIXELS = 8_294_400
GPT_IMAGE2_MIN_PIXELS = 655_360
_STEP = 16

CHAT_RATIO_SIZE_OPTIONS = {
    (1, 1): ("1024x1024", "1536x1536", "2048x2048"),
    (2, 3): ("720x1080", "1024x1536", "1365x2048"),
    (3, 2): ("1080x720", "1536x1024", "2048x1365"),
    (3, 4): ("1008x1344", "1536x2048", "2448x3264"),
    (4, 3): ("1344x1008", "2048x1536", "3264x2448"),
    (9, 16): ("720x1280", "1080x1920", "1440x2560"),
    (16, 9): ("1280x720", "1920x1080", "2560x1440"),
}
GPT_IMAGE2_AUTO_RATIO_SIZES = {
    "1:1": "2880x2880", "2:3": "2352x3520", "3:2": "3520x2352",
    "3:4": "2448x3264", "4:3": "3264x2448", "5:4": "3840x3072", "4:5": "3072x3840",
    "9:16": "2160x3840", "16:9": "3840x2160", "21:9": "3840x1648",
}
_PIXEL_PAIR = re.compile(r"\s*(\d+)\s*[xX*]\s*(\d+)\s*")
_CHAT_PIXELS = re.compile(r"(?<!\d)([1-9]\d{2,4})\s*[xX×*]\s*([1-9]\d{2,4})(?!\d)")
_CHAT_RATIO = re.compile(r"(?<!\d)(1|2|3|4|9|16)\s*:\s*(1|2|3|4|9|16)(?!\d)")
_RATIO_SEPARATORS = str.maketrans("：﹕∶比／/", "::::::")


def parse_size_pair(size):
    match = _PIXEL_PAIR.fullmatch(str(size or ""))
    if match is not None:
        try:
            return tuple(map(int, match.groups()))
        except ValueError:
            pass
    return 0, 0


def chat_prompt_size_override(message, current_size=""):
    text = str(message or "")
    pixels = _CHAT_PIXELS.search(text)
    if pixels:
        width, height = map(int, pixels.groups())
        if min(width, height) >= 256:
            return f"{width}x{height}"
    ratio = _CHAT_RATIO.search(text.translate(_RATIO_SEPARATORS))
    sizes = CHAT_RATIO_SIZE_OPTIONS.get(tuple(map(int, ratio.groups()))) if ratio else None
    if not sizes:
        return ""
    edge = max(parse_size_pair(current_size))
    if edge >= 2400 or re.search(r"(?i)\b4\s*k\b|4K|超清|超高分辨率", text):
        return sizes[-1]
    if edge >= 1500 or re.search(r"(?i)\b2\s*k\b|2K|高清|高分辨率", text):
        return sizes[1]
    return sizes[0]


def gpt_image_2_auto_size_for_ratio(aspect_ratio=""):
    value = str(aspect_ratio or "").strip().replace("：", ":")
    match = re.fullmatch(r"(\d+)\s*:\s*(\d+)", value)
    if not match:
        return ""
    try:
        left, right = map(int, match.groups())
    except ValueError:
        return ""
    if not (left and right):
        return ""
    divisor = math.gcd(left, right)
    return GPT_IMAGE2_AUTO_RATIO_SIZES.get(f"{left // divisor}:{right // divisor}", "")


def _bounded_axes(width, height, step):
    """Fit both axes under the edge and area limits, rounding down to the grid."""
    longest = max(width, height)
    area = GPT_IMAGE2_MAX_PIXELS // (step * step)

    def units(axis, other):
        edge_bound = axis * GPT_IMAGE2_MAX_EDGE // (longest * step)
        area_bound = math.isqrt(area * axis // other)
        return max(1, min(axis // step, edge_bound, area_bound))

    return units(width, height), units(height, width)


def normalize_gpt_image_2_size(size):
    width, height = parse_size_pair(size)
    if not (width and height):
        return size or "auto"
    width, height = min(width, height * 3), min(height, width * 3)
    columns, rows = _bounded_axes(width, height, _STEP)
    # A grid step can make the rounded ratio wider than the source.
    columns, rows = min(columns, rows * 3), min(rows, columns * 3)
    area = GPT_IMAGE2_MIN_PIXELS // (_STEP * _STEP)
    if columns * rows < area:
        # Round both square roots up to keep the scaled area above the minimum.
        columns, rows = (
            math.isqrt((area * columns - 1) // rows) + 1,
            math.isqrt((area * rows - 1) // columns) + 1,
        )
    return f"{columns * _STEP}x{rows * _STEP}"


def gpt_image_2_safe_dimensions(width, height):
    try:
        width, height = int(width), int(height)
    except (TypeError, ValueError, OverflowError):
        return 0, 0
    return _bounded_axes(width, height, 1) if min(width, height) >= 1 else (0, 0)
