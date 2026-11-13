"""Prepare video references and submit media for APIMart asset review."""

import asyncio
import base64
import mimetypes
import ssl
from io import BytesIO
from pathlib import Path
from urllib.parse import quote, unquote, urlsplit

import httpx
from fastapi import HTTPException
from PIL import Image

from media_cloud import LOCAL_MEDIA_PREFIXES, is_public_media_url

_UPLOAD_ROUTES = {"image": ("images",), "audio": ("audios", "files", "images")}
_SAFE_IMAGE_BYTES = 9_500_000
_ASSET_URL_KEYS = ("asset_url", "assetUrl", "uri", "url", "file_url", "fileUrl")
_ASSET_ID_KEYS = ("asset_id", "assetId", "file_id", "fileId", "id")
_DONE = frozenset(("completed", "complete", "succeeded", "success", "active", "done"))
_FAILED = frozenset(("failed", "fail", "error", "rejected", "canceled", "cancelled", "expired"))


def _parse_url(text):
    try:
        return urlsplit(text)
    except ValueError:
        return None


def _asset_uri(value):
    return isinstance(value, str) and value.startswith("asset://") and bool(value[8:].strip())


def accepts_reference(value):
    return _asset_uri(value) or is_public_media_url(value)


def _record(value):
    return value if isinstance(value, dict) else {}


def _first_url(row, accept):
    for key in _ASSET_URL_KEYS:
        value = str(row.get(key) or "").strip()
        if accept(value):
            return value
    return ""


def _identifier_url(row, keys):
    for key in keys:
        value = row.get(key)
        if isinstance(value, (str, int)) and not isinstance(value, bool) and str(value).strip():
            value = str(value).strip()
            if value != "asset://":
                return value if _asset_uri(value) else f"asset://{value}"
    return ""


def uploaded_reference(payload):
    if isinstance(payload, list):
        return next((url for item in payload if (url := uploaded_reference(item))), "")
    if not isinstance(payload, dict):
        return ""
    row = payload
    explicit = _first_url(row, accepts_reference)
    if explicit:
        return explicit
    for key in ("data", "file", "asset", "result"):
        url = uploaded_reference(row.get(key))
        if url:
            return url
    return _identifier_url(row, _ASSET_ID_KEYS)


def _data_url(text, kind):
    header, separator, encoded = text.partition(";base64,")
    if not separator:
        raise ValueError("素材 data URL 缺少 base64 内容")
    mime = header.removeprefix("data:").split(";", 1)[0].lower()
    mime = mime or {"audio": "audio/mpeg", "image": "image/png"}[kind]
    if not mime.startswith(f"{kind}/"):
        raise ValueError("素材的 data URL 类型与参考素材类型不符")
    try:
        content = base64.b64decode("".join(encoded.split()), validate=True)
    except (ValueError, UnicodeError) as exc:
        raise ValueError("素材 data URL 的 base64 内容无效") from exc
    suffix = mimetypes.guess_extension(mime) or {"image": ".png", "audio": ".mp3"}[kind]
    return f"canvas_{kind}{suffix}", content, mime


def _image_file(part, *, inline=False):
    name, content, mime = part
    supported_inline = mime in {"image/jpeg", "image/png", "image/webp"}
    if len(content) <= _SAFE_IMAGE_BYTES and (not inline or supported_inline):
        return part
    with Image.open(BytesIO(content)) as source:
        layer = source.convert("RGBA")
    canvas = Image.new("RGB", layer.size, "white")
    canvas.paste(layer, mask=layer.getchannel("A"))
    for quality in (92, 84, 76, 68):
        with BytesIO() as buffer:
            canvas.save(buffer, "JPEG", quality=quality, optimize=True)
            if buffer.tell() <= _SAFE_IMAGE_BYTES:
                return f"{Path(name).stem}.jpg", buffer.getvalue(), "image/jpeg"
    raise ValueError("图片压缩后仍超过 APIMart 上传大小限制")


def _part_from_disk(path, kind, mime):
    source = Path(path)
    part = (source.name, source.read_bytes(), mime)
    return _image_file(part) if kind == "image" else part


def _retryable_upload(exc):
    return isinstance(exc, (httpx.TransportError, ssl.SSLError)) or any(
        marker in str(exc).upper() for marker in ("BAD RECORD MAC", "EOF OCCURRED", "DECRYPTION FAILED", "WRONG VERSION NUMBER")
    )


