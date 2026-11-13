"""Build APIMart video requests from canvas settings and prepared references."""

import re
from urllib.parse import quote

from fastapi import HTTPException

from apimart_media import accepts_reference


_VEO_ALIASES = {"veo3.1": "veo3.1-fast", "veo3.1-preview": "veo3.1-fast", "veo3.1-pro": "veo3.1-quality"}
_VEO_MODES = frozenset(("veo3.1-lite", "veo3.1-fast", "veo3.1-quality"))
_VEO_RESOLUTIONS = {"1080": "1080p", "1080p": "1080p", "4k": "4k"}
_RATIOS = frozenset(("16:9", "9:16", "4:3", "3:4", "1:1", "21:9", "adaptive"))
_ROLES = frozenset(("first_frame", "last_frame", "reference_image"))


def _v1(root):
    return root if root.endswith("/v1") else f"{root}/v1"


def submit_url(root):
    return f"{_v1(root)}/videos/generations"


def task_url(root, task_id):
    identifier = quote(str(task_id), safe="")
    return f"{_v1(root)}/tasks/{identifier}?language=zh"


def prompt_with_asset_indexes(prompt, images, videos, audios):
    text = str(prompt or "").strip()
    missing = []
    for label, count in (("图片", images), ("视频", videos), ("音频", audios)):
        references = [f"{label}{index}" for index in range(1, count + 1)]
        if references and not any(reference in text for reference in references):
            missing.append("、".join(references))
    if missing:
        hint = "参考素材：" + "，".join(missing) + "。"
        return "\n".join(filter(None, (text, hint)))
    return text


def _error(reason):
    return reason.removeprefix("ERR:") if isinstance(reason, str) and reason.startswith("ERR:") else "上游素材地址无效"


async def _references(sources, kind, uploader):
    results = []
    for source in sources:
        result = await uploader.prepare(source, kind)
        if not accepts_reference(result):
            label = {"video": "视频", "audio": "音频"}[kind]
            raise HTTPException(status_code=400, detail=f"无法转换 APIMart 参考{label}。{_error(result)}")
        results.append(result)
    return results


async def _images(references, uploader, *, use_roles):
    prepared = {}

    async def prepare(ref):
        if ref.url not in prepared:
            prepared[ref.url] = await uploader.prepare(ref.url, "image")
        return prepared[ref.url]

    roles = []
    if use_roles:
        for ref in references:
            role = str(ref.role or "").strip()
            if role in _ROLES:
                address = await prepare(ref)
                if accepts_reference(address):
                    roles.append({"url": address, "role": role})
    if roles:
        return "image_with_roles", roles
    images = []
    for ref in references:
        address = await prepare(ref)
        if accepts_reference(address):
            images.append(address)
    if references and not images:
        reason = _error(next(iter(prepared.values()), ""))
        raise HTTPException(status_code=400, detail=f"无法转换 APIMart 参考图片。{reason}")
    return "image_urls", images


def _veo_settings(payload, model):
    ratio = str(payload.aspect_ratio or "").strip()
    return dict(model=model, prompt=payload.prompt, duration=max(4, min(payload.duration, 8)),
                aspect_ratio=ratio if ratio in {"16:9", "9:16"} else "16:9",
                resolution=_VEO_RESOLUTIONS.get(str(payload.resolution or "").strip().lower(), "720p"))


async def build_request(payload, model, uploader):
    images = [ref for ref in payload.images if str(ref.url or "").strip()]
    videos = [value for value in payload.videos if value.strip()]
    audios = [value for value in payload.audios if value.strip()]
    if model.lower().startswith("veo3.1"):
        alias = _VEO_ALIASES.get(model.lower(), model.lower())
        veo = alias if alias in _VEO_MODES else "veo3.1-fast"
        if videos or audios:
            raise HTTPException(status_code=400, detail="APIMart VEO3.1 只支持图片参考，请使用支持视频或音频参考的 Seedance 模型。")
        if veo == "veo3.1-lite" and images:
            raise HTTPException(status_code=400, detail="veo3.1-lite 不支持参考图片，请选择 veo3.1-fast 或 veo3.1-quality。")
        request = _veo_settings(payload, veo)
        if veo != "veo3.1-lite":
            request["official_fallback"] = False
            _, urls = await _images(images[:3], uploader, use_roles=False)
            if veo == "veo3.1-quality":
                urls = urls[:2]
            if urls:
                request["image_urls"] = urls
                if len(urls) > 1:
                    request["generation_type"] = "frame" if len(urls) == 2 else "reference"
        return request

    if len(videos) > 3:
        raise HTTPException(status_code=400, detail="APIMart 最多支持 3 个参考视频，请减少输入视频后重试。")
    images = images[:9]
    if videos and any(str(ref.role or "").strip() in _ROLES for ref in images):
        raise HTTPException(status_code=400, detail="APIMart Seedance 的带角色图片与参考视频需分开使用，请保留其中一种。")
    ratio = str(payload.aspect_ratio or payload.size or "").strip()
    if ratio == "keep_ratio":
        ratio = "adaptive"
    request = dict(model=model, prompt=payload.prompt, duration=max(4, min(payload.duration, 15)),
                   size=ratio if ratio in _RATIOS else "16:9", resolution=payload.resolution or "480p")
    video_urls = await _references(videos, "video", uploader)
    image_key, image_urls = await _images(images, uploader, use_roles=True)
    audio_urls = await _references(audios[:3], "audio", uploader)
    for key, values in ((image_key, image_urls), ("video_urls", video_urls), ("audio_urls", audio_urls)):
        if values:
            request[key] = values
    if payload.trusted_asset:
        request["prompt"] = prompt_with_asset_indexes(payload.prompt, len(image_urls), len(video_urls), len(audio_urls))
    if payload.seed is not None:
        request["seed"] = payload.seed
    if payload.return_last_frame:
        request["return_last_frame"] = True
    if payload.generate_audio or "seedance" in model.lower() or re.match(r"^minimax[-_\s]*h3(?:$|[-_\s])", model, re.I):
        request["generate_audio"] = bool(payload.generate_audio)
    return request
