"""Read URL and inline media for the local asset import API."""

import asyncio
import base64
import mimetypes
from pathlib import Path
from urllib.parse import unquote, urlsplit
from uuid import uuid4

from fastapi import HTTPException
from httpx import AsyncClient, Timeout

import asset_kernel
from canvas_media import LOCAL_PREFIXES
from media_paths import MEDIA_TYPE_FOLDER_NAMES, media_type_folder, path_under
from media_storage import write_media_snapshot


_LOOPBACK = {"localhost", "127.0.0.1", "::1"}
_WEB = {"http", "https"}


def _folder(root, value):
    location = asset_kernel.contained(root, value)
    if location.get("error"):
        raise HTTPException(status_code=400, detail=location["error"])
    relative = location["rel"]
    if relative and path_under(root, relative) is None:
        raise HTTPException(status_code=400, detail="非法路径")
    return relative, Path(location["path"])


def destination(root, folder, parent, name):
    if str(name or "").strip():
        parent_rel, directory = _folder(root, parent)
        named = asset_kernel.folder_label(name)
        if named.get("error"):
            raise HTTPException(status_code=400, detail=named["error"])
        label = named["name"]
        try:
            matches = [item.name for item in directory.iterdir()
                       if item.name.casefold() == label.casefold() and item.is_dir()]
        except OSError:
            matches = []
        if matches:
            label = min(matches, key=lambda existing: (existing != label, existing))
        folder = "/".join(part for part in (parent_rel, label) if part)
    relative, directory = _folder(root, folder)
    directory.mkdir(parents=True, exist_ok=True)
    return relative, directory


def http_client():
    return AsyncClient(
        timeout=Timeout(connect=20, read=120, write=30, pool=20), follow_redirects=True,
        headers={"User-Agent": "Xiaomei-Canvas-Asset-Import/1.0"},
    )


def _mime(value):
    return str(value or "").partition(";")[0].strip().lower()


def _inline(data, content_type):
    mime = _mime(content_type)
    if data.startswith("data:"):
        header, separator, data = data.partition(",")
        if not separator:
            raise ValueError("素材数据无法解码")
        mime = mime or _mime(header[5:])
    try:
        decoded = base64.b64decode("".join(data.split()), validate=True)
    except ValueError as exc:
        raise ValueError("素材数据无法解码") from exc
    return decoded, mime


async def read(entry, client, resolve_file):
    source = entry.url.strip()
    data = entry.data.strip()
    try:
        address = urlsplit(source)
        host = address.hostname
    except ValueError as exc:
        if not data:
            raise ValueError("素材地址无效") from exc
        address, host = urlsplit(""), None
    if data:
        content, content_type = _inline(data, entry.content_type)
        return content, content_type, address.path

    local = source.startswith(LOCAL_PREFIXES) or (
        address.scheme in _WEB and host in _LOOPBACK and address.path.startswith(LOCAL_PREFIXES)
    )
    if local:
        path = resolve_file(source)
        if not path or not Path(path).is_file():
            raise HTTPException(status_code=404, detail="本地素材不存在，请刷新素材列表后重试")
        file = Path(path)
        return await asyncio.to_thread(file.read_bytes), mimetypes.guess_type(file)[0] or "", address.path
    if address.scheme not in _WEB or not host:
        raise ValueError("请使用本地素材地址或 http(s) 素材地址")
    response = await client.get(source)
    response.raise_for_status()
    return response.content, _mime(response.headers.get("content-type")), address.path


def save(directory, relative, content, label, source_path, kind, extension):
    if not content:
        raise ValueError("素材内容为空")
    fallback = "web-video" if kind == "video" else "web-image"
    source = label or unquote(source_path).replace("\\", "/").rsplit("/", 1)[-1]
    stem = asset_kernel.upload_stem(Path(source).stem, fallback, extension, already_stem=True)
    name = f"up_{uuid4().hex[:12]}_{stem}{extension}"
    # New imports are layered into 图片/视频/音频 under the chosen folder.
    type_folder = media_type_folder(name)
    nested = type_folder and Path(directory).name not in MEDIA_TYPE_FOLDER_NAMES
    target = Path(directory, type_folder, name) if nested else Path(directory, name)
    write_media_snapshot(target, content, deduplicate=False)
    parts = (relative, type_folder if nested else "", name)
    return "/".join(part for part in parts if part), target
