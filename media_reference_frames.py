"""Read media duration and sample chronological video references for vision chat."""

import asyncio
import base64
import json
import logging
import math
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import time

import httpx

from media_formats import url_extension


_LOGGER = logging.getLogger(__name__)
_WINDOW_FLAGS = getattr(subprocess, "CREATE_NO_WINDOW", 0)
_DOWNLOAD_TIMEOUT = httpx.Timeout(connect=20, read=120, write=30, pool=10)


def _tool(name):
    executable = shutil.which(name)
    if executable:
        return executable
    configured = os.getenv("XIAOMEI_FFMPEG_PATH")
    if not configured:
        return None
    ffmpeg = Path(configured)
    candidate = ffmpeg if name == "ffmpeg" else ffmpeg.with_name(name + ffmpeg.suffix)
    return str(candidate) if candidate.is_file() else None


def video_poster(source, edge):
    executable = _tool("ffmpeg")
    if not executable:
        raise ValueError("未找到 FFmpeg，无法生成视频预览图")
    scale = f"scale=w='min(iw,{edge})':h='min(ih,{edge})':force_original_aspect_ratio=decrease"
    deadline = time.monotonic() + 60
    for seek in ("0.5", "0"):
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            break
        result = subprocess.run(
            [executable, "-nostdin", "-v", "error", "-ss", seek, "-i", str(source),
             "-map", "0:V:0", "-vf", scale, "-frames:v", "1", "-c:v", "mjpeg",
             "-threads", "1", "-f", "image2pipe", "pipe:1"],
            stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=remaining,
            creationflags=_WINDOW_FLAGS,
        )
        if result.returncode == 0 and result.stdout:
            return result.stdout
    raise ValueError("无法从视频读取预览帧")


def local_duration(value, locate):
    source = locate(value)
    executable = _tool("ffprobe")
    if not executable or not source or not Path(source).is_file():
        return None
    try:
        probe = subprocess.run(
            [executable, "-v", "error", "-of", "json", "-show_entries", "format=duration", str(source)],
            capture_output=True,
            timeout=20,
            creationflags=_WINDOW_FLAGS,
        )
        if probe.returncode:
            return None
        report = json.loads(probe.stdout)
        duration = float(report["format"]["duration"])
    except (OSError, ValueError, KeyError, TypeError, subprocess.TimeoutExpired):
        return None
    return duration if math.isfinite(duration) and duration > 0 else None


async def _download(address, folder):
    extension = url_extension(address)
    if len(extension) > 8 or not extension[1:].isalnum():
        extension = ".mp4"
    source = folder / ("reference" + extension)
    async with httpx.AsyncClient(timeout=_DOWNLOAD_TIMEOUT) as client:
        async with client.stream("GET", address) as response:
            response.raise_for_status()
            with source.open("wb") as stream:
                async for chunk in response.aiter_bytes(chunk_size=1024 * 1024):
                    stream.write(chunk)
    return source


def _sample(executable, source, workspace, count, width):
    folder = Path(workspace.name)
    try:
        result = subprocess.run(
            [executable, "-nostdin", "-loglevel", "error", "-i", str(source),
             "-vf", f"fps=1,scale=w=min(iw\\,{width}):h=-2",
             "-frames:v", str(count), str(folder / "sample-%06d.jpg")],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.PIPE,
            timeout=90,
            creationflags=_WINDOW_FLAGS,
        )
        if result.returncode:
            _LOGGER.warning("视频抽帧失败，FFmpeg 退出码 %s", result.returncode)
            return []
        frames = []
        for frame in sorted(folder.glob("sample-*.jpg"))[:count]:
            encoded = base64.b64encode(frame.read_bytes()).decode("ascii")
            frames.append("data:image/jpeg;base64," + encoded)
        return frames
    except (OSError, subprocess.TimeoutExpired) as error:
        _LOGGER.warning("视频抽帧失败（%s）", type(error).__name__)
        return []
    finally:
        workspace.cleanup()


async def video_frames(value, locate, *, max_frames=6, max_size=768):
    if not isinstance(value, str) or not value.strip():
        return []
    executable = _tool("ffmpeg")
    if not executable:
        return []
    address = value.strip()
    source = locate(address)
    if not source and not address.startswith(("http://", "https://")):
        return []
    if source and not Path(source).is_file():
        return []
    count, width = max(1, int(max_frames)), max(1, int(max_size))
    workspace = tempfile.TemporaryDirectory(prefix="xiaomei-video-reference-")
    worker = None
    try:
        if not source:
            try:
                source = await _download(address, Path(workspace.name))
            except (OSError, httpx.HTTPError, httpx.InvalidURL) as error:
                _LOGGER.warning("参考视频下载失败（%s）", type(error).__name__)
                return []
        worker = asyncio.create_task(asyncio.to_thread(_sample, executable, source, workspace, count, width))
        # The worker owns the source and extracted files until FFmpeg exits.
        return await asyncio.shield(worker)
    finally:
        if worker is None:
            workspace.cleanup()
