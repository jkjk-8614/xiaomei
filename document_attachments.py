"""Read document text locally without running embedded content or following links."""

import base64
import json
import logging
import posixpath
import re
import zipfile
from io import BytesIO
from pathlib import Path
from xml.etree import ElementTree as ET
from zlib import error as DeflateError

from PIL import Image


_LOG = logging.getLogger(__name__)
MAX_ATTACHMENT_TEXT_CHARS = 12000
EXCEL_MAX_SHEETS = 8
EXCEL_MAX_ROWS_PER_SHEET = 80
EXCEL_MAX_COLS_PER_ROW = 30
TEXT_ATTACHMENT_EXTS = {".txt", ".md", ".markdown", ".json", ".csv", ".log", ".py", ".js", ".ts", ".tsx",
                        ".jsx", ".html", ".css", ".xml", ".yaml", ".yml"}
DOCUMENT_EXTS = {".docx", ".pptx", ".pdf", ".xmind"}
LEGACY_DOCUMENT_EXTS = {
    ".doc": ".docx", ".wps": ".docx",
    ".xls": ".xlsx", ".et": ".xlsx",
    ".ppt": ".pptx", ".dps": ".pptx",
}
MAX_DOCUMENT_MEMBER_BYTES = 32 * 1024 * 1024
MAX_PREVIEW_IMAGES = 40
PREVIEW_IMAGE_EXTS = {".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp", ".tif", ".tiff"}


def document_archive_read(archive, name):
    info = archive.getinfo(name)
    if info.file_size > MAX_DOCUMENT_MEMBER_BYTES:
        raise ValueError("文档中的文字数据过大，请拆分文件后重新上传")
    if info.flag_bits & 1:
        raise ValueError("文档已加密，请移除密码后重新上传")
    return archive.read(info)


def _local(tag):
    return str(tag).rsplit("}", 1)[-1]


def _paragraphs(root):
    for paragraph in root.iter():
        if _local(paragraph.tag) != "p":
            continue
        parts = []
        for node in paragraph.iter():
            tag = _local(node.tag)
            if tag == "t" and node.text:
                parts.append(node.text)
            elif tag == "tab":
                parts.append("\t")
            elif tag in {"br", "cr"}:
                parts.append("\n")
        text = "".join(parts).strip()
        if text:
            yield text


def _xmind_json_events(sheets):
    if not isinstance(sheets, list):
        raise ValueError("XMind 文件的主题结构无效，请重新保存后上传")
    for sheet in sheets:
        if not isinstance(sheet, dict):
            continue
        sheet_title = str(sheet.get("title") or "未命名")
        yield "text", "工作表：" + sheet_title, ""
        stack = [(sheet.get("rootTopic"), 0, (sheet_title,))]
        while stack:
            topic, depth, parents = stack.pop()
            if not isinstance(topic, dict):
                continue
            if depth > 100:
                raise ValueError("XMind 分支层级过深，请拆分文件后上传")
            indent = "  " * depth
            topic_title = str(topic.get("title") or "未命名主题")
            title = parents + (topic_title,)
            yield "text", indent + "- " + topic_title, ""
            picture = topic.get("image")
            if isinstance(picture, dict) and picture.get("src"):
                yield "image", picture["src"], " › ".join(title)
            notes = topic.get("notes") or {}
            plain = notes.get("plain") if isinstance(notes, dict) else notes
            if isinstance(plain, dict):
                plain = plain.get("content")
            if isinstance(plain, str) and plain.strip():
                yield "text", indent + "  备注：" + plain.strip(), ""
            labels = topic.get("labels")
            if isinstance(labels, list) and labels:
                yield "text", indent + "  标签：" + "、".join(map(str, labels)), ""
            children = topic.get("children") or {}
            if isinstance(children, dict):
                child_topics = [child for group in children.values() if isinstance(group, list) for child in group]
                stack.extend((child, depth + 1, title) for child in reversed(child_topics))


def _xmind_json_lines(sheets):
    for kind, value, _ in _xmind_json_events(sheets):
        if kind == "text":
            yield value


