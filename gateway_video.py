"""Build requests and translate errors for canvas video gateways."""

import re

from video_tasks import humanize_failure


_LABELS = {
    "runninghub": "RunningHub",
    "scnet": "超算互联网",
    "agnes": "Agnes",
    "api-6789": "6789API",
    "lingjing": "灵境 API",
}
_MINIMAX = re.compile(r"^minimax[-_\s]*h3(?:$|[-_\s])", re.I)
_MODEL_CHOICES = re.compile(r"not in\s*\[([^\]]+)\]", re.I)


def request(payload, model, encode):
    body = {
        "model": model,
        "prompt": payload.prompt,
        "duration": payload.duration,
        "watermark": payload.watermark,
    }
    for key in ("aspect_ratio", "size", "resolution"):
        value = getattr(payload, key)
        if value:
            body[key] = value
    if payload.aspect_ratio:
        body["ratio"] = payload.aspect_ratio
    images = [encode(ref.dict(), max_size=1536) for ref in payload.images[:4] if ref.url]
    if images:
        body["images"] = images
    if payload.videos:
        body["videos"] = [address for address in payload.videos if address]
    for key in ("enhance_prompt", "enable_upsample", "camerafixed", "return_last_frame"):
        if getattr(payload, key):
            body[key] = True
    if payload.seed is not None:
        body["seed"] = payload.seed
    if payload.generate_audio or _MINIMAX.match(model) or "seedance" in model.lower():
        body["generate_audio"] = bool(payload.generate_audio)
    return body


def yuli_request(payload, model, encode):
    text = str(payload.prompt or "")
    body = {"model": model, "prompt": text, "enhance_prompt": not text.isascii()}
    images = []
    for ref in payload.images[:3]:
        address = str(ref.url or "").strip()
        if not address:
            continue
        if not address.startswith(("https://", "http://")):
            address = encode(ref.dict(), max_size=1536)
        if address:
            images.append(address)
    if images:
        body["images"] = images
    ratio = str(payload.aspect_ratio or "").strip()
    if ratio in ("16:9", "9:16"):
        body["aspect_ratio"] = ratio
    if payload.enable_upsample:
        body["enable_upsample"] = True
    return body


def label(kind):
    return _LABELS.get(kind, "上游")


def status_detail(kind, provider, model, text):
    platform = provider.get("name") or provider["id"]
    if kind == "scnet":
        return humanize_failure(text, fallback_prefix="超算互联网视频接口错误")
    if kind in _LABELS or kind == "yuli-multipart":
        separator = "" if kind in ("lingjing", "yuli-multipart") else " "
        message = text[:500] if kind == "api-6789" else text
        return f"{label(kind)}{separator}视频接口错误：{message}"
    models = _MODEL_CHOICES.search(text)
    if models:
        choices = [choice.strip() for choice in models[1].split(",") if choice.strip()]
        visible = "、".join(choices[:30])
        more = f"。共 {len(choices)} 个，已列出前 30 个" if len(choices) > 30 else ""
        return f"上游「{platform}」未识别模型「{model}」。请在 API 设置中选择可用型号。\n\n可选型号包括 {visible}{more}。"
    lowered = text.lower()
    if "channel not found" in lowered or "model_not_found" in lowered:
        return f"当前账号缺少「{platform}」模型「{model}」的可用通道。请在平台控制台开通该模型，或在 API 设置中切换到已开通的型号。"
    if "text.duration" in lowered or "specified duration is not supported" in lowered:
        return f"「{platform}」模型「{model}」不支持当前时长。请选择该模型允许的时长后重试。"
    if "audio duration" in lowered:
        direction = "偏长" if "less than or equal" in lowered or "15.2" in lowered else "偏短"
        return f"「{platform}」模型「{model}」认为参考音频时长{direction}。请按平台要求调整音频时长。"
    if any(reason in lowered for reason in ("inputimagesensitivecontentdetected", "privacyinformation", "may contain real person")):
        return f"「{platform}」的内容审核拦截了参考图，图片可能包含真人身份信息。请替换参考图或遮挡可识别的人脸后重试。"
    return f"上游视频接口错误：{text}"
