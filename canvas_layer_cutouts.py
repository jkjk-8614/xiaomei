"""Source-pixel cutouts and masked completion for canvas image layers."""
import asyncio
import math
import re

import numpy as np
from fastapi import HTTPException
from PIL import Image, ImageChops, ImageDraw, ImageFilter, ImageOps


PLAN_INSTRUCTIONS = """
本次使用原图抠取加遮挡补齐，不重新绘制可见内容。layers 必须从底到顶排序。
每层额外返回 extraction（background/local/color）、regions、occluded_by。
背景 extraction=background，regions=[]，occluded_by 列出全部前景层编号。
产品/人物/照片主体 extraction=local：regions 是本层的一个或多个紧贴元素的多边形区域，
本地抠图模型在区域包围框内识别可见主体。多边形应容纳完整可见轮廓和少许边缘，不要用粗略形状剪掉主体。
普通文字、标识和彩色装饰 extraction=color：逐区域给出原图真实前景 colors（#RRGGBB 数组）和 tolerance（15到100）。
文字层必须用 color，不用通用主体抠图模型 local（会漏掉小字）。描边、阴影、多色文字使用多个前景 colors；渐变用多个代表色。
文字区域逐段圈出全部标题、两侧文案、标识、小字，避开相同颜色的商品，不能遗漏侧边文字，不能把整张图都列为一个文字区域。
颜色选择不可包含本层后面的背景色。细线烟花和彩纸逐种颜色/区域提取，不能使用 local，否则细装饰会漏掉。
每个装饰元素单独圈紧，禁止用顶部整条、左右宽条等范围圈装饰：它们会把同色文字一起抠走。文字与装饰区域不得覆盖对方。
商品上的包装文字、瓶身标签归商品本身，不另抠；完整可见的商品不因为旁边有文案就设为被遮挡。
regions 格式 [{"polygon":[[x,y],[x,y],[x,y]],"colors":["#FFF0C5"],"tolerance":55}]。
polygon 至少3个顶点，所有坐标是原图坐标归一化0..1000的[x,y]。
occluded_by 只列实际遮挡本层的更上方图层ID；完整可见、无需补齐的文字/产品设为空数组。
需要补齐的层还必须给 repair_regions，格式为多边形数组 [[[x,y],...]]，只圈本层被遮住、移走遮挡物后应露出的区域。
背景 repair_regions=[]，程序用全部前景的实际蒙版作为背景缺口。
必须区分：文字本身要抠出来；移走文字后它挡住的产品/背景属于下层，要在下层补齐。
不要凭空扩大遮挡范围。每层的 prompt 描述补齐缺失内容，明确保留可见文字、材质、透视和结构。
"""


def validate_cutout_plan(plan, layers):
    if plan.get('bbox_format') != 'xyxy':
        raise ValueError('抠图规划必须明确使用 xyxy 坐标，请重新分析')
    def polygon_valid(polygon):
        if not isinstance(polygon, list) or not 3 <= len(polygon) <= 80:
            return False
        if not all(isinstance(p, list) and len(p) == 2 and all(type(v) in (int,float) and math.isfinite(v) and 0 <= v <= 1000 for v in p) for p in polygon):
            return False
        return abs(sum(a[0]*b[1]-b[0]*a[1] for a,b in zip(polygon, polygon[1:]+polygon[:1]))) > 1
    for i, layer in enumerate(layers):
        mode = layer.get('extraction')
        if (i == 0 and mode != 'background') or (i > 0 and mode not in ('local','color')):
            raise ValueError('缺少原图抠取方法，请重新分析；不会改为重画整层')
        if layer.get('kind') == 'text' and mode != 'color':
            raise ValueError('文字层缺少颜色提取规划，请重新分析，避免通用抠图模型漏字')
        regions = layer.get('regions')
        if not isinstance(regions,list) or len(regions) > 30 or (i > 0 and not regions):
            raise ValueError('缺少有效的抠图区域，请重新分析')
        for region in regions:
            if not isinstance(region,dict) or not polygon_valid(region.get('polygon')):
                raise ValueError('抠图区域坐标无效，请重新分析')
            if mode == 'color':
                colors = region.get('colors')
                tolerance = region.get('tolerance')
                if not isinstance(colors,list) or not 1 <= len(colors) <= 12 or not all(isinstance(c,str) and re.fullmatch(r'#[0-9a-fA-F]{6}',c) for c in colors):
                    raise ValueError('文字或装饰缺少原图颜色，请重新分析')
                if type(tolerance) not in (int,float) or not 15 <= tolerance <= 100:
                    raise ValueError('抠图颜色容差无效，请重新分析')
        occluders = layer.get('occluded_by')
        upper = {x['id'] for x in layers[i+1:]}
        if not isinstance(occluders,list) or len(occluders)!=len(set(occluders)) or any(identity not in upper for identity in occluders):
            raise ValueError('遮挡关系必须指向上方图层，请重新分析')
        repairs = layer.get('repair_regions',[])
        if not isinstance(repairs,list) or len(repairs)>30 or not all(polygon_valid(p) for p in repairs):
            raise ValueError('补齐区域无效，请重新分析')
        if i > 0 and occluders and not repairs:
            raise ValueError('被遮挡的图层缺少补齐区域，请重新分析')
        if i == 0:
            layer['occluded_by'] = [x['id'] for x in layers[1:]]


