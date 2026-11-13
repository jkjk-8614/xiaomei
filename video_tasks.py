"""Gateway routes, receipts and result handling for canvas video jobs."""

import asyncio
import json
import re
import time
from urllib.parse import quote, urlencode, urlsplit

import httpx
from fastapi import HTTPException

import apimart_video
from dispatch_kernel import FAILED, PENDING, SUCCESS, read_status, task_receipt as receipt


SUCCESS_STATES = SUCCESS | {"FINISH"}
FAILURE_STATES = FAILED | {"TIMEDOUT"}
_GATEWAY_PATHS = ("/v1/video/generations", "/v1/videos/generations", "/v2/videos/generations")
_ASSET_FIELDS = ("url", "video_url", "videoUrl", "mp4_url", "mp4Url", "output", "output_url", "outputUrl",
                 "file", "download_url", "downloadUrl", "video", "src", "uri", "path")
_RESULT_NODES = ("videos", "outputs", "results", "content", "data", "detail", "result", "response")
_STILL_EXTENSIONS = (".png", ".jpg", ".jpeg", ".webp", ".gif", ".avif", ".bmp", ".svg", ".tiff")
_VIDEO_EXTENSIONS = (".mp4", ".webm", ".mov", ".m4v", ".mkv", ".avi")


def _with_volcengine_path(root):
    return root if urlsplit(root).path.strip("/") else f"{root}/api/v3/contents/generations/tasks"


def submit_urls(kind, root):
    if kind == "apimart":
        return [apimart_video.submit_url(root)]
    if kind == "volcengine":
        return [_with_volcengine_path(root)]
    routes = {
        "scnet": ("/videos/generations",), "api-6789": ("/v1/videos",), "agnes": ("/v1/videos",),
        "lingjing": ("/v1/videos",), "yuli": ("/v1/video/create",),
    }
    return [root + path for path in routes.get(kind, _GATEWAY_PATHS)]


def query_urls(kind, root, task_id, submit_url="", *, model=""):
    identifier = quote(str(task_id), safe="")
    video = f"{root}/v1/videos/{identifier}"
    if kind == "agnes":
        params = {"video_id": task_id}
        if model:
            params["model_name"] = model
        return [f"{root}/agnesapi?{urlencode(params)}", video]
    if kind in {"lingjing", "yuli"}:
        return [video, f"{root}/v1/video/query?{urlencode({'id': task_id})}"]
    if kind == "apimart":
        return [apimart_video.task_url(root, task_id)]
    if kind == "api-6789":
        return [video]
    if kind == "scnet":
        return [f"{root}/tasks/{identifier}"]
    if kind == "volcengine":
        return [f"{_with_volcengine_path(root)}/{identifier}"]
    singular, plural, v2 = _GATEWAY_PATHS
    endpoint = str(submit_url or "")
    primary = next((path for path in _GATEWAY_PATHS if path in endpoint), plural)
    order = {
        singular: (singular, plural, "/v1/tasks", v2),
        plural: (plural, singular, "/v1/tasks", v2),
        v2: (v2, plural, singular, "/v1/tasks"),
    }[primary]
    paths = [f"{root}{path}/{identifier}" for path in order]
    return [*paths, video]


def _accepted_url(value, *, preview=False):
    if not isinstance(value, str):
        return ""
    text = value.strip()
    if not text.startswith(("https://", "http://", "/output/", "/assets/")):
        return ""
    try:
        path = urlsplit(text).path.lower()
    except ValueError:
        return ""
    if path.endswith(_STILL_EXTENSIONS) or (preview and not path.endswith(_VIDEO_EXTENSIONS)):
        return ""
    return text


def output_urls(raw):
    direct = {}
    fallback = {}

    def visit(value, depth=0, *, secondary=False, preview=False):
        if depth > 10:
            return
        if isinstance(value, list):
            for item in value:
                visit(item, depth + 1, secondary=secondary, preview=preview)
        elif isinstance(value, dict):
            media_type = str(value.get("mime_type") or value.get("content_type") or value.get("type") or "").lower()
            if media_type in {"image", "last_frame", "thumbnail"} or media_type.startswith("image/"):
                return
            for key in (*_RESULT_NODES, *_ASSET_FIELDS):
                if key in value:
                    visit(value[key], depth + 1, secondary=secondary, preview=preview)
            for key in ("result_url", "resultUrl", "preview_url", "previewUrl"):
                if key in value:
                    visit(value[key], depth + 1, secondary=True, preview=preview or key.startswith("preview"))
        else:
            address = _accepted_url(value, preview=preview)
            if address:
                (fallback if secondary else direct)[address] = None

    if isinstance(raw, (dict, list)):
        visit(raw)
    return list(direct or fallback)


def task_state(raw):
    if not isinstance(raw, dict):
        return "", {}
    for key in ("data", "detail", "output", "result"):
        value = raw.get(key)
        for row in value if isinstance(value, list) else (value,):
            state = read_status(row)
            if state:
                return state, row
    return read_status(raw), raw


