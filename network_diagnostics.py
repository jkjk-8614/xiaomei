"""Collect recent image delivery checks and log errors without credentials."""

import asyncio
import errno
import re
import socket
import ssl
import time
from collections import OrderedDict
from threading import Lock
from urllib.parse import urlsplit
from urllib.request import getproxies

import httpx


_SAFE_REASON = re.compile(r"[A-Z0-9_]{1,64}")


def _origin(address):
    try:
        parsed = urlsplit(str(address or ""))
        host = parsed.hostname
        port = parsed.port
    except (TypeError, ValueError):
        return ""
    if not parsed.scheme or not host:
        return ""
    if ":" in host:
        host = f"[{host}]"
    return f"{parsed.scheme}://{host}" + (f":{port}" if port is not None else "")


def http_origin(address):
    origin = _origin(address)
    return origin if origin.startswith(("http://", "https://")) else ""


def _request_address(error):
    try:
        return error.request.url
    except (AttributeError, RuntimeError):
        return ""


def _failure_chain(error):
    seen = set()
    while error is not None and id(error) not in seen and len(seen) < 6:
        seen.add(id(error))
        label = type(error).__name__
        for field in ("errno", "winerror", "verify_code"):
            number = getattr(error, field, None)
            if isinstance(number, int):
                label += f" {field}={number}"
        reason = getattr(error, "reason", None)
        if isinstance(reason, str) and _SAFE_REASON.fullmatch(reason):
            label += f" reason={reason}"
        status = getattr(getattr(error, "response", None), "status_code", None)
        if isinstance(status, int):
            label += f" http_status={status}"
        yield label
        error = error.__cause__ or error.__context__


def log_net_error(context, exc, url=""):
    try:
        try:
            proxies = getproxies()
            configured = ",".join(key for key in ("http", "https", "all") if proxies.get(key))
        except OSError:
            configured = "unknown"
        endpoint = _origin(url or _request_address(exc)) or "unknown"
        chain = " <- ".join(_failure_chain(exc))
        context = " ".join(str(context).split())
        print(f"[NET-ERR] {context} | origin={endpoint} | proxy={configured or 'none'} | {chain}", flush=True)
    except Exception:
        pass


IMAGE_CHECKS = ("provider", "query", "download", "save")
RECENT_SECONDS = 30 * 60
_recent = OrderedDict()
_recent_lock = Lock()


def error_code(exc):
    status = getattr(getattr(exc, "response", None), "status_code", None)
    status = status or getattr(exc, "status_code", None)
    if isinstance(status, int):
        return f"http_{status}"
    if isinstance(exc, httpx.ProxyError):
        return "proxy"
    if isinstance(exc, (httpx.TimeoutException, asyncio.TimeoutError, TimeoutError)):
        return "timeout"
    seen = set()
    while exc is not None and id(exc) not in seen:
        seen.add(id(exc))
        if isinstance(exc, ssl.SSLError):
            return "tls"
        if isinstance(exc, socket.gaierror) or getattr(exc, "winerror", None) in {11001, 11002, 11004}:
            return "dns"
        if isinstance(exc, PermissionError):
            return "permission"
        if getattr(exc, "errno", None) == errno.ENOSPC or getattr(exc, "winerror", None) == 112:
            return "disk_full"
        if getattr(exc, "code", "") in {"invalid_image", "local_file_missing"}:
            return exc.code
        if exc.__cause__ is None and exc.__context__ is None:
            break
        exc = exc.__cause__ or exc.__context__
    return "connection"


def request_proxy(client, address):
    try:
        # HTTPX applies per-destination proxy and NO_PROXY rules in its transport selection.
        return "proxy" if client._transport_for_url(httpx.URL(address)) is not client._transport else "direct"
    except (AttributeError, ValueError, httpx.InvalidURL):
        return ""


def check_result(status, code, *, url="", started=None):
    return {
        "status": status,
        "code": code,
        "origin": _origin(url),
        "checked_at": time.time(),
        "elapsed_ms": round((time.monotonic() - started) * 1000) if started is not None else None,
    }


def record_image_check(provider_id, stage, status, code, *, url="", started=None,
                       sample_url="", recovery_id="", proxy_route="", probe=False):
    if not provider_id:
        return
    entry = check_result(status, code, url=url, started=started)
    if recovery_id:
        entry["recovery_id"] = recovery_id
    if proxy_route:
        entry["proxy_route"] = proxy_route
    with _recent_lock:
        checks = _recent.setdefault(provider_id, {})
        previous = checks.get(stage, {})
        if probe and code in {"timeout", "connection", "dns", "tls", "proxy"}:
            if previous.get("status") in {"warning", "error"} and time.time() - previous["checked_at"] < RECENT_SECONDS:
                entry["status"] = "error"
            else:
                entry["status"] = "warning"
        # A completed probe must not erase a failure from a later real request.
        if probe and started is not None and previous.get("checked_at", 0) > time.time() - (time.monotonic() - started):
            return
        checks[stage] = entry
        if sample_url:
            checks["sample_url"] = sample_url
        if stage == "save" and status == "ok":
            checks["sample_url"] = sample_url
        if stage in {"download", "save"} and status == "error":
            checks["incident"] = {**entry, "stage": stage}
        _recent.move_to_end(provider_id)
        while len(_recent) > 64:
            _recent.popitem(last=False)


def clear_image_incident(provider_id, recovery_id):
    with _recent_lock:
        checks = _recent.get(provider_id, {})
        if checks.get("incident", {}).get("recovery_id") == recovery_id:
            checks.pop("incident", None)


def image_status(provider_id):
    now = time.time()
    with _recent_lock:
        checks = _recent.get(provider_id, {})
        rows = {
            stage: checks[stage].copy() for stage in IMAGE_CHECKS
            if stage in checks and now - checks[stage]["checked_at"] < RECENT_SECONDS
        }
        incident = checks.get("incident")
        if incident and now - incident["checked_at"] < RECENT_SECONDS:
            rows[incident["stage"]] = incident.copy()
        return {"checks": rows, "sample_url": checks.get("sample_url", "") if rows.get("save", {}).get("status") == "ok" else ""}


async def compare_proxy_routes(address):
    """Compare HTTPS reachability with one certificate policy and no credentials."""
    started = time.monotonic()
    try:
        verify = httpx.create_ssl_context(trust_env=True)
    except (OSError, ValueError):
        result = check_result("error", "tls", url=address, started=started)
        return {"configured": result, "no_proxy": result}

    async def request(trust_env):
        async with httpx.AsyncClient(verify=verify, trust_env=trust_env, timeout=6) as client:
            async with client.stream("GET", address) as response:
                return response.status_code

    async def reach(trust_env):
        try:
            status = await asyncio.wait_for(request(trust_env), timeout=8)
            state = "error" if status in {407, 502, 503, 504} else "ok"
            return check_result(state, f"http_{status}", url=address, started=started)
        except (httpx.HTTPError, OSError, asyncio.TimeoutError, ValueError) as exc:
            return check_result("error", error_code(exc), url=address, started=started)

    configured, no_proxy = await asyncio.gather(reach(True), reach(False))
    return {"configured": configured, "no_proxy": no_proxy}
