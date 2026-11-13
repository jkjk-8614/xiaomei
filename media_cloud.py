"""Send local canvas media to the configured temporary file host."""

import ipaddress
import os
from pathlib import Path
from urllib.parse import quote, unquote, urlsplit, urlunsplit

import httpx
from fastapi import HTTPException


LOCAL_MEDIA_PREFIXES = ("/assets/", "/output/", "/api/storage-files/")
_DEFAULT_LIMIT = 4 * 1024**3
_HOSTS = ("litterbox", "temp.sh")
_ALIASES = {"catbox": "litterbox", "temp": "temp.sh", "tempsh": "temp.sh"}


def is_public_media_url(text):
    try:
        url = urlsplit(str(text or "").strip())
        host = (url.hostname or "").rstrip(".")
    except ValueError:
        return False
    if url.scheme not in {"http", "https"} or not host:
        return False
    if host == "localhost" or host.endswith((".localhost", ".local")):
        return False
    try:
        return ipaddress.ip_address(host).is_global
    except ValueError:
        return True


def reference_location(value):
    raw = value.get("url") if isinstance(value, dict) else value
    address = str(raw or "").strip()
    try:
        parsed = urlsplit(address)
    except ValueError:
        return "", True
    if parsed.scheme in {"http", "https"}:
        if is_public_media_url(address):
            return address, False
        address = unquote(parsed.path)
    return (address if address.startswith(LOCAL_MEDIA_PREFIXES) else ""), True


def public_asset_link(address, base, token=""):
    if not address.startswith(("/assets/", "/output/")) or not base:
        return ""
    parts = urlsplit(address)
    destination = urlsplit(base)
    if destination.scheme not in {"http", "https"} or not destination.hostname:
        return ""
    path = destination.path.rstrip("/") + quote(parts.path, safe="/%:@-._~")
    query = parts.query
    if token:
        query = "&".join(filter(None, (query, "token=" + quote(token, safe=""))))
    return urlunsplit((destination.scheme, destination.netloc, path, query, ""))


def select_hosts(service):
    selection = str(service or os.getenv("CLOUD_VIDEO_UPLOAD_SERVICE", "auto")).strip().lower()
    host = _ALIASES.get(selection, selection)
    return (host,) if host in _HOSTS else _HOSTS


def local_file(address, locate, content_type, allowed):
    if not address:
        raise HTTPException(status_code=400, detail="没有可上传的媒体文件")
    if address.startswith(("https://", "http://")):
        return ""
    if not address.startswith(LOCAL_MEDIA_PREFIXES):
        raise HTTPException(status_code=400, detail="云端上传只支持画布里的本地图片或视频文件")
    path = locate(address)
    if not path or not Path(path).is_file():
        raise HTTPException(status_code=404, detail="本地媒体文件不存在或已被删除")
    if not content_type(path).startswith(tuple(allowed)):
        raise HTTPException(status_code=400, detail="请选择受支持的图片或视频文件")
    try:
        limit = int(os.getenv("TEMP_SH_MAX_BYTES", str(_DEFAULT_LIMIT)))
    except ValueError:
        limit = _DEFAULT_LIMIT
    try:
        size = Path(path).stat().st_size
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail="本地媒体文件不存在或已被删除") from exc
    if size > limit:
        raise HTTPException(status_code=400, detail=f"媒体文件大小为 {size} 字节，超过云端上传限制")
    return path


async def upload(path, source, mime, service):
    if service == "litterbox":
        default_url = "https://litterbox.catbox.moe/resources/internals/api.php"
        endpoint = os.getenv("LITTERBOX_UPLOAD_URL", "").strip() or default_url
        expires = os.getenv("LITTERBOX_TIME", "").strip() or "72h"
        form = {"reqtype": "fileupload", "time": expires}
        field = "fileToUpload"
    else:
        endpoint = os.getenv("TEMP_SH_UPLOAD_URL", "").strip() or "https://temp.sh/upload"
        expires = "3 days"
        form = {}
        field = "file"
    file = Path(path)
    timeout = httpx.Timeout(connect=20, read=600, write=600, pool=20)
    try:
        async with httpx.AsyncClient(timeout=timeout, follow_redirects=True) as client:
            with file.open("rb") as handle:
                response = await client.post(endpoint, data=form, files={field: (file.name, handle, mime)})
    except (httpx.HTTPError, OSError) as exc:
        raise HTTPException(status_code=502, detail=f"{service} 上传异常（{type(exc).__name__}）") from exc
    if not response.is_success:
        raise HTTPException(status_code=response.status_code, detail=f"{service} 上传失败（HTTP {response.status_code}）")
    direct = response.text.strip().partition("\n")[0].strip()
    if not is_public_media_url(direct):
        raise HTTPException(status_code=502, detail=f"{service} 未返回可访问的公网链接")
    return {"url": direct, "source": source, "name": file.name, "expires": expires, "service": service}