def _xmind_xml_events(root):
    for sheet in root.iter():
        if _local(sheet.tag) != "sheet":
            continue
        title = next((child.text for child in sheet if _local(child.tag) == "title"), "未命名")
        sheet_title = str(title or "未命名")
        yield "text", "工作表：" + sheet_title, ""
        stack = [(child, 0, (sheet_title,)) for child in reversed(list(sheet)) if _local(child.tag) == "topic"]
        while stack:
            topic, depth, parents = stack.pop()
            if depth > 100:
                raise ValueError("XMind 分支层级过深，请拆分文件后上传")
            indent = "  " * depth
            title = next((child.text for child in topic if _local(child.tag) == "title"), "未命名主题")
            topic_title = str(title or "未命名主题")
            topic_path = parents + (topic_title,)
            yield "text", indent + "- " + topic_title, ""
            for child in topic:
                if _local(child.tag) == "notes":
                    note = "".join(child.itertext()).strip()
                    if note:
                        yield "text", indent + "  备注：" + note, ""
                if _local(child.tag) == "children":
                    continue
                for node in child.iter():
                    if _local(node.tag) not in {"img", "image"}:
                        continue
                    source = next((value for key, value in node.attrib.items() if _local(key) in {"src", "href"}), "")
                    if source:
                        yield "image", source, " › ".join(topic_path)
            children = []
            for child in topic:
                if _local(child.tag) == "children":
                    for group in child:
                        children.extend(item for item in group if _local(item.tag) == "topic")
            stack.extend((child, depth + 1, topic_path) for child in reversed(children))


def _xmind_xml_lines(root):
    for kind, value, _ in _xmind_xml_events(root):
        if kind == "text":
            yield value


def _pdf_lines(path):
    try:
        from pypdf import PdfReader
    except ImportError as exc:
        raise ValueError("PDF 读取组件缺失，请安装 requirements.txt 中的依赖后重试") from exc
    reader = PdfReader(path)
    if reader.is_encrypted and not reader.decrypt(""):
        raise ValueError("PDF 已加密，请移除密码后重新上传")
    readable_pages = 0
    for index, page in enumerate(reader.pages, 1):
        # A small compressed PDF can otherwise expand into an enormous text stream.
        contents = page.get_contents()
        if contents is not None and len(contents.get_data()) > MAX_DOCUMENT_MEMBER_BYTES:
            raise ValueError(f"PDF 第 {index} 页内容过大，请拆分文件后上传")
        text = (page.extract_text() or "").strip()
        if text:
            readable_pages += 1
            yield f"第 {index} 页\n{text}"
        else:
            yield f"第 {index} 页：未读取到文字，扫描页请先识字或另行上传页面图片。"
    if not readable_pages:
        raise ValueError("PDF 未读取到文字；扫描文档请先识字或另行上传页面图片")


def _xmind_image_path(source, names):
    if not isinstance(source, str):
        return ""
    value = source.removeprefix("xap:").replace("\\", "/").lstrip("/")
    if not value or ":" in value or "?" in value or "#" in value:
        return ""
    if value.startswith("resources/"):
        name = value
    else:
        name = "resources/" + value
    if posixpath.normpath(name) != name or Path(name).suffix.lower() not in PREVIEW_IMAGE_EXTS:
        return ""
    return name if name in names else ""


def _xmind_event_images(events, names):
    offset = 0
    for kind, value, title in events:
        if kind == "text":
            offset += len(value) + 1
        else:
            name = _xmind_image_path(value, names)
            if name:
                yield {"member": name, "title": title, "after_char": offset}


def document_preview_images(path, limit=MAX_PREVIEW_IMAGES):
    """List local raster images for preview without exposing archive paths to the browser."""
    ext = Path(path).suffix.lower()
    media_prefix = {".docx": "word/media/", ".pptx": "ppt/media/", ".xlsx": "xl/media/"}.get(ext)
    if ext != ".xmind" and not media_prefix:
        return [], False
    with zipfile.ZipFile(path) as archive:
        if len(archive.infolist()) > 10000:
            raise ValueError("文档内部文件过多，请拆分文件后上传")
        names = set(archive.namelist())
        if ext == ".xmind":
            if "content.json" in names:
                entries = list(_xmind_event_images(_xmind_json_events(json.loads(document_archive_read(archive, "content.json").decode("utf-8-sig"))), names))
            else:
                entries = list(_xmind_event_images(_xmind_xml_events(ET.fromstring(document_archive_read(archive, "content.xml"))), names))
            used = {entry["member"] for entry in entries}
            entries.extend({"member": name, "title": "文档图片：" + posixpath.basename(name)} for name in sorted(names)
                           if name.startswith("resources/") and Path(name).suffix.lower() in PREVIEW_IMAGE_EXTS and name not in used)
        else:
            entries = [{"member": name, "title": posixpath.basename(name)} for name in sorted(names)
                       if name.startswith(media_prefix) and Path(name).suffix.lower() in PREVIEW_IMAGE_EXTS]
        return entries[:limit], len(entries) > limit


