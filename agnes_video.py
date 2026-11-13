"""Agnes frame geometry and image inputs for the legacy video model API."""

from urllib.parse import urlsplit

from fastapi import HTTPException

from media_cloud import is_public_media_url


_DIMENSIONS = {
    "1:1": (768, 768), "4:3": (1024, 768), "3:4": (768, 1024),
    "16:9": (1152, 648), "9:16": (648, 1152), "21:9": (1280, 544), "9:21": (544, 1280),
}
_SCALES = {"480p": 0.625, "1080p": 1.5}
_FRAME_RATE = 24


def _geometry(payload):
    ratio = str(payload.aspect_ratio or "16:9").strip()
    resolution = str(payload.resolution or "").strip().lower()
    scale = _SCALES.get(resolution, 1)
    width, height = _DIMENSIONS.get(ratio, (1152, 768))
    seconds = max(1, min(payload.duration or 5, 18))
    steps = round((_FRAME_RATE * seconds - 1) / 8)
    return {
        "width": max(64, 8 * round(width * scale / 8)),
        "height": max(64, 8 * round(height * scale / 8)),
        "num_frames": 8 * max(1, min(55, steps)) + 1,
        "frame_rate": _FRAME_RATE,
    }


async def _reference_url(value, upload):
    if is_public_media_url(value):
        return value
    try:
        url = urlsplit(value)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail="Agnes 参考图片地址无效") from exc
    if url.scheme in {"http", "https"}:
        if (url.hostname or "").rstrip(".") not in {"127.0.0.1", "localhost", "::1"}:
            raise HTTPException(status_code=400, detail="Agnes 需要公网图片地址或画布中的本地图片")
        value = url.path
    result = await upload(value, "auto")
    address = result.get("url") or ""
    if not is_public_media_url(address):
        raise HTTPException(status_code=502, detail="Agnes 参考图片上传后缺少公网地址")
    return address


async def build_request(payload, model, upload):
    request = {"model": model, "prompt": payload.prompt, **_geometry(payload)}
    urls = []
    keyframes = bool(payload.multimodal)
    for image in payload.images[:4]:
        address = str(image.url or "").strip()
        if address:
            urls.append(await _reference_url(address, upload))
            role = str(image.role or "").strip().lower()
            keyframes |= role in {"first_frame", "last_frame"}
    if len(urls) == 1:
        request["image"] = urls[0]
    elif len(urls) > 1:
        request["extra_body"] = {"image": urls}
        if keyframes:
            request["extra_body"]["mode"] = "keyframes"
    if payload.seed is not None:
        request["seed"] = payload.seed
    return request
