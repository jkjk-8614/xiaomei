"""Discover model catalogs and verify the configured provider protocol."""

import re
from urllib.parse import urlsplit

from fastapi import HTTPException
import httpx

import api6789_video
from dispatch_kernel import bearer_auth_value
from scnet_api import is_scnet_provider, scnet_api_base, supplement_scnet_models


_MODEL_ROOTS = {"gemini": "/v1beta", "volcengine": "/api/v3", "runninghub": "/openapi/v2"}
_REDIRECTS = {301, 302, 303, 307, 308}
_AUTH_ERRORS = {401, 403}
_PROBE_ID = "healthcheck_probe_do_not_submit"
_ARK_PROBE_ID = "cgt-20000101000000-00000"
_MODEL_TYPES = ("image", "chat", "video")
_VIDEO_MARKERS = (
    "veo", "sora", "wan2", "wanx", "seedance", "doubao-1", "kling", "hailuo", "happyhorse",
    "minimax-h3", "minimax-video", "minimax-01", "video", "t2v-", "i2v-", "s2v",
)
_IMAGE_MARKERS = (
    "banana", "image", "dalle", "dall-e", "imagen", "flux", "stable", "sdxl",
    "midjourney", "ideogram", "fal-ai", "klein", "seedream",
)
_UNAVAILABLE = {
    "archived", "decommissioned", "deleted", "disabled", "discontinued", "inactive",
    "not_found", "not-found", "offline", "removed", "retired", "suspended", "unavailable",
}
_FALSE_FLAGS = {"0", "false", "no", "off", "disabled", "inactive", "unavailable"}
_AGNES_HOST = "apihub.agnes-ai.com"


def _versioned(base, version):
    return base if base.endswith(version) else base + version


def models_url(base, protocol):
    base = base.rstrip("/")
    if is_scnet_provider({"base_url": base}):
        return f"{scnet_api_base(base)}/models"
    return _versioned(base, _MODEL_ROOTS.get(protocol, "/v1")) + "/models"


def request_headers(key, protocol):
    name = "x-goog-api-key" if protocol == "gemini" else "Authorization"
    value = key if protocol == "gemini" else bearer_auth_value(key)
    return {"Accept": "application/json", name: value}


def validate_base(value):
    base = str(value or "").strip().rstrip("/")
    if not base:
        raise HTTPException(400, "请先填写请求地址")
    if not base.startswith(("https://", "http://")):
        raise HTTPException(400, "请求地址必须以 http:// 或 https:// 开头")
    try:
        parts = urlsplit(base)
        valid = bool(parts.hostname) and not any(char.isspace() for char in parts.netloc)
        if parts.port is not None and not 1 <= parts.port <= 65535:
            valid = False
    except ValueError:
        valid = False
    if not valid:
        raise HTTPException(400, "请求地址的主机名或端口不合法。")
    return base


def classify_model(value):
    model = str(value or "").lower()
    if any(marker in model for marker in _VIDEO_MARKERS):
        return "video"
    if any(marker in model for marker in _IMAGE_MARKERS):
        return "image"
    return "chat"


def image_mode_hint(base="", models=None):
    if _AGNES_HOST in str(base or "").lower():
        return "openai-json"
    if any(str(model or "").strip().lower().startswith("agnes-image-") for model in models or ()):
        return "openai-json"
    return ""


def _flag(value):
    if isinstance(value, (bool, int, float)):
        return bool(value)
    return str(value or "").strip().lower() not in _FALSE_FLAGS


def model_is_available(item):
    if not isinstance(item, dict):
        return True
    for field in ("deleted", "disabled"):
        if field in item and _flag(item[field]):
            return False
    for field in ("enabled", "available", "active", "is_active"):
        if field in item and not _flag(item[field]):
            return False
    return all(
        not isinstance(item.get(field), str) or item[field].strip().lower().replace(" ", "_") not in _UNAVAILABLE
        for field in ("status", "state")
    )


def _records(raw):
    if not isinstance(raw, dict):
        return []
    records = raw.get("data") or raw.get("models") or raw.get("list")
    return records if isinstance(records, list) else []


