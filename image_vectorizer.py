"""Local raster tracing for canvas image settings."""
import asyncio
import importlib.util
import os
from pathlib import Path
import subprocess
import sys
import threading
from typing import Literal
import xml.etree.ElementTree as ET

from fastapi import APIRouter, HTTPException, Request
from PIL import Image, ImageOps
from pydantic import BaseModel, Field

MAX_PIXELS = 16_777_216
MAX_EDGE = 8192
TIMEOUT_SECONDS = 180
SVG_NAMESPACE = "http://www.w3.org/2000/svg"


class VectorizeRequest(BaseModel):
    source_url: str = Field(min_length=1, max_length=4096)
    name: str = Field(default="", max_length=200)
    preset: Literal["logo", "illustration"] = "logo"
    detail: Literal["simple", "balanced", "fine"] = "balanced"
    color_mode: Literal["color", "binary"] = "color"


def vectorizer_status():
    return {
        "vtracer_ready": importlib.util.find_spec("vtracer") is not None,
        "paid_api": False,
    }


def trace_options(preset, detail, color_mode):
    return {
        "colormode": color_mode,
        "hierarchical": "stacked",
        "mode": "spline",
        "filter_speckle": {"simple": 8, "balanced": 4, "fine": 1}[detail],
        "color_precision": {"simple": 4, "balanced": 6, "fine": 8}[detail],
        "layer_difference": 16 if preset == "logo" else 8,
        "corner_threshold": 60 if preset == "logo" else 90,
        "length_threshold": 4.0,
        "splice_threshold": 45,
        "path_precision": 3,
    }


def load_raster(source):
    with Image.open(source) as image:
        if getattr(image, "is_animated", False):
            raise ValueError("请先把动态图片导出为静态 PNG，再进行矢量转换")
        if max(image.size) > MAX_EDGE or image.width * image.height > MAX_PIXELS:
            raise ValueError("图片过大，请先缩小到长边 8192 像素以内、总像素不超过 1677 万")
        return ImageOps.exif_transpose(image).convert("RGBA")


def trace_worker(source, destination, preset, detail, color_mode):
    import vtracer
    from io import BytesIO
    with load_raster(source) as image:
        if not image.getchannel("A").getbbox():
            raise ValueError("图片完全透明，没有可转换的图形")
        content = BytesIO()
        image.save(content, "PNG")
        svg = vtracer.convert_raw_image_to_svg(content.getvalue(), img_format="png", **trace_options(preset, detail, color_mode))
        root = ET.fromstring(svg)
        root.set("viewBox", f"0 0 {image.width} {image.height}")
        ET.register_namespace("", SVG_NAMESPACE)
        Path(destination).write_text(ET.tostring(root, encoding="unicode"), encoding="utf-8")


def convert_image(host, source_path, payload):
    if not vectorizer_status()["vtracer_ready"]:
        raise HTTPException(503, "VTracer 未安装，请安装项目 requirements.txt 中的依赖后重启小美画布")
    try:
        with load_raster(source_path) as image:
            width, height = image.size
        filename = host.generated_output_filename("vector_", ".svg")
        destination = Path(host.output_path_for(filename, "output"))
        destination.parent.mkdir(parents=True, exist_ok=True)
        # A separate process keeps native tracing from blocking the API's Python
        # interpreter and bounds a malformed image or expensive conversion.
        process = subprocess.run([
            sys.executable, str(Path(__file__).resolve()), "--trace",
            str(Path(source_path).resolve()), str(destination.resolve()),
            payload.preset, payload.detail, payload.color_mode,
        ], capture_output=True, timeout=TIMEOUT_SECONDS, shell=False,
            env={**os.environ, "PYTHONIOENCODING": "utf-8"},
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        if process.returncode:
            error = process.stderr.decode("utf-8", errors="replace").strip()
            raise ValueError(error[:400] or "VTracer 未能完成转换，请尝试简化细节或缩小原图")
        svg = destination.read_text(encoding="utf-8")
        root = ET.fromstring(svg)
        if root.tag != f"{{{SVG_NAMESPACE}}}svg":
            raise ValueError("转换结果不是有效 SVG，请重试")
        paths = sum(1 for _ in root.iter(f"{{{SVG_NAMESPACE}}}path"))
        if not paths:
            raise ValueError("未识别到图形，请换一张图片或调整颜色模式")
        stem = Path(payload.name or source_path).stem
        name = f"{stem}_矢量.svg"
        return {
            "url": host.output_url_for(filename, "output"), "name": name,
            "kind": "image", "width": width, "height": height,
            "path_count": paths, "size_bytes": destination.stat().st_size,
            "preset": payload.preset, "detail": payload.detail,
            "color_mode": payload.color_mode, "engine": "vtracer", "paid_api": False,
            "derived_from": {"url": payload.source_url, "operation": "vectorize"},
        }
    except HTTPException:
        raise
    except subprocess.TimeoutExpired:
        raise HTTPException(504, "矢量转换超时，请选择简化细节或缩小图片后重试") from None
    except Exception as error:
        raise HTTPException(422, f"矢量转换失败：{error}") from None
    finally:
        if "destination" in locals() and sys.exc_info()[0] is not None:
            destination.unlink(missing_ok=True)


def install_image_vectorizer(app, host):
    router = APIRouter()
    busy = threading.BoundedSemaphore(1)

    def require_local(request):
        address = getattr(getattr(request, "client", None), "host", "")
        if not host._request_host_is_loopback(address) or host._request_is_share_gateway(request):
            raise HTTPException(403, "矢量转换只能在运行小美画布的电脑上使用")

    @router.get("/api/image-vectorizer/status")
    async def status(request: Request):
        require_local(request)
        return await asyncio.to_thread(vectorizer_status)

    @router.post("/api/image/vectorize")
    async def vectorize(payload: VectorizeRequest, request: Request):
        require_local(request)
        source = host.local_media_path_from_url(payload.source_url)
        if not source or not Path(source).is_file():
            raise HTTPException(400, "请等待图片上传到小美画布后再转换，只支持本地图片")
        if not busy.acquire(blocking=False):
            raise HTTPException(409, "已有图片正在矢量转换，请等待完成后再试")
        def run():
            try:
                return convert_image(host, source, payload)
            finally:
                busy.release()
        return await asyncio.to_thread(run)

    app.include_router(router)


if __name__ == "__main__":
    try:
        if len(sys.argv) != 7 or sys.argv[1] != "--trace":
            raise ValueError("无效的转换参数")
        trace_worker(*sys.argv[2:])
    except Exception as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