class ReferenceUploader:
    def __init__(self, client, root, headers, local_file, content_type, public_link, cloud_upload):
        self.client = client
        self.root = root
        self.headers = headers
        self.local_file = local_file
        self.content_type = content_type
        self.public_link = public_link
        self.cloud_upload = cloud_upload

    async def prepare(self, reference, kind):
        text = str(reference or "").strip()
        label = {"image": "图片", "video": "视频", "audio": "音频"}[kind]
        if not text:
            return "ERR:空地址"
        if accepts_reference(text):
            return text
        parsed = _parse_url(text)
        if parsed and parsed.scheme in ("http", "https"):
            if (parsed.hostname or "").lower().rstrip(".") not in {"127.0.0.1", "::1", "localhost"}:
                return f"ERR:参考{label}地址指向本机或局域网，APIMart 无法读取。请使用画布素材或公网 URL。"
            text = unquote(parsed.path) if kind == "video" else parsed.path
        if text.startswith(LOCAL_MEDIA_PREFIXES):
            return await self._local_reference(text, kind, label)
        if text.startswith("data:") and kind in _UPLOAD_ROUTES:
            try:
                part = await asyncio.to_thread(_data_url, text, kind)
                if kind == "image":
                    part = await asyncio.to_thread(_image_file, part, inline=True)
            except (ValueError, OSError, Image.DecompressionBombError) as exc:
                return f"ERR:无法读取参考{label}：{exc}"
            return await self._upload(kind, part)
        return f"ERR:参考{label}地址格式不受支持。请使用画布素材、公网 http/https URL 或 asset:// 地址。"

    async def _local_reference(self, address, kind, label):
        if kind != "image":
            published = self.public_link(address)
            if published:
                if is_public_media_url(published):
                    return published
                return "ERR:PUBLIC_MEDIA_BASE_URL/PUBLIC_BASE_URL 必须指向公网媒体地址。"
        path = self.local_file(address)
        if not path:
            return f"ERR:本地{label}不存在或已被删除"
        mime = self.content_type(path)
        if not mime.startswith(f"{kind}/"):
            return f"ERR:参考{label}的文件类型不受支持"
        if kind == "video":
            try:
                uploaded = await self.cloud_upload(address)
                url = str(_record(uploaded).get("url") or "").strip()
                if is_public_media_url(url):
                    return url
                return "ERR:临时云端上传未返回公网视频地址，请重试或使用公网视频 URL。"
            except HTTPException as exc:
                return f"ERR:本地视频上传临时云端失败：{exc.detail}。请检查网络后重试，或使用公网视频地址。"
        try:
            part = await asyncio.to_thread(_part_from_disk, path, kind, mime)
        except (ValueError, OSError, Image.DecompressionBombError) as exc:
            return f"ERR:无法读取参考{label}：{exc}"
        return await self._upload(kind, part)

    async def _upload(self, kind, part):
        last_error = "上传响应缺少素材地址"
        for route in _UPLOAD_ROUTES[kind]:
            url = f"{self.root}/v1/uploads/{route}"
            try:
                response = await self._post(url, part, kind)
                if response.status_code not in (200, 201):
                    last_error = f"{route} 返回 HTTP {response.status_code}"
                    continue
                address = uploaded_reference(response.json())
                if address:
                    return address
                last_error = "上传响应缺少素材地址"
            except (ValueError, OSError, httpx.HTTPError, HTTPException) as exc:
                last_error = f"{route} 上传异常（{type(exc).__name__}）"
        if kind == "audio":
            return f"ERR:APIMart 音频上传失败（{last_error}）。请配置公网媒体地址或使用 asset:// 音频地址。"
        return f"ERR:APIMart 图片上传失败（{last_error}）"

    async def _post(self, url, part, kind):
        options = {"headers": self.headers(), "files": {"file": part}, "timeout": 60 if kind == "image" else 180}
        attempts = 3 if kind == "image" else 1
        for attempt in range(attempts):
            try:
                if attempt == 0:
                    return await self.client.post(url, **options)
                async with httpx.AsyncClient(follow_redirects=True) as fresh:
                    return await fresh.post(url, **options)
            except Exception as exc:
                if attempt + 1 == attempts or not _retryable_upload(exc):
                    raise
                await asyncio.sleep(0.6 * (attempt + 1))


def avatar_kind(kind):
    return {"audio": "Audio", "video": "Video"}.get(str(kind or "").lower(), "Image")


def _approved_asset(payload):
    if isinstance(payload, list):
        return next((uri for item in payload if (uri := _approved_asset(item))), "")
    row = _record(payload)
    if "usable_assets" in row:
        return _approved_asset(row["usable_assets"])
    status = str(row.get("status") or "").strip().lower()
    if status and status not in _DONE:
        return ""
    for key in ("result", "assets"):
        if key in row:
            return _approved_asset(row[key])
    return _first_url(row, _asset_uri) or _identifier_url(row, ("asset_id", "assetId"))


def _avatar_response(response, operation):
    if response.status_code not in (200, 201):
        raise HTTPException(status_code=502, detail=f"{operation}失败（HTTP {response.status_code}）")
    try:
        body = response.json()
    except ValueError as exc:
        raise HTTPException(status_code=502, detail=f"{operation}返回非 JSON 响应") from exc
    if not isinstance(body, dict) or str(body.get("code", 200)) != "200":
        raise HTTPException(status_code=502, detail=f"{operation}未被 APIMart 接受")
    return {**body, **_record(body.get("data"))}


async def submit_avatar(client, root, headers, url, name, kind, project, group):
    body = dict(project_name=project, asset_type=avatar_kind(kind),
                group={"name": (group or name or "数字人素材")[:60]},
                assets=[{"url": url, "name": (name or "asset")[:60]}])
    response = await client.post(f"{root}/v1/seedance2/private-avatar", json=body, headers=headers, timeout=120)
    task = _avatar_response(response, "APIMart 素材审核提交")
    task_id = str(task.get("id") or task.get("task_id") or "").strip()
    if not task_id:
        raise HTTPException(status_code=502, detail="APIMart 素材审核响应缺少任务 ID")
    return task_id


async def avatar_status(client, root, headers, task_id):
    path = f"{root}/v1/tasks/{quote(task_id, safe='')}"
    response = await client.get(path, headers=headers, timeout=60)
    task = _avatar_response(response, "APIMart 素材审核查询")
    status = str(task.get("status") or "").strip().lower()
    if status in _FAILED:
        return {"status": "Failed", "asset_uri": "", "detail": f"审核未通过（{status}）"}
    if status in _DONE:
        uri = _approved_asset(task)
        if uri:
            return {"status": "Active", "asset_uri": uri, "detail": ""}
        return {"status": "Failed", "asset_uri": "", "detail": "审核完成，APIMart 未返回可用的素材地址。"}
    return {"status": "Processing", "asset_uri": "", "detail": "审核中"}