def _model_id(record):
    if isinstance(record, str):
        return record.strip()
    if isinstance(record, dict):
        return str(record.get("id") or record.get("name") or record.get("model") or "").strip()
    return ""


def _group(ids):
    grouped = {kind: [] for kind in _MODEL_TYPES}
    for model in ids:
        grouped[classify_model(model)].append(model)
    return grouped


def _available_ids(records, protocol):
    ids = set()
    for record in records:
        if model_is_available(record):
            model = _model_id(record)
            if protocol == "gemini":
                model = model.removeprefix("models/")
            if model:
                ids.add(model)
    return sorted(ids)


def parse_models(raw, protocol="openai"):
    ids = _available_ids(_records(raw), protocol)
    return _group(ids), ids


def _fields(grouped=None, ids=None):
    grouped = grouped or {}
    fields = {f"{kind}_models": grouped.get(kind, []) for kind in _MODEL_TYPES}
    return {**fields, "all": ids or []}


NEWAPI_GATEWAY_HEADERS = ("x-new-api-version", "x-oneapi-request-id")

def is_newapi_upstream_response(response) -> bool:
    """New API / One API 网关会在响应头里带版本号或请求号。

    ``/v1/models`` 只返回当前 Key 所属分组的模型，但站点公开的
    ``/api/pricing`` 会列出全部分组。用响应头识别网关，避免给普通
    OpenAI 兼容平台多发一次探测请求。
    """
    headers = getattr(response, "headers", None)
    if not headers:
        return False
    return any(headers.get(name) for name in NEWAPI_GATEWAY_HEADERS)

def newapi_site_root(base_url: str):
    base = str(base_url or "").strip().rstrip("/")
    for suffix in ("/v1beta", "/api/v3", "/v1"):
        if base.endswith(suffix):
            return base[: -len(suffix)]
    return base

async def read_newapi_pricing_models(base_url: str):
    """读取 New API 站点公开的模型清单，返回 {模型 ID: {groups, endpoints}}。"""
    root = newapi_site_root(base_url)
    if not root:
        return {}
    try:
        async with httpx.AsyncClient(timeout=8) as client:
            response = await client.get(
                f"{root}/api/pricing",
                headers={"Accept": "application/json"},
            )
    except httpx.HTTPError:
        return {}
    if response.status_code >= 400 or _html(response):
        return {}
    try:
        raw = response.json()
    except Exception:
        return {}
    items = raw.get("data") if isinstance(raw, dict) else None
    if not isinstance(items, list):
        return {}
    models = {}
    for item in items:
        if not isinstance(item, dict):
            continue
        if not any(key in item for key in ("quota_type", "model_ratio", "model_price", "enable_groups")):
            continue
        name = str(item.get("model_name") or item.get("model") or "").strip()
        if not name:
            continue
        groups_raw = item.get("enable_groups")
        endpoints_raw = item.get("supported_endpoint_types")
        groups = [str(value).strip() for value in groups_raw if str(value).strip()] if isinstance(groups_raw, list) else []
        endpoints = [str(value).strip().lower() for value in endpoints_raw if str(value).strip()] if isinstance(endpoints_raw, list) else []
        models[name] = {"groups": groups, "endpoints": endpoints}
    return models

async def supplement_newapi_group_models(base_url, grouped, ids):
    """补齐 New API 网关其它分组里的生图/视频模型。

    很多 New API 站点把生图模型放在独立分组（例如「生图分组」），
    而 ``/v1/models`` 只按当前 Key 的分组过滤，导致站点明明有图却拉到 0 个。
    这里只补充图片/视频模型，并把分组写进提示，避免影响聊天模型清单。
    """
    pricing = await read_newapi_pricing_models(base_url)
    if not pricing:
        return grouped, ids, {}
    known = set(ids or [])
    merged = {key: list(value or []) for key, value in (grouped or {}).items()}
    added = []
    added_groups = {}
    for name, meta in pricing.items():
        if name in known:
            continue
        category = classify_model(name)
        if category == "chat":
            continue
        if name not in merged.setdefault(category, []):
            merged[category].append(name)
        added.append(name)
        added_groups[name] = list(meta.get("groups") or [])
    if not added:
        return grouped, ids, {}
    merged = {key: sorted(set(value or [])) for key, value in merged.items()}
    merged_ids = sorted(known | set(added))
    groups = []
    for values in added_groups.values():
        for group in values:
            if group not in groups:
                groups.append(group)
    group_text = f"（{'、'.join(groups)}）" if groups else ""
    message = (
        f"上游 /v1/models 未返回以下 {len(added)} 个生图/视频模型{group_text}；"
        "它们来自站点其它分组，可能需要对应分组的 Key 或授权后才能调用，实际以生成接口返回为准。"
    )
    return merged, merged_ids, {"model_groups": added_groups, "message": message}


