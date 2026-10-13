"""Local product protection shared by image providers; no paid calls in this module."""
import copy
import hashlib
import importlib.util
import json
import math
import re
import threading
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageOps


GOOGLE_SOURCE = 'https://ai.google.dev/gemini-api/docs/image-generation'
OPENAI_SOURCE = 'https://developers.openai.com/api/reference/python/resources/images/methods/edit'
RATIOS = ['1:1', '2:3', '3:2', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9']
_CACHE_LOCK = threading.Lock()


def capabilities(provider, model, protocol, request_mode, transport_limit=16):
    """Declare exact known IDs; channel aliases keep their actual submitted ID."""
    name = str(model).lower().removeprefix('models/')
    google = bool(re.match(r'gemini-(?:2\.5-flash-image|3-pro-image|3\.1-flash(?:-lite)?-image|nano-banana-2\.1)(?:-preview)?$', name))
    alias = name in {'nano-banana', 'nano-banana-pro', 'nano-banana-2', 'nano-banana-2.1'}
    gpt = bool(re.match(r'gpt-image-2(?:\.5-(?:flare|sunburst))?(?:-\d{4}-\d{2}-\d{2}|-high|-medium)?$', name))
    direct_google = 'generativelanguage.googleapis.com' in str(provider.get('base_url', ''))
    direct_openai = 'api.openai.com' in str(provider.get('base_url', ''))
    transport = ('google-generate-content' if protocol == 'gemini' else
                 'codex' if protocol == 'codex' else
                 'openai-images' if protocol == 'openai' and request_mode == 'openai' else request_mode)
    known_route = transport in {'google-generate-content', 'openai-images', 'codex', 'openai-json', 'openai-responses'}
    supported = known_route and (gpt or google or alias)
    legacy = name in {'gemini-2.5-flash-image', 'gemini-2.5-flash-image-preview', 'nano-banana'}
    lite = 'lite' in name
    pro = 'pro' in name
    limit = 16 if gpt else (14 if google and not legacy else None)
    # Alias/version and proxy limits are not official limits. Stay within a
    # conservative application budget until the channel is independently probed.
    budget = min(transport_limit, limit or (3 if legacy or alias else 1))
    return dict(provider='openai' if gpt else 'google' if google or alias else 'unknown',
                modelId=model, channelId=provider.get('id'), transport=transport,
                supported=supported, supportsImageReferences=supported,
                supportsMultipleReferences=supported and budget > 1,
                maxReferenceImages=limit if (direct_google or direct_openai) else None,
                applicationReferenceLimit=budget,
                preferredReferenceImages=1 if lite else 3 if legacy or alias else 5 if pro else 4,
                supportsImageEditing=supported,
                maskEditMode='native-raster-mask' if gpt and transport == 'openai-images' else 'semantic-only' if google or alias else 'none',
                maskAppliesToFirstImage=bool(gpt and transport == 'openai-images'),
                nativeMaskUsed=False, supportsTransparentOutput=bool(gpt and '2.5' in name),
                supportedAspectRatios=RATIOS if google or alias else [],
                supportedOutputSizes=(['1K'] if legacy or lite else ['1K', '2K', '4K']) if google or alias else ['auto', 'pixel-dimensions'],
                availableQualities=(['auto', 'low', 'medium', 'high', 'xhigh', 'max'] if '2.5' in name else ['auto', 'low', 'medium', 'high']) if gpt else [],
                supportsNativeControlNet=False, supportsNativeDepthControl=False,
                supportsNativeEdgeControl=False, supportsNativeCameraControl=False,
                verificationSource=OPENAI_SOURCE if gpt else GOOGLE_SOURCE,
                channelVerified=False, aliasVersionVerified=not alias,
                verifiedAt='2026-10-13', localPixelProtection=True,
                localFeatureAlignment=importlib.util.find_spec('cv2') is not None)


def normalize(raw):
    raw = copy.deepcopy(raw or {})
    if not raw.get('enabled'):
        return {'version': 1, 'enabled': False}
    if raw.get('version', 1) != 1:
        raise ValueError('产品保真配置版本暂不支持，请更新小美画布')
    raw.update(version=1, enabled=True)
    raw.setdefault('mode', 'strict')
    if raw['mode'] not in {'strict', 'structure', 'view'}:
        raise ValueError('产品保真模式无效')
    for field in ('detail', 'view', 'generation', 'validation', 'retries', 'structure', 'dimensions'):
        if not isinstance(raw.get(field, {}), dict):
            raise ValueError('产品保真配置格式无效：' + field)
        raw.setdefault(field, {})
    detail = raw['detail']
    detail.setdefault('enabled', True)
    detail.setdefault('inputMode', 'combined')
    detail.setdefault('highPassRadiusPx', 2)
    detail.setdefault('highPassGain', 2)
    detail.setdefault('autoCrops', False)
    detail.setdefault('cropCount', 2)
    detail.setdefault('restoreMode', 'off')
    detail.setdefault('restoreStrength', .3)
    if not 0 <= float(raw.get('maskFeatherPx', 0)) <= 8 or not .7 <= float(raw.get('alignmentThreshold', .85)) <= 1:
        raise ValueError('蒙版羽化应为 0–8px，对齐门槛应为 0.7–1')
    if detail['inputMode'] not in {'original', 'highpass', 'crops', 'combined'}:
        raise ValueError('细节输入方式无效')
    if not .5 <= float(detail['highPassRadiusPx']) <= 8 or not 0 <= int(detail['cropCount']) <= 3:
        raise ValueError('高反差半径应为 0.5–8px，裁切数量应为 0–3')
    if not .5 <= float(detail['highPassGain']) <= 4 or not isinstance(detail['autoCrops'], bool):
        raise ValueError('高反差增益应为 0.5–4，自动裁切必须为开关值')
    if detail['restoreMode'] not in {'off', 'auto'} or not 0 <= float(detail['restoreStrength']) <= 1:
        raise ValueError('细节恢复仅支持关闭或可靠对齐后自动恢复，强度应为 0–1')
    if raw['mode'] == 'strict' and (raw['view'].get('mode', 'keep') != 'keep' or any(float(raw['view'].get(k, 0)) for k in ('yaw', 'pitch', 'roll'))):
        raise ValueError('严格保真需要保持原视角；请保留原角度或切换视角保真并补充多视角参考')
    if raw['mode'] == 'strict' and raw['generation'].get('allowedEdits', 'background') != 'background':
        raise ValueError('严格保真只改变背景；修改产品光照或材质请使用结构保真')
    if raw['retries'].get('enabled'):
        raise ValueError('自动重试暂不可用：渠道费用未知，请查看结果后手动重试')
    scope = raw['generation'].get('allowedEdits', 'view' if raw['mode']=='view' else 'lighting' if raw['mode']=='structure' else 'background')
    if scope not in {'background', 'lighting', 'material', 'view'}:
        raise ValueError('允许变化范围无效')
    if raw['mode'] != 'view' and (scope == 'view' or raw['view'].get('mode', 'keep') != 'keep' or any(float(raw['view'].get(k, 0)) for k in ('yaw', 'pitch', 'roll'))):
        raise ValueError('改变视角请切换视角保真，结构模式仅支持同视角约束')
    for key in ('width', 'height', 'depth'):
        number = float(raw['dimensions'].get(key) or 0)
        if not math.isfinite(number) or number < 0 or number > 1e6:
            raise ValueError('真实产品尺寸应为 0–1000000，留空表示未知')
    tolerance = float(raw['validation'].get('ratioTolerancePct', 5))
    if not 1 <= tolerance <= 20:
        raise ValueError('实验比例误差阈值应为 1–20%')
    for k in ('yaw', 'pitch', 'roll'):
        if not -90 <= float(raw['view'].get(k, 0)) <= 90:
            raise ValueError('目标角度应在 -90° 到 90° 之间')
    return raw


def load_image(url, resolve):
    path = resolve(str(url or ''))
    if not path or not Path(path).is_file():
        raise ValueError('产品保真需要已保存的本地图片，请先将参考图导入画布')
    with Image.open(path) as image:
        if image.width * image.height > 32_000_000:
            raise ValueError('产品保真原图超过 3200 万像素，请先缩小副本')
        image.load()
        return ImageOps.exif_transpose(image).convert('RGBA')


def product_mask(source, config, resolve):
    if config.get('maskUrl'):
        uploaded = load_image(config['maskUrl'], resolve)
        if uploaded.size != source.size:
            raise ValueError('产品蒙版与原图尺寸不一致；请使用白色保护产品、黑色表示背景的同尺寸蒙版')
        mask = uploaded.convert('L')
    elif config.get('maskStrokes'):
        mask = Image.new('L', source.size, 0)
        draw = ImageDraw.Draw(mask)
        strokes = config['maskStrokes']
        if len(strokes) > 500:
            raise ValueError('蒙版笔画过多，请上传蒙版图片')
        for stroke in strokes:
            points = stroke.get('points', [])
            if len(points) > 2000:
                raise ValueError('单条蒙版笔画过长')
            coords = [(round(float(p[0]) * source.width), round(float(p[1]) * source.height)) for p in points]
            width = max(1, round(float(stroke.get('width', .03)) * min(source.size)))
            if not 1 <= width <= min(source.size):
                raise ValueError('蒙版画笔宽度无效')
            fill = 0 if stroke.get('erase') else 255
            if coords:
                draw.line(coords, fill=fill, width=width)
                for x, y in coords:
                    draw.ellipse((x-width/2, y-width/2, x+width/2, y+width/2), fill=fill)
    else:
        mask = source.getchannel('A')
        if mask.getextrema() == (255, 255):
            return None
    # An uploaded mask cannot make fully transparent source pixels opaque.
    mask = Image.fromarray(np.minimum(np.asarray(mask), np.asarray(source.getchannel('A'))).astype('uint8'))
    if not mask.getbbox():
        raise ValueError('产品蒙版为空，请画出需要保护的产品区域')
    return mask


def highpass(source, radius, gain=2):
    rgb = np.asarray(source.convert('RGB'), dtype=np.float32) / 255
    linear = np.where(rgb <= .04045, rgb / 12.92, ((rgb + .055) / 1.055) ** 2.4)
    # Pillow GaussianBlur requires integer channels; quantization is below
    # preview resolution. Float subtraction preserves negative frequencies.
    blur = np.asarray(Image.fromarray(np.round(linear * 255).astype('uint8')).filter(ImageFilter.GaussianBlur(radius)), dtype=np.float32) / 255
    quantized = np.round(linear * 255) / 255
    response = np.clip(.5 + float(gain) * (quantized - blur), 0, 1)
    response[np.asarray(source.getchannel('A')) == 0] = .5
    return Image.fromarray(np.round(response * 255).astype('uint8'), 'RGB')


def crop_box(roi, size):
    x, y, w, h = (float(roi.get(k, 0)) for k in ('x', 'y', 'w', 'h'))
    if not all(math.isfinite(v) for v in (x, y, w, h)) or min(x, y) < 0 or min(w, h) <= 0 or x+w > 1.00001 or y+h > 1.00001:
        raise ValueError('局部细节框超出原图，请重新框选')
    box = (round(x*size[0]), round(y*size[1]), round((x+w)*size[0]), round((y+h)*size[1]))
    if box[2] <= box[0] or box[3] <= box[1]:
        raise ValueError('局部细节框太小，请重新框选')
    return box


def detect_detail_rois(source, mask, count=2, exclusions=()):
    """Rank bounded texture windows; no semantic LOGO/OCR inference or upscaling."""
    if count <= 0:
        return []
    work = source.copy()
    work.thumbnail((768, 768), Image.Resampling.LANCZOS)
    width, height = work.size
    if min(width, height) < 24:
        return []
    region = (mask if mask is not None else source.getchannel('A')).resize(work.size, Image.Resampling.NEAREST)
    bbox = region.getbbox()
    if not bbox:
        return []
    # Exclude the alpha/mask seam from scoring, which otherwise dominates.
    gate = np.asarray(region.filter(ImageFilter.MinFilter(7))) >= 240
    gray = work.convert('L')
    energy = np.abs(np.asarray(gray, dtype=np.float32) - np.asarray(gray.filter(ImageFilter.GaussianBlur(2)), dtype=np.float32)) * gate
    if not gate.any() or float(energy.max()) < 2:
        return []
    integral = np.pad(energy.cumsum(0).cumsum(1), ((1, 0), (1, 0)))
    coverage = np.pad(gate.astype(np.int32).cumsum(0).cumsum(1), ((1, 0), (1, 0)))
    def total(array, x, y, w, h):
        return array[y+h, x+w] - array[y, x+w] - array[y+h, x] + array[y, x]
    def overlap(a, b):
        area = max(0, min(a['x']+a['w'], b['x']+b['w'])-max(a['x'], b['x'])) * max(0, min(a['y']+a['h'], b['y']+b['h'])-max(a['y'], b['y']))
        return area / max(1e-12, min(a['w']*a['h'], b['w']*b['h']))
    candidates = []
    for fraction in (.22, .34):
        w = min(width, max(24, round((bbox[2]-bbox[0])*fraction)))
        h = min(height, max(24, round((bbox[3]-bbox[1])*fraction)))
        xs = sorted(set(range(max(0, bbox[0]), min(width-w, bbox[2])+1, max(8, w//3))) | {max(0, min(width-w, bbox[2]-w))})
        ys = sorted(set(range(max(0, bbox[1]), min(height-h, bbox[3])+1, max(8, h//3))) | {max(0, min(height-h, bbox[3]-h))})
        for y in ys:
            for x in xs:
                pixels = int(total(coverage, x, y, w, h))
                if pixels < w*h*.6:
                    continue
                score = float(total(integral, x, y, w, h))/(w*h)
                if score < 1:
                    continue
                candidates.append((score, dict(x=x/width, y=y/height, w=w/width, h=h/height, source='auto')))
    selected = []
    for score, roi in sorted(candidates, key=lambda item: -item[0]):
        if any(overlap(roi, other) > .25 for other in [*exclusions, *selected]):
            continue
        selected.append(roi)
        if len(selected) >= min(3, count):
            break
    return selected


def perspective_proxy(ratio, view):
    """A simple planar target, not an inferred 3D reconstruction."""
    yaw, pitch, roll = [math.radians(float(view.get(k,0))) for k in ('yaw','pitch','roll')]
    if max(abs(math.degrees(yaw)),abs(math.degrees(pitch))) > 60:
        raise ValueError('平面透视代理只支持左右／俯仰 ±60°，更大角度请提供真实视角图')
    points = np.array([[-ratio/2,-.5,0],[ratio/2,-.5,0],[ratio/2,.5,0],[-ratio/2,.5,0]],dtype=float)
    y = np.array([[math.cos(yaw),0,math.sin(yaw)],[0,1,0],[-math.sin(yaw),0,math.cos(yaw)]])
    p = np.array([[1,0,0],[0,math.cos(pitch),-math.sin(pitch)],[0,math.sin(pitch),math.cos(pitch)]])
    r = np.array([[math.cos(roll),-math.sin(roll),0],[math.sin(roll),math.cos(roll),0],[0,0,1]])
    rotated = points@(r@p@y).T
    distance = max(3,ratio*2)
    xy = rotated[:,:2]*distance/(distance+rotated[:,2:3])
    xy = (xy-(xy.max(axis=0)+xy.min(axis=0))/2)*700/max(np.ptp(xy,axis=0))+512
    image = Image.new('RGB',(1024,1024),'white')
    draw = ImageDraw.Draw(image)
    polygon = [tuple(pt) for pt in xy]
    draw.polygon(polygon,fill='#d9dde1')
    draw.line(polygon+[polygon[0]],fill='#28343f',width=12)
    for i,(x,z) in enumerate(polygon):
        draw.ellipse((x-10,z-10,x+10,z+10),fill='#238d82')
        draw.text((x+12,z),str(i+1),fill='black')
    return image


def preprocess(refs, config, caps, resolve, save):
    config = normalize(config)
    if not config['enabled']:
        return None
    if not caps['supported']:
        raise ValueError('当前模型或渠道尚未验证产品保真参考图链路，请选择已接入的 GPT-Image 或 Gemini 图片模型')
    ids = [r.get('reference_id', '') for r in refs]
    if not all(ids) or len(set(ids)) != len(ids):
        raise ValueError('参考图身份缺失或重复，请在产品保真节点重新选择主图并更新处理结果')
    if any(not (path := resolve(str(r.get('url') or ''))) or not Path(path).is_file() for r in refs):
        raise ValueError('产品保真参考图必须先保存到本地；请导入远程图片，避免渠道遗漏参考图')
    selected = config.get('productReferenceId')
    if selected not in ids:
        raise ValueError('产品主参考图已移除或替换，请重新选择')
    source = load_image(refs[ids.index(selected)]['url'], resolve)
    mask = product_mask(source, config, resolve)
    if config['mode'] == 'strict' and mask is None:
        raise ValueError('严格保真需要透明产品 PNG、已有黑白蒙版或手动画蒙版；不能仅靠提示词保护产品')
    budget = caps['applicationReferenceLimit']
    if len(refs) > budget:
        raise ValueError(f'当前渠道产品保真最多提交 {budget} 张参考图；用户原图不会被丢弃，请减少参考图')
    warnings = []
    if not caps['channelVerified']:
        warnings.append('渠道能力未全部验证；参考图数量使用保守的应用限制，费用未知')
    if not caps['aliasVersionVerified']:
        warnings.append('该渠道使用 Nano Banana 别名；实际上游版本未确认，不将别名改写为官方型号')
    if caps['provider'] == 'google':
        warnings.append('Google 使用语义编辑；产品蒙版仅在本地合成使用，未上传为原生二值 mask')
        if 'lite' in str(caps['modelId']).lower():
            warnings.append('Lite 只生成 1K 背景；未针对多参考图优化，优先少量原始产品图')
    if config['mode'] == 'strict' and ids.index(selected) != 0:
        warnings.append('产品主图不是第一张：保持用户顺序，使用本地蒙版合成，不提交原生 mask')
    assets = []
    content_hash = hashlib.sha256(source.tobytes() + str(source.size).encode()).hexdigest()
    def asset(image, role, label, parameter):
        key = hashlib.sha256((content_hash + role + json.dumps(parameter, sort_keys=True)).encode()).hexdigest()
        url = save(image, 'fidelity_' + key + '.png', cached=True)
        item = dict(url=url, name=label, kind='image', role=role, reference_id=key,
                    parentReferenceId=selected, source='derived', width=image.width, height=image.height)
        assets.append(item)
        return item
    mask_asset = asset(mask, 'product-mask', '主体蒙版（白色保护）', config.get('maskStrokes', []) + [config.get('maskUrl', ''), hashlib.sha256(mask.tobytes()).hexdigest()]) if mask else None
    derived = []
    detail = config['detail']
    detected_rois = []
    if detail['enabled'] and detail['inputMode'] in {'highpass', 'combined'}:
        work = source.copy()
        work.thumbnail((1536, 1536), Image.Resampling.LANCZOS)
        derived.append(asset(highpass(work, float(detail['highPassRadiusPx']), float(detail['highPassGain'])), 'highpass', '高反差：灰图仅参考纹理边缘，非真实颜色', dict(radius=detail['highPassRadiusPx'], gain=detail['highPassGain'])))
    if detail['enabled'] and detail['inputMode'] in {'crops', 'combined'}:
        manual_rois = config.get('rois', [])[:int(detail['cropCount'])]
        # Validate manual regions before using them as automatic exclusions.
        for roi in manual_rois:
            crop_box(roi, source.size)
        if detail['autoCrops']:
            detected_rois = detect_detail_rois(source, mask, int(detail['cropCount'])-len(manual_rois), manual_rois)
            if detected_rois:
                warnings.append('自动裁切按本地纹理与边缘选区，不代表已识别 LOGO 或文字；请预览并人工确认')
                if mask is None:
                    warnings.append('缺少产品蒙版：自动选区可能包含背景，请画蒙版或改用手动 ROI')
            elif len(manual_rois) < int(detail['cropCount']):
                warnings.append('未找到可靠的高频细节候选区域；未添加自动裁切，请手动框选')
        for index, roi in enumerate([*manual_rois, *detected_rois]):
            box = crop_box(roi, source.size)
            derived.append(asset(source.crop(box), 'detail-crop', f'{"自动" if roi.get("source")=="auto" else "手动"}局部细节 {index+1}，原图归一化区域 {roi}', roi))
        if not manual_rois and not detail['autoCrops']:
            warnings.append('未框选局部区域：本次没有局部裁切参考，不进行自动猜测')
    if config['mode'] == 'view':
        warnings.append('目标角度由提示词表达；不可见面为 AI 推测，关闭旧视角高频回填和精确比例判定')
        if config['view'].get('proxyEnabled'):
            if config.get('geometry') != 'plane':
                warnings.append('当前几何不适用平面透视代理，已跳过；请提供真实多视角图')
            else:
                dimensions = config['dimensions']
                width,height = float(dimensions.get('width') or 0),float(dimensions.get('height') or 0)
                box = mask.getbbox() if mask else None
                ratio = width/height if width and height else (box[2]-box[0])/(box[3]-box[1]) if box else source.width/source.height
                if not width or not height:
                    warnings.append('透视代理使用参考图可见比例，不能代表真实三维尺寸')
                derived.insert(0, asset(perspective_proxy(ratio, config['view']), 'perspective-proxy', '平面目标透视示意：仅参考形状和方向，非产品真实颜色或隐藏面', dict(ratio=ratio,view=config['view'])))
    available = max(0, budget-len(refs))
    if len(derived) > available:
        warnings.append(f'参考图预算不足，仅附加 {available} 张辅助图；保留所有用户参考图')
        derived = derived[:available]
    ordered = [{**r, 'fidelity_reference': True} for r in refs] + [{**r, 'fidelity_reference': True} for r in derived]
    if len(ordered) > caps['preferredReferenceImages']:
        warnings.append(f'本次 {len(ordered)} 张图超过该型号建议数量 {caps["preferredReferenceImages"]}，不保证更多辅助图更有效')
    box = mask.getbbox() if mask else None
    dimensions = config['dimensions']
    physical_ratio = float(dimensions.get('width') or 0)/float(dimensions.get('height') or 1) if dimensions.get('width') and dimensions.get('height') else None
    return dict(config=config, source=source, mask=mask, reference_images=ordered,
                generatedAssets=assets, usedReferenceIds=[r['reference_id'] for r in ordered],
                detectedRois=detected_rois,
                modelCapabilities=caps, warnings=warnings,
                sourceRatio=physical_ratio or ((box[2]-box[0])/(box[3]-box[1]) if box else None),
                sourceCanvasRatio=source.width/source.height,
                productMask=mask_asset, bbox=list(mask.getbbox()) if mask else None,
                retryCount=0, costEstimate=None, appliedStrategy='local-pixel-composite' if config['mode']=='strict' else 'ordered-detail-references')


def prompt_for(prompt, context):
    config = context['config']
    lines = [prompt, '产品保真参考说明：']
    for i, ref in enumerate(context['reference_images'], 1):
        if ref['reference_id'] == config['productReferenceId']:
            role = '产品真实外观、比例、颜色和标识基准'
        elif ref.get('source') == 'derived':
            role = ref['name']
        else:
            role = '用户参考图，沿用其原有用途'
        lines.append(f'图片 {i}：{role}。')
    scopes = dict(background='仅改变背景，保持产品位置、尺寸、原视角和内部像素；在产品周围生成环境和接触阴影', lighting='允许改变背景和环境光', material='仅允许指定局部材质变化', view='允许受控视角变化')
    scope = config['generation'].get('allowedEdits', 'view' if config['mode']=='view' else 'lighting' if config['mode']=='structure' else 'background')
    if scope not in scopes:
        raise ValueError('允许变化范围无效')
    lines += [scopes[scope], '保持真实产品身份，不增删 LOGO、文字、接口或部件。']
    if config['mode'] == 'strict':
        lines.append('本次只输出环境背景与接触阴影：原产品将由本地蒙版回贴。产品原位置留出空位，不绘制另一个产品、边框或文字；参考图用于环境布局和接触阴影位置。')
    if config.get('dimensionNotes'):
        lines.append('用户提供的真实尺寸说明：' + str(config['dimensionNotes'])[:200])
    if any(config['dimensions'].get(k) for k in ('width','height','depth')):
        lines.append('用户提供的真实尺寸（未填写的维度未知）：' + json.dumps(config['dimensions'],ensure_ascii=False))
    for flag, instruction in dict(lockRatio='保持产品实体长宽比例', lockOutline='保持产品外轮廓', lockLines='保持真实直线、四角和矩形边界', lockSymmetry='保持已有对称结构', lockLayout='保持部件相对布局').items():
        if config['structure'].get(flag):
            lines.append(instruction + '（普通参考约束，不是模型原生控制参数）。')
    if config['mode'] == 'view':
        lines.append(f'目标视角 yaw={config["view"].get("yaw",0)}°、pitch={config["view"].get("pitch",0)}°、roll={config["view"].get("roll",0)}°；优先依据已有真实多视角图。')
    return '\n'.join(lines)


def planar_geometry(source_mask, target_rgb, transform, tolerance=5):
    """Experimental same-view rectangle comparison after reliable feature pose."""
    import cv2
    if source_mask is None:
        return dict(status='unknown', reason='缺少原图产品蒙版，无法确认外轮廓')
    contours,_ = cv2.findContours(np.asarray(source_mask),cv2.RETR_EXTERNAL,cv2.CHAIN_APPROX_SIMPLE)
    if not contours:
        return dict(status='unknown',reason='原图产品轮廓为空')
    outline = max(contours,key=cv2.contourArea)
    quad = cv2.approxPolyDP(outline, .015*cv2.arcLength(outline,True), True)
    if len(quad)!=4 or not cv2.isContourConvex(quad):
        return dict(status='unknown',reason='原图未可靠识别四角，不适用矩形比例检查')
    predicted = cv2.transform(quad.astype('float32'),transform)[:,0,:]
    area = cv2.contourArea(predicted)
    edges = cv2.Canny(cv2.cvtColor(target_rgb,cv2.COLOR_RGB2GRAY),60,150)
    outlines,_ = cv2.findContours(edges,cv2.RETR_LIST,cv2.CHAIN_APPROX_SIMPLE)
    candidates=[]
    for contour in outlines:
        actual=cv2.approxPolyDP(contour,.015*cv2.arcLength(contour,True),True)
        if len(actual)!=4 or not cv2.isContourConvex(actual) or not .6*area<cv2.contourArea(actual)<1.4*area:
            continue
        pts=actual[:,0,:].astype('float32')
        permutations=[np.roll(ordered,i,axis=0) for ordered in (pts,pts[::-1]) for i in range(4)]
        best=min(permutations,key=lambda candidate:np.linalg.norm(candidate-predicted,axis=1).mean())
        error=float(np.linalg.norm(best-predicted,axis=1).mean())
        candidates.append((error,best))
    candidates.sort(key=lambda candidate:candidate[0])
    diagonal=math.sqrt(area)
    if not candidates or candidates[0][0]>.12*diagonal:
        return dict(status='unknown',reason='输出未可靠识别对应外框四角')
    # Edge thickness yields near-duplicate contours, which share the same
    # geometry; larger competing rectangles are genuinely ambiguous.
    best_error,actual=candidates[0]
    if len(candidates)>1 and candidates[1][0]-best_error<.01*diagonal and np.linalg.norm(candidates[1][1]-actual,axis=1).mean()>.02*diagonal:
        return dict(status='unknown',reason='输出有多个候选外框，需人工确认产品区域')
    expected_lengths=np.linalg.norm(np.roll(predicted,-1,axis=0)-predicted,axis=1)
    actual_lengths=np.linalg.norm(np.roll(actual,-1,axis=0)-actual,axis=1)
    relative=actual_lengths/np.maximum(expected_lengths,1)
    deviation=float((relative.max()/relative.min()-1)*100)
    return dict(status='failed' if deviation>tolerance else 'warning',
                scope='实验性同视角四角与边长一致性，不代表三维实测比例或 OCR 校验',
                edgeRatioDeviationPct=round(deviation,2),meanCornerErrorPx=round(best_error,2),
                sourceCorners=quad[:,0,:].tolist(),outputCorners=actual.tolist(),ratioTolerancePct=tolerance)


def report(context):
    return {k:context[k] for k in ('generatedAssets', 'usedReferenceIds', 'modelCapabilities', 'warnings', 'sourceRatio', 'sourceCanvasRatio', 'bbox', 'retryCount', 'costEstimate', 'appliedStrategy', 'detectedRois')}


def composite(source, mask, background, feather=0):
    # Output adopts the source canvas, so there is no anisotropic product warp.
    if abs(background.width/background.height/(source.width/source.height)-1) > .03:
        raise ValueError('模型输出与原图画幅比例偏差超过 3%，已停止严格合成；请选择原图比例或兼容该比例的模型')
    background = background.convert('RGBA').resize(source.size, Image.Resampling.LANCZOS)
    if not 0 <= float(feather) <= 8:
        raise ValueError('蒙版羽化应为 0–8px')
    # Feather inward; it may never reveal product pixels outside the mask.
    softened = mask.filter(ImageFilter.GaussianBlur(float(feather))) if feather else mask
    blend = Image.fromarray(np.minimum(np.asarray(softened), np.asarray(mask)).astype('uint8'))
    output = Image.composite(source.convert('RGB'), background.convert('RGB'), blend).convert('RGBA')
    core = np.asarray(blend) == 255
    count = int(core.sum())
    if not count:
        raise ValueError('蒙版没有完全不透明的核心保护像素，无法验收严格保真；请调整蒙版或羽化')
    difference = np.abs(np.asarray(output.convert('RGB'), dtype=np.int16)[core] - np.asarray(source.convert('RGB'), dtype=np.int16)[core])
    error = int(difference.max())
    if error:
        raise ValueError('产品核心像素保护校验失败')
    return output, dict(status='passed', scope='本地合成核心 RGB 像素；不代表语义/OCR 或透明边缘融合已通过', protectedPixels=count, maxPixelError=error)


def align_details(source, generated, mask, config):
    """Conservative planar same-view matching. Failure always skips restoration."""
    validation = dict(status='unknown', reason='缺少可靠的产品定位，不能判定几何、LOGO 或文字是否一致', restoration='skipped')
    if config['mode'] == 'view' or config['view'].get('mode', 'keep') != 'keep':
        validation['reason'] = '视角变化：不执行旧视角高频回填，不用外接框比例判畸变'
        return generated, validation
    if config.get('geometry') not in {'plane', 'box'}:
        validation['reason'] = '仅对同视角平面商品或盒体可见平面进行实验对齐；其他几何暂未能判断'
        return generated, validation
    try:
        import cv2
    except ImportError:
        validation['reason'] = '当前环境未安装可选 OpenCV；跳过特征对齐和自动细节恢复'
        return generated, validation
    src = np.asarray(source.convert('RGB'))
    dst = np.asarray(generated.convert('RGB'))
    scale = min(1, 1400/max(source.size))
    dscale = min(1, 1400/max(generated.size))
    small = cv2.resize(src, None, fx=scale, fy=scale)
    target = cv2.resize(dst, None, fx=dscale, fy=dscale)
    smask = cv2.resize(np.asarray(mask), (small.shape[1], small.shape[0]), interpolation=cv2.INTER_NEAREST) if mask else None
    orb = cv2.ORB_create(1800)
    a, da = orb.detectAndCompute(cv2.cvtColor(small, cv2.COLOR_RGB2GRAY), smask)
    b, db = orb.detectAndCompute(cv2.cvtColor(target, cv2.COLOR_RGB2GRAY), None)
    if da is None or db is None or len(a) < 12 or len(b) < 12:
        return generated, validation
    pairs = cv2.BFMatcher(cv2.NORM_HAMMING).knnMatch(da, db, k=2)
    matches = [p[0] for p in pairs if len(p)==2 and p[0].distance < .7*p[1].distance]
    if len(matches) < 16:
        return generated, validation
    p = np.float32([a[m.queryIdx].pt for m in matches])/scale
    q = np.float32([b[m.trainIdx].pt for m in matches])/dscale
    transform, inliers = cv2.estimateAffinePartial2D(p, q, method=cv2.RANSAC, ransacReprojThreshold=3/dscale)
    if transform is None or inliers is None:
        return generated, validation
    keep = inliers.ravel().astype(bool)
    confidence = float(keep.mean())
    spread = np.ptp(p[keep], axis=0)/np.array(source.size)
    angle = abs(math.degrees(math.atan2(transform[1,0], transform[0,0])))
    threshold = float(config.get('alignmentThreshold', .85))
    if not .7 <= threshold <= 1:
        raise ValueError('对齐阈值应为 0.7–1')
    validation.update(alignmentConfidence=confidence, matchedPoints=int(keep.sum()))
    if confidence < threshold or keep.sum() < 16 or min(spread) < .3 or angle > 8:
        validation['reason'] = '匹配置信度、覆盖区域或角度不足，禁止自动回填'
        return generated, validation
    predicted = cv2.transform(p[keep,None,:], transform)[:,0,:]
    residual = float(np.median(np.linalg.norm(predicted-q[keep],axis=1)))
    if residual*dscale > 2:
        validation['reason'] = '对齐残差过大，禁止自动回填'
        return generated, validation
    warped = cv2.warpAffine(src.astype('float32')/255, transform, generated.size)
    warped_mask = cv2.warpAffine(np.asarray(mask) if mask else np.full(src.shape[:2],255,'uint8'), transform, generated.size)
    support = cv2.erode(warped_mask, np.ones((7,7),'uint8')).astype('float32')/255
    feather = float(config.get('maskFeatherPx', 0))
    if feather:
        support = np.minimum(support, cv2.GaussianBlur(support, (0,0), feather))
    validation.update(status='warning', reason='同视角平面特征对齐可靠；语义、OCR、完整轮廓和精确比例仍需人工复核', medianResidualPx=residual)
    geometry = planar_geometry(mask,dst,transform,float(config['validation'].get('ratioTolerancePct',5)))
    validation['geometry'] = geometry
    if geometry['status']=='failed':
        validation.update(status='failed',reason='实验外框检查发现边长相对变化，已跳过细节恢复；请核对原图与输出')
        return generated,validation
    if config['detail']['enabled'] and config['detail']['restoreMode'] == 'auto' and mask is not None:
        radius = float(config['detail']['highPassRadiusPx']) * math.hypot(transform[0,0],transform[1,0])
        high = warped-cv2.GaussianBlur(warped, (0,0), max(.5,radius))
        restored = np.clip(dst.astype('float32')/255 + float(config['detail']['restoreStrength'])*support[:,:,None]*high,0,1)
        validation['restoration'] = 'applied'
        return Image.fromarray(np.round(restored*255).astype('uint8')).convert('RGBA'), validation
    if config['detail']['restoreMode'] == 'auto' and mask is None:
        validation['reason'] += '；没有产品蒙版，已跳过细节恢复'
    return generated, validation
