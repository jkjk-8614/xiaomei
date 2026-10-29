"""SCNet's documented asynchronous video API and live model discovery."""

import re
import asyncio
from html.parser import HTMLParser
from urllib.parse import urlsplit

import httpx
from fastapi import HTTPException


SEEDANCE_DOC_URL = "https://www.scnet.cn/help/docs/mainsite/mass/api/video/seedance.html"
VIDEO_DOC_URLS = [SEEDANCE_DOC_URL, *[
    f"https://www.scnet.cn/help/docs/mainsite/mass/api/video/{name}.html"
    for name in ("minimax-h3", "wan", "happyhorse")]]
# The model marketplace lists 2.5, while its shared Seedance documentation
# still uses 2.0 in every request example. Keep this catalogue-only addition
# on the backend; the picker continues to consume /api/providers/fetch-models.
CATALOG_ONLY_VIDEO_MODELS = {"Seedance2.5": "https://www.scnet.cn/ui/console/index.html#/llm/models"}


def is_scnet_provider(provider):
    try:
        return urlsplit(str((provider or {}).get("base_url") or "")).hostname == "api.scnet.cn"
    except ValueError:
        return False


def scnet_api_base(base_url):
    parsed = urlsplit(str(base_url or ""))
    return f"{parsed.scheme}://{parsed.netloc}/api/llm/v1"


class _CodeParser(HTMLParser):
    def __init__(self):
        super().__init__()
        self.in_code = False
        self.parts = []

    def handle_starttag(self, tag, attrs):
        if tag == "code":
            self.in_code = True

    def handle_endtag(self, tag):
        if tag == "code":
            self.in_code = False
            self.parts.append("\n")

    def handle_data(self, data):
        if self.in_code:
            self.parts.append(data)


def documented_video_models(page):
    parser = _CodeParser()
    parser.feed(page)
    # Read request examples only; navigation labels are not callable model IDs.
    return sorted(set(re.findall(r'["\']model["\']\s*:\s*["\']((?:Seedance|MiniMax-H3|Wan|HappyHorse)[A-Za-z0-9._-]*)["\']', "".join(parser.parts))))


async def supplement_scnet_models(base_url, grouped, ids, excluded=()):
    if not is_scnet_provider({"base_url": base_url}):
        return grouped, ids, {}
    async with httpx.AsyncClient(timeout=10) as client:
        async def read(url):
            try:
                response = await client.get(url, headers={"Accept": "text/html"})
                response.raise_for_status()
                models = documented_video_models(response.text)
                if not models:
                    raise ValueError("no documented model IDs")
                return {model: url for model in models}
            except (httpx.HTTPError, ValueError):
                return {}
        pages = await asyncio.gather(*(read(url) for url in VIDEO_DOC_URLS))
    sources = dict(CATALOG_ONLY_VIDEO_MODELS)
    for page in pages:
        sources.update(page)
    added = sorted(set(sources) - set(ids) - set(excluded))
    grouped = {key: list(values) for key, values in grouped.items()}
    grouped["video"] = sorted(set(grouped.get("video", [])) | set(added))
    return grouped, sorted(set(ids) | set(added)), ({
        "model_sources": {model: sources[model] for model in added},
        "message": ("部分视频模型文档暂时无法读取，请重试拉取或手动填写。" if not all(pages) else "") + "视频模型由官方文档及模型广场补充，当前 Key 的调用权限以生成接口返回为准。",
    } if added else {})


def scnet_video_body(payload, media):
    model = str(payload.model or "").strip()
    family = scnet_video_family(model)
    low, high = (2,15) if family == "wan" else (3,15) if family == "happyhorse" else (4,30) if model.lower() == "seedance2.5" else (4,15)
    if not low <= payload.duration <= high:
        raise HTTPException(status_code=400, detail=f"超算互联网 {model} 视频时长支持 {low}–{high} 秒，请调整时长。")
    ratios = ["16:9", "9:16"]
    if family in {"seedance", "minimax"}: ratios += ["adaptive"]
    if family in {"happyhorse", "minimax"}: ratios += ["1:1", "4:3", "3:4", "21:9"]
    if family == "happyhorse": ratios += ["4:5", "5:4", "9:21"]
    ratio = payload.aspect_ratio or "16:9"
    if ratio not in ratios or (family == "minimax" and not media and ratio == "adaptive"):
        raise HTTPException(status_code=400, detail=f"超算互联网 {model} 不支持当前比例；文生视频请选择具体比例。可用比例：{', '.join(ratios)}。")
    resolution = str(payload.resolution or "720p").lower()
    resolutions = {"768p", "2k"} if family == "minimax" else {"720p", "1080p"} if family == "happyhorse" else {"480p", "720p", "1080p"}
    if resolution not in resolutions:
        raise HTTPException(status_code=400, detail=f"超算互联网 {model} 视频清晰度支持 {'、'.join(sorted(resolutions))}，请调整清晰度。")
    parameters = dict(duration=payload.duration, ratio=ratio, resolution=resolution.upper() if family == "minimax" else resolution, watermark=payload.watermark)
    if family == "seedance":
        parameters.update(generate_audio=payload.generate_audio, camera_fixed=payload.camerafixed)
    if family == "wan": parameters["prompt_extend"] = payload.enhance_prompt
    if payload.seed is not None and family != "minimax":
        parameters["seed"] = payload.seed
    body = {"model": model, "input": {"prompt": payload.prompt}, "parameters": parameters}
    if family in {"wan", "happyhorse"}:
        if any(item["type"] != "reference_audio" for item in media) or (family == "happyhorse" and media) or len(media) > 1:
            raise HTTPException(status_code=400, detail=f"超算互联网 {model} 不支持当前参考素材；请选择文生视频，或切换到支持多模态参考的模型。")
        if media:
            url = media[0]["url"]
            if not url.startswith(("https://", "http://")):
                raise HTTPException(status_code=400, detail="万相参考音频需要 HTTP(S) 公网地址，请输入音频链接。")
            body["input"]["audio_url"] = url
    elif media:
        if family == "minimax" and any(i["type"] in {"first_frame", "last_frame"} for i in media) and any(i["type"].startswith("reference_") for i in media):
            raise HTTPException(status_code=400, detail="MiniMax-H3 首尾帧与多模态参考不能混用，请选择一种生成模式。")
        body["input"]["media"] = media
    return body


def scnet_video_family(model):
    value = str(model or "").lower()
    for prefix, family in (("seedance", "seedance"), ("minimax-h3", "minimax"), ("wan", "wan"), ("happyhorse", "happyhorse")):
        if value.startswith(prefix): return family
    raise HTTPException(status_code=400, detail="超算互联网视频模型未适配，请重新拉取并选择支持的视频模型。")
