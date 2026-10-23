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
PALETTE_SAMPLE_EDGE = 400


class VectorizeRequest(BaseModel):
    source_url: str = Field(min_length=1, max_length=4096)
    name: str = Field(default="", max_length=200)
    preset: Literal["logo", "illustration"] = "logo"
    detail: Literal["simple", "balanced", "fine"] = "balanced"
    color_mode: Literal["color", "binary"] = "color"


# 描摹前的位图整理强度 + 描摹参数，按「图片类型 × 细节程度」分档。
# sigma / palette_size 决定平滑力度与保留的颜色数；min_share 与 merge_tolerance 负责把
# 抗锯齿过渡色和 JPEG 噪点并回主色 —— 这两个值不设好，色块边缘就会套一圈 1 像素描边。
# corner_threshold 越小越容易连成平滑曲线，length_threshold 越小曲线越长。
TRACE_PROFILES = {
    ("logo", "simple"): {
        "sigma": 1.10, "palette_size": 8, "min_share": 0.030, "merge_tolerance": 34,
        "speckle": 0, "corner_threshold": 40, "length_threshold": 2.6, "layer_difference": 6,
    },
    ("logo", "balanced"): {
        "sigma": 0.70, "palette_size": 12, "min_share": 0.020, "merge_tolerance": 24,
        "speckle": 0, "corner_threshold": 45, "length_threshold": 3.0, "layer_difference": 6,
    },
    ("logo", "fine"): {
        "sigma": 0.45, "palette_size": 18, "min_share": 0.010, "merge_tolerance": 14,
        "speckle": 0, "corner_threshold": 50, "length_threshold": 3.2, "layer_difference": 6,
    },
    ("illustration", "simple"): {
        "sigma": 0.60, "palette_size": 14, "min_share": 0.0030, "merge_tolerance": 12,
        "speckle": 10, "corner_threshold": 55, "length_threshold": 3.0, "layer_difference": 12,
    },
    ("illustration", "balanced"): {
        "sigma": 0.45, "palette_size": 22, "min_share": 0.0020, "merge_tolerance": 8,
        "speckle": 8, "corner_threshold": 60, "length_threshold": 3.0, "layer_difference": 8,
    },
    ("illustration", "fine"): {
        "sigma": 0.30, "palette_size": 32, "min_share": 0.0012, "merge_tolerance": 6,
        "speckle": 5, "corner_threshold": 65, "length_threshold": 3.0, "layer_difference": 6,
    },
}
BINARY_SIGMA = 0.6
# 预处理后与原图的平均色差上限。超过说明细节被磨掉了（细线、极小图、高对比文字），
# 此时降档重试，仍超标就放弃预处理直接用原图——宁可多一点毛边，也不能丢结构。
FLATTEN_MAX_ERROR = 7.5
FLATTEN_RETRY_STRENGTH = 0.35


def profile_for(preset, detail):
    return TRACE_PROFILES.get((preset, detail)) or TRACE_PROFILES[("logo", "balanced")]


def effective_sigma(sigma, width, height):
    """模糊半径是绝对像素值，小图上同样的半径会"吃掉"整个图形，按边长收一收。"""
    return sigma * min(1.0, max(0.3, min(width, height) / 600.0))


def vectorizer_status():
    return {
        "vtracer_ready": importlib.util.find_spec("vtracer") is not None,
        "paid_api": False,
    }


def trace_options(preset, detail, color_mode):
    profile = profile_for(preset, detail)
    return {
        "colormode": color_mode,
        "hierarchical": "stacked",
        "mode": "spline",
        "filter_speckle": profile["speckle"],
        "color_precision": 8,
        "layer_difference": profile["layer_difference"],
        "corner_threshold": profile["corner_threshold"],
        "length_threshold": profile["length_threshold"],
        "splice_threshold": 60,
        "path_precision": 3,
        "max_iterations": 20,
    }


def load_raster(source):
    with Image.open(source) as image:
        if getattr(image, "is_animated", False):
            raise ValueError("请先把动态图片导出为静态 PNG，再进行矢量转换")
        if max(image.size) > MAX_EDGE or image.width * image.height > MAX_PIXELS:
            raise ValueError("图片过大，请先缩小到长边 8192 像素以内、总像素不超过 1677 万")
        return ImageOps.exif_transpose(image).convert("RGBA")


def _snap_to_palette(rgb, palette):
    """把每个像素吸附到最近的调色板颜色。

    逐色累加最优距离，内存只跟像素数走（不随色数膨胀），而且比查表精确——
    查表会把落在同一格里的两个近似主色并成一个，照片上会出现大片同色的断层。
    """
    import numpy as np

    height, width = rgb.shape[:2]
    flat = rgb.reshape(-1, 3).astype(np.float32)
    best = np.full(flat.shape[0], np.inf, dtype=np.float32)
    index = np.zeros(flat.shape[0], dtype=np.uint8)
    for position, color in enumerate(palette):
        delta = flat - color.astype(np.float32)
        distance = np.einsum("ij,ij->i", delta, delta)
        closer = distance < best
        best[closer] = distance[closer]
        index[closer] = position
    return palette[index].reshape(height, width, 3)


