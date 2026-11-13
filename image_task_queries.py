"""Read and poll already-submitted provider image tasks."""

import asyncio
from dataclasses import dataclass, field
import json
import re
from urllib.parse import quote

from fastapi import HTTPException
import httpx

import dispatch_kernel
from media_result_payloads import extract_images
from responses_images import responses_no_image_detail, responses_output_text_image


_TASK_ID_IN_MESSAGE = re.compile(
    r"\b(?:task|submit|job|operation|generation)[_ ]?id\s*[=:：]\s*([A-Za-z0-9_.:-]+)", re.I,
)
_QUERY_PATHS = (
    "v1/tasks", "v1/images/tasks", "v1/images/generations", "v1/jobs", "v1/predictions",
    "tasks", "images/tasks", "jobs", "predictions",
)


def extract_task_id(payload):
    return dispatch_kernel.task_receipt(payload) or None


def extract_task_id_from_text(text):
    found = _TASK_ID_IN_MESSAGE.search(str(text or ""))
    return found[1] if found else ""


def image_task_error_payload(payload):
    return dispatch_kernel.read_error(payload, extra_envelopes=("errors",))


def image_task_error_code(payload):
    error = image_task_error_payload(payload)
    if isinstance(error, dict):
        return str(error.get("code") or error.get("error_code") or error.get("errorCode") or "").strip()
    return ""


def _status_and_record(payload):
    data = payload.get("data") if isinstance(payload, dict) else None
    if isinstance(data, list):
        for row in dispatch_kernel.task_records(data):
            status = dispatch_kernel.read_status(row)
            if status:
                return status, row
    status = dispatch_kernel.read_status(payload)
    if not status:
        for row in dispatch_kernel.task_records(payload):
            status = dispatch_kernel.read_status(row)
            if status:
                return status, row
    return status, payload


def image_task_status(payload):
    return _status_and_record(payload)[0]


def image_task_fail_reason(payload):
    _, record = _status_and_record(payload)
    error = image_task_error_payload(payload)
    reason = dispatch_kernel.failure_message(record, error=error)
    if not reason and record is not payload:
        return dispatch_kernel.failure_message(payload, error=error)
    return reason


@dataclass(frozen=True)
class Observation:
    state: str
    images: list = field(default_factory=list)
    error: object = None


def inspect(payload):
    error = image_task_error_payload(payload)
    status = image_task_status(payload)
    if error is not None or status in dispatch_kernel.FAILED:
        return Observation("failed", error=error)
    if status and status not in dispatch_kernel.SUCCESS:
        return Observation("running")
    try:
        return Observation("succeeded", images=extract_images(payload))
    except HTTPException:
        return Observation("awaiting_result" if status else "running")


def endpoints(provider, task_id, *, apimart=False, fallback_base=""):
    effective = dict(provider or {})
    base = str(effective.get("base_url") or fallback_base).rstrip("/")
    effective["base_url"] = base
    root = base.removesuffix("/v1")
    segment = quote(str(task_id), safe="")
    preferred = dispatch_kernel.task_lookup_url(effective, segment, apimart=apimart)
    return tuple(dict.fromkeys((preferred, *(f"{root}/{path}/{segment}" for path in _QUERY_PATHS))))


async def fetch(task_id, addresses, get):
    last_response = None
    receipt_without_image = None
    for address in addresses:
        last_response = await get(address)
        if last_response.status_code in (400, 404, 405):
            continue
        last_response.raise_for_status()
        try:
            payload = last_response.json()
        except ValueError:
            continue
        if inspect(payload).state == "awaiting_result":
            receipt_without_image = payload
            continue
        return payload
    if receipt_without_image is not None:
        return receipt_without_image
    if last_response is not None:
        last_response.raise_for_status()
    raise HTTPException(status_code=502, detail=f"无法查询生图任务，task_id={task_id}")


def _terminal_failure(task_id, payload, observation):
    error = HTTPException(status_code=502, detail=f"生图任务失败：{image_task_fail_reason(payload)}")
    error.upstream_payload = payload
    error.upstream_task_id = task_id
    error.upstream_terminal_error = True
    if observation.error is not None:
        error.upstream_error_code = image_task_error_code(payload)
    return error