def document_preview_image_bytes(path, index):
    """Return a bounded, decoded preview; never serve untrusted archive bytes as-is."""
    from PIL import ImageOps

    entries, _ = document_preview_images(path)
    if index < 0 or index >= len(entries):
        raise IndexError(index)
    with zipfile.ZipFile(path) as archive:
        raw = document_archive_read(archive, entries[index]["member"])
    with Image.open(BytesIO(raw)) as source:
        if source.width * source.height > 24_000_000:
            raise ValueError("图片尺寸过大，无法预览")
        source.load()
        picture = ImageOps.exif_transpose(source)
        picture.thumbnail((1800, 1800), Image.Resampling.LANCZOS)
        transparent = picture.mode in {"RGBA", "LA"} or picture.mode == "P" and "transparency" in picture.info
        picture = picture.convert("RGBA" if transparent else "RGB")
        output = BytesIO()
        picture.save(output, format="PNG" if transparent else "JPEG", **({} if transparent else {"quality": 85}))
    return output.getvalue(), "image/png" if transparent else "image/jpeg"


def _pptx_slide_paths(archive):
    names = set(archive.namelist())
    if "ppt/presentation.xml" in names:
        presentation = ET.fromstring(document_archive_read(archive, "ppt/presentation.xml"))
        relationships = ET.fromstring(document_archive_read(archive, "ppt/_rels/presentation.xml.rels"))
        targets = {}
        for relationship in relationships:
            target = relationship.attrib.get("Target", "")
            if relationship.attrib.get("TargetMode") == "External":
                continue
            resolved = target.lstrip("/") if target.startswith("/") else posixpath.normpath("ppt/" + target)
            targets[relationship.attrib.get("Id")] = resolved
        for node in presentation.iter():
            if _local(node.tag) == "sldId":
                rid = next((value for key, value in node.attrib.items() if key.endswith("}id")), "")
                name = targets.get(rid)
                if name not in names or not re.fullmatch(r"ppt/slides/slide\d+\.xml", name):
                    raise ValueError("PPT 的页面引用无效，请重新保存后上传")
                yield name
    else:
        yield from sorted(
            (name for name in names if re.fullmatch(r"ppt/slides/slide\d+\.xml", name)),
            key=lambda name: int(re.search(r"slide(\d+)\.xml", name).group(1)),
        )


def _workbook_media(archive):
    return sorted(
        entry.filename for entry in archive.infolist()
        if entry.filename.startswith("xl/media/") and Path(entry.filename).suffix.lower() in PREVIEW_IMAGE_EXTS
    )


def _workbook_sheets(archive):
    names = set(archive.namelist())
    book, relationships = "xl/workbook.xml", "xl/_rels/workbook.xml.rels"
    ordered = []
    if book in names and relationships in names:
        try:
            workbook = ET.fromstring(document_archive_read(archive, book))
            links = ET.fromstring(document_archive_read(archive, relationships))
        except ET.ParseError:
            pass
        else:
            destinations = {}
            for link in links:
                target = link.get("Target", "").replace("\\", "/")
                link_id = link.get("Id")
                if not link_id or not target or link.get("TargetMode", "").lower() == "external":
                    continue
                entry = posixpath.normpath(target.lstrip("/") if target.startswith(("/", "xl/")) else "xl/" + target)
                if entry.startswith("xl/") and entry in names:
                    destinations[link_id] = entry
            for sheet in workbook.iter():
                if _local(sheet.tag) != "sheet":
                    continue
                identifier = next((value for attr, value in sheet.attrib.items() if _local(attr) == "id"), None)
                if identifier in destinations:
                    ordered.append((sheet.get("name") or "Sheet", destinations[identifier]))
    if ordered:
        return ordered
    sheets = []
    for name in names:
        match = re.fullmatch(r"xl/worksheets/sheet(\d+)\.xml", name)
        if match:
            sheets.append((int(match[1]), name))
    return [(Path(name).stem, name) for _, name in sorted(sheets)]


