"""Build Dreamina image and video commands from canvas inputs."""

import csv
import io
import re

from fastapi import HTTPException

from gpt_image_dimensions import parse_size_pair


_IMAGE_RATIOS = ("21:9", "16:9", "3:2", "4:3", "1:1", "3:4", "2:3", "9:16")
_VIDEO_RATIOS = frozenset(_IMAGE_RATIOS) - {"3:2", "2:3"}
_IMAGE_MODELS = {"3.0", "3.1", "4.0", "4.1", "4.5", "4.6", "4.7", "5.0", "5.0Pro"}
_LEGACY_IMAGE_MODELS = {"3.0", "3.1"}
_VIDEO_MODELS = (
    "seedance2.5", "seedance2.0fast_vip", "seedance2.0_vip", "seedance2.0mini",
    "seedance2.0fast", "seedance2.0", "seedance1.0fast", "seedance1.5pro",
    "3.0fast", "3.0pro", "3.5pro", "3.0",
)
_VIDEO_DURATIONS = {
    "seedance2.5": (4, 30), "seedance1.0fast": (5, 10), "seedance1.5pro": (5, 12),
    "3.0": (3, 10), "3.0fast": (3, 10), "3.0pro": (3, 10), "3.5pro": (4, 12),
}
_VIDEO_RESOLUTIONS = {
    "seedance2.5": {"480p", "720p", "1080p"},
    "seedance2.0_vip": {"720p", "1080p", "4k"},
}


def _flag(name, value):
    return f"--{name}={value}"


def _csv_paths(paths):
    out = io.StringIO()
    csv.writer(out, lineterminator="\r\n").writerow(paths)
    return out.getvalue().removesuffix("\r\n")


def reference_url(ref):
    value = ref.get("url") if isinstance(ref, dict) else getattr(ref, "url", "")
    return str(value or "").strip()


def _role(ref):
    value = ref.get("role") if isinstance(ref, dict) else getattr(ref, "role", "")
    return str(value or "").strip().lower()


def _ratio_value(ratio):
    width, height = map(int, ratio.split(":"))
    return width / height


def _image_settings(model, size, editing):
    width, height = parse_size_pair(size)
    ratio = min(_IMAGE_RATIOS, key=lambda label: abs(width / height - _ratio_value(label))) if width and height else "1:1"
    name = str(model or "")
    match = re.search(r"\d+\.\d+", name)
    version = match[0] if match else ""
    if version == "5.0" and re.search(r"\b5\.0pro\b", name, re.I):
        version = "5.0Pro"
    hint = re.search(r"(?<![\d.])(1\.5|[124])k", name, re.I)
    requested = f"{hint[1]}k" if hint else ("4k" if max(width, height) > 2048 else "2k")
    if version in _LEGACY_IMAGE_MODELS and not editing:
        supported = {"1k", "2k"}
    else:
        supported = {"2k", "4k", "1.5k"} if version == "5.0Pro" else {"2k", "4k"}
    if version not in _IMAGE_MODELS or editing and version in _LEGACY_IMAGE_MODELS:
        version = ""
    return ratio, requested if requested in supported else "2k", version


def image_command(prompt, size, model, paths, poll):
    ratio, resolution, version = _image_settings(model, size, editing=bool(paths))
    args = ["image2image", _flag("images", _csv_paths(paths))] if paths else ["text2image"]
    args.extend((_flag("prompt", prompt), _flag("ratio", ratio), _flag("resolution_type", resolution), _flag("poll", poll)))
    if version:
        args.append(_flag("model_version", version))
    return args


def upscale_resolution(value):
    normalized = str(value or "").strip().lower()
    return normalized if normalized in {"2k", "4k", "8k"} else "2k"


def upscale_command(path, resolution, poll):
    return ["image_upscale", _flag("image", path), _flag("resolution_type", upscale_resolution(resolution)), _flag("poll", poll)]


def _video_model(value):
    model = re.sub(r"(3\.[05])_(pro|fast)", r"\1\2", str(value or "").strip().lower())
    return next((version for version in _VIDEO_MODELS if version in model), "")