async def _catalog(base, raw, protocol, apply_recommended, response):
    records = _records(raw)
    ids = _available_ids(records, protocol)
    if api6789_video.is_provider({"base_url": base}):
        ids = sorted({api6789_video.catalog_model(model) for model in ids})
    if _AGNES_HOST in base.lower() and not records:
        ids = ["agnes-video-v2.0"]
    grouped = _group(ids)
    excluded = [_model_id(row) for row in records if not model_is_available(row)]
    grouped, ids, discovery = await supplement_scnet_models(base, grouped, ids, excluded)
    if protocol == "openai" and is_newapi_upstream_response(response):
        grouped, ids, extra = await supplement_newapi_group_models(base, grouped, ids)
        discovery.update(extra)
    return {**_fields(apply_recommended(base, grouped), ids), **discovery}


def _html(response):
    start = response.text.lstrip("\ufeff \r\n\t")[:200].lower()
    return start.startswith(("<!doctype html", "<html")) or "<head" in start


def _json_or_excerpt(response):
    if not response.content:
        return {}
    try:
        return response.json()
    except ValueError:
        return response.text[:500]


def _transport_problem(response, label):
    if response.status_code in _REDIRECTS:
        target = response.headers.get("location") or response.headers.get("Location")
        location = f"（{target}）" if target else ""
        return f"{label} 发生跳转{location}。请填写 API Base URL。"
    if _html(response):
        return f"{label} 返回网页 HTML。请检查 API Base URL。"
    return ""


def _probe(response, message, raw):
    return {"status": response.status_code, "message": message, "raw": raw}


async def _ark_tasks(client, base, key):
    endpoint = _versioned(base, "/api/v3") + "/contents/generations/tasks"
    headers = request_headers(key, "volcengine")
    response = await client.get(endpoint, headers=headers, params={"page_size": 1, "filter.task_ids": _ARK_PROBE_ID})
    raw = _json_or_excerpt(response)
    problem = _transport_problem(response, "方舟任务列表")
    if problem:
        return False, _probe(response, problem, raw)
    if response.status_code in _AUTH_ERRORS:
        return False, _probe(response, "方舟 API Key 无效或无权限", raw)
    if response.is_success and isinstance(raw, dict):
        if isinstance(raw.get("items"), list) or raw.get("total") == 0:
            return True, _probe(response, "方舟任务查询端点可达", {"total": raw.get("total")})
    if response.status_code in (404, 405):
        # Some Ark gateways only forward lookup by task ID.
        response = await client.get(f"{endpoint}/{_ARK_PROBE_ID}", headers=headers)
        raw = _json_or_excerpt(response)
        error = raw.get("error") if isinstance(raw, dict) else None
        if response.is_success and isinstance(raw, dict) and raw.get("id") and raw.get("status"):
            return True, _probe(response, "方舟任务查询端点可达", {"status": raw["status"]})
        if response.status_code in (400, 404) and isinstance(error, dict):
            code = str(error.get("code") or "").lower()
            message = str(error.get("message") or "").lower()
            mentions_task = re.search(r"\btask\b|任务", message)
            if mentions_task and code.startswith(("invalidparameter", "resourcenotfound", "tasknotfound", "notfound")):
                return True, _probe(response, "方舟任务查询端点可达", raw)
        problem = _transport_problem(response, "方舟任务查询")
    if response.status_code in _AUTH_ERRORS:
        problem = "方舟 API Key 无效或无权限"
    return False, _probe(response, problem or f"方舟任务接口未通过验证（HTTP {response.status_code}）", raw)


