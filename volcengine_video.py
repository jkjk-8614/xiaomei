"""Prepare native Ark video requests and their reference media."""

import asyncio
from dataclasses import dataclass
import os

from fastapi import HTTPException

from apimart_video import prompt_with_asset_indexes
import media_cloud
from media_formats import url_extension


_DEFAULT_MODEL = "doubao-seedance-2-0-fast-260128"
_FRAME_ROLES = {"first_frame", "last_frame"}
_IMAGE_EXTENSIONS = {".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp", ".tiff"}
_RESOLUTIONS = {"480p", "720p", "1080p", "4k"}


@dataclass(frozen=True)
class _Limits:
    duration: tuple[int, int] | None
    resolutions: tuple[str, ...]
    references: tuple[int, int, int]


_OLDER_MODELS = _Limits(None, (), (9, 0, 0))
_SEEDANCE_20 = _Limits((4, 15), ("1080p", "480p", "4k", "720p"), (9, 3, 3))
_SEEDANCE_20_FAST = _Limits((4, 15), ("480p", "720p"), (9, 3, 3))
_SEEDANCE_25 = _Limits((4, 30), ("1080p", "480p", "720p"), (30, 10, 10))


def _model_key(model):
    return str(model or "").strip().lower().replace("_", "-").replace(".", "-")


def _limits(model):
    name = _model_key(model)
    if "seedance-2-5" in name:
        return _SEEDANCE_25
    if "seedance-2-0" not in name:
        return _OLDER_MODELS
    if any(variant in name for variant in ("seedance-2-0-fast", "seedance-2-0-mini")):
        return _SEEDANCE_20_FAST
    return _SEEDANCE_20


def resolution(value):
    name = str(value or "").strip().lower()
    if name in ("480", "720", "1080"):
        name += "p"
    return name if name in _RESOLUTIONS else ""


def _duration(value):
    try:
        seconds = int(value)
    except (TypeError, ValueError, OverflowError):
        seconds = 5
    return min(60, max(1, seconds))


def validate_settings(model, duration, resolution):
    limits = _limits(model)
    if limits.duration is None:
        return
    minimum, maximum = limits.duration
    if not minimum <= duration <= maximum:
        raise HTTPException(400, f"火山模型「{model}」生成时长支持 {minimum}–{maximum} 秒，请调整时长。")
    if resolution and resolution not in limits.resolutions:
        choices = "、".join(limits.resolutions)
        raise HTTPException(400, f"火山模型「{model}」不支持 {resolution} 清晰度，请选择 {choices}。")


def _media(kind, address, role):
    field = f"{kind}_url"
    return {"type": field, field: {"url": address}, "role": role}


def _image_like(address):
    prefix = address.lower()
    return prefix.startswith("data:image/") or (
        not prefix.startswith("asset://") and url_extension(address) in _IMAGE_EXTENSIONS
    )


def inline_reference(value, encode, *, max_size=1536):
    if not isinstance(value, str):
        return ""
    address = value.strip()
    if address.startswith(("asset://", "data:")):
        return address
    source, local = media_cloud.reference_location(address)
    if source and local:
        return encode({"url": source}, max_size=max_size)
    return source


async def reference_video(value, *, locate, upload, public_link):
    address = str(value or "").strip()
    if not address:
        return []
    if address.startswith("asset://"):
        return [_media("video", address, "reference_video")]
    source, local = media_cloud.reference_location(address)
    if not source:
        raise HTTPException(400, "火山参考视频需要公网 URL、asset:// 素材地址或画布本地视频。")
    if not local:
        return [_media("video", source, "reference_video")]
    if os.path.getsize(locate(source)) > 200 * 1024 * 1024:
        raise HTTPException(400, "火山单个参考视频不能超过 200 MB，请压缩后重试。")
    try:
        uploaded = await upload(source)
    except HTTPException as error:
        public = public_link(source)
        if not public:
            raise HTTPException(502, f"火山参考视频上传失败：{error.detail}。请检查网络或改用公网视频地址。") from error
    else:
        public = str((uploaded or {}).get("url") or "").strip()
    if not public.startswith(("http://", "https://")):
        raise HTTPException(502, "火山参考视频上传后没有得到公网 URL。")
    return [_media("video", public, "reference_video")]


