"""Materialize reference media for local command-line tools."""

import base64
import binascii
from contextlib import suppress
import mimetypes
from pathlib import Path
from tempfile import NamedTemporaryFile
from urllib.parse import urlsplit
from urllib.request import url2pathname

from fastapi import HTTPException
import httpx


_STORED_PREFIXES = ("/output/", "/assets/", "/api/storage-files/")


def _write_temp(content, suffix):
    path = None
    try:
        with NamedTemporaryFile(prefix="codex_ref_", suffix=suffix, delete=False) as stream:
            path = Path(stream.name)
            stream.write(content)
    except OSError:
        if path is not None:
            with suppress(OSError):
                path.unlink(missing_ok=True)
        raise
    return str(path), [str(path)]


def _inline_reference(address):
    header, marker, data = address.partition(";base64,")
    if not marker:
        raise HTTPException(400, "OpenAI CLI 参考素材 data URL 缺少 base64 数据")
    mime = header.removeprefix("data:").split(";", 1)[0]
    try:
        content = base64.b64decode("".join(data.split()), validate=True)
    except (binascii.Error, ValueError) as error:
        raise HTTPException(400, "OpenAI CLI 参考素材的 base64 数据无效") from error
    return _write_temp(content, mimetypes.guess_extension(mime) or ".png")


async def prepare(value, locate):
    address = str(value or "").strip()
    if not address:
        return "", []
    if address.startswith(_STORED_PREFIXES):
        local = locate(address)
        if local:
            return local, []
        raise HTTPException(404, f"OpenAI CLI 参考素材不存在：{address}")
    if address.startswith("data:"):
        return _inline_reference(address)
    if address.startswith(("http://", "https://")):
        timeout = httpx.Timeout(connect=20.0, read=300.0, write=60.0, pool=20.0)
        async with httpx.AsyncClient(timeout=timeout, follow_redirects=True) as client:
            response = await client.get(address)
            response.raise_for_status()
        mime = response.headers.get("content-type", "").split(";", 1)[0]
        suffix = Path(urlsplit(address).path).suffix or mimetypes.guess_extension(mime) or ".png"
        return _write_temp(response.content, suffix)

    local = url2pathname(urlsplit(address).path) if address.startswith("file://") else address
    if local and Path(local).is_file():
        return local, []
    raise HTTPException(400, f"OpenAI CLI 无法读取参考素材：{address[:120]}")
