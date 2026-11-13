"""Multipart Veo requests for Yuli and Lingjing."""

import base64
from binascii import Error as Base64Error
from pathlib import Path
import re

import httpx

from media_formats import content_type
import video_tasks


_YULI_MODELS = {"veo31": "veo_3_1", "veo31fast": "veo_3_1-fast"}


def yuli_model(value):
    key = re.sub(r"[_.-]", "", str(value or "").strip().lower())
    return _YULI_MODELS.get(key, "")


def lingjing_model(value):
    model = str(value or "").strip() or "veo_3_1-fast"
    model = re.sub(r"^veo3[._]1", "veo_3_1", model, flags=re.I)
    return re.sub(r"-4k$", "-4K", model, flags=re.I)


def _image_part(data, mime):
    extension = mime.rpartition("/")[2].partition("+")[0] or "png"
    return f"input_reference.{extension}", data, mime


async def _image(client, url, locate):
    if not url:
        return None
    if url.startswith("data:"):
        head, _, encoded = url.partition(",")
        mime = head[5:].partition(";")[0].strip() or "image/png"
        try:
            return _image_part(base64.b64decode(encoded), mime)
        except (Base64Error, ValueError):
            return None
    path = locate(url)
    if path:
        file = Path(path)
        try:
            return file.name, file.read_bytes(), content_type(file)
        except OSError:
            return None
    if url.startswith(("http://", "https://")):
        try:
            response = await client.get(url)
            response.raise_for_status()
        except (httpx.HTTPError, httpx.InvalidURL):
            return None
        mime = response.headers.get("Content-Type", "").partition(";")[0].strip() or "image/png"
        return _image_part(response.content, mime)
    return None


async def submit(client, root, headers, payload, model, *, lingjing, locate):
    try:
        seconds = max(0, int(payload.duration)) or 8
    except (TypeError, ValueError, OverflowError):
        seconds = 8
    ratio = payload.aspect_ratio or (payload.size if lingjing else "")
    fields = {
        "model": model,
        "prompt": str(payload.prompt or ""),
        "seconds": str(seconds),
        "size": "9x16" if str(ratio or "").strip() == "9:16" else "16x9",
        "watermark": "true" if payload.watermark else "false",
    }
    parts = [(key, (None, value)) for key, value in fields.items()]
    for ref in payload.images[:3 if lingjing else 1]:
        image = await _image(client, str(ref.url or "").strip(), locate)
        if image is not None:
            parts.append(("input_reference", image))
    # Text-only jobs also use multipart/form-data.
    endpoint = f"{root}/v1/videos"
    response = await client.post(endpoint, headers=headers, files=parts)
    response.raise_for_status()
    platform = "灵境 API" if lingjing else "玉玉API"
    raw = video_tasks.response_record(response, operation=f"{platform} 视频创建")
    task_id = raw.get("id") or video_tasks.receipt(raw)
    task_id = str(task_id).strip() if lingjing else task_id or None
    return raw, endpoint, task_id
