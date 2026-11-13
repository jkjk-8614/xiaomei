"""Request chat completions and assemble the assistant's saved message."""

import asyncio
import uuid

from fastapi import HTTPException
import httpx

from network_diagnostics import log_net_error


_NO_RAW = object()


def unwrap_response(payload):
    if isinstance(payload, dict) and "choices" not in payload:
        nested = payload.get("data")
        if isinstance(nested, dict):
            return nested
    return payload


def _choice_content(payload, key, separator):
    data = unwrap_response(payload)
    choices = data.get("choices") if isinstance(data, dict) else None
    if not isinstance(choices, list) or not choices or not isinstance(choices[0], dict):
        return ""
    entry = choices[0].get(key)
    if not isinstance(entry, dict):
        return ""
    content = entry.get("content")
    if not isinstance(content, list):
        return str(content) if content is not None else ""
    parts = (part.get("text") or part.get("content") for part in content if isinstance(part, dict))
    return separator.join(part for part in parts if isinstance(part, str) and part)


def message_text(payload):
    return _choice_content(payload, "message", "\n")


def delta_text(payload):
    return _choice_content(payload, "delta", "")


def assistant_message(text, model, created_at, *, usage=None, raw=_NO_RAW):
    record = dict(
        id=uuid.uuid4().hex, role="assistant", content=text,
        created_at=created_at, model=model, raw_usage=usage,
    )
    if raw is not _NO_RAW:
        record["raw"] = raw
    return record


def parse_completion(response):
    if not response.is_success:
        response.raise_for_status()
    if not response.content:
        raise HTTPException(502, "上游接口返回了空响应")
    try:
        payload = response.json()
    except ValueError as error:
        raise HTTPException(502, "上游接口返回的内容不是有效 JSON") from error
    if not isinstance(payload, dict):
        raise HTTPException(502, "上游接口返回的 JSON 缺少对话响应对象")
    return payload


def retry_after_seconds(response):
    try:
        return float(response.headers.get("Retry-After", ""))
    except (TypeError, ValueError):
        return 0.0


async def complete(client, url, headers, body, *, retries, retry_delay, is_transient, notice):
    for attempt in range(1, retries + 2):
        delay = retry_delay * attempt
        try:
            response = await client.post(url, headers=headers, json=body)
        except httpx.TransportError as error:
            if attempt > retries or isinstance(error, httpx.TimeoutException):
                raise
            reason = error
        else:
            if attempt > retries or not response.is_error or not is_transient(response.text, response.status_code):
                return parse_completion(response)
            delay = max(delay, retry_after_seconds(response))
            reason = response.status_code
            await response.aclose()
        delay = min(8.0, delay)
        notice(reason, attempt, retries, delay)
        await asyncio.sleep(delay)


def upstream_error(error, *, provider, provider_id, model, timeout, friendly, retries=True):
    if isinstance(error, httpx.HTTPStatusError):
        response = error.response
        detail = friendly(response.text, model, provider, response.status_code)
        return HTTPException(response.status_code, detail or f"上游接口错误：{response.text}")
    if isinstance(error, httpx.TimeoutException):
        return HTTPException(504, f"聊天模型响应超过 {timeout:g} 秒，已自动停止。请重试或切换聊天模型。")
    if isinstance(error, httpx.TransportError):
        log_net_error(f"对话 Agent 网络错误 provider={provider_id} model={model}", error)
        name = (provider or {}).get("name") or provider_id or "当前 API 平台"
        advice = "系统已自动重试。请稍后重试，或切换聊天模型。" if retries else "请重试或切换聊天模型。"
        return HTTPException(502, (
            f"{name} 的聊天模型「{model}」在返回响应前断开了连接（{type(error).__name__}）。"
            + advice
        ))
    return HTTPException(502, f"请求上游接口失败：{error}")
