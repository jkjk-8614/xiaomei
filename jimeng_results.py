"""Normalize Dreamina replies used by canvas generation and task recovery."""

import json
import re

from fastapi import HTTPException


_ID_FIELDS = ("submit_id", "submitid", "task_id", "taskid")
_MEDIA_FIELDS = (
    "url", "urls", "image", "images", "image_url", "image_urls", "video", "videos", "video_url",
    "video_urls", "output", "outputs", "result", "results", "file", "files", "path", "paths",
    "download_url", "download_urls", "downloadUrl", "file_path", "filePath", "result_json",
)
_MEDIA_PATH = re.compile(r"\.(png|jpe?g|webp|gif|bmp|mp4|webm|mov|m4v|avi|mkv|mp3|wav|m4a|aac|ogg|flac)([?#]|$)", re.I)
_PENDING = {"pending", "queued", "queue", "running", "processing", "generating", "submitted", "in_progress"}
_FAILED = {"fail", "failed", "error", "cancelled", "canceled", "rejected"}


def _structured_result(value):
    if isinstance(value, str) and value.lstrip().startswith(("{", "[")):
        try:
            return json.loads(value)
        except (ValueError, RecursionError):
            pass
    return value


def _records(raw):
    stack = [raw]
    while stack:
        current = stack.pop()
        if isinstance(current, dict):
            yield current
            children = [_structured_result(value) if key == "result_json" else value for key, value in current.items()]
            stack.extend(reversed(children))
        elif isinstance(current, list):
            stack.extend(reversed(current))


def submit_id(raw):
    rows = [{str(key).casefold(): value for key, value in row.items()} for row in _records(raw)]
    for key in _ID_FIELDS:
        for row in rows:
            value = row.get(key)
            if type(value) in (str, int) and str(value).strip():
                return str(value).strip()
    return ""


def queue_info(raw):
    return next((value for row in _records(raw) if isinstance(value := row.get("queue_info"), dict) and value), {})


def failure_reason(raw):
    for row in _records(raw):
        state = str(row.get("gen_status") or row.get("status") or "").strip().lower()
        detail = next((row[key] for key in ("fail_reason", "failReason", "error", "message", "msg") if row.get(key)), "")
        if state in _FAILED or (detail and re.search(r"fail|invalid param", str(detail), re.I)):
            return str(detail or state)
    return ""


def _still_running(raw):
    return bool(queue_info(raw)) or any(
        str(row.get("gen_status") or row.get("status") or "").strip().lower() in _PENDING
        for row in _records(raw)
    )


def output_values(raw):
    outputs = {}

    def read(value):
        if isinstance(value, str):
            text = value.strip()
            if text.startswith(("http://", "https://", "/output/", "/assets/", "/api/storage-files/", "file://")) or _MEDIA_PATH.search(text):
                outputs[text] = None
        elif isinstance(value, list):
            for item in value:
                read(item)
        elif isinstance(value, dict):
            for field in _MEDIA_FIELDS:
                if field in value:
                    data = _structured_result(value[field]) if field == "result_json" else value[field]
                    read(data)
            for key, item in value.items():
                if key not in _MEDIA_FIELDS and isinstance(item, (dict, list)):
                    read(item)

    read(raw)
    return list(outputs)


class JimengPendingError(Exception):
    def __init__(self, submit_id, kind="image", queue_info=None, raw=None):
        self.submit_id = str(submit_id or "")
        self.kind = kind or "image"
        self.queue_info = queue_info if isinstance(queue_info, dict) else {}
        self.raw = raw
        super().__init__(f"即梦任务等待中（{self.submit_id}）")


def pending_payload(exc):
    queue = exc.queue_info
    position, total = queue.get("queue_idx"), queue.get("queue_length")
    if position is not None and total is not None:
        state = f"即梦任务正在排队（第 {position}/{total} 位）。可继续等待或手动查询。"
    else:
        state = "即梦任务仍在生成。"
    return {
        "jimeng_pending": True, "submit_id": exc.submit_id, "kind": exc.kind,
        "queue_info": queue, "message": f"{state} submit_id={exc.submit_id}",
    }


async def resolve_outputs(raw, kind, save, *, query=None, queried_id=""):
    failure = failure_reason(raw)
    if failure:
        raise HTTPException(502, f"即梦生成失败。{failure}")
    urls = {}
    for value in output_values(raw):
        saved = await save(value, kind)
        if saved:
            urls[saved] = None
    if urls:
        return list(urls)

    task_id = submit_id(raw)
    if task_id and query is not None:
        polled = await query(task_id, kind)
        return await resolve_outputs(polled, kind, save, queried_id=task_id)
    if task_id or (queried_id and _still_running(raw)):
        raise JimengPendingError(task_id or queried_id, kind, queue_info(raw), raw)
    detail = json.dumps(raw, ensure_ascii=False) if isinstance(raw, (dict, list)) else str(raw)
    raise HTTPException(502, f"即梦 CLI 未返回可用媒体结果。{detail[:800]}")
