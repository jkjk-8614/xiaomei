"""Resolve Dreamina media and stage transient references for one command."""

import base64
import binascii
import mimetypes
import os
from pathlib import Path
import re
from tempfile import TemporaryDirectory
from urllib.parse import unquote, urlsplit

from fastapi import HTTPException
import httpx

from jimeng_cli import wsl_path_to_windows
import media_formats
import media_paths


_DEFAULT_SUFFIX = {"image": ".png", "video": ".mp4", "audio": ".mp3"}
_URL_TIMEOUT = httpx.Timeout(connect=20, read=300, write=60, pool=20)
_SUFFIX = re.compile(r"\.[a-zA-Z0-9]{1,8}\Z")


def managed_address(value):
    return media_paths.parse_address(value, allow_loopback=True) is not None


def local_file(value, *, wsl=False):
    text = str(value or "").strip()
    if not text:
        return None
    if text.startswith("file:"):
        try:
            uri = urlsplit(text)
            if uri.netloc not in ("", "localhost"):
                return None
            text = unquote(uri.path)
        except ValueError:
            return None
        if os.name == "nt" and re.match(r"^/[A-Za-z]:/", text):
            text = text[1:]
    if wsl:
        text = wsl_path_to_windows(text)
    try:
        path = Path(text)
        return path.resolve() if path.is_file() else None
    except (OSError, ValueError):
        return None


def relative_output_file(path, root):
    try:
        return Path(path).resolve().relative_to(Path(root).resolve()).as_posix()
    except (OSError, ValueError):
        return ""


def _known_kind(suffix):
    mime = media_formats.content_type("media" + suffix)
    if mime == "application/octet-stream":
        mime = mimetypes.guess_type("media" + suffix)[0] or ""
    major = mime.partition("/")[0].lower()
    return major if major in _DEFAULT_SUFFIX else ""


def matches_kind(value, kind, *, remote=False):
    try:
        suffix = Path(urlsplit(str(value)).path if remote else value).suffix.lower()
    except ValueError:
        return False
    known = _known_kind(suffix)
    return known == kind if known else remote


def _suffix(name, mime, kind):
    media_type = mime.split(";", 1)[0].strip().lower()
    major = media_type.partition("/")[0]
    if (major in {"text", "image", "video", "audio"} and major != kind) or "json" in media_type:
        raise HTTPException(400, f"即梦参考素材与所选类型不符（{media_type}）。")
    extension = Path(name).suffix.lower()
    if _SUFFIX.fullmatch(extension) and _known_kind(extension) == kind:
        return extension
    guess = mimetypes.guess_extension(media_type) or ""
    return guess if _SUFFIX.fullmatch(guess) and _known_kind(guess) == kind else _DEFAULT_SUFFIX[kind]


class ReferenceFiles:
    def __init__(self, locate, cli_path):
        self.locate = locate
        self.cli_path = cli_path
        self._temporary = None
        self._counter = 0

    def __enter__(self):
        return self

    def __exit__(self, *_exc):
        if self._temporary is not None:
            self._temporary.cleanup()

    def _new_file(self, suffix):
        if self._temporary is None:
            self._temporary = TemporaryDirectory(prefix="xiaomei-jimeng-ref-", ignore_cleanup_errors=True)
        self._counter += 1
        return Path(self._temporary.name) / f"reference-{self._counter}{suffix}"

    def _inline(self, text, kind):
        header, separator, encoded = text.partition(",")
        if not separator or not header.lower().endswith(";base64"):
            raise HTTPException(400, "即梦参考素材缺少 Base64 数据。")
        mime = header[5:].split(";", 1)[0]
        suffix = _suffix("", mime, kind)
        try:
            data = base64.b64decode("".join(encoded.split()), validate=True)
        except (binascii.Error, ValueError) as exc:
            raise HTTPException(400, "即梦参考素材的 Base64 数据无效。") from exc
        if not data:
            raise HTTPException(400, "即梦参考素材为空。")
        path = self._new_file(suffix)
        path.write_bytes(data)
        return path

    async def _download(self, url, kind):
        try:
            async with httpx.AsyncClient(timeout=_URL_TIMEOUT, follow_redirects=True) as client:
                async with client.stream("GET", url) as response:
                    response.raise_for_status()
                    name = response.url.path
                    path = self._new_file(_suffix(name, response.headers.get("Content-Type", ""), kind))
                    with path.open("xb") as output:
                        async for chunk in response.aiter_bytes():
                            output.write(chunk)
        except (httpx.HTTPError, httpx.InvalidURL) as exc:
            raise HTTPException(502, "无法下载即梦参考素材。请检查链接后重试。") from exc
        if path.stat().st_size == 0:
            raise HTTPException(400, "即梦参考素材为空。")
        return path

    async def stage(self, address, kind="image"):
        value = str(address or "").strip()
        if managed_address(value):
            path = self.locate(value)
            if not path:
                raise HTTPException(404, f"即梦参考素材不存在。{value}")
        elif value.startswith("data:"):
            path = self._inline(value, kind)
        elif value.startswith(("http://", "https://")):
            path = await self._download(value, kind)
        else:
            path = local_file(value)
            if path is None:
                raise HTTPException(400, f"无法读取即梦参考素材。{value[:120]}")
        return self.cli_path(os.fspath(path))
