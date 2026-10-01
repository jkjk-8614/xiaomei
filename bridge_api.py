"""Local Photoshop/Eagle bridge APIs.

Kept outside the historical main.py monolith so local-app integrations can evolve
without replacing the image generation backend.
"""
from __future__ import annotations

import json
import base64
import io
import mimetypes
import os
import subprocess
import sys
import threading
import time
import uuid
from pathlib import Path
from typing import Any, Literal
from urllib.parse import unquote, urlparse

import requests
from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import FileResponse, Response
from pydantic import BaseModel, Field
from PIL import Image


router = APIRouter(prefix="/api", tags=["local-bridges"])


def _runtime_root() -> Path:
    """Resolve the persistent user-data directory in source and packaged builds."""
    configured = str(os.environ.get("XIAOMEI_CANVAS_DATA_ROOT") or "").strip()
    if configured:
        return Path(configured).expanduser().resolve()
    if getattr(sys, "frozen", False):
        return Path(sys.executable).resolve().parent
    return Path(__file__).resolve().parent


ROOT = _runtime_root()
DATA_DIR = ROOT / "data"
QUEUE_FILE = DATA_DIR / "photoshop_bridge_queue.json"
STATE_FILE = DATA_DIR / "photoshop_bridge_state.json"
INBOX_FILE = DATA_DIR / "photoshop_canvas_inbox.json"
PLUGIN_LOG_FILE = DATA_DIR / "photoshop_bridge_plugin_logs.json"
STORAGE_SETTINGS_FILE = DATA_DIR / "storage_settings.json"
LOCK = threading.RLock()


def _read(path: Path, default: Any) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return default


def _write(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_suffix(path.suffix + ".tmp")
    temp.write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding="utf-8")
    temp.replace(path)


def _queue() -> list[dict[str, Any]]:
    value = _read(QUEUE_FILE, [])
    return value if isinstance(value, list) else []


def _public_job(job: dict[str, Any]) -> dict[str, Any]:
    public = {key: value for key, value in job.items() if key != "source_path"}
    # The UXP panel downloads through this stable bridge endpoint. Older queue
    # entries only contain `url`, so keep both fields for backwards compatibility.
    job_id = str(job.get("id") or "").strip()
    public["filename"] = str(job.get("filename") or job.get("name") or "xiaomei-canvas.png")
    if job_id:
        public["file_url"] = f"/api/photoshop-bridge/jobs/{job_id}/file"
    return public


def _storage_roots() -> dict[str, Path]:
    """Resolve the same configurable storage folders used by the main app."""
    roots = {
        "upload": ROOT / "assets" / "input",
        "generated": ROOT / "assets" / "output",
        "local": ROOT / "assets" / "uploads",
    }
    settings = _read(STORAGE_SETTINGS_FILE, {})
    if isinstance(settings, dict):
        settings = settings.get("dirs", settings)
    if not isinstance(settings, dict):
        settings = {}
    for kind, fallback in list(roots.items()):
        value = str(settings.get(kind) or "").strip()
        if not value:
            roots[kind] = fallback.resolve()
            continue
        value = os.path.expandvars(os.path.expanduser(value))
        candidate = Path(value)
        if not candidate.is_absolute():
            candidate = ROOT / candidate
        roots[kind] = candidate.resolve()
    return roots


def _safe_child(base: Path, relative: str) -> Path | None:
    candidate = (base / str(relative or "").lstrip("/\\")).resolve()
    try:
        candidate.relative_to(base.resolve())
    except ValueError:
        return None
    return candidate if candidate.is_file() else None


def _local_path(url: str) -> Path | None:
    parsed = urlparse(str(url or ""))
    path = unquote(parsed.path or "")
    mappings = {
        "/assets/": ROOT / "assets",
        "/output/": ROOT / "output",
        "/static/": ROOT / "static",
    }
    for prefix, base in mappings.items():
        if path.startswith(prefix):
            return _safe_child(base, path[len(prefix):])
    storage_prefix = "/api/storage-files/"
    if path.startswith(storage_prefix):
        rest = path[len(storage_prefix):].lstrip("/")
        kind, separator, relative = rest.partition("/")
        roots = _storage_roots()
        if separator and kind in roots:
            return _safe_child(roots[kind], relative)
    return None