def _extract_palette(rgb, mask, profile, strength=1.0):
    """kmeans 取主色 -> 丢弃低覆盖率的抗锯齿过渡色 -> 合并近似色（JPEG 噪点）。

    strength < 1 是"降档重试"：保留更多颜色、少合并一些，用来救细节丰富的图。
    """
    import numpy as np
    import cv2

    height, width = rgb.shape[:2]
    scale = min(1.0, PALETTE_SAMPLE_EDGE / max(height, width))
    size = (max(1, int(width * scale)), max(1, int(height * scale)))
    sample = cv2.resize(rgb, size, interpolation=cv2.INTER_AREA)
    points = sample.reshape(-1, 3).astype(np.float32)
    if mask is not None:
        sample_mask = cv2.resize(mask, size, interpolation=cv2.INTER_NEAREST).reshape(-1) > 0
        if sample_mask.any():
            points = points[sample_mask]
    if len(points) < 2:
        raise ValueError("没有足够的不透明像素用于提取颜色")

    k = int(min(profile["palette_size"], len(np.unique(points, axis=0))))
    k = max(2, k)
    cv2.setRNGSeed(20260101)
    criteria = (cv2.TERM_CRITERIA_EPS + cv2.TERM_CRITERIA_MAX_ITER, 30, 0.5)
    _, labels, centers = cv2.kmeans(points, k, None, criteria, 8, cv2.KMEANS_PP_CENTERS)

    min_share = profile["min_share"] * strength
    merge_tolerance = profile["merge_tolerance"] * strength
    share = np.bincount(labels.ravel(), minlength=k) / labels.size
    kept = []
    for index in np.argsort(-share):
        if share[index] < min_share:
            continue
        center = centers[index]
        if all(np.linalg.norm(center - centers[other]) > merge_tolerance for other in kept):
            kept.append(index)
    if len(kept) < 2:
        kept = list(np.argsort(-share)[:2])
    return np.uint8(centers[kept])


def _flatten_once(rgb, mask, profile, strength, width, height):
    """按给定强度做一次「去噪 → 提主色 → 吸附」，返回吸附后的 RGB。"""
    import cv2

    sigma = effective_sigma(profile["sigma"], width, height) * strength
    blurred = cv2.GaussianBlur(rgb, (0, 0), sigma) if sigma > 0 else rgb
    palette = _extract_palette(blurred, mask, profile, strength)
    return _snap_to_palette(blurred, palette)


def _flatten_error(original, flattened, mask):
    import numpy as np

    delta = np.abs(original.astype(np.int16) - flattened.astype(np.int16)).mean(axis=2)
    if mask is not None:
        delta = delta[mask > 0]
        if delta.size == 0:
            return 0.0
    return float(delta.mean())


def flatten_raster(image, preset, detail):
    """把位图压成"平涂"图再描摹，返回 RGBA；判定会丢结构时返回 None 表示放弃预处理。

    放大后边缘发毛、路径数量暴涨的真正原因不是 VTracer，而是喂给它的位图：
    抗锯齿会在色块交界处生成一圈过渡色，JPEG 又会把同一个白色拆成十几个近似值，
    VTracer 会把它们各描一条 1 像素宽的路径，于是边缘出现毛边和套色描边。
    这里先去噪、提取主色、再把每个像素吸附到主色上，边界变干净，曲线才拟合得出来。
    """
    import numpy as np

    rgba = np.array(image)
    rgb = rgba[:, :, :3]
    alpha = rgba[:, :, 3]
    height, width = rgb.shape[:2]
    opaque = bool((alpha == 255).all())
    mask = None if opaque else (alpha >= 128).astype(np.uint8)
    profile = profile_for(preset, detail)

    for strength in (1.0, FLATTEN_RETRY_STRENGTH):
        snapped = _flatten_once(rgb, mask, profile, strength, width, height)
        if _flatten_error(rgb, snapped, mask) <= FLATTEN_MAX_ERROR:
            return np.dstack([snapped, alpha])
    return None


def denoise_raster(image):
    """二值模式只去噪不吸附：它靠灰度层次做阈值，抹平中间调会丢掉过渡。"""
    import numpy as np
    import cv2

    rgba = np.array(image)
    height, width = rgba.shape[:2]
    sigma = effective_sigma(BINARY_SIGMA, width, height)
    rgb = cv2.GaussianBlur(rgba[:, :, :3], (0, 0), sigma)
    return np.dstack([rgb, rgba[:, :, 3]])


def prepare_raster(image, preset, detail, color_mode):
    if color_mode == "binary":
        return denoise_raster(image)
    return flatten_raster(image, preset, detail)


def trace_worker(source, destination, preset, detail, color_mode):
    import vtracer
    from io import BytesIO
    with load_raster(source) as image:
        if not image.getchannel("A").getbbox():
            raise ValueError("图片完全透明，没有可转换的图形")
        options = trace_options(preset, detail, color_mode)
        raster = image
        try:
            prepared = prepare_raster(image, preset, detail, color_mode)
            if prepared is not None:
                raster = Image.fromarray(prepared, "RGBA")
        except Exception:
            # 预处理只是提质手段，失败就退回原图，不让整次转换失败
            raster = image
        content = BytesIO()
        raster.save(content, "PNG")
        svg = vtracer.convert_raw_image_to_svg(content.getvalue(), img_format="png", **options)
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
