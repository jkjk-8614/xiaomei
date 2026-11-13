"""Protocol and task-status helpers.

Runtime always uses this module. Query parameters, stored flags, and request
headers do not choose another implementation.
"""
from __future__ import annotations

import json
import re
from typing import Any, Mapping
from urllib.parse import urlsplit

PROVIDER_ID_RE = re.compile(r"^[a-zA-Z0-9_-]{2,40}$")
PROTOCOLS = {"openai", "apimart", "gemini", "gemini-cli", "volcengine", "runninghub", "jimeng", "codex"}
VERSION_PREFIXES = ("/api/v3", "/v1beta", "/v1", "/v2")
STATUS_KEYS = ("status", "task_status", "taskStatus", "state", "phase", "job_status", "jobStatus")
NEST_KEYS = ("data", "result", "task", "job", "operation", "output", "response")
_RECEIPT_FIELDS = (
    "task_id", "taskId", "submit_id", "submitId", "job_id", "jobId", "operation_id", "operationId",
    "prediction_id", "predictionId", "generation_id", "generationId", "video_id", "videoId",
)
_RECEIPT_ENVELOPES = ("data", "result", "output", "response", "detail", "task", "job", "operation")
SUCCESS = {"SUCCESS", "SUCCESSFUL", "SUCCEED", "SUCCEEDED", "COMPLETED", "COMPLETE", "DONE", "FINISHED", "OK", "READY"}
FAILED = {"FAILURE", "FAILED", "FAIL", "ERROR", "ERRORED", "CANCELED", "CANCELLED", "TIMEOUT", "REJECTED", "EXPIRED"}
PENDING = {
    "ACCEPTED", "CREATED", "IN_PROGRESS", "IN-PROGRESS", "IN PROGRESS", "PENDING", "PROCESSING",
    "QUEUED", "RUNNING", "SCHEDULED", "STARTED", "SUBMITTED", "WAITING",
}
REASON_KEYS = ("message", "detail", "fail_reason", "failReason", "reason", "description", "error_message", "errorMessage")


def selected() -> bool:
    """The next dispatch path is the only runtime path."""
    return True


def bearer_auth_value(value):
    token = re.sub(r"^Bearer\s+", "", str(value or "").strip(), flags=re.I).strip()
    return f"Bearer {token}" if token else ""


def provider_core(item: Mapping[str, Any] | None) -> dict:
    record = item or {}
    provider_id = str(record.get("id") or "").strip().lower()
    if not PROVIDER_ID_RE.fullmatch(provider_id):
        return {"error": f"API 平台 ID 不合法：{provider_id or '(empty)'}"}
    name = re.sub(r"\s+", " ", str(record.get("name") or provider_id).strip())[:60] or provider_id
    base_url = str(record.get("base_url") or "").strip().rstrip("/")
    if base_url and not re.match(r"^https?://", base_url, re.I):
        return {"error": f"{name} 的 Base URL 需要以 http:// 或 https:// 开头"}
    protocol = str(record.get("protocol") or "openai").strip().lower()
    if protocol not in PROTOCOLS:
        protocol = "openai"
    return {"id": provider_id, "name": name, "base_url": base_url, "protocol": protocol}


def join_endpoint(provider: Mapping[str, Any] | None, key: str, default_path: str, fallback_base: str = "") -> str:
    record = provider or {}
    base_url = str(record.get("base_url") or fallback_base or "").strip().rstrip("/")
    override = str(record.get(key) or "").strip()
    if override:
        if re.match(r"^https?://", override, re.I):
            return override.rstrip("/")
        parsed = urlsplit(base_url)
        if parsed.scheme and parsed.netloc:
            return f"{parsed.scheme}://{parsed.netloc}{override}"
        return override
    for prefix in VERSION_PREFIXES:
        if base_url.endswith(prefix) and str(default_path).startswith(prefix + "/"):
            return f"{base_url}{default_path[len(prefix):]}"
    return f"{base_url}{default_path}"


def task_lookup_url(provider: Mapping[str, Any] | None, task_id: str, apimart: bool = False) -> str:
    record = provider or {}
    base_url = str(record.get("base_url") or "").rstrip("/")
    mode = str(record.get("image_request_mode") or "").strip()
    protocol = str(record.get("protocol") or "").strip().lower()
    if mode == "openai-video-proxy":
        suffix = f"/videos/{task_id}"
    elif apimart or protocol == "apimart":
        suffix = f"/tasks/{task_id}"
    else:
        suffix = f"/images/tasks/{task_id}"
    if base_url.endswith("/v1"):
        return f"{base_url}{suffix}"
    return f"{base_url}/v1{suffix}"


def _nested_dict(payload: Any) -> Any:
    if isinstance(payload, dict) and isinstance(payload.get("data"), dict):
        return payload["data"]
    return payload if isinstance(payload, dict) else {}


