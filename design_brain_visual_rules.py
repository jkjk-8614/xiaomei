"""电商视觉规范、SKU 文字模板与外观款式规则。"""
from __future__ import annotations

import io
import json
import math
import os
import re
from pathlib import Path


ECOMMERCE_RULES = """小美的电商视觉规范（本软件的默认设计标准）：
一、主图完整一组固定5张，第1张用于测点击率，其余4张是提升转化的展示图，统一风格、配色与产品机位。第1张1:1；第2至5张默认2:3营销长图，以比例为准，不把750×1000误称为2:3。产品约70%、文案约30%，3秒内看懂，手机缩略图仍清楚，拒绝模糊、脏乱、粗糙素材。
设计五步：定位市场与人群→分析同类TOP竞对并跨类目找思路→精简文案→用场景化、数据化、细节特写、促销氛围可视化卖点→在文案、产品表现与背景上创新。先说消费者得到的利益，再说产品特点。文案类型可按产品选择促销、情感、理想效果、对比、风险提醒、专业、卖点、夸张修辞或创意，不编造事实或恐吓用户。
差异化四步：分析搜索环境TOP10直接竞对的风格/边框/产品摆放/场景/配色→统计少数项→每张可收集20至50张参考学习→自主创新、做减法；未实际读取竞对或参考时注明资料待补，不能编造已调研数量或结论。
七天测图是独立于5张正式主图的运营实验：第1天上4张创意、测1天、再做2张；第2至5天每天09:00换掉点击率最低的2张并再做2张；第6天09:00再换最差2张；第7天把4张创意统一为点击率最高的那张，选为正式第1张。前三天测热度与背景、后三天测文案；一次只变一个变量。这里只提供测图方案，不伪称已上传广告或获得CTR数据，不自动创建排期。没有展现量/点击量/CTR就标待测；这些是用户的设计经验，不保证转化率提升。
二、SKU数量无上限，按真实SKU逐一规划，不为了凑数编造SKU。仅替换数据参数、赠品、属性名称时，共用同一底图加固定文字位，其余像素不变。用户明确要求不同框色、产品颜色、照片组合或内芯图案时，按外观款式逐张规划和生成，只改变用户指定的外观内容；统一背景场景、光感、装裱工艺、机位、角度、大小比例、版式和品牌。未指定的外观变化不能擅自添加。
三、详情页屏数和总长度无上限，一般每屏9:16、整页同宽纵向连贯；第1屏展示商品，第2屏卖点，第3屏好处与特性，第4屏强视觉抓回注意力，之后反复强化核心卖点。前三屏放消费者最关心的利益点，完成后回查前三个卖点是否通顺、有无矛盾；每屏围绕一个主题，不平均用力。
详情排版按750宽参考稿同比缩放：首屏约1200px；主标题至少48px、优先60px以上，参考60至70pt；副标题至少24px、参考40至50pt；正文手机至少25pt、PC至少18pt，参考25至30pt。行距为字号高度加10px，主标题字距紧凑可为负、副标题0或正整数，两行间距不超过字高。所有标题字号与间距一致，中西文分开调字级、优先偶数字号。主副标题相隔半字高，副标题与正文隔一字高或加间距。
三三原则：字体、设计主辅色、逻辑、排版各不超过3种。商品实色及照片素材中的自然颜色不计入设计配色，不得为了凑三色改变商品或照片。通栏约150px、底栏120至130px；侧边距参考40至70px且必须大于20px，手机参考左右40px内、避免超过80px；屏间间隔不超过160px。主标题4至8字，副标题15字内。文字不用纯黑。
FABE按本用户定义：F/A为属性功能与优势，结合需求情景；B为消费者好处/结果；E为情感吸引力。卖点按1级核心至4级辅助排序，文案公式A+B、A+E、E，最大好处进标题。
卖点从原料（地域/时间/历史/气候）、工艺（配方/标准/工序/人工）、设计（设计师/奖项/专利/风格/人群）、功效、价格（性价比/赠品/促销）、服务（售后/质保/安装/物流）、工厂（研发/供应链）、品牌（资历/荣誉）八维提炼；仅使用已提供的真实证据，不虚构功效、认证、促销、专利或数据。
人群画像九维：性别、年龄、学历、收入、地域、兴趣、职业、生活行为、消费者类型（价格诱导/冲动/日常/高端）；未知项标待确认，不臆造个人属性。
配色简单干净，避免大面积高饱和或分散注意的渐变；高饱和点缀配低饱和底色，同类产品色相协调，用边框或边角图标适度吸引注意。使用明确HEX/RGB/HSB值统一整组主辅色，深浅冷暖搭配可参考灰蓝+浅米、深青绿+米黄、深墨+酒红。
质检须检查各图用途、前三屏顺序、缩略图可读性、字号层级、三三原则、标题长度、配色、商品真实性、品牌标识与SKU模板一致性。看不清文字或无法从位图测定字体/字号时标needs_human，不能假装测量通过。"""

