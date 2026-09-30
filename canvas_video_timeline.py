"""Render a saved canvas timeline from local media with FFmpeg."""

import asyncio
import os
import shutil
import subprocess
import tempfile
import uuid
from pathlib import Path

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field


class TimelineClip(BaseModel):
    url: str
    kind: str
    duration: float = Field(ge=0.1, le=120)
    source_start: float = Field(default=0, ge=0)
    volume: float = Field(default=1, ge=0, le=2)
    timeline_start: float = Field(default=0, ge=0, le=600)


class TimelineCaption(BaseModel):
    text: str = Field(max_length=500)
    start: float = Field(ge=0)
    end: float = Field(gt=0)


class TimelineExport(BaseModel):
    clips: list[TimelineClip] = Field(min_length=1, max_length=60)
    captions: list[TimelineCaption] = Field(default_factory=list, max_length=100)
    width: int = Field(default=1080, ge=256, le=3840)
    height: int = Field(default=1920, ge=256, le=3840)
    fps: int = Field(default=30, ge=12, le=60)


def _srt_time(seconds):
    millis = max(0, round(seconds * 1000))
    hours, millis = divmod(millis, 3600000)
    minutes, millis = divmod(millis, 60000)
    whole, millis = divmod(millis, 1000)
    return f"{hours:02}:{minutes:02}:{whole:02},{millis:03}"


def _run_ffmpeg(ffmpeg, args):
    process = subprocess.run(
        [ffmpeg, "-hide_banner", "-loglevel", "error", "-y", *args],
        capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=900,
    )
    if process.returncode:
        raise ValueError((process.stderr or "FFmpeg 导出失败").strip()[-1200:])


def _render(request, host):
    ffmpeg = shutil.which("ffmpeg") or os.getenv("XIAOMEI_FFMPEG_PATH")
    if not ffmpeg or not Path(ffmpeg).is_file():
        raise ValueError("未找到 FFmpeg。请安装 FFmpeg，或在 API/.env 配置 XIAOMEI_FFMPEG_PATH 后重启。")
    visual = [clip for clip in request.clips if clip.kind in ("video", "image")]
    audio = [clip for clip in request.clips if clip.kind == "audio"]
    if not visual:
        raise ValueError("时间线至少需要一个视频或图片片段")
    if any(clip.kind not in ("video", "image", "audio") for clip in request.clips):
        raise ValueError("时间线仅支持视频、图片和音频素材")
    total = sum(clip.duration for clip in visual)
    if total > 600:
        raise ValueError("成片最长支持 10 分钟")
    resolved = []
    for clip in request.clips:
        path = host.local_media_path_from_url(clip.url)
        if not path or not Path(path).is_file():
            raise ValueError(f"找不到本地素材：{clip.url[:160]}")
        resolved.append(Path(path).resolve())
    output_dir = Path(host.OUTPUT_DIR) / "canvas-videos"
    output_dir.mkdir(parents=True, exist_ok=True)
    filename = f"canvas-video-{uuid.uuid4().hex[:12]}.mp4"
    output = output_dir / filename
    visual_index = 0
    try:
        with tempfile.TemporaryDirectory(prefix="xiaomei-video-") as temp_name:
            temp = Path(temp_name)
            parts = []
            for clip, path in zip(request.clips, resolved):
                if clip.kind not in ("video", "image"):
                    continue
                part = temp / f"part-{visual_index:03}.mp4"
                visual_index += 1
                source = (["-loop", "1"] if clip.kind == "image" else ["-ss", str(clip.source_start)])
                vf = (f"scale={request.width}:{request.height}:force_original_aspect_ratio=decrease,"
                      f"pad={request.width}:{request.height}:(ow-iw)/2:(oh-ih)/2:black,"
                      f"fps={request.fps},format=yuv420p")
                _run_ffmpeg(ffmpeg, [*source, "-i", str(path), "-t", str(clip.duration),
                                     "-vf", vf, "-an", "-c:v", "libx264", "-preset", "veryfast",
                                     "-movflags", "+faststart", str(part)])
                parts.append(part)
            concat_file = temp / "parts.txt"
            concat_file.write_text("".join(f"file '{part.as_posix()}'\n" for part in parts), encoding="utf-8")
            joined = temp / "joined.mp4"
            _run_ffmpeg(ffmpeg, ["-f", "concat", "-safe", "0", "-i", str(concat_file),
                                 "-c", "copy", str(joined)])
            captions = [caption for caption in request.captions if caption.text.strip() and caption.start < caption.end and caption.start < total]
            args = ["-i", str(joined)]
            filters = []
            video_map = "0:v:0"
            if captions:
                subtitle_file = temp / "captions.srt"
                subtitle_file.write_text("\n".join(
                    f"{index}\n{_srt_time(caption.start)} --> {_srt_time(min(total, caption.end))}\n{caption.text.strip()}\n"
                    for index, caption in enumerate(captions, 1)
                ), encoding="utf-8")
                escaped = subtitle_file.as_posix().replace(":", "\\:").replace("'", "\\'")
                filters.append(f"[0:v]subtitles='{escaped}'[vout]")
                video_map = "[vout]"
            audio_inputs = []
            for clip, path in zip(request.clips, resolved):
                if clip.kind != "audio":
                    continue
                args.extend(["-ss", str(clip.source_start), "-i", str(path)])
                input_index = len(audio_inputs) + 1
                label = f"a{input_index}"
                filters.append(f"[{input_index}:a]atrim=duration={min(clip.duration, total):.3f},"
                               f"asetpts=PTS-STARTPTS,adelay={round(min(clip.timeline_start, total) * 1000)}:all=1,"
                               f"volume={clip.volume:.3f}[{label}]")
                audio_inputs.append(label)
            if audio_inputs:
                joined_audio = "".join(f"[{label}]" for label in audio_inputs)
                filters.append(f"{joined_audio}amix=inputs={len(audio_inputs)}:duration=longest:normalize=0[aout]")
            if filters:
                args.extend(["-filter_complex", ";".join(filters)])
            args.extend(["-map", video_map])
            if audio_inputs:
                args.extend(["-map", "[aout]", "-c:a", "aac", "-b:a", "192k"])
            if captions:
                args.extend(["-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p"])
            else:
                args.extend(["-c:v", "copy"])
            args.extend(["-t", str(total), "-movflags", "+faststart", str(output)])
            _run_ffmpeg(ffmpeg, args)
        if not output.is_file() or output.stat().st_size == 0:
            raise ValueError("FFmpeg 没有生成有效视频")
        url = f"/output/canvas-videos/{filename}"
        host.asset_registry_register_media(url, name=filename, kind="video", source="canvas-timeline")
        return {"url": url, "name": filename, "kind": "video", "duration": total}
    except Exception:
        output.unlink(missing_ok=True)
        raise


def install_canvas_video_timeline(app, host):
    router = APIRouter()

    @router.post("/api/canvas-video-timeline/export")
    async def export_canvas_video_timeline(request: TimelineExport):
        try:
            return await asyncio.to_thread(_render, request, host)
        except (ValueError, subprocess.TimeoutExpired) as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

    app.include_router(router)