def read_status(payload: Any) -> str:
    current = _nested_dict(payload)
    for _ in range(6):
        if not isinstance(current, dict):
            return ""
        for key in STATUS_KEYS:
            value = current.get(key)
            if value is not None and str(value).strip():
                return str(value).strip().upper()
        current = next((current.get(key) for key in NEST_KEYS if isinstance(current.get(key), dict)), None)
    return ""

def task_records(value: Any, *, depth=0):
    if depth > 8:
        return
    if isinstance(value, dict):
        yield value
        for key in _RECEIPT_ENVELOPES:
            if key in value:
                yield from task_records(value[key], depth=depth + 1)
    elif isinstance(value, list):
        for item in value:
            yield from task_records(item, depth=depth + 1)


def task_receipt(raw, fields=_RECEIPT_FIELDS, *, plain_id=True):
    records = list(task_records(raw))
    for keys in (fields, ("id",) if plain_id else ()):
        for row in records:
            for key in keys:
                value = row.get(key)
                if type(value) not in (str, int):
                    continue
                identifier = str(value).strip()
                if identifier and not identifier.lower().startswith(("chatcmpl-", "resp_", "response_")):
                    return identifier
    return ""


def read_error(payload: Any, *, extra_envelopes=()):
    keys = (*NEST_KEYS, *extra_envelopes)

    def find(value, remaining):
        if isinstance(value, dict):
            error = value.get("error")
            if isinstance(error, str):
                if error.strip():
                    return error
            elif error:
                return error
            children = (value[key] for key in reversed(keys) if key in value)
        elif isinstance(value, list):
            children = reversed(value)
        else:
            return None
        if remaining:
            for child in children:
                error = find(child, remaining - 1)
                if error is not None:
                    return error
        return None

    return find(payload, 6)


def failure_message(payload: Any, *, error=None) -> str:
    if error is None:
        error = read_error(payload)
    reason = ""
    code = ""
    if isinstance(error, dict):
        for key in REASON_KEYS:
            value = error.get(key)
            if value not in (None, "", []):
                reason = value if isinstance(value, str) else json.dumps(value, ensure_ascii=False)
                break
        code = str(error.get("code") or error.get("error_code") or error.get("errorCode") or "").strip()
    elif isinstance(error, (list, tuple)):
        return json.dumps(error, ensure_ascii=False)
    elif error is not None:
        reason = str(error)
    reason = str(reason or "").strip()
    if code.lower() == "bad_response_status_code" and reason.lower() in {"openai_error", "bad_response_status_code"}:
        reason = "上游通道未返回有效图片结果，请稍后重试或更换图片模型"
    if code and code.lower() not in reason.lower():
        reason = f"{reason}（错误码：{code}）" if reason else f"上游返回错误（错误码：{code}）"
    if reason:
        return reason
    current = _nested_dict(payload)
    if isinstance(current, dict):
        for key in REASON_KEYS:
            value = current.get(key)
            if isinstance(value, str) and value.strip():
                return value.strip()
    return ""


def _accept_url(found: list[str], value: Any) -> None:
    if isinstance(value, dict):
        value = value.get("url") or value.get("image_url") or value.get("video_url")
    text = value.strip() if isinstance(value, str) else ""
    if text and text not in found:
        found.append(text)


def collect_urls(payload: Any) -> list[str]:
    found: list[str] = []
    record = payload if isinstance(payload, dict) else {}
    for key in ("url", "image_url", "video_url"):
        _accept_url(found, record.get(key))
    for key in ("images", "data", "output", "results"):
        bucket = record.get(key)
        rows = bucket if isinstance(bucket, list) else []
        for item in rows:
            _accept_url(found, item)
        if isinstance(bucket, dict):
            _accept_url(found, bucket.get("url"))
            for item in bucket.get("images") or []:
                _accept_url(found, item)
    return found


def classify_remote(payload: Any) -> dict:
    status = read_status(payload)
    if status in SUCCESS:
        return {"state": "succeeded", "status": status, "urls": collect_urls(payload), "message": ""}
    if status in FAILED or (not status and read_error(payload) is not None):
        return {"state": "failed", "status": status, "urls": [], "message": failure_message(payload)}
    return {"state": "pending", "status": status, "urls": [], "message": ""}


def open_task(kind: str, provider_id: str, request_id: str = "") -> dict:
    return {
        "kind": kind,
        "provider_id": provider_id,
        "client_request_id": request_id,
        "status": "queued",
        "result": None,
        "error": "",
    }


def observe_task(record: Mapping[str, Any], observation: Mapping[str, Any]) -> dict:
    next_record = dict(record)
    state = observation.get("state")
    if state == "succeeded":
        next_record["status"] = "succeeded"
        next_record["result"] = {"urls": list(observation.get("urls") or [])}
        next_record["error"] = ""
    elif state == "failed":
        next_record["status"] = "failed"
        next_record["error"] = str(observation.get("message") or "")
    else:
        next_record["status"] = "running"
    return next_record