SKU_RULES = """电商 SKU 规则：按用户实际要求选择文字模板或外观款式。
仅替换数据参数、赠品、属性名称时使用series_mode=sku：固定版式、背景、配色、产品造型、机位、角度、大小比例、字体字号、文案位置、品牌标识。
文字模板共用一张无可变文字的底图；sku_scene描述完整底图，sku_layout指定固定信息位，shots[].sku_values只填parameters/gifts/attributes三个字符串。文字色与信息位底色必须复用visual_framework.palette中的颜色，合计不超过3种。
明确要求不同框色、产品颜色、照片组合或内芯图案时使用series_mode=sku_variants：sku_scene描述共同场景和工艺，shots[].sku_variant描述本款的框色、照片来源与组合等已要求变化，prompt写本款完整生成要求。逐款生图，后续款引用首张场景基准；不创建三个文字信息位，不以排字代替换照片。设计palette仅记录统一的1至3种主辅色，不把真实商品和照片色彩加进来。
参数、赠品、属性名须来自用户提供的商品事实，不编造、不为凑张数发明SKU。数量未知或SKU信息不全时先澄清，数量本身无上限。
SKU任务交给brain.workflow.run；不可多次调用brain.generate.submit逐张独立生成。
逐张质检：文字模板对照同一底图，信息位以外变化为严重问题；外观款式对照共同场景及本款方案，允许已确认的框色和照片变化，检查装裱工艺、构图、光线与产品真实性。不能可靠判断就needs_human。"""

SLOT_KEYS = ("parameters", "gifts", "attributes")
SLOT_LABELS = {"parameters": "参数", "gifts": "赠品", "attributes": "属性"}
CTR_TEST_SCHEDULE = [
    {"day": 1, "time": "", "action": "上传4张创意测1天，同时再做2张", "variable": "热度与背景，每次仅变一个因素"},
    *[{"day": day, "time": "09:00", "action": "替换点击率最低的2张，同时再做2张", "variable": "热度与背景" if day <= 3 else "文案"} for day in range(2, 6)],
    {"day": 6, "time": "09:00", "action": "替换点击率最低的2张", "variable": "文案"},
    {"day": 7, "time": "", "action": "4张创意统一为点击率最高的那张，选为正式第1张主图", "variable": "依据真实展现量、点击量和CTR选优；缺数据则待测"},
]
DEFAULT_LAYOUT = {
    "parameters": {"box": [0.06, 0.70, 0.88, 0.09], "font_pt": 26, "color": "#252525", "background": "#F5F1E8"},
    "gifts": {"box": [0.06, 0.80, 0.88, 0.09], "font_pt": 26, "color": "#252525", "background": "#F5F1E8"},
    "attributes": {"box": [0.06, 0.90, 0.88, 0.09], "font_pt": 26, "color": "#252525", "background": "#F5F1E8"},
}


class VisualRuleError(ValueError):
    pass


def sku_series_mode(brief):
    text = "\n".join(str(brief.get(key) or "") for key in
                     ("source_text", "goal", "product", "deliverables", "style_direction", "adjustments"))
    mode = brief.get("series_mode")
    if mode not in ("sku", "sku_variants") and not re.search(r"(?<![a-z])sku(?![a-z])", text, re.I):
        return ""
    if mode == "sku_variants":
        return mode
    appearance = r"(?:框色|框架颜色|产品颜色|商品颜色|照片|图案|内芯|外观|造型)"
    change = r"(?:不同|更换|替换|换成|换用|切换|可选|多种)"
    for clause in re.split(r"[，。；,;\n]", text):
        if re.search(r"不(?:要|能|得|允许|可)|禁止|不变|保持.{0,8}一致|仅?改文字|只改文字", clause):
            continue
        if (re.search(change + r".{0,12}" + appearance, clause)
                or re.search(appearance + r".{0,12}" + change, clause)):
            return "sku_variants"
    return "sku"