class PhotoshopSend(BaseModel):
    url: str
    name: str = "xiaomei-canvas.png"
    bridge_id: str = ""
    canvas_id: str = ""
    node_id: str = ""
    open_mode: Literal["place", "document"] = "place"
    request_id: str = Field(default="", max_length=160)


class PhotoshopOpenImage(BaseModel):
    url: str = Field(min_length=1, max_length=4096)


@router.post("/photoshop-bridge/open-image")
def photoshop_open_image(payload: PhotoshopOpenImage, request: Request) -> dict[str, str]:
    if not request.client or request.client.host not in ("127.0.0.1", "::1"):
        raise HTTPException(403, "请在本机画布打开 Photoshop")
    origin = request.headers.get("origin")
    if origin and urlparse(origin).hostname not in ("127.0.0.1", "localhost", "::1"):
        raise HTTPException(403, "请从本机画布打开 Photoshop")
    url = payload.url.strip()
    if not url.startswith(("/assets/", "/output/", "/api/storage-files/")):
        raise HTTPException(400, "这张图片尚未保存在本机，请先下载后从 Photoshop 打开")
    image_path = _local_path(url)
    if not image_path:
        raise HTTPException(404, "本机图片不存在，请检查原图是否已移动")
    try:
        with Image.open(image_path) as image:
            if image.format not in {"PNG", "JPEG", "WEBP", "GIF", "BMP", "TIFF", "AVIF"}:
                raise HTTPException(400, "当前文件不是 Photoshop 可打开的图片")
            image.verify()
    except (OSError, ValueError):
        raise HTTPException(400, "图片文件无法读取") from None
    from canvas_image_layers import installed_photoshop
    executable = installed_photoshop()
    if not executable:
        raise HTTPException(409, "未检测到本机 Photoshop，请先安装或通过下载按钮保存图片")
    try:
        subprocess.Popen([str(executable), str(image_path)], shell=False,
                         creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    except OSError:
        raise HTTPException(503, "无法启动 Photoshop，请先下载图片后手动打开") from None
    return {"status": "launched", "message": "已交给 Photoshop 打开，请查看文档标签。"}


class PhotoshopHeartbeat(BaseModel):
    bridge_id: str = "photoshop"
    name: str = "Photoshop"
    version: str = ""
    status: str = "online"
    active_document: bool = False
    auto_import: bool = False
    capabilities: list[str] = Field(default_factory=list)


class PhotoshopAck(BaseModel):
    job_id: str
    status: str = "done"
    error: str = ""
    bridge_id: str = ""
    import_mode: str = ""


class PhotoshopCanvasSend(BaseModel):
    name: str = "Photoshop Layer.png"
    image_b64: str = ""
    mime_type: str = "image/png"
    document_name: str = ""
    layer_name: str = ""
    target_canvas_id: str = ""
    canvas_point: dict[str, Any] = Field(default_factory=dict)


class PhotoshopCanvasPixelsSend(BaseModel):
    name: str = "Photoshop Layer.png"
    pixels_b64: str = ""
    width: int = 0
    height: int = 0
    components: int = 4
    document_name: str = ""
    layer_name: str = ""
    target_canvas_id: str = ""
    canvas_point: dict[str, Any] = Field(default_factory=dict)


class PhotoshopCanvasAck(BaseModel):
    item_id: str
    status: str = "done"


class PhotoshopPluginLog(BaseModel):
    level: str = "info"
    message: str = ""
    bridge_id: str = ""


@router.get("/photoshop-bridge/status")
def photoshop_status() -> dict[str, Any]:
    with LOCK:
        state = _read(STATE_FILE, {})
        jobs = _queue()
    last_seen = float(state.get("last_seen") or 0)
    online = bool(last_seen and time.time() - last_seen < 20)
    recent = [_public_job(item) for item in reversed(jobs[-20:])]
    latest = next((item for item in jobs if item.get("status") == "pending"), None)
    photoshop = {**state, "online": online, "last_seen": last_seen}
    return {
        "online": online,
        "last_seen": last_seen,
        "bridge": state,
        "photoshop": photoshop,
        "pending": sum(1 for job in jobs if job.get("status") == "pending"),
        "latest": _public_job(latest) if latest else None,
        "recent": recent,
        "jobs": [_public_job(job) for job in jobs[-20:]],
    }


@router.post("/photoshop-bridge/heartbeat")
def photoshop_heartbeat(payload: PhotoshopHeartbeat, request: Request) -> dict[str, Any]:
    state = {
        "bridge_id": payload.bridge_id or "photoshop",
        "name": payload.name or "Photoshop",
        "version": payload.version,
        "status": payload.status or "online",
        "active_document": payload.active_document,
        "auto_import": payload.auto_import,
        "capabilities": payload.capabilities,
        "host": request.client.host if request.client else "",
        "last_seen": time.time(),
    }
    with LOCK:
        _write(STATE_FILE, state)
    return {"ok": True, "server_time": time.time()}


@router.post("/photoshop-bridge/send")
def photoshop_send(payload: PhotoshopSend) -> dict[str, Any]:
    if not payload.url.strip():
        raise HTTPException(400, "图片地址不能为空")
    job = {
        "id": uuid.uuid4().hex,
        "url": payload.url.strip(),
        "name": (payload.name or "xiaomei-canvas.png").strip(),
        "bridge_id": payload.bridge_id.strip(),
        "canvas_id": payload.canvas_id.strip(),
        "node_id": payload.node_id.strip(),
        "open_mode": payload.open_mode,
        "request_id": payload.request_id,
        "status": "pending",
        "created_at": time.time(),
        "updated_at": time.time(),
    }
    local = _local_path(job["url"])
    if local:
        job["source_path"] = str(local)
    with LOCK:
        jobs = _queue()
        if payload.request_id:
            previous = next((item for item in jobs if item.get("request_id") == payload.request_id), None)
            if previous:
                if any(previous.get(key) != job[key] for key in ("url", "name", "canvas_id", "node_id", "open_mode")):
                    raise HTTPException(409, "此发送编号已用于其他文件，请查看原任务")
                return {"ok": True, "job": _public_job(previous)}
        if payload.open_mode == "document":
            state = _read(STATE_FILE, {})
            if time.time() - float(state.get("last_seen") or 0) >= 20 or "open-layered-psd" not in state.get("capabilities", []):
                raise HTTPException(409, "请在 Photoshop 加载更新后的桥接插件并保持面板打开，再发送分层 PSD")
            if not local or not local.is_file() or local.suffix.lower() != ".psd":
                raise HTTPException(400, "请先导出并保存本地 PSD 文件")
            with local.open("rb") as source:
                if source.read(6) != b"8BPS\x00\x01":
                    raise HTTPException(400, "PSD 文件格式无效")
            job["bridge_id"] = state["bridge_id"]
        jobs.append(job)
        _write(QUEUE_FILE, jobs[-100:])
    return {"ok": True, "job": _public_job(job)}


@router.get("/photoshop-bridge/latest")
def photoshop_latest(consume: bool = False, bridge_id: str = "") -> dict[str, Any]:
    with LOCK:
        jobs = _queue()
        job = next((item for item in jobs if item.get("status") == "pending" and
                    (not item.get("bridge_id") or item.get("bridge_id") == bridge_id or (not bridge_id and item.get("open_mode") != "document"))), None)
        if job and consume:
            job["status"] = "taken"
            job["updated_at"] = time.time()
            _write(QUEUE_FILE, jobs)
    recent = [_public_job(item) for item in reversed(jobs[-20:])]
    return {
        "ok": True,
        "job": _public_job(job) if job else None,
        "latest": _public_job(job) if job else None,
        "pending": sum(1 for item in jobs if item.get("status") == "pending"),
        "recent": recent,
    }


@router.get("/photoshop-bridge/jobs/{job_id}/take")
def photoshop_take(job_id: str, consume: bool = True, bridge_id: str = "") -> dict[str, Any]:
    with LOCK:
        jobs = _queue()
        job = next((item for item in jobs if item.get("id") == job_id), None)
        if not job:
            raise HTTPException(404, "桥接任务不存在")
        if job.get("open_mode") == "document" and job.get("bridge_id") != bridge_id:
            raise HTTPException(409, "此 PSD 已发送给另一桥接面板，请在对应面板查看")
        if consume and job.get("status") == "pending":
            job["status"] = "taken"
            job["updated_at"] = time.time()
            _write(QUEUE_FILE, jobs)
    return {"ok": True, "job": _public_job(job)}


@router.post("/photoshop-bridge/ack")
def photoshop_ack(payload: PhotoshopAck) -> dict[str, Any]:
    with LOCK:
        jobs = _queue()
        job = next((item for item in jobs if item.get("id") == payload.job_id), None)
        if not job:
            raise HTTPException(404, "桥接任务不存在")
        job["status"] = "failed" if payload.status in {"failed", "error"} or payload.error else "done"
        job["error"] = payload.error
        if payload.bridge_id:
            job["bridge_id"] = payload.bridge_id
        if payload.import_mode:
            job["import_mode"] = payload.import_mode
        job["updated_at"] = time.time()
        _write(QUEUE_FILE, jobs)
    return {"ok": True, "job": _public_job(job)}


@router.get("/photoshop-bridge/jobs/{job_id}")
def photoshop_job(job_id: str) -> dict[str, Any]:
    job = next((item for item in _queue() if item.get("id") == job_id), None)
    if not job:
        raise HTTPException(404, "桥接任务不存在")
    return {"ok": True, "job": _public_job(job)}


@router.get("/photoshop-bridge/jobs/{job_id}/file")
def photoshop_job_file(job_id: str):
    job = next((item for item in _queue() if item.get("id") == job_id), None)
    if not job:
        raise HTTPException(404, "桥接任务不存在")
    local = Path(job.get("source_path") or "") if job.get("source_path") else None
    if not (local and local.is_file()):
        local = _local_path(job.get("url", ""))
    if local and local.is_file():
        return FileResponse(local, media_type=mimetypes.guess_type(local.name)[0] or "application/octet-stream")
    url = str(job.get("url") or "")
    if not url.startswith(("http://", "https://")):
        raise HTTPException(404, "图片文件不存在")
    try:
        response = requests.get(url, timeout=30)
        response.raise_for_status()
    except Exception as exc:
        raise HTTPException(502, f"读取图片失败：{exc}") from exc
    return Response(response.content, media_type=response.headers.get("content-type", "application/octet-stream"))


@router.post("/photoshop-bridge/clear")
def photoshop_clear() -> dict[str, Any]:
    with LOCK:
        _write(QUEUE_FILE, [])
    return {"ok": True}


def _save_canvas_image(raw: bytes, name: str) -> dict[str, Any]:
    if not raw or len(raw) > 80 * 1024 * 1024:
        raise HTTPException(400, "Photoshop 图层数据为空或过大")
    folder = ROOT / "assets" / "photoshop-bridge"
    folder.mkdir(parents=True, exist_ok=True)
    safe = "".join(char if char.isalnum() or char in "._-" else "_" for char in (name or "Photoshop_Layer.png"))
    if not safe.lower().endswith(".png"):
        safe += ".png"
    filename = f"{int(time.time())}_{uuid.uuid4().hex[:8]}_{safe}"
    path = folder / filename
    path.write_bytes(raw)
    item = {"id": uuid.uuid4().hex, "filename": filename, "url": f"/assets/photoshop-bridge/{filename}",
            "status": "pending", "created_at": time.time()}
    return item


@router.post("/photoshop-bridge/canvas-send")
def photoshop_canvas_send(payload: PhotoshopCanvasSend) -> dict[str, Any]:
    try:
        raw = base64.b64decode(payload.image_b64, validate=True)
    except Exception as exc:
        raise HTTPException(400, "无效的 Photoshop PNG 数据") from exc
    item = _save_canvas_image(raw, payload.name)
    item.update({"target_canvas_id": payload.target_canvas_id, "canvas_point": payload.canvas_point,
                 "document_name": payload.document_name, "layer_name": payload.layer_name})
    with LOCK:
        inbox = _read(INBOX_FILE, [])
        inbox.append(item)
        _write(INBOX_FILE, inbox[-100:])
    return {"ok": True, "item": item}


@router.post("/photoshop-bridge/canvas-send-pixels")
def photoshop_canvas_send_pixels(payload: PhotoshopCanvasPixelsSend) -> dict[str, Any]:
    if payload.width <= 0 or payload.height <= 0 or payload.components not in {3, 4}:
        raise HTTPException(400, "无效的图层像素尺寸")
    try:
        raw = base64.b64decode(payload.pixels_b64, validate=True)
        mode = "RGBA" if payload.components == 4 else "RGB"
        image = Image.frombytes(mode, (payload.width, payload.height), raw)
        output = io.BytesIO()
        image.save(output, format="PNG")
    except Exception as exc:
        raise HTTPException(400, "无法解析 Photoshop 像素数据") from exc
    item = _save_canvas_image(output.getvalue(), payload.name)
    item.update({"target_canvas_id": payload.target_canvas_id, "canvas_point": payload.canvas_point,
                 "document_name": payload.document_name, "layer_name": payload.layer_name})
    with LOCK:
        inbox = _read(INBOX_FILE, [])
        inbox.append(item)
        _write(INBOX_FILE, inbox[-100:])
    return {"ok": True, "item": item}


@router.get("/photoshop-bridge/canvas-inbox")
def photoshop_canvas_inbox(canvas_id: str = "") -> dict[str, Any]:
    items = _read(INBOX_FILE, [])
    pending = [item for item in items if item.get("status") == "pending" and
               (not canvas_id or not item.get("target_canvas_id") or item.get("target_canvas_id") == canvas_id)]
    return {"ok": True, "items": pending}


@router.post("/photoshop-bridge/canvas-inbox/ack")
def photoshop_canvas_inbox_ack(payload: PhotoshopCanvasAck) -> dict[str, Any]:
    with LOCK:
        items = _read(INBOX_FILE, [])
        item = next((entry for entry in items if entry.get("id") == payload.item_id), None)
        if not item:
            raise HTTPException(404, "画布收件任务不存在")
        item["status"] = payload.status
        item["updated_at"] = time.time()
        _write(INBOX_FILE, items)
    return {"ok": True}


@router.post("/photoshop-bridge/plugin-log")
def photoshop_plugin_log(payload: PhotoshopPluginLog) -> dict[str, Any]:
    with LOCK:
        logs = _read(PLUGIN_LOG_FILE, [])
        logs.append({"time": time.time(), **payload.dict()})
        _write(PLUGIN_LOG_FILE, logs[-300:])
    return {"ok": True}


class EagleConnection(BaseModel):
    base_url: str = "http://127.0.0.1:41595"


class EagleSend(EagleConnection):
    url: str
    name: str = "xiaomei-canvas.png"
    folder_id: str = ""
    tags: list[str] = Field(default_factory=list)
    annotation: str = ""


def _eagle_base(value: str) -> str:
    base = (value or "").strip().rstrip("/")
    if base.isdigit():
        base = f"http://127.0.0.1:{base}"
    parsed = urlparse(base)
    if parsed.scheme not in {"http", "https"} or parsed.hostname not in {"127.0.0.1", "localhost"}:
        raise HTTPException(400, "Eagle 地址仅允许本机 localhost/127.0.0.1")
    return base


@router.post("/eagle/test")
def eagle_test(payload: EagleConnection) -> dict[str, Any]:
    base = _eagle_base(payload.base_url)
    try:
        response = requests.get(f"{base}/api/application/info", timeout=5)
        response.raise_for_status()
        return {"ok": True, "data": response.json()}
    except Exception as exc:
        raise HTTPException(502, f"无法连接 Eagle：{exc}") from exc


@router.post("/eagle/folders")
def eagle_folders(payload: EagleConnection) -> dict[str, Any]:
    base = _eagle_base(payload.base_url)
    try:
        response = requests.get(f"{base}/api/folder/list", timeout=8)
        response.raise_for_status()
        data = response.json()
        return {"ok": True, "folders": data.get("data", data)}
    except Exception as exc:
        raise HTTPException(502, f"读取 Eagle 文件夹失败：{exc}") from exc


@router.post("/eagle/send")
def eagle_send(payload: EagleSend) -> dict[str, Any]:
    base = _eagle_base(payload.base_url)
    body = {
        "url": payload.url,
        "name": payload.name,
        "website": "小美画布",
        "tags": [str(tag).strip() for tag in payload.tags if str(tag).strip()][:30],
        "annotation": payload.annotation,
    }
    if payload.folder_id:
        body["folderId"] = payload.folder_id
    try:
        response = requests.post(f"{base}/api/item/addFromURL", json=body, timeout=20)
        response.raise_for_status()
        data = response.json()
    except Exception as exc:
        raise HTTPException(502, f"发送到 Eagle 失败：{exc}") from exc
    return {"ok": True, "data": data}
