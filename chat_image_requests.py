"""Prepare chat image requests from saved messages and the provider catalog."""

import json
import logging
import re

from PIL import Image


_LOGGER = logging.getLogger(__name__)
_COUNT_WORDS = {"一": 1, "二": 2, "两": 2, "俩": 2, "三": 3, "四": 4}
_COUNT_UNIT = r"\s*[张幅个组套]"
_NUMBERED_COUNT = re.compile(r"(?<!\d)([1-4])" + _COUNT_UNIT + r"(?!\d)")
_WORD_COUNT = re.compile(f"([{''.join(_COUNT_WORDS)}])" + _COUNT_UNIT)
_IMAGE_NOUNS = ("海报", "头像", "壁纸", "插画", "照片", "图片", "图像")
_BATCH_INSTRUCTION = re.compile(
    r"再?(?:生成|画|绘制|制作|创建)\s*"
    + f"[1-4{''.join(_COUNT_WORDS)}]?"
    + _COUNT_UNIT + "?"
)
_BATCH_SEPARATOR = re.compile(r"[和与、，,+＋]")


def previous_image(messages):
    for message in reversed(messages or ()):
        if isinstance(message, dict) and message.get("image_url"):
            return {"url": message["image_url"], "name": message.get("content") or "上一张图片", "role": "source"}
    return None


def reference_dimensions(path):
    if not path:
        return ""
    try:
        with Image.open(path) as image:
            width, height = image.size
    except (OSError, ValueError, SyntaxError, Image.DecompressionBombError):
        _LOGGER.debug("Could not read the chat reference dimensions", exc_info=True)
        return ""
    return f"{width}x{height}" if min(width, height) > 0 else ""


def image_count(message):
    numbered = _NUMBERED_COUNT.search(message)
    if numbered:
        return int(numbered[1])
    written = _WORD_COUNT.search(message)
    return _COUNT_WORDS[written[1]] if written else 1


def batch_prompts(prompt, count):
    text = prompt.strip()
    if count <= 1:
        return [text]
    repeated = [text] * count
    last_line = text.rsplit("\n", 1)[-1]
    noun = next((noun for noun in _IMAGE_NOUNS if last_line.endswith(noun)), "")
    if not noun:
        return repeated
    description = last_line[:-len(noun)].removesuffix("的")
    description = _BATCH_INSTRUCTION.sub("", description)
    subjects = [item.strip() for item in _BATCH_SEPARATOR.split(description) if item.strip()]
    if len(subjects) < count:
        return repeated
    return [f"{subject}的{noun}" for subject in subjects[:count]]


def image_provider(catalog, requested_id, chat_id):
    by_id = {}
    first = primary = None
    for provider in catalog:
        if not provider.get("enabled", True) or not provider.get("image_models"):
            continue
        by_id.setdefault(provider.get("id"), provider)
        if first is None:
            first = provider
        if primary is None and provider.get("primary"):
            primary = provider
    for candidate in (requested_id, chat_id):
        key = str(candidate or "").strip().lower()
        if key and key in by_id:
            return by_id[key]
    return primary or first


def refine_draft(decision, response):
    """Use model wording while keeping the user's locally determined action."""
    raw = str(response or "")
    start, end = raw.find("{"), raw.rfind("}")
    if start < 0 or end <= start:
        return decision
    try:
        fields = json.loads(raw[start:end + 1])
    except ValueError:
        return decision
    prompt = str(fields.get("prompt") or "").strip() or decision["prompt"]
    return {
        **decision,
        "prompt": prompt,
        "reply": str(fields.get("reply") or "").strip(),
        "router_action": str(fields.get("action") or "").strip(),
    }