def is_sku(brief):
    return sku_series_mode(brief) == "sku"


def task_kind(brief):
    mode = sku_series_mode(brief)
    if mode:
        return mode
    return brief.get("task_type") if brief.get("task_type") in ("main_image", "detail_images") else ""


def infer_task_type(text, fallback="other"):
    if re.search(r"sku", text, re.I):
        return "other"
    if "详情" in text:
        return "detail_images"
    if re.search(r"(?:7|七)\s*天.*测图|测图(?:方案|实验)|创意", text):
        return "creative"
    if "主图" in text:
        return "main_image"
    return fallback


def normalize_layout(raw):
    raw = raw or DEFAULT_LAYOUT
    if not isinstance(raw, dict) or set(raw) != set(SLOT_KEYS):
        raise VisualRuleError("SKU 信息位只能包含 parameters、gifts、attributes，请重新规划")
    result = {}
    for key in SLOT_KEYS:
        item = raw[key]
        try:
            x, y, w, h = map(float, item["box"])
            font_pt = float(item["font_pt"])
        except (TypeError, ValueError, KeyError):
            raise VisualRuleError("SKU 信息位必须包含归一化 box=[x,y,w,h] 与固定 font_pt") from None
        if not all(math.isfinite(v) for v in (x, y, w, h, font_pt)) or not (0 <= x < 1 and 0 <= y < 1 and w > 0 and h > 0 and x + w <= 1 and y + h <= 1 and 25 <= font_pt <= 70):
            raise VisualRuleError("SKU 信息位超出画布或字号不合规范（正文至少25pt）")
        colors = {name: str(item.get(name) or "") for name in ("color", "background")}
        if any(not re.fullmatch(r"#[0-9a-fA-F]{6}", c) for c in colors.values()) or colors["color"].lower() == "#000000" or colors["color"].lower() == colors["background"].lower():
            raise VisualRuleError("SKU 信息位需使用不同的HEX文字色与底色，文字不用纯黑")
        result[key] = {"box": [x, y, w, h], "font_pt": font_pt, **colors}
    boxes = [v["box"] for v in result.values()]
    for i, (x, y, w, h) in enumerate(boxes):
        for a, b, c, d in boxes[i + 1:]:
            if x < a + c and a < x + w and y < b + d and b < y + h:
                raise VisualRuleError("SKU 信息位不可重叠，请重新规划")
    return result


def normalize_values(raw):
    if not isinstance(raw, dict) or set(raw) != set(SLOT_KEYS):
        raise VisualRuleError("每款SKU必须给出 parameters、gifts、attributes 三个信息位，未知内容先向用户确认")
    if any(not isinstance(raw[k], str) or len(raw[k]) > 500 for k in SLOT_KEYS):
        raise VisualRuleError("SKU 信息位必须是500字内的原文，不接受其他产品变化字段")
    return {k: raw[k].strip() for k in SLOT_KEYS}


def validate_framework(raw):
    if not isinstance(raw, dict):
        raise VisualRuleError("电商方案缺少全组视觉框架 visual_framework，请统一配色、字体、字级与品牌位置")
    palette = raw.get("palette")
    fonts = raw.get("fonts")
    if not isinstance(palette, list) or not 1 <= len(palette) <= 3 or any(not isinstance(c, str) or not re.fullmatch(r"#[0-9A-Fa-f]{6}", c) for c in palette):
        raise VisualRuleError("三三原则：全组配色需为1至3个明确的HEX颜色")
    if not isinstance(fonts, list) or not 1 <= len(fonts) <= 3 or any(not isinstance(v, str) or not v.strip() for v in fonts):
        raise VisualRuleError("三三原则：全组字体需为1至3种，标题字级保持一致")
    for key in ("style", "brand", "product_pose"):
        if not isinstance(raw.get(key), str) or not raw[key].strip():
            raise VisualRuleError(f"全组视觉框架缺少 {key}（风格、品牌位置、产品机位）；无品牌时明确写无Logo")
    typography = raw.get("typography") or {"title_pt": 64, "subtitle_pt": 44, "body_pt": 26, "line_extra_px": 10}
    try:
        title, subtitle, body = [float(typography[k]) for k in ("title_pt", "subtitle_pt", "body_pt")]
        extra = float(typography["line_extra_px"])
    except (TypeError, ValueError, KeyError):
        raise VisualRuleError("字级需包含 title_pt、subtitle_pt、body_pt 和 line_extra_px") from None
    if not all(math.isfinite(v) for v in (title, subtitle, body, extra)) or title < 36 or subtitle < 18 or body < 25 or extra != 10 or any(v % 2 for v in (title, subtitle, body)):
        raise VisualRuleError("字级应使用偶数：主标题至少48px、建议60px以上，副标题至少24px、手机正文至少25pt，行距增加10px")
    return {"palette": palette, "fonts": fonts, "typography": {"title_pt": title, "subtitle_pt": subtitle, "body_pt": body, "line_extra_px": extra},
            **{k: raw[k].strip()[:600] for k in ("style", "brand", "product_pose")}}


