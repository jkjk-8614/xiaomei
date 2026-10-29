"""Model-independent local patch compositing. No provider calls or ComfyUI code."""
from __future__ import annotations

import hashlib
import math
from pathlib import Path
from typing import Any, Literal

import numpy as np
from PIL import Image, ImageOps
from pydantic import BaseModel, Field


class FusionRegion(BaseModel):
    id: str = ''
    sourceUrl: str = ''
    sourceWidth: int = Field(gt=0)
    sourceHeight: int = Field(gt=0)
    x: int = Field(ge=0)
    y: int = Field(ge=0)
    width: int = Field(gt=0)
    height: int = Field(gt=0)


class FusionPatch(BaseModel):
    url: str
    region: FusionRegion | None = None
    maskUrl: str = ''
    alignment: Literal['auto', 'coordinates', 'manual'] = 'auto'
    offsetX: float = Field(default=0, ge=-4096, le=4096, allow_inf_nan=False)
    offsetY: float = Field(default=0, ge=-4096, le=4096, allow_inf_nan=False)
    scale: float = Field(default=1, ge=.5, le=2, allow_inf_nan=False)
    rotation: float = Field(default=0, ge=-30, le=30, allow_inf_nan=False)
    allowDistortion: bool = False
    maskMode: Literal['rectangle', 'changes'] = 'rectangle'


class FusionRequest(BaseModel):
    sourceUrl: str
    patches: list[FusionPatch] = Field(min_length=1, max_length=12)
    colorMatch: bool = True
    feather: int = Field(default=12, ge=0, le=128)
    blend: Literal['alpha', 'poisson'] = 'alpha'
    overlap: Literal['reject', 'ordered'] = 'reject'


class FusionCancelled(Exception):
    pass


def read_image(url, resolve, max_pixels=40_000_000):
    path = resolve(url)
    if not path or not Path(path).is_file():
        raise ValueError('请先将图片导入小美画布，再连接本地图片')
    with Image.open(path) as image:
        if image.width * image.height > max_pixels:
            raise ValueError('图片超过 4000 万像素，请先缩小副本')
        return ImageOps.exif_transpose(image).convert('RGBA')


def _check(cancel):
    if cancel():
        raise FusionCancelled()


def _features(reference, patch, ring=False):
    """Estimate edited-patch -> reference mapping, with independently checked support."""
    def small(image):
        scale = min(1., 1600 / max(image.shape[:2]))
        gray = cv2.cvtColor(image[:, :, :3], cv2.COLOR_RGB2GRAY)
        return cv2.resize(gray, None, fx=scale, fy=scale), scale
    a, sa = small(reference)
    b, sb = small(patch)
    ma = mb = None
    if ring:
        def border_mask(gray):
            h, w = gray.shape
            mask = np.full((h, w), 255, np.uint8)
            mask[int(h*.22):int(h*.78), int(w*.22):int(w*.78)] = 0
            return mask
        ma, mb = border_mask(a), border_mask(b)
    detector = cv2.ORB_create(nfeatures=3500, edgeThreshold=12, fastThreshold=9)
    ka, da = detector.detectAndCompute(a, ma)
    kb, db = detector.detectAndCompute(b, mb)
    if da is None or db is None:
        return None, {'matches': 0}
    pairs = cv2.BFMatcher(cv2.NORM_HAMMING).knnMatch(db, da, k=2)
    matches = [p[0] for p in pairs if len(p) == 2 and p[0].distance < .72*p[1].distance]
    if len(matches) < 12:
        return None, {'matches': len(matches)}
    src = np.float32([kb[m.queryIdx].pt for m in matches]) / sb
    dst = np.float32([ka[m.trainIdx].pt for m in matches]) / sa
    matrix, inliers = cv2.estimateAffinePartial2D(src, dst, method=cv2.RANSAC,
                                               ransacReprojThreshold=3/max(sa, sb), maxIters=3000)
    count = int(inliers.sum()) if inliers is not None else 0
    report = {'matches': len(matches), 'inliers': count, 'inlierRatio': round(count/len(matches), 3)}
    if matrix is None or count < 12 or count/len(matches) < .55:
        return None, report
    supported = src[inliers.ravel().astype(bool)]
    coverage = cv2.contourArea(cv2.convexHull(supported)) / (patch.shape[0]*patch.shape[1])
    report['coverage'] = round(coverage, 3)
    if coverage < .10:
        return None, report
    return matrix, report


def locate(source, patch):
    matrix, report = _features(source, patch)
    if matrix is None:
        raise ValueError('无法可靠定位局部图；请连接从原图裁剪的版本，或在高级设置中填写位置')
    h, w = patch.shape[:2]
    corners = cv2.transform(np.float32([[[0, 0], [w, 0], [w, h], [0, h]]]), matrix)[0]
    x, y = np.floor(corners.min(axis=0)).astype(int)
    right, bottom = np.ceil(corners.max(axis=0)).astype(int)
    if x < 0 or y < 0 or right > source.shape[1] or bottom > source.shape[0] or right-x < 8 or bottom-y < 8:
        raise ValueError('自动定位超出原图，请手动调整位置')
    matrix[:, 2] -= [x, y]
    return (int(x), int(y), int(right-x), int(bottom-y)), matrix, report


