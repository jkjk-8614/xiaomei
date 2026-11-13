"""Seedance, MiniMax H3 and Muse video jobs on 6789API."""

import asyncio
import base64
from binascii import Error as Base64Error
import os
from pathlib import Path
import re
from tempfile import TemporaryDirectory
from urllib.parse import urlsplit
from uuid import uuid4

from fastapi import HTTPException
import httpx

import media_cloud
from media_formats import content_type
import video_tasks


_DURATIONS = {
    "seedance2.0": (5, 10, 15),
    "seedance2.0fast": (5, 10, 15),
    "seedance2.0mini": (5, 10),
    "seedance2.5": (30,),
    "minimax-h3": range(5, 16),
    # Muse 每条固定约 10 秒，上游拒绝其它时长。
    "muse-video": (10,),
}
_SEEDANCE_RATIOS = ("1:1", "3:4", "4:3", "9:16", "16:9", "21:9")
# Muse 不支持 21:9，但支持竖版 3:2 / 2:3。
_MUSE_RATIOS = ("1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3")
_H3_SIZES = {
    "1:1": ("1024x1024", "1440x1440"),
    "2:3": ("832x1248", "1184x1760"),
    "3:2": ("1248x832", "1760x1184"),
    "3:4": ("896x1184", "1248x1664"),
    "4:3": ("1184x896", "1664x1248"),
    "9:16": ("768x1376", "1088x1920"),
    "16:9": ("1376x768", "1920x1088"),
    "21:9": ("1568x672", "2208x960"),
}
_IMAGE_SUFFIXES = {".png", ".jpg", ".webp"}
_IMAGE_TYPES = {"image/png", "image/jpeg", "image/webp"}
_MAX_IMAGE_BYTES = 25 * 1024 * 1024
_POLL_INTERVAL = 5.0
_RETRYABLE_QUERY = {429, 500, 502, 503, 504}
_OUTPUT_FIELDS = ("file", "download_url", "downloadUrl", "video_url", "videoUrl", "output_url", "result_url")
_OUTPUT_GROUPS = ("data", "detail", "result", "response", "content", "output")


def is_provider(provider):
    record = provider or {}
    identifier = str(record.get("id") or "").strip().lower()
    base = str(record.get("base_url") or "").lower()
    return identifier == "api-6789" or "6789api.top" in base


def catalog_model(value):
    model = str(value or "").strip()
    lower = model.lower()
    return lower if lower in _DURATIONS else model


def _is_seedance_25(model):
    return bool(re.search(r"(?<![a-z0-9])seedance[ _-]*2[._-]5(?![0-9])", model, re.I))


def video_model(value):
    model = catalog_model(value)
    legacy = re.fullmatch(r"seedance-2\.0-?(fast|mini)?", model, re.I)
    if legacy:
        model = "seedance2.0" + (legacy[1] or "").lower()
    if model in _DURATIONS or _is_seedance_25(model):
        return model
    raise HTTPException(400, f"6789API 视频接口不支持模型「{value or '未选择'}」。请在 API 设置中重新拉取并勾选 Seedance、MiniMax H3 或 Muse 视频模型。")


def video_duration(model, value):
    try:
        duration = int(value)
    except (TypeError, ValueError, OverflowError):
        duration = 0
    family = "seedance2.5" if _is_seedance_25(model) else model
    allowed = _DURATIONS[family]
    if family == "seedance2.5" and re.search(r"线路\s*1$", model):
        allowed = range(4, 31)
    if family == "seedance2.5" and re.search(r"[（(]\s*满血版\s*[）)]$", model):
        allowed = range(10, 31)
    if duration in allowed:
        return duration
    label = f"{allowed.start}–{allowed.stop - 1}" if isinstance(allowed, range) else "/".join(map(str, allowed))
    raise HTTPException(400, f"6789API 模型「{model}」只支持 {label} 秒，请调整视频时长。")


