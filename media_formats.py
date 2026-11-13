"""Media types and byte conversions for canvas references and results."""

import base64
import os
from io import BytesIO
from pathlib import Path
from urllib.parse import urlsplit

from PIL import Image, ImageOps

from svg_media import generated_svg_meta


_TYPES = {
    ".mp4": "video/mp4", ".m4v": "video/mp4", ".webm": "video/webm", ".mov": "video/quicktime",
    ".mpeg": "video/mpeg", ".mpg": "video/mpeg",
    ".avi": "video/x-msvideo", ".mkv": "video/x-matroska", ".flv": "video/x-flv",
    ".mp3": "audio/mpeg", ".wav": "audio/wav", ".m4a": "audio/mp4", ".aac": "audio/aac",
    ".ogg": "audio/ogg", ".flac": "audio/flac",
    ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp",
    ".gif": "image/gif", ".svg": "image/svg+xml", ".bmp": "image/bmp", ".tif": "image/tiff",
    ".tiff": "image/tiff", ".avif": "image/avif",
    ".txt": "text/plain", ".json": "application/json", ".csv": "text/csv", ".md": "text/markdown",
    ".srt": "application/x-subrip", ".vtt": "text/vtt",
}
_TEXT = {".txt", ".json", ".csv", ".md", ".srt", ".vtt"}
IMAGE_EXTENSIONS = frozenset(ext for ext, mime in _TYPES.items() if mime.startswith("image/")) - {".avif"}
_IMAGE_EXT_BY_TYPE = {
    _TYPES[ext]: ext for ext in (".png", ".jpg", ".webp", ".gif", ".svg", ".bmp", ".tiff")
}
_MEDIA_TYPES = {"image", "audio", "video"}
_MEDIA_SUFFIX = {
    mime: suffix for suffix, mime in reversed(_TYPES.items()) if mime.partition("/")[0] in _MEDIA_TYPES
}
_MEDIA_SUFFIX.update({
    "image/jpg": ".jpg", "audio/x-wav": ".wav", "audio/x-m4a": ".m4a",
    "application/ogg": ".ogg", "video/x-m4v": ".m4v", "video/x-mpeg": ".mpeg",
})
_IMAGE_SIGNATURES = (
    (b"\x89PNG\r\n\x1a\n", ".png"), (b"\xff\xd8\xff", ".jpg"),
    (b"GIF87a", ".gif"), (b"GIF89a", ".gif"), (b"BM", ".bmp"),
)


def content_type(path):
    extension = os.path.splitext(os.fspath(path))[1].lower()
    mime = _TYPES.get(extension, "application/octet-stream")
    return mime + "; charset=utf-8" if extension in _TEXT else mime


def url_extension(value):
    text = str(value or "")
    try:
        path = urlsplit(text).path
    except ValueError:
        path = text.split("?", 1)[0].split("#", 1)[0]
    return os.path.splitext(path)[1].lower()


def sniff_image_extension(content):
    data = content or b""
    if data.startswith(b"RIFF") and data[8:12] == b"WEBP":
        return ".webp"
    return next((extension for signature, extension in _IMAGE_SIGNATURES if data.startswith(signature)), None)


def media_kind(extension):
    family = _TYPES.get(extension, "").partition("/")[0]
    return family if family in _MEDIA_TYPES else ""


def media_suffix(source="", header=""):
    declared = _MEDIA_SUFFIX.get(str(header or "").partition(";")[0].strip().lower(), "")
    extension = url_extension(source)
    source_kind = media_kind(extension)
    if source_kind and (not declared or media_kind(declared) == source_kind):
        return extension
    return declared


def _image_extension(extension):
    extension = str(extension or "").lower()
    if extension and not extension.startswith("."):
        extension = "." + extension
    if extension == ".jpeg":
        return ".jpg"
    return extension if extension in IMAGE_EXTENSIONS else ".png"


def image_extension(source="", header=""):
    mime = str(header or "").partition(";")[0].strip().lower()
    if mime == "image/jpg":
        return ".jpg"
    return _IMAGE_EXT_BY_TYPE.get(mime) or _image_extension(url_extension(source))


def video_extension(source, header):
    extension = url_extension(source)
    if _TYPES.get(extension, "").startswith("video/"):
        return extension
    mime = str(header or "").lower()
    for ext, aliases in ((".webm", ("webm",)), (".mov", ("quicktime", "mov")),
                         (".mkv", ("matroska", "mkv")), (".flv", ("flv",))):
        if any(alias in mime for alias in aliases):
            return ext
    return ".mp4"


def has_alpha(image):
    return image.mode in ("RGBA", "LA") or (image.mode == "P" and "transparency" in image.info)


def rgb_on_white(image):
    if not has_alpha(image):
        return image.convert("RGB")
    with image.convert("RGBA") as rgba, rgba.getchannel("A") as alpha:
        output = Image.new("RGB", rgba.size, "white")
        output.paste(rgba, mask=alpha)
    return output


def _png(source):
    source.load()
    profile = source.info.get("icc_profile")
    with ImageOps.exif_transpose(source) as oriented, BytesIO() as buffer:
        with oriented.convert("RGBA" if has_alpha(oriented) else "RGB") as output:
            output.save(buffer, "PNG", optimize=True, icc_profile=profile)
        return buffer.getvalue()


def image_snapshot(content, fallback_extension, *, require_decodable):
    payload = bytes(content or b"")
    extension = _image_extension(fallback_extension)
    if generated_svg_meta(payload):
        return ".svg", payload
    if extension == ".svg":
        raise ValueError("平台返回的内容不是 SVG 图片")
    try:
        with Image.open(BytesIO(payload)) as source:
            if source.format == "GIF" and source.is_animated:
                source.load()
                return ".gif", payload
            return ".png", _png(source)
    except Exception as exc:
        if require_decodable:
            raise ValueError("上游返回的文件无法读取为图片") from exc
        return extension, payload


def reference_data_url(path, max_size, mime):
    file = Path(path)
    if max_size:
        try:
            with Image.open(file) as source, BytesIO() as output:
                source.load()
                if max(source.size) > max_size:
                    source.thumbnail((max_size, max_size), Image.Resampling.LANCZOS)
                mode = "RGBA" if has_alpha(source) else "RGB"
                fmt = "PNG" if mode == "RGBA" else "JPEG"
                with source.convert(mode) as converted:
                    options = {"quality": 88} if fmt == "JPEG" else {}
                    converted.save(output, fmt, **options)
                return _data_url(output.getvalue(), f"image/{fmt.lower()}")
        except Exception:
            pass
    return _data_url(file.read_bytes(), mime)


def _data_url(content, mime):
    return f"data:{mime};base64,{base64.b64encode(content).decode('ascii')}"