def _ring(shape):
    h, w = shape[:2]
    border = max(1, round(min(h, w)*.12))
    ring = np.ones((h, w), bool)
    ring[border:h-border, border:w-border] = False
    return ring


def _boundary_error(base, patch, support):
    valid = _ring(base.shape) & (support > .99)
    if valid.sum() < 16:
        return 1.
    a = base[:, :, :3].astype(np.float32)[valid]
    b = patch[:, :, :3].astype(np.float32)[valid]
    # Remove a uniform exposure / white balance offset for the geometry check.
    delta = a-b
    return float(np.mean(np.abs(delta-np.median(delta, axis=0)))/255)


def _soft_mask(mask, feather):
    if not feather:
        return mask.astype(np.float32)/255
    # Distance is measured inward: no nonzero weight may escape the selected mask.
    padded = np.pad((mask > 0).astype(np.uint8), 1)
    distance = cv2.distanceTransform(padded, cv2.DIST_L2, 5)[1:-1, 1:-1]
    t = np.clip((distance-1)/max(1, feather), 0, 1)
    return t*t*(3-2*t)*(mask.astype(np.float32)/255)


def _match_color(base, patch, support):
    valid = _ring(base.shape) & (support > .99)
    if valid.sum() < 32:
        return patch, '边界样本不足，未匹配颜色'
    a, b = base[:, :, :3].astype(np.float32), patch[:, :, :3].astype(np.float32)
    # Robust bounded channel offset avoids changing local contrast and sharp text.
    offset = np.clip(np.median(a[valid]-b[valid], axis=0), -35, 35)
    result = patch.copy()
    result[:, :, :3] = np.clip(np.round(b+offset), 0, 255).astype(np.uint8)
    return result, ''