def _check_counts(payload, model, limits):
    images, videos, audios = limits.references
    if payload.videos and not videos:
        raise HTTPException(400, f"火山模型「{model}」不支持参考视频，请选择 Seedance 2.0 或 2.5 模型。")
    if payload.audios and not audios:
        raise HTTPException(400, f"火山模型「{model}」不支持参考音频，请选择 Seedance 2.0 或 2.5 模型。")
    if len(payload.images) > images or len(payload.videos) > videos or len(payload.audios) > audios:
        raise HTTPException(
            400, f"火山模型「{model}」最多支持 {images} 张参考图、{videos} 个参考视频和 {audios} 段参考音频，请减少素材数量。",
        )


async def _check_reference_durations(videos, audios, model, maximum, probe):
    total = 0.0
    for address, image_like in videos:
        if image_like:
            continue
        seconds = await asyncio.to_thread(probe, address)
        if seconds is None:
            continue
        if not 2 <= seconds <= maximum:
            raise HTTPException(
                400, f"参考视频时长 {seconds:.2f} 秒超出范围：火山模型「{model}」要求单个视频为 2–{maximum} 秒。",
            )
        total += seconds
        if total > maximum:
            raise HTTPException(400, f"参考视频总时长超过 {maximum} 秒，请裁剪或减少视频。")
    for address in audios:
        seconds = await asyncio.to_thread(probe, address)
        if seconds is not None and not 2 <= seconds <= maximum:
            raise HTTPException(400, f"参考音频时长 {seconds:.2f} 秒超出范围：火山模型「{model}」要求单段音频为 2–{maximum} 秒，请裁剪后再插入。")


async def build_request(payload, *, inline, video_items, probe):
    model = str(payload.model or _DEFAULT_MODEL).strip()
    limits = _limits(model)
    seconds = _duration(payload.duration)
    quality = resolution(payload.resolution)
    if payload.resolution and not quality:
        raise HTTPException(400, f"火山视频接口不支持 {payload.resolution} 清晰度，请选择该模型支持的档位。")
    validate_settings(model, seconds, quality)
    _check_counts(payload, model, limits)

    addresses = [address.strip() for address in payload.videos if address and address.strip()]
    videos = [(address, _image_like(address)) for address in addresses]
    if limits.duration:
        await _check_reference_durations(videos, payload.audios, model, limits.duration[1], probe)

    references = []
    images = set()
    frames = set()
    default_role = "reference_image" if payload.multimodal else "first_frame"

    def add_image(source, role):
        if role in _FRAME_ROLES and role in frames:
            return
        address = inline(source, max_image_size=1536)
        if address:
            references.append(_media("image", address, role))
            images.add(address)
            if role in _FRAME_ROLES:
                frames.add(role)

    for ref in payload.images:
        role = str(ref.role or "").strip().lower()
        add_image(ref.url, role if role in _FRAME_ROLES else default_role)
    for address, image_like in videos:
        if image_like:
            add_image(address, default_role)
        else:
            references.extend(await video_items(address))
    for source in payload.audios:
        address = inline(source, max_image_size=None)
        if address:
            references.append(_media("audio", address, "reference_audio"))

    text = str(payload.prompt or "").strip()
    if payload.trusted_asset:
        count = sum(item["type"] == "video_url" for item in references)
        text = prompt_with_asset_indexes(text, len(images), count, 0)
    body = {"model": model, "duration": seconds, "content": [{"type": "text", "text": text}, *references]}
    if payload.aspect_ratio:
        body["ratio"] = payload.aspect_ratio
    if quality:
        body["resolution"] = quality
    if payload.watermark:
        body["watermark"] = True
    if limits.duration:
        body["generate_audio"] = bool(payload.generate_audio)
    if payload.camerafixed and "seedance-1-0" in _model_key(model) and not payload.images:
        body["camera_fixed"] = True
    if payload.seed is not None:
        body["seed"] = payload.seed
    return body
