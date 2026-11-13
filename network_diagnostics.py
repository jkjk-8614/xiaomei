"""Log network failure locations and error codes without logging credentials."""

import re
from urllib.parse import urlsplit
from urllib.request import getproxies


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
