"""Read completed image results from provider and saved recovery payloads."""

import base64
import json
import re

from fastapi import HTTPException

import media_formats


_REMOTE = ("http://", "https://")
_LOCAL = ("/output/", "/assets/", "/api/storage-files/")
_MAX_DEPTH = 8
_DEFAULT_MIME = "image/png"
_BAD_FORMAT = "无法识别生图接口返回格式"
_EMPTY_RESULT = "生图接口没有返回图片数据"

_URL_FIELDS = (
    "url", "image_url", "imageUrl", "image",
    "output_url", "outputUrl", "result_url", "resultUrl",
    "download_url", "downloadUrl", "asset_url", "assetUrl", "file_url", "fileUrl",
    "image_urls", "imageUrls", "output_urls", "outputUrls", "uri", "src",
    "secure_url", "secureUrl", "temporary_url", "temporaryUrl",
    "original_url", "originalUrl", "signed_url", "signedUrl",
)
_BODY_FIELDS = (
    "images", "output", "outputs", "result", "results", "data", "items", "files",
    "response", "responses", "choices", "choice", "message", "messages",
    "candidates", "candidate", "content", "contents", "parts", "part",
)
_BASE64_FIELDS = ("b64_json", "base64", "image_base64", "imageBase64")
_DATA_IN_TEXT = re.compile(r"data:(image/[a-z0-9.+-]+);base64,([A-Za-z0-9+/=_-]+)", re.I)
_URL_IN_TEXT = re.compile(r"""https?://[^\s<>'")\]]+""", re.I)
_MARKDOWN_IMAGE = re.compile(r"!\[[^\]]*\]\((https?://[^\s)]+)\)", re.I)
_BASE64 = re.compile(r"[A-Za-z0-9+/=_-]+")


def _mime(item):
    return item.get("mime_type") or item.get("mimeType") or _DEFAULT_MIME


def _encoded(value, mime):
    return {"type": "b64", "value": value, "mime_type": mime or _DEFAULT_MIME}


def _address(value):
    return {"type": "url", "value": value}


def _supported_address(text):
    return text.lower().startswith(_REMOTE) or text.startswith(_LOCAL)


def _file_mime(text):
    return media_formats.content_type("result" + media_formats.url_extension(text))


def _has_image_extension(text):
    return media_formats.url_extension(text) in media_formats.IMAGE_EXTENSIONS


def _is_known_image(text):
    text = text.strip()
    return text.lower().startswith("data:image/") or (
        _supported_address(text) and _has_image_extension(text)
    )


def _looks_encoded(text):
    if len(text) < 200:
        return False
    sample = "".join(text[:4096].split())
    if not _BASE64.fullmatch(sample):
        return False
    prefix = sample[:256]
    try:
        header = base64.b64decode(prefix + "=" * (-len(prefix) % 4), altchars=b"-_")
    except ValueError:
        return False
    return (
        header.startswith((b"\x89PNG\r\n\x1a\n", b"\xff\xd8\xff", b"GIF87a", b"GIF89a"))
        or (header.startswith(b"RIFF") and header[8:12] == b"WEBP")
    )


def _from_text(value, depth, *, mime=_DEFAULT_MIME, encoded=False, address=False):
    if depth > _MAX_DEPTH or not isinstance(value, str):
        return
    text = value.strip()
    if not text:
        return

    if text.lower().startswith("data:"):
        header, comma, content = text.partition(",")
        if header[5:].lower().startswith("image/") and comma and content.strip():
            yield _encoded(content.strip(), header[5:].partition(";")[0])
        return

    if text[0] in "{[":
        try:
            document = json.loads(text)
        except (ValueError, RecursionError):
            pass
        else:
            yield from _document_images(document, depth + 1)
            return

    supported = _supported_address(text)
    bare = supported and not any(char.isspace() for char in text)
    if supported:
        if bare and _file_mime(text).startswith(("audio/", "video/")):
            return
        if (bare and address) or _has_image_extension(text):
            yield _address(text)
            return

    data_uri = _DATA_IN_TEXT.search(text)
    if data_uri:
        yield _encoded(data_uri[2], data_uri[1])
        return
    for match in _URL_IN_TEXT.finditer(text):
        url = match[0]
        if "?" not in url and "#" not in url:
            url = url.rstrip(".,;")
        if _has_image_extension(url):
            yield _address(url)
            return
    markdown = _MARKDOWN_IMAGE.search(text)
    if markdown and not _file_mime(markdown[1]).startswith(("audio/", "video/")):
        yield _address(markdown[1])
        return
    if bare and text.lower().startswith(_REMOTE):
        yield _address(text)
        return
    if (encoded and not str(mime).lower().startswith(("audio/", "video/"))) or _looks_encoded(text):
        yield _encoded(text, mime)


