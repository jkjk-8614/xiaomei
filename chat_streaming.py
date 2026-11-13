"""Translate provider chat streams into text, errors and a completed reply."""

import asyncio
from contextlib import AsyncExitStack, aclosing
import json

import httpx

from chat_replies import delta_text, message_text, unwrap_response
from network_diagnostics import log_net_error


_END = object()
_INCOMPLETE = object()


class _Deadline:
    def __init__(self, total, first_text):
        self.clock = asyncio.get_running_loop().time
        now = self.clock()
        self.end = now + total
        self.first = None if first_text is None else now + first_text

    def limit(self):
        if self.first is not None and self.first <= self.end:
            return self.first, "first"
        return self.end, "total"

    async def read(self, operation, *args):
        end, kind = self.limit()
        remaining = end - self.clock()
        if remaining <= 0:
            raise _Expired(kind)
        try:
            return await asyncio.wait_for(operation(*args), remaining)
        except asyncio.TimeoutError as error:
            raise _Expired(kind) from error


class _Expired(Exception):
    pass


class _Rejected(Exception):
    def __init__(self, detail, retryable):
        super().__init__(detail)
        self.retryable = retryable


def _decode(text):
    if text == "[DONE]":
        return _END
    try:
        return json.loads(text)
    except ValueError:
        return _INCOMPLETE if text.startswith(("{", "[")) else text


async def _frames(response, deadline):
    lines = response.aiter_lines().__aiter__()
    fragments = []
    while True:
        try:
            line = (await deadline.read(lines.__anext__)).strip()
        except StopAsyncIteration:
            if fragments:
                yield "\n".join(fragments)
            return
        if line.startswith((":", "event:", "id:", "retry:")):
            continue
        if line.startswith("data:"):
            line = line.removeprefix("data:").lstrip()
        if not line or line == "[DONE]":
            if fragments:
                yield "\n".join(fragments)
                fragments.clear()
            if line:
                yield _END
                return
            continue

        fragments.append(line)
        value = _decode("\n".join(fragments))
        if value is _INCOMPLETE:
            continue
        fragments.clear()
        yield value


async def _attempt(client, url, headers, body, deadline, transient, status_detail):
    async with AsyncExitStack() as stack:
        context = client.stream("POST", url, headers=headers, json=body)
        response = await deadline.read(stack.enter_async_context, context)
        status = response.status_code
        if status >= 400:
            raw = await deadline.read(response.aread)
            text = raw.decode("utf-8", errors="replace")
            raise _Rejected(status_detail(text, status), transient(text, status))
        async for frame in _frames(response, deadline):
            if frame is _END:
                return
            if isinstance(frame, str) and transient(frame, status):
                raise _Rejected(frame[:500], True)
            if not isinstance(frame, dict):
                continue
            packet = unwrap_response(frame)
            error = frame.get("error") or packet.get("error")
            if error:
                detail = error.get("message") if isinstance(error, dict) else str(error)
                raise _Rejected(detail or "上游接口返回了错误", transient(json.dumps(frame, ensure_ascii=False), status))
            yield packet


def _timeout_detail(kind, total, first_text):
    if kind == "first":
        return f"聊天模型在 {first_text:g} 秒内没有返回首段文字，已自动停止。请减少详情图片引用或切换聊天模型。"
    return f"聊天模型在 {total:g} 秒内没有完成回复，已自动停止。请重试或切换聊天模型。"


async def events(
    client, url, headers, body, *, timeout, first_text_timeout, retries, retry_delay, transient, status_detail, notice,
):
    deadline = _Deadline(timeout, first_text_timeout)
    parts = []
    for attempt in range(retries + 1):
        usage = None
        try:
            async with aclosing(_attempt(client, url, headers, body, deadline, transient, status_detail)) as packets:
                async for packet in packets:
                    usage = packet.get("usage") or usage
                    text = delta_text(packet)
                    if not text and not parts:
                        text = message_text(packet)
                    if text:
                        parts.append(text)
                        deadline.first = None
                        yield dict(type="delta", delta=text)
        except _Expired as error:
            yield dict(type="error", detail=_timeout_detail(error.args[0], timeout, first_text_timeout))
            return
        except httpx.TimeoutException as error:
            log_net_error("对话流式请求超时", error, url)
            first_expired = deadline.first is not None and deadline.clock() >= deadline.first
            kind = "first" if first_expired else "total"
            yield dict(type="error", detail=_timeout_detail(kind, timeout, first_text_timeout))
            return
        except _Rejected as error:
            if parts or attempt >= retries or not error.retryable:
                yield dict(type="error", detail=str(error))
                return
        except httpx.HTTPError as error:
            log_net_error("对话流式请求断开", error, url)
            if parts or attempt >= retries:
                yield dict(type="error", detail=f"请求上游接口失败（{type(error).__name__}）")
                return
        else:
            if parts:
                yield dict(type="complete", content="".join(parts).strip(), usage=usage)
            else:
                yield dict(type="error", detail="上游接口在返回文字前结束了连接，请重试或切换聊天模型")
            return

        delay = min(8.0, retry_delay * (attempt + 1))
        end, kind = deadline.limit()
        if deadline.clock() + delay >= end:
            yield dict(type="error", detail=_timeout_detail(kind, timeout, first_text_timeout))
            return
        notice(attempt + 1, retries, delay)
        await asyncio.sleep(delay)