def _video_settings(payload, model):
    h3 = model == "minimax-h3"
    if h3:
        ratios = _H3_SIZES
    elif model == "muse-video":
        ratios = _MUSE_RATIOS
    else:
        ratios = _SEEDANCE_RATIOS
    ratio = str(payload.aspect_ratio or "16:9").strip()
    if ratio not in ratios:
        raise HTTPException(400, f"6789API 视频接口不支持比例「{ratio or '未选择'}」。可用比例为 {'、'.join(ratios)}。")
    options = ("768p", "1080p", "2k", "4k") if h3 else ("720p",)
    resolution = str(payload.resolution or options[0]).strip().lower()
    if resolution.isdecimal():
        resolution += "p"
    if resolution not in options:
        allowed = "、".join(option.upper() for option in options)
        raise HTTPException(400, f"6789API 视频清晰度不支持「{payload.resolution or '未选择'}」。可用档位为 {allowed}。")
    return ratio, resolution


def _public_https(url):
    return url.lower().startswith("https://") and media_cloud.is_public_media_url(url)


async def _upload(path, source):
    failures = []
    for host in media_cloud.select_hosts(os.getenv("CLOUD_VIDEO_UPLOAD_SERVICE")):
        try:
            result = await media_cloud.upload(path, source, content_type(path), host)
        except HTTPException as exc:
            failures.append(f"{host} {str(exc.detail)[:160]}")
            continue
        url = str(result.get("url") or "").strip()
        if _public_https(url):
            return url
        failures.append(f"{host} 未返回公网 HTTPS 地址")
    raise HTTPException(502, "6789API 参考图上传失败。请检查网络或改用公网 HTTPS 图片链接。\n" + "\n".join(failures))


def _check_image(size, extension):
    if not size:
        raise HTTPException(400, "参考图内容为空。请重新添加图片。")
    if size > _MAX_IMAGE_BYTES:
        raise HTTPException(400, "6789API 单张参考图不能超过 25 MB。请缩小图片后重试。")
    if extension not in _IMAGE_SUFFIXES:
        raise HTTPException(400, "参考图内容无法识别。请重新导出为 PNG、JPG/JPEG 或 WebP。")