def _spreadsheet_text(element):
    return "".join(node.text or "" for node in element.iter() if _local(node.tag) == "t").strip()


def _spreadsheet_cell(cell, shared):
    data = {_local(child.tag): child for child in cell}
    value_node = data.get("v")
    value = (value_node.text or "") if value_node is not None else ""
    kind = cell.get("t")
    if kind == "s" and value.isascii() and value.isdigit() and len(value) <= 10:
        index = int(value)
        if index < len(shared):
            value = shared[index]
    elif kind == "inlineStr" and "is" in data:
        value = _spreadsheet_text(data["is"])
    elif kind == "b":
        value = {"0": "FALSE", "1": "TRUE"}.get(value, value)
    value = value.strip()
    formula = data["f"].text if "f" in data else ""
    if formula:
        return f"{value} [={formula}]" if value else f"={formula}"
    return value


def _spreadsheet_rows(sheet, shared):
    number = 0
    for row in sheet.iter():
        if _local(row.tag) != "row":
            continue
        cells = []
        for cell in row:
            if _local(cell.tag) == "c":
                value = _spreadsheet_cell(cell, shared)
                if value:
                    address = cell.get("r")
                    cells.append(f"{address}={value}" if address else value)
                    if len(cells) == EXCEL_MAX_COLS_PER_ROW:
                        break
        if cells:
            number += 1
            yield f"第 {row.get('r') or number} 行：" + " | ".join(cells)
            if number == EXCEL_MAX_ROWS_PER_SHEET:
                return


def _workbook_lines(archive, path, strict):
    members = archive.infolist()
    if len(members) > 10000:
        raise ValueError("文档内部文件过多，请拆分文件后上传")
    if strict and any(entry.filename.endswith(".xml") and entry.file_size > MAX_DOCUMENT_MEMBER_BYTES
                      for entry in members):
        raise ValueError("表格中的文字数据过大，请拆分文件后上传")
    sheets = _workbook_sheets(archive)
    if strict and not sheets:
        raise ValueError("Excel 中没有可读取的工作表，请重新保存后上传")
    yield "Excel 工作簿：" + Path(path).name
    count = len(_workbook_media(archive))
    if count:
        yield f"内嵌图片数量：{count}"
    shared = []
    if "xl/sharedStrings.xml" in archive.namelist():
        strings = ET.fromstring(document_archive_read(archive, "xl/sharedStrings.xml"))
        shared = [_spreadsheet_text(node) for node in strings if _local(node.tag) == "si"]
    for index, (name, member) in enumerate(sheets[:EXCEL_MAX_SHEETS], 1):
        try:
            sheet = ET.fromstring(document_archive_read(archive, member))
        except (ValueError, ET.ParseError, zipfile.BadZipFile, DeflateError, RuntimeError):
            if strict:
                raise
            continue
        yield f"\n工作表 {index}：{name}"
        rows = _spreadsheet_rows(sheet, shared)
        first = next(rows, None)
        if first is None:
            yield "（未读取到非空单元格）"
        else:
            yield first
            yield from rows


def read_workbook_text(path, limit, *, strict=False):
    parts = []
    remaining = max(0, limit)
    with zipfile.ZipFile(path) as archive:
        for line in _workbook_lines(archive, path, strict):
            if parts:
                line = "\n" + line
            parts.append(line[:remaining])
            remaining -= len(line)
            if remaining <= 0:
                break
    text = "".join(parts)
    return text.rstrip() if remaining > 0 else text