def validate_submission(payload):
    status = image_task_status(payload)
    if status not in dispatch_kernel.PENDING and status not in dispatch_kernel.FAILED:
        return
    task_id = extract_task_id(payload)
    if not task_id:
        return
    if status in dispatch_kernel.FAILED:
        raise _terminal_failure(task_id, payload, inspect(payload))
    raise HTTPException(status_code=502, detail="生图任务尚未完成")


async def resolve_submission(response, provider, model, *, responses_mode, decode, retrieve, save_recovery):
    try:
        submission = response.json()
    except ValueError:
        response.raise_for_status()
        raise
    if image_task_error_payload(submission) is not None:
        label = provider.get("name") or provider["id"]
        status = response.status_code if response.status_code >= 400 else 502
        error = HTTPException(status_code=status, detail=f"{label} 生图接口返回失败：{image_task_fail_reason(submission)}")
        error.upstream_payload = submission
        error.upstream_error_code = image_task_error_code(submission)
        error.upstream_terminal_error = True
        task_id = extract_task_id(submission)
        if task_id:
            error.upstream_task_id = task_id
        raise error
    response.raise_for_status()

    provider_id = provider["id"]
    try:
        validate_submission(submission)
        return decode(submission), submission
    except HTTPException as error:
        if getattr(error, "upstream_terminal_error", False):
            raise
        if responses_mode:
            fallback = responses_output_text_image(submission)
            if fallback:
                return fallback, submission
            raise HTTPException(status_code=502, detail=responses_no_image_detail(submission) or error.detail) from error
        task_id = extract_task_id(submission)
        if not task_id:
            recovery_id = save_recovery(provider_id, model, submission)
            raise HTTPException(
                status_code=502,
                detail=f"上游已返回结果，但小美画布暂时无法识别图片格式。原始结果已保存，恢复编号：{recovery_id}。请勿重新生成，避免重复扣费。",
            ) from error

    result = None
    try:
        result = await retrieve(task_id)
        return decode(result), result
    except HTTPException as error:
        if getattr(error, "upstream_terminal_error", False):
            raise
        latest = getattr(error, "upstream_payload", result)
        if latest is None:
            latest = result
        detail = str(error.detail or "")
        if any(note in detail for note in ("无法识别", "没有返回图片数据")):
            recovery_id = save_recovery(provider_id, model, latest or {}, task_id)
            error.detail = (
                "上游任务已完成，但小美画布暂时无法识别图片格式。"
                f"原始结果已保存，恢复编号：{recovery_id}。请勿重新生成，避免重复扣费。"
            )
        else:
            recovery_id = save_recovery(provider_id, model, {
                "submission": submission, "task_result": latest, "error": detail,
            }, task_id)
        error.recovery_id = recovery_id
        error.upstream_task_id = task_id
        raise


async def wait(task_id, retrieve, *, timeout, interval, initial_delay=0, on_receipt=None):
    if callable(on_receipt):
        try:
            on_receipt(task_id)
        except Exception:
            pass
    clock = asyncio.get_running_loop().time
    deadline = clock() + timeout
    payload = {}
    if initial_delay > 0 and timeout > 0:
        await asyncio.sleep(min(initial_delay, timeout))
    while (remaining := deadline - clock()) > 0:
        try:
            payload = await asyncio.wait_for(retrieve(), timeout=remaining)
        except asyncio.TimeoutError:
            break
        except httpx.HTTPStatusError as error:
            error.upstream_task_id = task_id
            if error.response.status_code >= 500:
                error.upstream_terminal_error = True
            raise
        observation = inspect(payload)
        if observation.state == "succeeded":
            return payload
        if observation.state == "failed":
            raise _terminal_failure(task_id, payload, observation)
        await asyncio.sleep(min(interval, max(0, deadline - clock())))

    detail = f"生图任务超时（已等待 {int(timeout)} 秒），task_id={task_id}"
    if payload:
        detail += "，最后响应：" + json.dumps(payload, ensure_ascii=False)[:800]
    error = HTTPException(status_code=504, detail=detail)
    error.upstream_payload = payload
    error.upstream_task_id = task_id
    raise error