def polygon_mask(size, polygons):
    mask = Image.new('L',size)
    draw = ImageDraw.Draw(mask)
    for polygon in polygons:
        draw.polygon([(round(x*size[0]/1000),round(y*size[1]/1000)) for x,y in polygon],fill=255)
    return mask


def color_mask(source, region):
    rgb = np.asarray(source.convert('RGB')).astype(np.float32)
    distance = np.full(rgb.shape[:2],255.,dtype=np.float32)
    for color in region['colors']:
        target = np.array([int(color[i:i+2],16) for i in (1,3,5)],dtype=np.float32)
        distance = np.minimum(distance,np.max(np.abs(rgb-target),axis=2))
    tolerance = region['tolerance']
    # Keep RGB from the source; soften only the narrow threshold boundary.
    feather = max(4,tolerance*.15)
    alpha = np.clip((tolerance+feather-distance)/feather,0,1)*255
    mask = Image.fromarray(alpha.astype('uint8'))
    return ImageChops.multiply(mask,polygon_mask(source.size,[region['polygon']]))


async def prepare_cutouts(service, job):
    if job.get('cutouts_ready'):
        return
    directory = service.output / job['id']
    size = (job['width'],job['height'])
    with Image.open(service.source_path(job['source_url'])) as opened:
        source = ImageOps.exif_transpose(opened).convert('RGBA').resize(size,Image.Resampling.LANCZOS)
    masks = {}
    occupied = Image.new('L',size)
    model = model_path = None
    for layer in reversed(job['layers'][1:]):
        service.checkpoint(job,'从原图抠取：'+layer['name'])
        mask = Image.new('L',size)
        for index, region in enumerate(layer['regions']):
            if layer['extraction']=='color':
                part = await asyncio.to_thread(color_mask,source,region)
            else:
                if model is None:
                    try:
                        model,model_path = await service.host._ready_background_removal_model()
                    except (HTTPException, AttributeError) as error:
                        raise ValueError('本地抠图模型未就绪，请先在“去背景”中准备模型，再继续分层') from error
                region_mask = polygon_mask(size,[region['polygon']])
                bounds = region_mask.getbbox()
                crop_path = directory/f"{layer['id']}-crop-{index}.png"
                source.crop(bounds).save(crop_path)
                extracted, _ = await asyncio.to_thread(service.host._remove_background_image_from_path,str(crop_path),model,model_path,False)
                try:
                    if extracted.size != (bounds[2]-bounds[0],bounds[3]-bounds[1]):
                        raise ValueError('本地抠图尺寸发生变化，已停止以保留原图位置')
                    part = Image.new('L',size)
                    part.paste(extracted.getchannel('A'),bounds[:2])
                    part = ImageChops.multiply(part,region_mask)
                finally:
                    extracted.close()
            mask = ImageChops.lighter(mask,part)
        mask = ImageChops.multiply(mask,ImageChops.invert(occupied))
        mask = ImageChops.multiply(mask,source.getchannel('A'))
        if mask.getbbox() is None or sum(mask.histogram()[32:]) < 4:
            raise ValueError('“'+layer['name']+'”没有抠出有效内容，请重新分层调整识别区域；不会自动重画该层')
        masks[layer['id']] = mask
        occupied = ImageChops.lighter(occupied,mask)
    masks[job['layers'][0]['id']] = ImageChops.invert(occupied)
    for i, layer in enumerate(job['layers']):
        mask = masks[layer['id']]
        cutout = source.copy();cutout.putalpha(mask)
        cutout_name = f"{layer['id']}-source-cutout.png"
        cutout.save(directory/cutout_name)
        hole = Image.new('L',size)
        for identity in layer['occluded_by']:
            hole = ImageChops.lighter(hole,masks[identity])
        if i > 0:
            hole = ImageChops.multiply(hole,polygon_mask(size,layer.get('repair_regions',[])))
            # AI may only write where this layer has no retained source pixels.
            hole = ImageChops.multiply(hole,mask.point(lambda value: 0 if value else 255))
        else:
            hole = hole.point(lambda value:255 if value>4 else 0).filter(ImageFilter.MaxFilter(5))
        hole_name=f"{layer['id']}-repair-mask.png";hole.save(directory/hole_name)
        layer.update(cutout_url=f"/output/image-layers/{job['id']}/{cutout_name}",
                     repair_mask_url=f"/output/image-layers/{job['id']}/{hole_name}",
                     source_locked=True, needs_fill=hole.getbbox() is not None,
                     method_label='原图抠取 + AI 补齐' if hole.getbbox() else '原图抠取')
    job['cutouts_ready']=True
    service.save(job)


def merge_completion(service, job, layer, generated):
    with Image.open(service.source_path(layer['cutout_url'])) as opened:
        cutout = opened.convert('RGBA')
    with Image.open(service.source_path(layer['repair_mask_url'])) as opened:
        hole = opened.convert('L')
    if abs(math.log((generated.width/generated.height)/(cutout.width/cutout.height))) > .02:
        raise ValueError('补齐图比例与原图不同，已保留原图抠取结果，请重试补齐')
    generated = generated.resize(cutout.size,Image.Resampling.LANCZOS)
    if not layer['transparent']:
        # The visible background must stay opaque, including outside the repair mask.
        with Image.open(service.source_path(job['source_url'])) as opened:
            cutout = ImageOps.exif_transpose(opened).convert('RGBA').resize(cutout.size,Image.Resampling.LANCZOS)
        generated.putalpha(255)
    return Image.composite(generated,cutout,hole)