def fuse(request: FusionRequest, resolve, cancel=lambda: False, progress=lambda _: None):
    global cv2
    try:
        import cv2
    except ImportError as exc:
        raise ValueError('本地图片处理组件未安装，请修复小美画布运行环境后重试') from exc
    source_image = read_image(request.sourceUrl, resolve)
    source = np.array(source_image)
    result = source.copy()
    union = np.zeros(source.shape[:2], np.uint8)
    records, warnings = [], []
    for index, item in enumerate(request.patches):
        _check(cancel)
        progress(f'正在处理区域 {index+1}/{len(request.patches)}')
        edited = np.array(read_image(item.url, resolve))
        auto_matrix = None
        alignment = {'status': 'coordinates'}
        if item.region:
            r = item.region
            if r.sourceUrl and Path(resolve(r.sourceUrl) or '').resolve() != Path(resolve(request.sourceUrl) or '').resolve():
                raise ValueError('局部图属于另一张原图，请重新选择原图或裁剪区域')
            if (r.sourceWidth, r.sourceHeight) != source_image.size:
                raise ValueError('原图尺寸已改变，请从当前原图重新裁剪')
            x, y, w, h = r.x, r.y, r.width, r.height
        else:
            (x, y, w, h), auto_matrix, alignment = locate(source, edited)
            alignment['status'] = 'located'
        if x+w > source_image.width or y+h > source_image.height or min(w, h) < 4:
            raise ValueError('修改区域超出原图，或区域小于 4 像素，请重新框选')
        if w*h > 16_000_000:
            raise ValueError('单个局部超过 1600 万像素，请缩小裁剪区域')
        base = source[y:y+h, x:x+w]
        if auto_matrix is None:
            mismatch = abs((edited.shape[1]/edited.shape[0])/(w/h)-1)
            if mismatch > .035 and not item.allowDistortion:
                raise ValueError('修改图宽高比与裁剪区域不同；请重新出图，或在高级设置中确认拉伸适配')
            edited = np.array(Image.fromarray(edited).resize((w, h), Image.Resampling.LANCZOS))
            if mismatch > .035:
                warnings.append(f'区域 {index+1} 已按手动确认拉伸，请检查产品比例')
        support = np.ones((h, w), np.float32)
        if auto_matrix is not None:
            support = cv2.warpAffine(np.ones(edited.shape[:2], np.float32), auto_matrix, (w, h))
            edited = cv2.warpAffine(edited, auto_matrix, (w, h))
        elif item.alignment == 'auto':
            matrix, details = _features(base, edited, ring=True)
            alignment.update(details)
            if matrix is not None:
                scale = math.hypot(matrix[0, 0], matrix[1, 0])
                angle = abs(math.degrees(math.atan2(matrix[1, 0], matrix[0, 0])))
                if not .88 <= scale <= 1.12 or angle > 7 or abs(matrix[0, 2]) > w*.15 or abs(matrix[1, 2]) > h*.15:
                    raise ValueError('修改图的结构或视角变化过大，请继续修图或手动调整，普通融合无法修复')
                warped = cv2.warpAffine(edited, matrix, (w, h))
                valid = cv2.warpAffine(support, matrix, (w, h))
                before, after = _boundary_error(base, edited, support), _boundary_error(base, warped, valid)
                if after < before*.95:
                    edited, support = warped, valid
                    alignment.update(status='registered', matrix=matrix.tolist())
        if item.alignment == 'manual':
            matrix = cv2.getRotationMatrix2D((w/2, h/2), item.rotation, item.scale)
            matrix[:, 2] += [item.offsetX, item.offsetY]
            edited = cv2.warpAffine(edited, matrix, (w, h))
            support = cv2.warpAffine(support, matrix, (w, h))
            alignment['status'] = 'manual'
        error = _boundary_error(base, edited, support)
        alignment['boundaryError'] = round(error, 4)
        if error > .20 and item.alignment == 'auto':
            raise ValueError('局部图与原图边界差异过大，自动对齐不可靠；请继续修图，或手动定位后预览')
        if error > .10:
            warnings.append(f'区域 {index+1} 边界纹理差异较大，请检查预览中的结构和接缝')
        mask = np.full((h, w), 255, np.uint8)
        if item.maskUrl:
            mask_image = read_image(item.maskUrl, resolve)
            if mask_image.size == source_image.size:
                mask_image = mask_image.crop((x, y, x+w, y+h))
            elif mask_image.size != (w, h):
                raise ValueError('蒙版尺寸必须等于裁剪区域或原图尺寸；白色表示修改区域')
            mask = np.array(mask_image.convert('L'))
        elif item.maskMode == 'changes':
            a = cv2.GaussianBlur(base[:, :, :3], (0, 0), 1.2).astype(np.float32)
            b = cv2.GaussianBlur(edited[:, :, :3], (0, 0), 1.2).astype(np.float32)
            delta = b-a
            delta -= np.median(delta[_ring(base.shape)], axis=0)
            mask = (np.max(np.abs(delta), axis=2) > 20).astype(np.uint8)*255
            mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, np.ones((5, 5), np.uint8))
            mask = cv2.dilate(mask, np.ones((7, 7), np.uint8))
        if not mask.any():
            raise ValueError('没有检测到修改区域，请选择整个裁剪区域或重新绘制蒙版')
        weight = _soft_mask(mask, min(request.feather, max(0, min(w, h)//4)))
        weight *= support * (edited[:, :, 3].astype(np.float32)/255)
        active = weight > 0
        if not active.any():
            raise ValueError('局部图没有可融合的不透明区域，请调整蒙版或位置')
        if np.any((union[y:y+h, x:x+w] > 0) & active):
            if request.overlap == 'reject':
                raise ValueError('多个修改区域发生重叠；请在高级设置选择按列表顺序融合，或取消重叠区域')
            warnings.append(f'区域 {index+1} 与前面区域重叠，已按列表顺序融合')
        if request.colorMatch:
            edited, warning = _match_color(base, edited, support)
            if warning:
                warnings.append(f'区域 {index+1}：{warning}')
        _check(cancel)
        target = result[y:y+h, x:x+w]
        if request.blend == 'poisson':
            # Clone only a local buffer, then reapply the exact support mask.
            # OpenCV otherwise may change pixels outside the requested region.
            try:
                poisson_mask = active.astype(np.uint8)*255
                ys, xs = np.where(active)
                center = ((int(xs.min())+int(xs.max())+1)//2, (int(ys.min())+int(ys.max())+1)//2)
                cloned = cv2.seamlessClone(edited[:, :, :3], target[:, :, :3].copy(), poisson_mask,
                                           center, cv2.NORMAL_CLONE)
                edited[:, :, :3] = cloned
            except cv2.error as exc:
                raise ValueError('当前蒙版无法使用泊松融合，请改用保留细节的羽化融合') from exc
        alpha = weight[:, :, None]
        rgb = np.round(edited[:, :, :3]*alpha+target[:, :, :3]*(1-alpha)).astype(np.uint8)
        target[:, :, :3][active] = rgb[active]
        # Keep original alpha, dimensions, and every pixel outside union intact.
        union[y:y+h, x:x+w][active] = 255
        records.append({'url': item.url, 'region': {'x': x, 'y': y, 'width': w, 'height': h},
                        'alignment': alignment, 'maskUrl': item.maskUrl, 'modifiedPixels': int(active.sum())})
    _check(cancel)
    digest = hashlib.sha256(source).hexdigest()
    outside_unchanged = all(np.array_equal(result[top:top+256][union[top:top+256] == 0],
                                           source[top:top+256][union[top:top+256] == 0])
                            for top in range(0, source.shape[0], 256))
    if not outside_unchanged:
        raise ValueError('修改范围外像素校验失败，未输出结果，请重试')
    return Image.fromarray(result, 'RGBA'), Image.fromarray(union, 'L'), {
        'version': 1, 'width': source_image.width, 'height': source_image.height,
        'sourcePixelHash': digest, 'regions': records, 'warnings': warnings,
        'outsideUnchanged': outside_unchanged,
        'paidApiCalled': False,
    }