def _duration(value, lower, upper):
    try:
        seconds = int(str(value).strip())
    except (TypeError, ValueError):
        seconds = 5
    return max(lower, min(upper, seconds))


def _video_resolution(model, requested):
    value = str(requested or "").strip().lower()
    if value not in {"480p", "720p", "1080p", "4k"}:
        value = "1080p" if "1080" in str(model or "") else "720p"
    options = _VIDEO_RESOLUTIONS.get(_video_model(model), {"720p"})
    return value if value in options else "720p"


def _multiframe(prompt, paths, duration, resolution, poll):
    segments = len(paths) - 1
    total = _duration(duration, max(2, segments), 8 * segments)
    quality = "1080p" if str(resolution or "").strip().lower() == "1080p" else "720p"
    args = ["multiframe2video", _flag("images", _csv_paths(paths)), _flag("video_resolution", quality), _flag("poll", poll)]
    if segments == 1:
        args.extend((_flag("prompt", prompt), _flag("duration", total)))
    else:
        seconds, remainder = divmod(total, segments)
        for index in range(segments):
            args.append(_flag("transition-prompt", prompt))
            args.append(_flag("transition-duration", seconds + (index < remainder)))
    return args


async def _multimodal(refs, stage, model):
    maximum = (30, 10, 10) if model == "seedance2.5" else (9, 3, 3)
    total_limit = sum(maximum) if model == "seedance2.5" else 12
    counts = tuple(len(group) for group in refs)
    if not any(counts) or (model != "seedance2.5" and not (counts[0] or counts[1])):
        raise HTTPException(400, "即梦全能参考需要图片或视频。Seedance 2.5 支持仅使用音频。")
    if sum(counts) > total_limit or any(count > limit for count, limit in zip(counts, maximum)):
        images, videos, audios = maximum
        raise HTTPException(
            400, f"即梦全能参考最多接收 {images} 张图片、{videos} 段视频和 {audios} 段音频，总数不能超过 {total_limit}。",
        )
    args = []
    for kind, group in zip(("image", "video", "audio"), refs):
        for url in group:
            args.append(_flag(kind, await stage(url, kind)))
    return args


async def video_command(payload, stage, poll):
    images = [(reference_url(ref), _role(ref)) for ref in payload.images or ()]
    images = [(url, role) for url, role in images if url]
    videos = [value.strip() for value in payload.videos or () if value and value.strip()]
    audios = [value.strip() for value in payload.audios or () if value and value.strip()]
    model = _video_model(payload.model)
    ratio = str(payload.aspect_ratio or "").strip()
    ratio = ratio if ratio in _VIDEO_RATIOS else ""
    args = []
    if payload.multimodal or videos or audios:
        command = "multimodal2video"
        args = await _multimodal(([url for url, _ in images], videos, audios), stage, model)
    elif len(images) > 1:
        first = next((url for url, role in images if role == "first_frame"), "")
        last = next((url for url, role in images if role == "last_frame"), "")
        if not (first and last):
            if len(images) > 20:
                raise HTTPException(400, "即梦多帧视频最多支持 20 张图片。")
            paths = [await stage(url, "image") for url, _ in images]
            return _multiframe(payload.prompt, paths, payload.duration, payload.resolution, poll)
        command = "frames2video"
        args = [_flag("first", await stage(first, "image")), _flag("last", await stage(last, "image"))]
    elif images:
        command = "image2video"
        args = [_flag("image", await stage(images[0][0], "image"))]
    else:
        command = "text2video"
        ratio = ratio or "16:9"

    low, high = _VIDEO_DURATIONS.get(model, (4, 15))
    options = [
        _flag("prompt", payload.prompt), _flag("duration", _duration(payload.duration, low, high)),
        _flag("video_resolution", _video_resolution(payload.model, payload.resolution)), _flag("poll", poll),
    ]
    if model:
        options.append(_flag("model_version", model))
    infer_from_frame = model == "seedance2.5" and command in {"image2video", "frames2video"}
    if ratio and not infer_from_frame:
        options.append(_flag("ratio", ratio))
    return [command, *args, *options]