def workbook_image_data_urls(path, max_images=4, max_size=1536):
    if max_images <= 0:
        return []
    pictures = []
    try:
        with zipfile.ZipFile(path) as archive:
            for member in _workbook_media(archive)[:max_images]:
                try:
                    raw = document_archive_read(archive, member)
                    with Image.open(BytesIO(raw)) as source:
                        if source.width * source.height > 24_000_000:
                            continue
                        source.thumbnail((max_size, max_size), Image.Resampling.LANCZOS)
                        if source.mode in {"RGBA", "LA"} or source.mode == "P" and "transparency" in source.info:
                            rgba = source.convert("RGBA")
                            rgb = Image.new("RGB", rgba.size, (255, 255, 255))
                            rgb.paste(rgba, mask=rgba.getchannel("A"))
                        else:
                            rgb = source.convert("RGB")
                        output = BytesIO()
                        rgb.save(output, format="JPEG", quality=88, optimize=True)
                    pictures.append("data:image/jpeg;base64," + base64.b64encode(output.getvalue()).decode("ascii"))
                except (OSError, ValueError, RuntimeError, SyntaxError, zipfile.BadZipFile, DeflateError, Image.DecompressionBombError) as exc:
                    _LOG.warning("无法读取工作簿内嵌图片 %s：%s", member, exc)
    except (OSError, zipfile.BadZipFile) as exc:
        _LOG.warning("无法读取工作簿图片：%s", exc)
    return pictures


def read_text_attachment(path, limit=MAX_ATTACHMENT_TEXT_CHARS, strict=False):
    if not path or not Path(path).is_file():
        return ""
    source = Path(path)
    ext = source.suffix.lower()
    try:
        if ext in TEXT_ATTACHMENT_EXTS:
            with source.open("rb") as handle:
                content = handle.read(max(0, limit) * 4)
            for encoding in ("utf-8-sig", "gb18030"):
                try:
                    return content.decode(encoding).strip()[:limit]
                except UnicodeDecodeError:
                    continue
            return content.decode("utf-8", errors="replace").strip()[:limit]
        if ext == ".xlsx":
            return read_workbook_text(source, limit, strict=strict)
        if ext == ".xls" and not strict:
            return "这是旧版 .xls 二进制 Excel 文件，当前内置解析器暂不支持直接读取内容。请另存为 .xlsx 后重新上传。"
        if ext in DOCUMENT_EXTS or ext in LEGACY_DOCUMENT_EXTS:
            return read_document_text(source, limit)
    except Exception as exc:
        if strict:
            raise
        _LOG.warning("无法读取附件文字 %s：%s", source.name, exc)
    return ""


def read_document_text(path, limit):
    """Return bounded text; the caller uses limit + 1 to detect truncation."""
    ext = Path(path).suffix.lower()
    if ext == ".xlsx":
        return read_workbook_text(path, limit, strict=True)
    if ext in LEGACY_DOCUMENT_EXTS:
        raise ValueError(f"{ext} 暂不能读取文字，请在 WPS / Office 中另存为 {LEGACY_DOCUMENT_EXTS[ext]} 后重新上传")
    parts, used = [], 0

    def collect(lines):
        nonlocal used
        for line in lines:
            value = str(line) + "\n"
            parts.append(value[:max(0, limit - used)])
            used += len(value)
            if used >= limit:
                break

    if ext == ".pdf":
        collect(_pdf_lines(path))
    else:
        with zipfile.ZipFile(path) as archive:
            if len(archive.infolist()) > 10000:
                raise ValueError("文档内部文件过多，请拆分文件后上传")
            if ext == ".docx":
                collect(_paragraphs(ET.fromstring(document_archive_read(archive, "word/document.xml"))))
            elif ext == ".pptx":
                slides = _pptx_slide_paths(archive)
                for index, name in enumerate(slides, 1):
                    collect([f"第 {index} 页"])
                    collect(_paragraphs(ET.fromstring(document_archive_read(archive, name))))
                    if used >= limit:
                        break
            elif ext == ".xmind":
                if "content.json" in archive.namelist():
                    collect(_xmind_json_lines(json.loads(document_archive_read(archive, "content.json").decode("utf-8-sig"))))
                else:
                    collect(_xmind_xml_lines(ET.fromstring(document_archive_read(archive, "content.xml"))))
            else:
                raise ValueError("该文件格式暂不支持读取文字")
    return "".join(parts).strip()