def image_payload_from_string(value, mime_type=_DEFAULT_MIME, assume_b64=False, assume_url=False):
    return next(_from_text(value, 0, mime=mime_type, encoded=assume_b64, address=assume_url), None)


def _thought(item):
    return item.get("thought") is True or item.get("type") in ("thought", "thought_image")


def _inline_image(item):
    inline = item.get("inlineData") or item.get("inline_data")
    if not isinstance(inline, dict):
        return None
    value = inline.get("data")
    mime = _mime(inline)
    if isinstance(value, str) and value.strip() and not str(mime).lower().startswith(("audio/", "video/")):
        return _encoded(value, mime)
    return None


def _rows(value):
    return value if isinstance(value, list) else ()


def _field_images(value, depth, mime, *, address):
    entries = value if isinstance(value, list) else (value,)
    for entry in entries:
        if isinstance(entry, str):
            if address or entry.strip().startswith(_LOCAL):
                yield from _from_text(entry, depth, mime=mime, address=True)
            else:
                yield from _from_text(entry, depth)
        else:
            yield from _walk(entry, depth)


def _walk(value, depth):
    if depth > _MAX_DEPTH:
        return
    if isinstance(value, str):
        yield from _from_text(value, depth)
        return
    if isinstance(value, list):
        for entry in value:
            yield from _walk(entry, depth + 1)
        return
    if not isinstance(value, dict) or _thought(value):
        return

    inline = _inline_image(value)
    if inline:
        yield inline
    mime = _mime(value)
    if value.get("type") == "image_generation_call":
        result = value.get("result")
        if isinstance(result, str):
            yield from _from_text(result, depth, mime=mime, encoded=True)
        else:
            yield from _walk(result, depth + 1)

    if not any(isinstance(value.get(key), str) and _is_known_image(value[key]) for key in _URL_FIELDS):
        for key in _BASE64_FIELDS:
            yield from _from_text(value.get(key), depth, mime=mime, encoded=True)

    for key in _URL_FIELDS:
        if key in value:
            yield from _field_images(value[key], depth + 1, mime, address=True)
    for key in _BODY_FIELDS:
        if key in value:
            yield from _field_images(value[key], depth + 1, mime, address=key == "images")


def _gemini_images(data, depth):
    for candidate in _rows(data.get("candidates")):
        if not isinstance(candidate, dict) or _thought(candidate):
            continue
        content = candidate.get("content")
        if not isinstance(content, dict) or _thought(content):
            continue
        for part in _rows(content.get("parts")):
            if not isinstance(part, dict) or _thought(part):
                continue
            yield from _from_text(part.get("text"), depth + 1)
            inline = _inline_image(part)
            if inline:
                yield inline


def _result_envelope(data):
    inner = data.get("data")
    if isinstance(inner, dict) and isinstance(inner.get("result"), dict) and not _thought(inner):
        return inner
    return data


def _document_images(data, depth):
    if depth > _MAX_DEPTH:
        return
    if isinstance(data, dict):
        if _thought(data):
            return
        yield from _gemini_images(data, depth)
        result = _result_envelope(data).get("result")
        if isinstance(result, dict) and not _thought(result):
            for row in _rows(result.get("images")):
                if isinstance(row, dict) and not _thought(row):
                    yield from _field_images(row.get("url"), depth + 1, _mime(row), address=True)
                yield from _walk(row, depth + 1)
    yield from _walk(data, depth)
    if isinstance(data, dict):
        envelope = data.get("data")
        if isinstance(envelope, dict) and not _thought(envelope) and isinstance(envelope.get("data"), dict):
            yield from _walk(envelope["data"], depth)


def extract_images(data):
    images = {}
    for image in _document_images(data, 0):
        images.setdefault((image["type"], image["value"]), image)
    if not images:
        raise HTTPException(status_code=502, detail=_BAD_FORMAT)
    return list(images.values())


def extract_image(data):
    image = next(_document_images(data, 0), None)
    if image:
        return image
    envelope = _result_envelope(data) if isinstance(data, dict) else {}
    raw = envelope.get("data")
    if isinstance(raw, dict) and isinstance(raw.get("data"), dict):
        raw = raw["data"].get("data")
    detail = _BAD_FORMAT if isinstance(raw, list) and raw else _EMPTY_RESULT
    raise HTTPException(status_code=502, detail=detail)
