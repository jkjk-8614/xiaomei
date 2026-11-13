"""Materialize provider results while retaining recoverable media addresses."""

import asyncio
import base64
import hashlib
from pathlib import Path
from urllib.parse import urlsplit

import httpx

import media_formats
import media_paths


class ImageResultDownloadError(Exception):
    pass


async def save_image(item, save, locate, rewrite, seen, *, require_local, attempts):
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
        content = await asyncio.to_thread(base64.b64decode, item["value"])
        try:
            return await publish(content, media_formats.image_extension(header=item.get("mime_type")))
        except OSError as exc:
            if require_local:
                raise ImageResultDownloadError() from exc
            raise

    value = str(item["value"] or "")
    if media_paths.parse_address(value, allow_loopback=True):
        try:
            path = locate(value)
            if path:
                content = await asyncio.to_thread(Path(path).read_bytes)
                return await publish(content, media_formats.image_extension(path))
        except (ValueError, OSError) as exc:
            if require_local:
                raise ImageResultDownloadError() from exc
            return value
        if media_paths.parse_address(value):
            if require_local:
                raise ImageResultDownloadError()
            return value

    value = rewrite(value)
    timeout = httpx.Timeout(connect=20, read=300, write=60, pool=20)
    headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126 Safari/537.36",
        "Accept": "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
    }
    last_error = None
    try:
        async with httpx.AsyncClient(timeout=timeout, follow_redirects=True, headers=headers) as client:
            for index in range(attempts):
                if index:
                    await asyncio.sleep(min(12.0, 1.5 * 2 ** (index - 1)))
                try:
                    response = await client.get(value)
                    response.raise_for_status()
                    if not response.content:
                        raise ValueError("上游返回空图片文件")
                    extension = media_formats.image_extension(value, response.headers.get("Content-Type", ""))
                    return await publish(response.content, extension)
                except (ValueError, OSError, httpx.HTTPError, httpx.InvalidURL) as exc:
                    last_error = exc
                    status = getattr(getattr(exc, "response", None), "status_code", "")
                    print(f"保存上游图片失败（{index + 1}/{attempts}） {type(exc).__name__} {status}", flush=True)
    except ValueError as exc:
        if require_local:
            raise ImageResultDownloadError() from exc
        raise
    if require_local:
        raise ImageResultDownloadError() from last_error
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
