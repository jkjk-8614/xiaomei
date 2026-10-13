"""Physical dimensions are millimetres; display units and image size are independent."""
import copy
import hashlib
import json
import math
from decimal import Decimal, InvalidOperation
from fractions import Fraction

UNIT_FACTORS = {'mm': 1, 'cm': 10, 'm': 1000, 'in': 25.4}
SHAPES = {'rectangle', 'cuboid', 'circle'}


def _number(value):
    if value is None or value == '':
        return None
    try:
        if isinstance(value, bool):
            raise ValueError()
        result = Decimal(str(value))
        if not result.is_finite():
            raise ValueError()
        return result
    except (InvalidOperation, ValueError):
        raise ValueError('尺寸必须是有限数字，未知尺寸请留空') from None


def convertToMillimeters(value, unit):
    if unit not in UNIT_FACTORS:
        raise ValueError('尺寸单位仅支持 mm、cm、m、in')
    value = _number(value)
    return None if value is None else float(value * Decimal(str(UNIT_FACTORS[unit])))


def convertFromMillimeters(value, unit):
    if unit not in UNIT_FACTORS:
        raise ValueError('尺寸单位仅支持 mm、cm、m、in')
    value = _number(value)
    return None if value is None else float(value / Decimal(str(UNIT_FACTORS[unit])))


def calculateAspectRatio(width, height):
    w, h = _number(width), _number(height)
    if w is None or h is None or w <= 0 or h <= 0:
        return None
    ratio = Fraction(w) / Fraction(h)
    return dict(value=float(ratio), label=f'{ratio.numerator}:{ratio.denominator}')


def calculateThicknessRatio(width, height, depth):
    values = [_number(v) for v in (width, height, depth)]
    if any(v is None or v <= 0 for v in values):
        return None
    w, h, d = values
    return dict(depthToWidth=float(d/w), depthToHeight=float(d/h))


def dimension_defaults():
    return dict(version=2, enabled=False, width=None, height=None, depth=None, unit='cm',
                shape='rectangle', constraintMode='prompt', aspectRatioLock=True,
                thicknessLock=True, outlineLock=True, guideAssetId=None,
                validationSettings=dict(enabled=True, tolerancePct=3))


def migrate_dimensions(raw, geometry='plane'):
    raw = copy.deepcopy(raw or {})
    result = dimension_defaults()
    if raw.get('version', 1) == 1:
        # Legacy projects explicitly used zero for unknown; only that format is migrated.
        for key in ('width', 'height', 'depth'):
            value = raw.get(key)
            result[key] = None if value in (None, '', 0, '0') else convertToMillimeters(value, raw.get('unit', 'cm'))
        result['unit'] = raw.get('unit', 'cm')
        result['shape'] = {'plane': 'rectangle', 'box': 'cuboid', 'circle': 'circle'}.get(geometry, 'rectangle')
        result['enabled'] = False
    elif raw['version'] == 2:
        result.update(raw)
        for key in ('width', 'height', 'depth'):
            value = _number(result[key])
            result[key] = None if value is None else float(value)
        result['validationSettings'] = {**dimension_defaults()['validationSettings'], **raw.get('validationSettings', {})}
    else:
        raise ValueError('真实尺寸配置版本暂不支持，请更新小美画布')
    return result


def validatePhysicalDimensions(data):
    errors = []
    if data.get('unit') not in UNIT_FACTORS:
        errors.append('尺寸单位仅支持 mm、cm、m、in')
    if data.get('shape') not in SHAPES:
        errors.append('尺寸结构图仅支持矩形、长方体和圆形平面')
    if data.get('constraintMode') not in {'prompt', 'guide', 'protect'}:
        errors.append('约束方式仅支持 Prompt、Guide、Protect')
    for key, label in [('width', '宽度'), ('height', '高度'), ('depth', '厚度')]:
        try:
            value = _number(data.get(key))
            if value is not None and (value <= 0 or value > 1e9):
                errors.append(f'{label}必须大于 0 且不超过 10亿 mm；未知请留空')
            elif value is None and data.get('enabled') and key != 'depth':
                errors.append(f'启用尺寸约束时请填写{label}')
        except ValueError:
            errors.append(f'{label}必须是有限数字，未知请留空')
    if not errors and data.get('enabled') and data.get('shape') == 'circle' and data.get('width') is not None and data.get('height') is not None:
        if not math.isclose(float(data['width']), float(data['height']), rel_tol=1e-10):
            errors.append('圆形平面的宽和高均表示直径，必须相同；厚度为垂直圆面的轴向深度')
    settings = data.get('validationSettings', {})
    try:
        tolerance = float(settings.get('tolerancePct', 3))
        if not math.isfinite(tolerance) or not .1 <= tolerance <= 20:
            raise ValueError()
    except (TypeError, ValueError):
        errors.append('比例误差提示阈值应为 0.1–20%')
    return dict(valid=not errors, errors=errors)


def buildNormalizedDimensions(data):
    result = validatePhysicalDimensions(data)
    if not result['valid']:
        raise ValueError('；'.join(result['errors']))
    return dict(width=data.get('width'), height=data.get('height'), depth=data.get('depth'),
                unit='mm', shape=data['shape'], aspectRatio=calculateAspectRatio(data.get('width'), data.get('height')),
                thicknessRatio=calculateThicknessRatio(data.get('width'), data.get('height'), data.get('depth')))