async def _inline_image(raw, sniff):
    header, separator, encoded = raw.partition(";base64,")
    if not separator:
        raise HTTPException(400, "参考图 data URL 无法解码。")
    mime = header[5:].partition(";")[0].strip().lower()
    if mime == "image/jpg":
        mime = "image/jpeg"
    if mime not in _IMAGE_TYPES:
        raise HTTPException(400, "请使用 PNG、JPG/JPEG 或 WebP 作为 6789API 参考图。")
    if len(encoded) > 4 * ((_MAX_IMAGE_BYTES + 2) // 3):
        raise HTTPException(400, "6789API 单张参考图不能超过 25 MB。请缩小图片后重试。")
    try:
        image = base64.b64decode(encoded, validate=True)
    except (Base64Error, ValueError) as exc:
        raise HTTPException(400, "参考图 data URL 无法解码。") from exc
    extension = sniff(image[:16])
    _check_image(len(image), extension)
    with TemporaryDirectory(prefix="6789_video_ref_") as folder:
        path = Path(folder) / f"reference{extension}"
        path.write_bytes(image)
        return await _upload(path, "data:image")


async def reference_url(raw, *, locate, public_link, sniff):
    if raw.startswith("data:image/"):
        return await _inline_image(raw, sniff)
    try:
        parts = urlsplit(raw)
        local = parts.scheme in ("http", "https") and parts.hostname in {"localhost", "127.0.0.1", "::1"}
    except ValueError as exc:
        raise HTTPException(400, "参考图地址格式有误。请重新添加图片。") from exc
    if parts.scheme == "blob":
        raise HTTPException(400, "参考图是浏览器临时文件。请先将图片上传到画布，再添加为参考图。")
    if _public_https(raw):
        return raw
    local_path = parts.path.startswith(media_cloud.LOCAL_MEDIA_PREFIXES)
    if not local_path or (not local and (parts.scheme or parts.netloc)):
        raise HTTPException(400, "6789API 需要公网 HTTPS 图片链接。请更换链接或将图片上传到画布。")
    filename = locate(parts.path)
    if not filename or not Path(filename).is_file():
        raise HTTPException(400, "找不到本地参考图。请移除失效的引用并重新添加图片。")
    path = Path(filename)
    if content_type(path) not in _IMAGE_TYPES:
        raise HTTPException(400, "请使用 PNG、JPG/JPEG 或 WebP 作为 6789API 参考图。")
    try:
        size = path.stat().st_size
        with path.open("rb") as image:
            head = image.read(16)
    except OSError as exc:
        raise HTTPException(400, "无法读取本地参考图。请重新添加图片。") from exc
    _check_image(size, sniff(head))
    try:
        return await _upload(path, parts.path)
    except HTTPException:
        address = public_link(parts.path)
        if _public_https(address):
            return address
        raise


async def _request_body(payload, resolve_image):
    model = video_model(payload.model)
    h3 = model == "minimax-h3"
    prompt = str(payload.prompt or "").strip()
    if not prompt:
        raise HTTPException(400, "请填写 6789API 视频提示词。")
    if not h3 and len(prompt) > 6000:
        raise HTTPException(400, "6789API Seedance 提示词最多 6000 个字符。请缩短后重试。")
    duration = video_duration(model, payload.duration)
    ratio, resolution = _video_settings(payload, model)
    if payload.videos or payload.audios:
        raise HTTPException(400, "6789API 仅支持参考图。请移除参考视频或音频后再生成。")
    limit = 30 if _is_seedance_25(model) else 9
    if len(payload.images) > limit:
        raise HTTPException(400, f"6789API 模型「{model}」最多支持 {limit} 张参考图。请减少图片数量。")

    sources = dict.fromkeys(str(ref.url or "").strip() for ref in payload.images)
    images = list(dict.fromkeys([await resolve_image(url) for url in sources if url]))
    body = {"model": model, "prompt": prompt}
    if not h3:
        body.update(duration=duration, resolution=resolution)
        # Seedance 走 ratio；Muse 文档使用 aspect_ratio。
        body["aspect_ratio" if model == "muse-video" else "ratio"] = ratio
        if images:
            body["image_urls"] = images
        return body
    if resolution in {"2k", "4k"}:
        if not images:
            raise HTTPException(400, "MiniMax H3 生成 2K 或 4K 视频需要至少一张参考图。请添加图片，或选择 768P、1080P。")
        body.update(size=resolution.upper(), workflow_id="cf-multi-reference")
    else:
        standard, high = _H3_SIZES[ratio]
        size = high if resolution == "1080p" else standard
        workflow = "multi-reference" if images else "text-to-video"
        body.update(size=size, workflow_id=workflow)
    body["seconds"] = duration
    if images:
        body["images"] = images
    return body


def _output_records(value, depth=0):
    if depth > 5:
        return
    if isinstance(value, dict):
        yield value
        for key in _OUTPUT_GROUPS:
            yield from _output_records(value.get(key), depth + 1)
    elif isinstance(value, list):
        for item in value:
            yield from _output_records(item, depth + 1)


def _is_output_link(value):
    return isinstance(value, str) and value.startswith(("https://", "http://", "/v1/videos/"))


def output_urls(raw):
    records = list(_output_records(raw))
    for field in _OUTPUT_FIELDS:
        links = dict.fromkeys(value for row in records if _is_output_link(value := row.get(field)))
        if links:
            return list(links)
    return [url for url in video_tasks.output_urls(raw) if _is_output_link(url)]


def _state(raw):
    data = raw.get("data")
    status = ""
    for row in (data, raw) if isinstance(data, dict) else (raw,):
        state = str(row.get("status") or row.get("task_status") or "").strip().upper()
        if state in video_tasks.FAILURE_STATES:
            reason = (
                row.get("error") or row.get("fail_reason") or row.get("message")
                or raw.get("error") or raw.get("message") or state
            )
            raise HTTPException(502, video_tasks.humanize_failure(reason))
        status = status or state
    return status


async def _poll(client, endpoint, headers, task_id, timeout):
    clock = asyncio.get_running_loop().time
    deadline = clock() + timeout
    while deadline > clock():
        await asyncio.sleep(min(_POLL_INTERVAL, max(0, deadline - clock())))
        remaining = deadline - clock()
        if remaining <= 0:
            break
        try:
            response = await asyncio.wait_for(client.get(endpoint, headers=headers), timeout=remaining)
        except asyncio.TimeoutError:
            break
        except httpx.TransportError:
            continue
        if response.status_code in _RETRYABLE_QUERY:
            continue
        response.raise_for_status()
        raw = video_tasks.response_record(response, operation="6789API 视频任务查询")
        state = _state(raw)
        if response.status_code != 202 and (state in video_tasks.SUCCESS_STATES or (not state and output_urls(raw))):
            return raw
    raise HTTPException(504, f"6789API 视频任务查询超时。任务 ID {task_id}")


async def _download(client, root, link, headers, save):
    base = httpx.URL(root)
    try:
        url = base.join(link)
    except httpx.InvalidURL as exc:
        raise HTTPException(502, "6789API 返回的视频下载地址无效。") from exc
    if url.scheme not in ("http", "https") or not url.host or url.userinfo:
        raise HTTPException(502, "6789API 返回的视频下载地址无效。")
    same_origin = (url.scheme, url.netloc) == (base.scheme, base.netloc)
    download_headers = {"Accept": "video/*,application/octet-stream,*/*;q=0.8"}
    if same_origin and url.path.startswith(("/v1/videos/", f"{base.path.rstrip('/')}/v1/videos/")):
        download_headers["Authorization"] = headers["Authorization"]
    for attempt in range(3):
        response = await client.get(url, headers=download_headers, follow_redirects=True)
        if response.status_code != 409 or not same_origin or attempt == 2:
            break
        await asyncio.sleep(2)
    response.raise_for_status()
    mime = (response.headers.get("Content-Type") or "video/mp4").lower()
    if mime.startswith(("text/", "image/")) or "json" in mime:
        raise HTTPException(502, f"6789API 视频下载返回了非视频内容（{mime}）。")
    try:
        return save(response.content, mime, str(url), "6789_video_", "output")
    except Exception as exc:
        raise HTTPException(502, f"保存 6789API 视频失败。{exc}") from exc


async def generate(client, payload, root, headers, *, resolve_image, save, timeout):
    body = await _request_body(payload, resolve_image)
    submit_url, = video_tasks.submit_urls("api-6789", root)
    response = await client.post(submit_url, headers={**headers, "Idempotency-Key": uuid4().hex}, json=body)
    response.raise_for_status()
    raw = video_tasks.response_record(response, operation="6789API 视频创建")
    task_id = video_tasks.receipt(raw)
    query_url = video_tasks.query_urls("api-6789", root, task_id)[0] if task_id else ""
    state = _state(raw)
    if response.status_code == 202 or state not in video_tasks.SUCCESS_STATES:
        if query_url:
            raw = await _poll(client, query_url, headers, task_id, timeout)
        elif response.status_code == 202 or state:
            raise HTTPException(502, "6789API 已受理视频任务，但未返回任务 ID，无法查询进度。")
    links = output_urls(raw)
    if not links and query_url:
        links = [query_url + "/content"]
    if not links:
        raise HTTPException(502, "6789API 未返回可下载的视频地址。")
    videos = [await _download(client, root, link, headers, save) for link in links]
    return {"videos": videos, "task_id": task_id, "raw": raw}
