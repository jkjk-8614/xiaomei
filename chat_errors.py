"""Classify and explain failures from the chat providers."""

import json
import re


_TEMPORARY_STATUS = frozenset({408, 425, 429, 500, 502, 503, 504, 520, 522, 524})
_TEMPORARY_CODES = {"unknown_error", "service_unavailable", "temporarily_unavailable", "overloaded"}
_TEMPORARY_MESSAGES = re.compile(
    r"(?:temporarily|service|upstream) unavailable|(?:upstream|gateway) timeout|network error"
    r"|connection (?:reset|closed)|server (?:disconnected|(?:is )?busy)|overloaded",
    re.IGNORECASE,
)
_ARK_ACCESS_CODES = {"invalidendpointormodel.notfound", "invalidendpointormodel.modelidaccessdisabled"}


def _error_fields(text):
    try:
        payload = json.loads(text)
    except (ValueError, TypeError):
        return "", text
    if not isinstance(payload, dict):
        return "", text
    nested = payload.get("error")
    fields = nested if isinstance(nested, dict) else {}
    code = str(fields.get("code") or payload.get("code") or "").strip().lower()
    detail = fields.get("message") or payload.get("message") or (nested if isinstance(nested, str) else text)
    return code, str(detail).strip()


def _status(value):
    try:
        return int(value or 0)
    except (ValueError, TypeError):
        return 0


def is_transient(text="", status_code=0):
    if _status(status_code) in _TEMPORARY_STATUS:
        return True
    code, detail = _error_fields(str(text or ""))
    return code in _TEMPORARY_CODES or bool(_TEMPORARY_MESSAGES.search(detail))


def friendly_detail(text, model="", provider=None, status_code=0):
    source = str(text or "")
    status = _status(status_code)
    code, detail = _error_fields(source)
    profile = provider or {}
    platform = profile.get("name") or profile.get("id") or "当前 API 平台"
    name = str(model or "").strip() or "当前模型"
    if str(profile.get("protocol") or "").strip().lower() == "volcengine" and (
        code in _ARK_ACCESS_CODES or "does not exist or you do not have access to it" in detail.lower()
    ):
        return (
            f"火山方舟无法访问聊天模型「{name}」。请确认模型权限，或填写已开通的推理接入点 ID（ep-…）。"
            "如果已经使用接入点，请检查其绑定的模型和所在区域。"
        )
    if status == 401 or re.search(r"\b(?:401|unauthorized)\b", source, re.I):
        return "API Key 无效或已过期，请到「API 设置」检查 Key。"
    if status == 429 or re.search(r"\b(?:429|rate limit)", source, re.I):
        return "请求过于频繁，已被上游限流，请稍后再试。"
    if is_transient(source, status):
        return f"{platform} 的聊天模型「{name}」暂时不可用。请稍后重试，或在 Agent 顶部切换到其他已拉取的聊天模型。"
    return ""
