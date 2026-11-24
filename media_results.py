"""Materialize provider results while retaining recoverable media addresses."""

import asyncio
import base64
import hashlib
from pathlib import Path
from urllib.parse import urlsplit

import httpx

import media_formats
import media_paths
from network_diagnostics import error_code, request_proxy


class ImageResultDownloadError(Exception):
    def __init__(self, stage="download", code="connection", *, status=None, observed_url=""):
        self.stage = stage
        self.code = code
        self.status = status
        self.observed_url = observed_url
        self.proxy_route = ""
        super().__init__(code)


async def save_image(item, save, locate, rewrite, seen, *, require_local, attempts, observe=None):
    async def publish(content, extension):
        digest = hashlib.sha256(content).hexdigest() if seen is not None else None
        if seen is not None and digest in seen:
            return None
        url, _ = await asyncio.to_thread(save, content, fallback_extension=extension)
        if seen is not None:
            if digest in seen:
                return None
            seen.add(digest)
        return url

    if item["type"] == "b64":
        try:
            content = await asyncio.to_thread(base64.b64decode, item["value"])
            return await publish(content, media_formats.image_extension(header=item.get("mime_type")))
        except ValueError as exc:
            if require_local:
                raise ImageResultDownloadError(code="invalid_image") from exc
            raise
        except OSError as exc:
            if require_local:
                raise ImageResultDownloadError("save", error_code(exc)) from exc
            raise

    value = str(item["value"] or "")
    if media_paths.parse_address(value, allow_loopback=True):
        try:
            path = locate(value)
            if path:
                content = await asyncio.to_thread(Path(path).read_bytes)
                return await publish(content, media_formats.image_extension(path))
        except ValueError as exc:
            if require_local:
                raise ImageResultDownloadError(code="invalid_image") from exc
            return value
        except OSError as exc:
            if require_local:
                raise ImageResultDownloadError("save", error_code(exc)) from exc
            return value
        if media_paths.parse_address(value):
            if require_local:
                raise ImageResultDownloadError("save", "local_file_missing")
            return value

    value = rewrite(value)
    timeout = httpx.Timeout(connect=20, read=300, write=60, pool=20)
    headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126 Safari/537.36",
        "Accept": "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
    }
    last_error = None
    observed_url = value
    status = None
    client = None
    try:
        async with httpx.AsyncClient(timeout=timeout, follow_redirects=True, headers=headers) as client:
            for index in range(attempts):
                if index:
                    await asyncio.sleep(min(12.0, 1.5 * 2 ** (index - 1)))
                try:
                    response = await client.get(value)
                    if getattr(response, "_request", None) is not None:
                        observed_url = str(response.url)
                    status = response.status_code
                    response.raise_for_status()
                except (OSError, httpx.HTTPError, httpx.InvalidURL) as exc:
                    last_error = exc
                    status = getattr(getattr(exc, "response", None), "status_code", None)
                    try:
                        observed_url = str(exc.request.url)
                    except (AttributeError, RuntimeError):
                        pass
                    print(f"保存上游图片失败（{index + 1}/{attempts}） {type(exc).__name__} {status}", flush=True)
                    if status is not None and status < 500 and status not in {408, 429}:
                        break
                    continue
                if not response.content:
                    if require_local:
                        raise ImageResultDownloadError(code="invalid_image", status=status, observed_url=observed_url)
                    return value
                extension = media_formats.image_extension(value, response.headers.get("Content-Type", ""))
                try:
                    url = await publish(response.content, extension)
                    return url
                except ValueError as exc:
                    if require_local:
                        raise ImageResultDownloadError(code="invalid_image", status=status, observed_url=observed_url) from exc
                    return value
                except OSError as exc:
                    if require_local:
                        raise ImageResultDownloadError("save", error_code(exc), status=status, observed_url=observed_url) from exc
                    return value
    except ValueError as exc:
        if require_local:
            raise ImageResultDownloadError(code=error_code(exc), observed_url=observed_url) from exc
        raise
    finally:
        if observe is not None and client is not None:
            observe(observed_url, request_proxy(client, observed_url))
    if require_local:
        raise ImageResultDownloadError(code=error_code(last_error), status=status, observed_url=observed_url) from last_error
    return value


async def save_video(url, save, timeout):
    if not url:
        return ""
    try:
        parsed = urlsplit(str(url).strip())
        if parsed.scheme not in ("http", "https") or not parsed.hostname:
            return url
        headers = {"User-Agent": "Xiaomei-Canvas/1.0", "Accept": "video/*,application/octet-stream,*/*;q=0.8"}
        limits = httpx.Timeout(connect=20, read=timeout, write=60, pool=20)
        async with httpx.AsyncClient(timeout=limits, follow_redirects=True, headers=headers) as client:
            response = await client.get(url)
            response.raise_for_status()
            mime = (response.headers.get("Content-Type") or "").lower()
            if mime.startswith("image/") or "text/html" in mime or "application/json" in mime:
                return url
            return await asyncio.to_thread(save, response.content, mime, url)
    except (ValueError, OSError, httpx.HTTPError, httpx.InvalidURL) as exc:
        print(f"保存上游视频失败 {type(exc).__name__}", flush=True)
        return url