async def _chat_probe(client, base, key):
    root = _versioned(base.removesuffix("/api/v3"), "/v1")
    response = await client.post(
        f"{root}/chat/completions", headers=request_headers(key, "openai"), json={"messages": []},
    )
    raw = _json_or_excerpt(response)
    problem = _transport_problem(response, "OpenAI 兼容入口")
    if not problem and isinstance(raw, dict):
        completion = response.is_success and isinstance(raw.get("choices"), list)
        validation_error = response.status_code in (400, 422) and bool(raw.get("error"))
        if completion or validation_error:
            return True, _probe(response, "OpenAI 兼容 Bearer 鉴权入口可达", raw)
    if response.status_code in _AUTH_ERRORS:
        problem = "API Key 无效或无权限"
    return False, _probe(response, problem or f"OpenAI 兼容入口未通过验证（HTTP {response.status_code}）", raw)


async def _ark_protocol(client, base, key, *, accept_compat):
    ok, task = await _ark_tasks(client, base, key)
    if ok or not accept_compat:
        return ok, {**task, "raw": {"task_probe": task["raw"]}}
    compat_ok, compat = await _chat_probe(client, base, key)
    raw = {"task_probe": task, "openai_compat_probe": compat["raw"]}
    return compat_ok, {**compat, "raw": raw}



def _catalog_failure(verify, status, message, *, client_status=None):
    if verify:
        return {"ok": False, "status": status, "message": message}
    raise HTTPException(client_status or status, message)


def _ark_catalog(verify, status, message, raw, *, model_request_failed=False):
    fields = {"message": message, "raw": raw, **_fields()}
    if verify:
        return {**fields, "ok": True, "status": status, "protocol": "volcengine", "model_count": 0}
    if model_request_failed:
        fields["protocol"] = "volcengine"
    return {**fields, "total": 0}


def _ark_model_message(protocol):
    if protocol == "openai":
        reason = "已检测到方舟任务接口。OpenAI 模型列表不可用，已切换为方舟协议。"
    else:
        reason = "方舟协议验证通过，模型列表请求失败。"
    return reason + "请按方舟控制台中的模型名称手动填写。"


async def load_models(base, key, protocol, image_mode, apply_recommended, *, verify=False):
    url = models_url(base, protocol)
    label = "上游 " + _MODEL_ROOTS.get(protocol, "/v1") + "/models"
    ark_protocol = protocol == "volcengine"
    try:
        async with httpx.AsyncClient(timeout=15 if verify else 30) as client:
            response = await client.get(url, headers=request_headers(key, protocol))
            status = response.status_code
            problem = _transport_problem(response, label)
            if problem:
                return _catalog_failure(verify, status, problem, client_status=400)
            if status >= 400:
                if protocol in {"openai", "volcengine"}:
                    ok, probe = await _ark_protocol(client, base, key, accept_compat=ark_protocol)
                    if ok:
                        raw = {"models_error": response.text[:300], **probe["raw"]}
                        return _ark_catalog(
                            verify, probe["status"], _ark_model_message(protocol), raw, model_request_failed=True,
                        )
                message = response.text[:300] or f"{label} 请求失败（HTTP {status}）"
                return _catalog_failure(verify, status, message)
            try:
                raw = response.json() if response.content else {}
            except ValueError:
                raw = None
            if not isinstance(raw, (dict, list)):
                return _catalog_failure(verify, 502, f"{label} 返回了无法解析的模型列表。")
            fields = await _catalog(base, raw, protocol, apply_recommended, response)
            ids = fields["all"]
            if ark_protocol and not ids:
                ok = not verify
                if verify:
                    ok, _ = await _ark_protocol(client, base, key, accept_compat=True)
                if ok:
                    message = "方舟模型列表未返回可用模型。请按方舟控制台中的模型名称手动填写。"
                    return _ark_catalog(verify, status, message, raw)
            fields["image_request_mode"] = image_mode_hint(base, ids) or image_mode
            if verify:
                return {**fields, "ok": True, "status": status, "model_count": len(ids)}
            return {**fields, "total": len(ids)}
    except httpx.HTTPError as exc:
        if ark_protocol:
            try:
                async with httpx.AsyncClient(timeout=15) as client:
                    ok, probe = await _ark_protocol(client, base, key, accept_compat=True)
            except httpx.HTTPError:
                ok = False
            if ok:
                raw = {"models_error": str(exc)[:300], **probe["raw"]}
                return _ark_catalog(
                    verify, probe["status"], _ark_model_message(protocol), raw, model_request_failed=True,
                )
        return _catalog_failure(verify, 0, f"请求上游模型列表失败。{str(exc)[:300]}", client_status=502)