def humanize_failure(reason, *, fallback_prefix="视频生成任务失败"):
    text = str(reason or "").strip()
    data = reason
    if not isinstance(reason, dict):
        try:
            data = json.loads(text)
        except ValueError:
            data = None
    data = data if isinstance(data, dict) else {}
    error = data.get("error")
    error = error if isinstance(error, dict) else {}
    message = str(data.get("msg") or data.get("message") or data.get("error_message") or error.get("message") or text).strip()
    lowered = message.lower()
    if re.search(r"\brate\s+limit\s+exceeded\b", lowered):
        match = re.search(r"\bfor\s+model\s+([^\s(),;]+)", message, re.I)
        subject = f"模型 {match[1]}" if match else "视频模型"
        summary = f"{subject}触发平台限流。请减少同时生成的任务，稍后重试。"
    elif re.fullmatch(r"video\s+generation\s+error\s*(?:\(\s*request_id\s*:\s*[^)]+\))?", lowered):
        summary = "上游平台视频生成失败。请稍后重试，若仍失败可将请求编号提供给 API 平台。"
    elif "prominent_people" in lowered:
        summary = "平台限制涉及知名人物或真人面孔的视频。请移除提示词中的相关人名，或改用插画、商品图等参考素材。"
    elif any(word in lowered for word in ("safety", "content_filter", "policy")):
        summary = "提示词或参考素材触发平台内容审核。请调整后重试。"
    else:
        return f"{fallback_prefix}。{message}" if message else fallback_prefix
    code = data.get("code") or data.get("error_code") or error.get("code")
    request_id = data.get("request_id") or error.get("request_id")
    if not request_id:
        match = re.search(r"\brequest_id\s*[:=]\s*([\w.:-]+)", message, re.I)
        request_id = match[1] if match else ""
    details = [summary]
    if code:
        details.append(f"错误码 {code}")
    if request_id:
        details.append(f"请求编号 {request_id}")
    return "\n".join(details)


def ensure_not_failed(raw):
    state, row = task_state(raw)
    error = row.get("error") or raw.get("error")
    if state not in FAILURE_STATES and (state or not error):
        return state
    reason = next((row[key] for key in ("fail_reason", "failReason", "error_message", "message") if row.get(key)), None)
    context = {"request_id": row.get("request_id") or raw.get("request_id"),
               "error_code": row.get("error_code") or raw.get("error_code")}
    if isinstance(error, dict):
        context["error"] = error
    elif error:
        reason = reason or error
    context["message"] = reason or raw.get("message") or (f"平台状态 {state}" if not context.get("error") else "")
    raise HTTPException(status_code=502, detail=humanize_failure(context))


def response_record(response, *, operation):
    try:
        payload = response.json()
    except ValueError as exc:
        raise HTTPException(status_code=502, detail=f"{operation}返回非 JSON 响应。请在平台核对任务状态。") from exc
    if not isinstance(payload, dict):
        raise HTTPException(status_code=502, detail=f"{operation}返回的数据格式不受支持。")
    return payload


async def submit(client, urls, headers, body):
    for index, url in enumerate(urls):
        response = await client.post(url, headers=headers, json=body)
        if response.status_code in (404, 405) and index < len(urls) - 1:
            continue
        if response.status_code >= 400:
            response.raise_for_status()
        raw = response_record(response, operation="视频提交")
        ensure_not_failed(raw)
        return raw, url
    raise HTTPException(status_code=502, detail="缺少可用的视频提交地址")


def _available_output(raw, extract):
    state = ensure_not_failed(raw)
    return state, [] if state in PENDING else extract(raw)


async def _lookup(client, urls, headers, extract):
    last_error = None
    finished_receipt = None
    for url in urls:
        try:
            response = await client.get(url, headers=headers)
            response.raise_for_status()
            raw = response_record(response, operation="视频查询")
        except (httpx.HTTPError, HTTPException) as exc:
            last_error = exc
            continue
        state, links = _available_output(raw, extract)
        reply = raw, url, links
        if state in SUCCESS_STATES and not links:
            finished_receipt = finished_receipt or reply
            continue
        if finished_receipt and not links:
            continue
        return reply
    if finished_receipt:
        return finished_receipt
    if last_error is not None:
        raise last_error
    raise HTTPException(status_code=502, detail="缺少可用的视频查询地址")


async def poll(client, urls, headers, task_id, *, timeout, interval, backoff=1.6, extract=output_urls):
    deadline = time.monotonic() + timeout
    delay = interval
    while time.monotonic() < deadline:
        await asyncio.sleep(min(delay, max(0, deadline - time.monotonic())))
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            break
        try:
            raw, matched, links = await asyncio.wait_for(_lookup(client, urls, headers, extract), timeout=remaining)
        except asyncio.TimeoutError:
            break
        if links:
            return raw
        urls = [matched, *(url for url in urls if url != matched)]
        delay = min(delay * backoff, 12)
    raise HTTPException(status_code=504, detail=f"视频任务查询超时。任务 ID {task_id}")


async def complete(raw, task_id, poll_task, save, *, extract=output_urls):
    _, links = _available_output(raw, extract)
    if task_id and not links:
        raw = await poll_task(task_id)
        _, links = _available_output(raw, extract)
    if not links:
        task = f"。任务 ID {task_id}" if task_id else ""
        raise HTTPException(status_code=502, detail=f"上游未返回可用的视频{task}")
    return {"videos": [await save(link) for link in links], "task_id": task_id, "raw": raw}
