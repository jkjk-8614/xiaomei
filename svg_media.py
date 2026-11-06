"""Validate generated static SVGs without rasterizing or rewriting their bytes."""
import math
import re
import xml.etree.ElementTree as ET


SVG_NAMESPACE = "http://www.w3.org/2000/svg"
STATIC_TAGS = set("""svg g defs title desc metadata path rect circle ellipse line
    polyline polygon text tspan textPath use symbol clipPath mask pattern marker
    linearGradient radialGradient stop filter feBlend feColorMatrix
    feComponentTransfer feComposite feConvolveMatrix feDiffuseLighting
    feDisplacementMap feDistantLight feDropShadow feFlood feFuncA feFuncB feFuncG
    feFuncR feGaussianBlur feImage feMerge feMergeNode feMorphology feOffset
    fePointLight feSpecularLighting feSpotLight feTile feTurbulence style""".split())


def generated_svg_meta(content):
    """Return SVG dimensions, or None for a raster; reject active SVG content."""
    head = content[:8192].lstrip(b"\xef\xbb\xbf \t\r\n")
    if not head.startswith(b"<"):
        return None
    try:
        text = content.decode("utf-8-sig")
        if re.search(r"<!DOCTYPE|<!ENTITY|<\?(?!xml\s)", text, re.I):
            raise ValueError("SVG 不支持文档声明、实体或外部样式表")
        root = ET.fromstring(text)
    except (UnicodeError, ET.ParseError) as exc:
        raise ValueError("平台返回的 SVG 文件无法读取") from exc
    if root.tag not in {"svg", f"{{{SVG_NAMESPACE}}}svg"}:
        raise ValueError("平台返回的内容不是 SVG 图片")
    for element in root.iter():
        tag = element.tag.removeprefix(f"{{{SVG_NAMESPACE}}}")
        if tag not in STATIC_TAGS:
            raise ValueError("SVG 仅支持静态矢量内容")
        values = list(element.attrib.values())
        if tag == "style":
            values.append(element.text or "")
        for name, value in element.attrib.items():
            local_name = name.rsplit("}", 1)[-1].lower()
            if local_name.startswith("on") or local_name == "base":
                raise ValueError("SVG 不支持脚本或外部资源")
            if local_name in {"href", "src"} and not value.strip().startswith("#"):
                raise ValueError("SVG 不支持外部资源或内嵌位图")
        for value in values:
            if "\\" in value or "/*" in value or re.search(r"@import|javascript\s*:", value, re.I):
                raise ValueError("SVG 不支持脚本或外部样式")
            for reference in re.findall(r"url\s*\((.*?)\)", value, re.I | re.S):
                if not reference.strip(" \t\r\n\"'").startswith("#"):
                    raise ValueError("SVG 不支持外部资源或内嵌位图")

    def length(value):
        match = re.fullmatch(r"\s*(\d+(?:\.\d+)?|\.\d+)\s*(px|pt|pc|in|cm|mm)?\s*", value or "")
        if not match:
            return 0
        scale = {None: 1, "px": 1, "pt": 96 / 72, "pc": 16, "in": 96, "cm": 96 / 2.54, "mm": 96 / 25.4}
        result = float(match[1]) * scale[match[2]]
        return result if math.isfinite(result) and result > 0 else 0

    width, height = length(root.get("width")), length(root.get("height"))
    try:
        box = [float(value) for value in re.split(r"[\s,]+", root.get("viewBox", "").strip())]
    except ValueError:
        box = []
    if len(box) == 4 and all(math.isfinite(value) for value in box) and min(box[2:]) > 0:
        width, height = (width or (height * box[2] / box[3] if height else box[2]),
                         height or (width * box[3] / box[2] if width else box[3]))
    return {"format": "svg", "natural_w": max(1, round(width or 300)),
            "natural_h": max(1, round(height or 150))}