def _async_task_probe(response, raw):
    problem = _transport_problem(response, "/v1/tasks/")
    if problem:
        return False, problem
    error = raw.get("error") if isinstance(raw, dict) else ""
    message = error.get("message") if isinstance(error, dict) else error
    invalid_id = re.search(r"invalid task id|无效的任务", str(message or ""), re.I)
    status = response.status_code
    if status == 400 and invalid_id:
        return True, "APIMart 异步任务端点可用，API Key 已通过认证"
    if status in _AUTH_ERRORS:
        return False, "/v1/tasks/ 返回鉴权失败"
    return False, f"/v1/tasks/ 未通过验证（HTTP {status}）"


def _protocol_reply(ok, protocol, status, message, raw):
    return {"ok": ok, "protocol": protocol, "status_code": status, "message": message, "raw": raw}


async def probe_protocol(base, key, protocol, image_mode, apply_recommended):
    async with httpx.AsyncClient(timeout=15) as client:
        if protocol == "volcengine":
            ok, ark = await _ark_protocol(client, base, key, accept_compat=True)
            return _protocol_reply(ok, "volcengine", ark["status"], ark["message"], ark["raw"])
        endpoint = _versioned(base, "/v1") + "/tasks/" + _PROBE_ID
        tasks = await client.get(endpoint, headers=request_headers(key, "openai"))
        task_raw = _json_or_excerpt(tasks)
        task_ok, task_message = _async_task_probe(tasks, task_raw)
        if task_ok or protocol == "apimart":
            return _protocol_reply(task_ok, "apimart", tasks.status_code, task_message, task_raw)

        models = await client.get(models_url(base, "openai"), headers=request_headers(key, "openai"))
        models_raw = _json_or_excerpt(models)
        raw = {"async_probe": _probe(tasks, task_message, task_raw), "openai_probe": models_raw}
        model_problem = _transport_problem(models, "OpenAI /v1/models")
        model_ok = models.is_success and not model_problem and isinstance(models_raw, (list, dict))
        if model_ok:
            fields = await _catalog(base, models_raw, "openai", apply_recommended, models)
            ids = fields["all"]
            message = "OpenAI 兼容模型列表端点可用"
            if ids:
                message += f"，找到 {len(ids)} 个模型"
            if fields.get("message"):
                message += "；" + fields["message"]
            reply = _protocol_reply(True, "openai", models.status_code, message, raw)
            return {
                **fields, **reply, "model_count": len(ids),
                "model_sources": fields.get("model_sources", {}),
                "image_request_mode": image_mode_hint(base, ids) or image_mode,
            }
        if protocol == "openai":
            compat_ok, compat = await _chat_probe(client, base, key)
            if compat_ok:
                raw["openai_compat_probe"] = compat["raw"]
                message = "OpenAI 兼容入口可达。该站未提供模型列表，请手动填写模型。"
                return {**_protocol_reply(True, "openai", compat["status"], message, raw), "model_count": 0, **_fields()}
            ark_ok, ark = await _ark_protocol(client, base, key, accept_compat=False)
            if ark_ok:
                raw.update(ark["raw"])
                return _protocol_reply(True, "volcengine", ark["status"], "检测到方舟任务协议，已自动切换。", raw)

        if models.status_code in _AUTH_ERRORS and not model_problem:
            model_problem = "OpenAI API Key 无效或无权限"
        message = model_problem or f"OpenAI 模型列表未通过验证（HTTP {models.status_code}）"
        return {
            **_protocol_reply(False, "openai", models.status_code, message, raw),
            "model_count": 0, "model_sources": {}, "image_request_mode": image_mode_hint(base) or image_mode,
            **_fields(),
        }
