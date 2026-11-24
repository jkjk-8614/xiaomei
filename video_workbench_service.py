"""Manage and reverse-proxy the embedded Node.js Video Workbench service."""

from __future__ import annotations

import asyncio
import hashlib
import html
import json
import os
import re
import secrets
import shutil
import socket
import subprocess
import threading
import time
from pathlib import Path
from typing import Any, Callable, Mapping, Optional
from urllib.parse import quote

import httpx
from fastapi import FastAPI, Request
from fastapi.responses import HTMLResponse, JSONResponse, RedirectResponse, Response, StreamingResponse

_HOP_BY_HOP_HEADERS = {
    "connection",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailers",
    "transfer-encoding",
    "upgrade",
    "host",
}


class VideoWorkbenchManager:
    """Lazy-start supervisor for `tools/video-workbench/server.js`."""

    def __init__(
        self,
        project_root: str | Path,
        runtime_root: str | Path,
        canvas_settings_loader: Optional[Callable[[], dict[str, Any]]] = None,
    ) -> None:
        self.project_root = Path(project_root).resolve()
        self.runtime_root = Path(runtime_root).resolve()
        self.workbench_dir = self.project_root / "tools" / "video-workbench"
        self.server_script = self.workbench_dir / "server.js"
        self.data_dir = self.runtime_root / "data" / "video_workbench" / "data"
        self.material_dir = self.runtime_root / "data" / "video_workbench" / "素材"
        self.output_dir = self.runtime_root / "output" / "video_workbench"
        self.log_file = self.runtime_root / "logs" / "video-workbench.log"
        self._canvas_settings_loader = canvas_settings_loader

        self._lock = threading.Lock()
        self._process: Optional[subprocess.Popen] = None
        self._port: int = 0
        self._log_handle = None
        self._client: Optional[httpx.AsyncClient] = None
        self._sync_token: str = ""
        self._last_synced_hash: str = ""

    def _find_node_executable(self) -> str:
        configured = str(os.getenv("XIAOMEI_NODE", "")).strip()
        candidates = [
            configured,
            shutil.which("node"),
            shutil.which("node.exe"),
        ]
        if os.name == "nt":
            program_files = os.environ.get("ProgramFiles", r"C:\Program Files")
            local_app_data = os.environ.get("LOCALAPPDATA", "")
            candidates.extend(
                [
                    os.path.join(program_files, "nodejs", "node.exe"),
                    os.path.join(local_app_data, "Programs", "nodejs", "node.exe"),
                ]
            )
        for candidate in candidates:
            if candidate and os.path.isfile(candidate):
                return os.path.abspath(candidate)
        return ""

    @staticmethod
    def _allocate_free_port() -> int:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
            sock.bind(("127.0.0.1", 0))
            return int(sock.getsockname()[1])

    def _is_alive(self) -> bool:
        return bool(self._process is not None and self._process.poll() is None)

    @staticmethod
    def _port_open(port: int) -> bool:
        if port <= 0:
            return False
        try:
            with socket.create_connection(("127.0.0.1", port), timeout=0.35):
                return True
        except OSError:
            return False

    def ensure_started(self) -> str:
        """Start the Node.js server lazily and return its loopback base URL."""
        with self._lock:
            if self._is_alive() and self._port > 0 and self._port_open(self._port):
                return f"http://127.0.0.1:{self._port}"

            self._stop_locked()

            node = self._find_node_executable()
            if not node:
                raise RuntimeError("未找到 Node.js，无法启动视频工作台。请先安装 Node.js 18 或更高版本。")
            if not self.server_script.is_file():
                raise RuntimeError(f"视频工作台服务文件不存在：{self.server_script}")

            self.data_dir.mkdir(parents=True, exist_ok=True)
            self.material_dir.mkdir(parents=True, exist_ok=True)
            self.output_dir.mkdir(parents=True, exist_ok=True)
            self.log_file.parent.mkdir(parents=True, exist_ok=True)

            port = self._allocate_free_port()
            self._sync_token = secrets.token_hex(24)
            self._last_synced_hash = ""
            env = os.environ.copy()
            env["HOST"] = "127.0.0.1"
            env["PORT"] = str(port)
            env["OPEN_BROWSER"] = "false"
            env["BASE_PATH"] = "/video-workbench"
            env["DATA_DIR"] = str(self.data_dir)
            env["MATERIAL_DIR"] = str(self.material_dir)
            env["OUTPUT_DIR"] = str(self.output_dir)
            env["CANVAS_SYNC_TOKEN"] = self._sync_token

            creationflags = getattr(subprocess, "CREATE_NO_WINDOW", 0) if os.name == "nt" else 0
            try:
                self._log_handle = open(self.log_file, "ab")
                self._process = subprocess.Popen(
                    [node, str(self.server_script)],
                    cwd=str(self.workbench_dir),
                    env=env,
                    stdin=subprocess.DEVNULL,
                    stdout=self._log_handle,
                    stderr=self._log_handle,
                    creationflags=creationflags,
                )
                self._port = port
            except Exception as exc:
                self._stop_locked()
                raise RuntimeError(f"启动视频工作台失败：{exc}") from exc

            deadline = time.monotonic() + 15.0
            while time.monotonic() < deadline:
                if not self._is_alive():
                    code = self._process.returncode if self._process else -1
                    self._stop_locked()
                    raise RuntimeError(f"视频工作台进程提前退出（退出码 {code}），请检查日志：{self.log_file}")
                if self._port_open(port):
                    return f"http://127.0.0.1:{port}"
                time.sleep(0.12)

            self._stop_locked()
            raise RuntimeError(f"视频工作台启动超时，请检查日志：{self.log_file}")

    def _stop_locked(self) -> None:
        proc = self._process
        self._process = None
        self._port = 0
        self._sync_token = ""
        self._last_synced_hash = ""
        if proc is not None:
            try:
                if proc.poll() is None:
                    proc.terminate()
                    try:
                        proc.wait(timeout=3.0)
                    except subprocess.TimeoutExpired:
                        proc.kill()
                        proc.wait(timeout=2.0)
            except Exception:
                pass
        if self._log_handle is not None:
            try:
                self._log_handle.close()
            except Exception:
                pass
            self._log_handle = None

    def stop(self) -> None:
        with self._lock:
            self._stop_locked()

    async def aclose(self) -> None:
        if self._client is not None:
            try:
                await self._client.aclose()
            except Exception:
                pass
            self._client = None
        await asyncio.to_thread(self.stop)

    def _get_client(self) -> httpx.AsyncClient:
        if self._client is None:
            self._client = httpx.AsyncClient(
                trust_env=False,
                follow_redirects=False,
                timeout=httpx.Timeout(connect=10.0, read=600.0, write=600.0, pool=10.0),
            )
        return self._client

    @staticmethod
    def _sanitize_forward_headers(headers: Mapping[str, str]) -> dict[str, str]:
        """Sanitize incoming headers so httpx never fails on non-ASCII values (e.g. Chinese Electron User-Agent)."""
        sanitized: dict[str, str] = {}
        for raw_key, raw_val in headers.items():
            key_lower = raw_key.lower()
            if key_lower in _HOP_BY_HOP_HEADERS or key_lower == "content-length":
                continue
            if not raw_key.isascii():
                continue
            val = str(raw_val)
            if not val.isascii():
                if key_lower in {"referer", "origin"}:
                    val = quote(val, safe=":/?#[]@!$&'()*+,;=%-._~")
                else:
                    val = re.sub(r"[^\x20-\x7e]+", "", val)
                    val = re.sub(r"\s{2,}", " ", val).strip()
                if not val:
                    continue
            sanitized[raw_key] = val
        return sanitized

    @staticmethod
    def _build_target_url(base_url: str, request: Request, subpath: str) -> str:
        raw_path = request.scope.get("raw_path")
        target_path = ""
        if isinstance(raw_path, (bytes, bytearray)):
            raw_text = bytes(raw_path).decode("latin-1", errors="ignore")
            prefix = "/video-workbench"
            if raw_text.startswith(prefix):
                suffix = raw_text[len(prefix):]
                target_path = suffix if suffix.startswith("/") else "/" + suffix
        if not target_path:
            target_path = "/" + subpath.lstrip("/")
        if not target_path.isascii():
            target_path = quote(target_path, safe="/:@!$&'()*+,;=%-._~")
        query = request.url.query
        if query and not query.isascii():
            query = quote(query, safe="=&:/?#[]@!$'()*+,;%-._~")
        return f"{base_url}{target_path}" + (f"?{query}" if query else "")

    @staticmethod
    def _error_response(request: Request, subpath: str, message: str, status_code: int = 503) -> Response:
        if subpath.startswith("api/") or "application/json" in str(request.headers.get("accept", "")).lower():
            return JSONResponse({"error": message}, status_code=status_code)
        escaped = html.escape(message)
        body = f"""<!doctype html>
<html lang="zh-CN" data-studio-skin="minimal">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>视频工作台暂不可用</title>
<script src="/static/js/xiaomei-shell-kernel.js"></script>
<script src="/static/js/theme.js"></script>
<link rel="stylesheet" href="/static/css/theme.css" />
<link rel="stylesheet" href="/static/vendor/fluent/tokens.css" />
<script type="module" src="/static/vendor/fluent/fluent.js"></script>
<style>
  :root {{
    --vw-err-bg: var(--colorNeutralBackground3, #f5f5f5);
    --vw-err-surface: var(--colorNeutralBackground1, #ffffff);
    --vw-err-soft: var(--colorNeutralBackground2, #fafafa);
    --vw-err-text: var(--colorNeutralForeground1, #242424);
    --vw-err-muted: var(--colorNeutralForeground2, #616161);
    --vw-err-border: var(--colorNeutralStroke2, #e0e0e0);
    --vw-err-accent: var(--studio-accent-color, var(--colorBrandBackground, #0e7490));
    --vw-err-on-accent: var(--colorNeutralForegroundOnBrand, #ffffff);
    --vw-err-danger-bg: var(--colorStatusDangerBackground1, #fdf3f4);
    --vw-err-danger-fg: var(--colorStatusDangerForeground1, #b10e1c);
    --vw-err-danger-border: var(--colorStatusDangerBorder1, #eeacb2);
    --vw-err-shadow: var(--shadow8, 0 4px 16px rgba(0, 0, 0, .08));
  }}
  * {{ box-sizing: border-box; }}
  body {{
    margin: 0;
    min-height: 100vh;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 24px;
    background: var(--vw-err-bg);
    color: var(--vw-err-text);
    font-family: var(--studio-font-family, var(--fontFamilyBase, "Segoe UI", "Microsoft YaHei", system-ui, sans-serif));
  }}
  .card {{
    width: 100%;
    max-width: 500px;
    padding: 28px 30px;
    border-radius: var(--borderRadius2XLarge, 12px);
    background: var(--vw-err-surface);
    border: 1px solid var(--vw-err-border);
    box-shadow: var(--vw-err-shadow);
  }}
  .badge {{
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 4px 10px;
    margin-bottom: 14px;
    border-radius: var(--borderRadiusCircular, 999px);
    background: var(--vw-err-danger-bg);
    border: 1px solid var(--vw-err-danger-border);
    color: var(--vw-err-danger-fg);
    font-size: 12px;
    font-weight: 600;
  }}
  .badge::before {{
    content: "";
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: currentColor;
  }}
  h1 {{
    margin: 0 0 10px;
    font-size: 20px;
    font-weight: 600;
    line-height: 1.3;
    color: var(--vw-err-text);
  }}
  p {{
    margin: 0 0 22px;
    padding: 12px 14px;
    border-radius: var(--borderRadiusLarge, 6px);
    background: var(--vw-err-soft);
    border: 1px solid var(--vw-err-border);
    color: var(--vw-err-muted);
    font-size: 13px;
    line-height: 1.6;
    word-break: break-word;
  }}
  .actions {{
    display: flex;
    align-items: center;
    gap: 10px;
  }}
  button {{
    min-height: 36px;
    padding: 0 18px;
    border-radius: var(--borderRadiusMedium, 4px);
    border: 1px solid transparent;
    background: var(--vw-err-accent);
    color: var(--vw-err-on-accent);
    font-size: 13px;
    font-weight: 600;
    cursor: pointer;
    transition: filter .15s ease, transform .15s ease;
  }}
  button:hover {{ filter: brightness(1.06); }}
  button:active {{ transform: translateY(1px); }}
  button:focus-visible {{
    outline: 2px solid var(--vw-err-accent);
    outline-offset: 2px;
  }}
</style>
</head>
<body>
  <div class="card" role="alert">
    <div class="badge">服务连接异常</div>
    <h1>视频工作台暂不可用</h1>
    <p>{escaped}</p>
    <div class="actions">
      <button type="button" onclick="location.reload()">重新加载</button>
    </div>
  </div>
</body>
</html>"""
        return HTMLResponse(body, status_code=status_code)

    async def _sync_canvas_settings(self, base_url: str) -> None:
        if self._canvas_settings_loader is None or not self._sync_token:
            return
        try:
            payload = await asyncio.to_thread(self._canvas_settings_loader)
        except Exception:
            return
        if not isinstance(payload, dict):
            return
        serialized = json.dumps(payload, sort_keys=True, ensure_ascii=False)
        digest = hashlib.sha256(serialized.encode("utf-8")).hexdigest()
        if digest == self._last_synced_hash:
            return
        client = self._get_client()
        try:
            resp = await client.post(
                f"{base_url}/internal/canvas-sync",
                content=serialized.encode("utf-8"),
                headers={
                    "Content-Type": "application/json",
                    "X-Canvas-Sync-Token": self._sync_token,
                },
            )
            if resp.status_code == 200:
                self._last_synced_hash = digest
        except Exception:
            pass

    async def proxy(self, request: Request, subpath: str) -> Response:
        normalized_subpath = subpath.lstrip("/")
        if normalized_subpath.startswith("internal/"):
            return JSONResponse({"error": "禁止访问"}, status_code=403)
        try:
            base_url = await asyncio.to_thread(self.ensure_started)
        except Exception as exc:
            return self._error_response(request, subpath, str(exc), status_code=503)

        if normalized_subpath in ("", "index.html") or normalized_subpath.startswith("api/"):
            await self._sync_canvas_settings(base_url)

        target_url = self._build_target_url(base_url, request, subpath)
        forward_headers = self._sanitize_forward_headers(request.headers)

        body = await request.body() if request.method not in ("GET", "HEAD") else None
        client = self._get_client()

        try:
            req = client.build_request(
                method=request.method,
                url=target_url,
                headers=forward_headers,
                content=body,
            )
            upstream = await client.send(req, stream=True)
        except Exception as exc:
            return self._error_response(request, subpath, f"连接视频工作台服务失败：{exc}", status_code=502)

        resp_headers = {
            k: v
            for k, v in upstream.headers.items()
            if k.lower() not in _HOP_BY_HOP_HEADERS
        }

        async def _stream():
            try:
                async for chunk in upstream.aiter_bytes():
                    yield chunk
            finally:
                await upstream.aclose()

        return StreamingResponse(
            _stream(),
            status_code=upstream.status_code,
            headers=resp_headers,
        )


def register_video_workbench_routes(app: FastAPI, manager: VideoWorkbenchManager) -> None:
    """Register reverse-proxy routes under `/video-workbench`."""

    @app.get("/video-workbench")
    async def video_workbench_root_redirect():
        return RedirectResponse(url="/video-workbench/", status_code=307)

    @app.api_route(
        "/video-workbench/{subpath:path}",
        methods=["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"],
    )
    async def video_workbench_proxy(request: Request, subpath: str):
        return await manager.proxy(request, subpath)
