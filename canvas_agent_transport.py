"""Run canvas chat requests within one deadline across configured models."""

import asyncio
from dataclasses import dataclass
import re

from fastapi import HTTPException
import httpx

import chat_errors
import chat_replies
from network_diagnostics import log_net_error


_COMPLETION_TOKEN_MODELS = re.compile(r"^(?:o\d|gpt-[56])", re.IGNORECASE)
_FAST_MODELS = re.compile(r"sol|mini|flash|fast|lite|low", re.IGNORECASE)
_SLOW_MODELS = re.compile(r"opus|terra|pro|max|high|thinking|reasoning", re.IGNORECASE)


def model_candidates(provider, selected, limit):
    catalog = (provider or {}).get("chat_models") or []
    names = (str(name or "").strip() for name in (selected, *catalog))
    ordered = list(dict.fromkeys(name for name in names if name))
    if not ordered:
        return []
    alternatives = sorted(ordered[1:], key=lambda name: (not _FAST_MODELS.search(name), bool(_SLOW_MODELS.search(name))))
    return [ordered[0], *alternatives[:limit]]


@dataclass(frozen=True)
class RequestBudget:
    total: float
    attempt: float
    retries: int
    retry_delay: float


@dataclass(frozen=True)
class Completion:
    payload: dict
    model: str
    attempted_models: tuple


class _Retryable(Exception):
    def __init__(self, cause):
        self.cause = cause


def _body(model, messages, output_tokens, apimart):
    result = dict(model=model, messages=messages)
    if output_tokens:
        field = "max_completion_tokens" if _COMPLETION_TOKEN_MODELS.match(model) else "max_tokens"
        result[field] = output_tokens
    if apimart:
        result["stream"] = False
    return result


def _limits(seconds):
    return httpx.Timeout(connect=min(20.0, seconds), read=seconds, write=min(120.0, seconds), pool=min(20.0, seconds))


async def _try_model(url, headers, body, provider, rejection, *, clock, deadline, retries, delay):
    async with httpx.AsyncClient(timeout=_limits(max(0.001, deadline - clock()))) as client:
        for attempt in range(1, retries + 2):
            remaining = deadline - clock()
            if remaining <= 0:
                raise _Retryable(asyncio.TimeoutError())
            pause = delay * attempt
            try:
                response = await asyncio.wait_for(client.post(url, headers=headers, json=body), remaining)
            except (asyncio.TimeoutError, httpx.TimeoutException) as error:
                raise _Retryable(error) from error
            except httpx.TransportError as error:
                failure = error
            except (httpx.HTTPError, httpx.InvalidURL, ValueError) as error:
                raise HTTPException(502, f"请求上游接口失败（{type(error).__name__}）") from error
            else:
                if not response.is_error:
                    try:
                        return chat_replies.parse_completion(response)
                    except httpx.HTTPStatusError as error:
                        raise HTTPException(502, f"上游接口返回了意外状态 {response.status_code}") from error
                status, detail = response.status_code, response.text or ""
                rejection_detail = rejection(detail)
                if rejection_detail:
                    raise HTTPException(status, rejection_detail)
                explanation = chat_errors.friendly_detail(detail, body["model"], provider, status)
                failure = HTTPException(status, explanation or f"上游接口错误：{detail}")
                if not chat_errors.is_transient(detail, status):
                    raise failure
                pause = max(pause, chat_replies.retry_after_seconds(response))
                await response.aclose()
            pause = min(8.0, pause)
            if attempt > retries or clock() + pause >= deadline:
                raise _Retryable(failure)
            await asyncio.sleep(pause)


async def complete(
    url, headers, messages, candidates, *, provider, budget, output_tokens, transport_retries, apimart, rejection,
):
    clock = asyncio.get_running_loop().time
    deadline = clock() + budget.total
    reserved = min(budget.attempt, budget.total / 2)
    attempted = []
    error = None
    for index, model in enumerate(candidates):
        remaining = deadline - clock()
        if remaining <= 0:
            break
        before_final = len(candidates) - index - 1
        if before_final:
            slot = min(budget.attempt, (remaining - reserved) / before_final)
            if slot <= 0:
                continue
        else:
            slot = remaining
        retries = transport_retries
        if retries < 0:
            retries = budget.retries if len(candidates) == 1 else min(1, budget.retries)
        attempted.append(model)
        try:
            raw = await _try_model(
                url, headers, _body(model, messages, output_tokens, apimart), provider, rejection,
                clock=clock, deadline=min(deadline, clock() + slot), retries=retries, delay=budget.retry_delay,
            )
            return Completion(raw, model, tuple(attempted))
        except _Retryable as failure:
            error = failure.cause

    tried = "、".join(attempted)
    if isinstance(error, HTTPException):
        extra = f" 已尝试模型：{tried}。" if len(attempted) > 1 else ""
        raise HTTPException(error.status_code, str(error.detail) + extra) from error
    if error is None or isinstance(error, (asyncio.TimeoutError, httpx.TimeoutException)):
        extra = f"（已尝试：{tried}）" if tried else ""
        raise HTTPException(504, f"聊天模型在 {budget.total:g} 秒的等待时限内未返回回复{extra}。请重试或切换聊天模型。") from error
    log_net_error(f"画布 Agent 连接中断 model={attempted[-1]}", error, url)
    provider_name = (provider or {}).get("name") or (provider or {}).get("id") or "当前 API 平台"
    raise HTTPException(502, (
        f"{provider_name} 的聊天接口在返回响应前断开了连接（{type(error).__name__}）。"
        "请核对用量后重试，或切换到其他已拉取的聊天模型。"
    )) from error