def dimension_signature(data):
    keys = ('width', 'height', 'depth', 'shape', 'aspectRatioLock', 'thicknessLock', 'outlineLock')
    return hashlib.sha256(json.dumps({k: data.get(k) for k in keys}, sort_keys=True).encode()).hexdigest()


class GeometryGuideGenerator:
    """Generate SVG geometry and rasterize its limited primitive subset for APIs."""
    @staticmethod
    def primitives(data):
        dims = buildNormalizedDimensions(data)
        w, h, d = (dims[k] for k in ('width', 'height', 'depth'))
        if not w or not h:
            raise ValueError('结构图需要有效宽度和高度')
        # All three panels share one uniform scale, including the depth axis.
        scale = min(230/max((w+(d or 0))*.866, d or 0, w), 260/(h+(w+(d or 0))*.5))
        w, h, d = w*scale, h*scale, None if d is None else d*scale
        shapes = []
        def polygon(points, fill='#e3e7eb'):
            shapes.append(dict(type='polygon', points=points, fill=fill))
        for center in (160, 800):
            x, y = center-w/2, 180-h/2
            if center == 800:
                if dims['shape']=='circle':
                    continue
                x, y = center-(w+(d or 0))*.866/2, 180-(h+w*.5)/2+(d or 0)*.25
                front = [(x,y),(x+w*.866,y+w*.5),(x+w*.866,y+w*.5+h),(x,y+h)]
                polygon(front)
                if d is not None:
                    dx,dy=d*.866,-d*.5
                    polygon([front[0],(x+dx,y+dy),(x+w*.866+dx,y+w*.5+dy),front[1]], '#f1f3f5')
                    polygon([front[1],(front[1][0]+dx,front[1][1]+dy),(front[2][0]+dx,front[2][1]+dy),front[2]], '#bfc8d0')
                continue
            if dims['shape'] == 'circle':
                shapes.append(dict(type='ellipse', box=[x, y, x+w, y+h], fill='#e3e7eb'))
            else:
                polygon([(x,y),(x+w,y),(x+w,y+h),(x,y+h)])
        if d is not None:
            x, y = 480-d/2, 180-h/2
            polygon([(x,y),(x+d,y),(x+d,y+h),(x,y+h)])
        return shapes

    @classmethod
    def svg(cls, data):
        parts = ['<svg xmlns="http://www.w3.org/2000/svg" width="960" height="360" viewBox="0 0 960 360"><rect width="960" height="360" fill="white"/>']
        for item in cls.primitives(data):
            if item['type'] == 'polygon':
                coords = ' '.join(f'{x:.6f},{y:.6f}' for x,y in item['points'])
                parts.append(f'<polygon points="{coords}" fill="{item["fill"]}" stroke="#25333f" stroke-width="2"/>')
            else:
                x,y,r,b = item['box']
                parts.append(f'<ellipse cx="{(x+r)/2}" cy="{(y+b)/2}" rx="{(r-x)/2}" ry="{(b-y)/2}" fill="{item["fill"]}" stroke="#25333f" stroke-width="2"/>')
        return ''.join(parts)+'</svg>'

    @classmethod
    def image(cls, data):
        from PIL import Image, ImageDraw
        from xml.etree import ElementTree
        image = Image.new('RGB', (960, 360), 'white')
        draw = ImageDraw.Draw(image)
        # The SVG is generated above, not supplied by an external document.
        # Only its polygon and ellipse primitives need a raster transport.
        for element in ElementTree.fromstring(cls.svg(data)):
            tag = element.tag.rsplit('}',1)[-1]
            if tag == 'polygon':
                points = [tuple(map(float,point.split(','))) for point in element.attrib['points'].split()]
                draw.polygon(points, fill=element.attrib['fill'])
                draw.line(points+[points[0]], fill=element.attrib['stroke'], width=2)
            elif tag == 'ellipse':
                x,y,rx,ry = [float(element.attrib[k]) for k in ('cx','cy','rx','ry')]
                draw.ellipse((x-rx,y-ry,x+rx,y+ry), fill=element.attrib['fill'], outline=element.attrib['stroke'], width=2)
        return image


def compile_dimension_prompt(data):
    dims = buildNormalizedDimensions(data)
    labels = ('正面直径', '正面直径（相同轴长）', '垂直圆面的轴向厚度') if data['shape']=='circle' else ('正面宽', '正面高', '前后厚度')
    if not data['enabled'] and not any(dims[key] is not None for key in ('width','height','depth')):
        return []
    lines = ['用户提供的产品物理尺寸：'+ '；'.join(f'{label}={dims[key]} mm' if dims[key] is not None else f'{label}=未知' for key,label in zip(('width','height','depth'),labels))]
    if not data['enabled']:
        return lines
    if data['aspectRatioLock']:
        lines.append(f'锁定产品正面宽高比 {dims["aspectRatio"]["label"]}；该比例仅作用于产品，不改变输出画布比例。')
    if data['thicknessLock'] and dims['thicknessRatio']:
        lines.append('保持前后厚度相对正面宽、高的比例：'+json.dumps(dims['thicknessRatio']))
    if data['outlineLock']:
        lines.append('保持产品原有外轮廓与几何形状。')
    lines.append('几何代理只说明尺寸与轮廓；原产品参考图负责外观、颜色、纹理和细节。物理尺寸是应用约束，不是模型原生参数。')
    return lines
