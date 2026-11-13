"""Download RunningHub results and keep the media type in the canvas payload."""

import asyncio
from pathlib import Path
from urllib.parse import urlsplit

from fastapi import HTTPException
import httpx

import media_formats


def rewrite_url(address, hosts):
    text = str(address or "")
    try:
        parsed = urlsplit(text)
    except ValueError:
        return text
    host = hosts.get(parsed.netloc.casefold())
    return parsed._replace(netloc=host).geturl() if host else text


async def materialize(client, remote, *, locate, save_local_image, save_image, save_binary):
    suffix = media_formats.media_suffix(remote)
    kind = media_formats.media_kind(suffix)
    try:
        if not remote.startswith(("http://", "https://")):
            path = locate(remote)
            if path:
                suffix = Path(path).suffix.lower()
                kind = media_formats.media_kind(suffix)
                if suffix in media_formats.IMAGE_EXTENSIONS:
                    address, _ = await asyncio.to_thread(save_local_image, path, prefix="rh_", category="output")
                    return address, "image"
            return remote, kind or "image"

        response = await client.get(remote, follow_redirects=True)
        if not response.is_success or not response.content:
            return remote, kind or "image"
        mime = response.headers.get("Content-Type", "").partition(";")[0].strip().lower()
        if mime in {"text/html", "application/json"} or mime.endswith("+json"):
            return remote, kind or "image"
        suffix = media_formats.media_suffix(remote, mime) or media_formats.sniff_image_extension(response.content[:16])
        if not suffix:
            return remote, kind or "image"
        kind = media_formats.media_kind(suffix)
        if kind == "image":
            address, _ = await asyncio.to_thread(
                save_image, response.content, prefix="rh_", fallback_extension=suffix, require_decodable=True,
            )
        else:
            address = await asyncio.to_thread(save_binary, response.content, suffix)
        return address, kind
    except (OSError, ValueError, httpx.HTTPError, httpx.InvalidURL, HTTPException):
        return remote, kind or "image"