def shot_role(kind, index):
    if kind == "main_image":
        return "ctr" if index == 0 else "conversion"
    if kind == "detail_images":
        return ("product", "selling_point", "benefit", "attention")[index] if index < 4 else "reinforce"
    return "sku"


ROLE_TEXT = {
    "ctr": "第1张点击率主图，1:1，产品约70%、文案约30%，3秒内传达最大利益点，手机缩略图清楚。",
    "conversion": "展示图，提升转化，以场景化、数据化、细节特写或促销氛围展示真实卖点与好处。",
    "product": "详情第1屏：展现商品，让用户看清买的是什么，优先最关心的利益点。",
    "selling_point": "详情第2屏：产品核心卖点，属性与优势对应真实需求情景。",
    "benefit": "详情第3屏：消费者得到的好处与产品特性，最大好处放在标题里。",
    "attention": "详情第4屏：用强视觉抓回注意力，围绕同一个核心利益点。",
    "reinforce": "详情后续屏：重复强化核心卖点，从场景、细节或已验证数据展开，不自相矛盾。",
}


def apply_visual_plan(brief, plan, *, compose=False, offset=0):
    kind = task_kind(brief)
    if not kind:
        return plan
    framework = validate_framework(plan.get("visual_framework"))
    plan["visual_framework"] = framework
    shots = plan.get("shots") or []
    if kind in ("sku", "sku_variants"):
        return plan
    if kind == "main_image":
        plan["test_schedule"] = [dict(day) for day in CTR_TEST_SCHEDULE]
    if not compose:
        if kind == "main_image" and (len(shots) != 5 or any(s.get("count", 1) != 1 for s in shots)):
            raise VisualRuleError("主图完整一组必须为5张：第1张测点击率，其余4张提升转化")
        if kind == "detail_images" and offset == 0 and len(shots) < 3:
            raise VisualRuleError("详情页至少包含商品、卖点、好处特性前三屏；总屏数没有上限")
    for i, shot in enumerate(shots, start=offset):
        role = shot_role(kind, i)
        if kind == "detail_images":
            copy = shot.get("copy") or {}
            title, subtitle = copy.get("title"), copy.get("subtitle")
            if not isinstance(title, str) or not 4 <= len(title.strip()) <= 8 or not isinstance(subtitle, str) or len(subtitle.strip()) > 15 or not isinstance(copy.get("body", ""), str):
                raise VisualRuleError("详情页每屏需给出 copy.title（4至8字）与 copy.subtitle（15字内），突出最大好处")
        if compose:
            shot["role"] = role
            shot["purpose"] = ROLE_TEXT[role]
            ratio = "1:1" if role == "ctr" else "2:3" if kind == "main_image" else str(brief.get("aspect_ratio") or "9:16")
            shot["aspect_ratio"] = ratio
            shot["size"] = {"1:1": "1024x1024", "2:3": "1024x1536", "9:16": "864x1536"}.get(ratio, shot["size"])
            shot["prompt"] = (ROLE_TEXT[role] + "\n全组视觉框架：" + json.dumps(framework, ensure_ascii=False)
                              + "\n" + shot["prompt"])
            if kind == "detail_images":
                shot["prompt"] += "\n本屏原文文案：" + json.dumps(shot["copy"], ensure_ascii=False)
                shot["prompt"] += "\n按750宽参考稿同比缩放：主标题4至8字、至少48px且优先60px以上，副标题15字内且至少24px，手机正文至少25pt；行距加10px、侧边距40至70px且大于20px、屏间距不超过160px；三三原则、文字不用纯黑。"
            shot["acceptance"] = [ROLE_TEXT[role], "全组风格、HEX配色、字体字级、产品机位与品牌标识一致"] + shot.get("acceptance", [])[:4]
        if shot.get("role") != role:
            raise VisualRuleError("图片分工或前三屏顺序不符，请重新规划后再确认")
        if shot.get("count", 1) != 1:
            raise VisualRuleError("电商方案须逐张规划，每张 count=1")
        width, height = map(int, shot["size"].split("x"))
        target = 1 if role == "ctr" else 2 / 3 if kind == "main_image" else None
        if target and abs(width / height - target) > .02:
            raise VisualRuleError("主图第1张应为1:1，展示图应为2:3，请统一画幅后再确认")
        if kind == "detail_images" and not brief.get("aspect_ratio") and abs(width / height - 9 / 16) > .02:
            raise VisualRuleError("详情页默认9:16竖版，请重新设置画幅")
        if len(shot["prompt"]) > 4000:
            raise VisualRuleError("提示词过长，请精简正文并保留视觉规范")
    if kind == "detail_images" and len({s["size"].split("x")[0] for s in shots}) != 1:
        raise VisualRuleError("详情页每屏必须同宽，才能纵向连贯")
    return plan


def cjk_font_path():
    windows_fonts = Path(os.environ.get("WINDIR", "C:/Windows")) / "Fonts"
    candidates = (windows_fonts / "msyh.ttc", windows_fonts / "simhei.ttf",
                  Path("/System/Library/Fonts/PingFang.ttc"), Path("/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc"))
    for path in candidates:
        if path.is_file():
            return path
    directories = [windows_fonts, Path(os.environ.get("LOCALAPPDATA", str(Path.home()))) / "Microsoft/Windows/Fonts",
                   Path("/Library/Fonts"), Path.home() / "Library/Fonts", Path("/usr/share/fonts/opentype/noto")]
    for directory in directories:
        for pattern in ("SourceHanSans*", "NotoSans*CJK*", "NotoSansSC*", "PingFang*"):
            for path in sorted(directory.glob(pattern)):
                if path.suffix.lower() in (".ttf", ".ttc", ".otf") and path.is_file():
                    return path
    raise VisualRuleError("SKU 模板排字缺少中文字体，请安装微软雅黑或思源黑体后重试")


def render_sku_image(template_path, layout, values):
    """仅在三个固定矩形内排字，矩形以外的像素原样保留。"""
    from PIL import Image, ImageDraw, ImageFont
    layout = normalize_layout(layout)
    values = normalize_values(values)
    with Image.open(template_path) as source:
        image = source.convert("RGB")
    draw = ImageDraw.Draw(image)
    width, height = image.size
    font_path = str(cjk_font_path())
    for key, spec in layout.items():
        x, y, w, h = spec["box"]
        left, top = round(x * width), round(y * height)
        right, bottom = round((x + w) * width), round((y + h) * height)
        font = ImageFont.truetype(font_path, max(1, round(spec["font_pt"] * 96 / 72 * width / 750)))
        padding = max(2, round(8 * width / 750))
        max_width = right - left - 2 * padding
        lines, line = [], ""
        for char in values[key]:
            if char == "\n" or (line and draw.textlength(line + char, font=font) > max_width):
                lines.append(line)
                line = "" if char == "\n" else char
            else:
                line += char
        lines.append(line)
        ascent, descent = font.getmetrics()
        line_height = ascent + descent + round(10 * width / 750)
        if (len(lines) * line_height - round(10 * width / 750) > bottom - top - 2 * padding
                or any(draw.textlength(s, font=font) > max_width for s in lines)):
            raise VisualRuleError(f"SKU 的{SLOT_LABELS[key]}文案超出固定信息位，请缩短文案或统一调大整组信息位；不会单独缩小字号")
        draw.rectangle((left, top, right - 1, bottom - 1), fill=spec["background"])
        for i, text in enumerate(lines):
            draw.text((left + padding, top + padding + i * line_height), text, font=font, fill=spec["color"], anchor="lt")
    buffer = io.BytesIO()
    image.save(buffer, "PNG")
    return buffer.getvalue()
