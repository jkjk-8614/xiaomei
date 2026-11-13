"""Build and cache derived media previews without changing source files."""

import hashlib
import os
from contextlib import contextmanager, suppress
from io import BytesIO
from pathlib import Path
from stat import S_ISREG
from threading import Lock

from PIL import Image, ImageOps

from media_formats import has_alpha, rgb_on_white
from media_reference_frames import video_poster
from media_storage import write_media_snapshot


MAX_JPEG_EDGE = 4096
MIN_THUMBNAIL_EDGE = 64
MAX_THUMBNAIL_EDGE = 2048
_THUMBNAIL_FORMATS = (("webp", "WEBP", {"quality": 90, "method": 3}), ("png", "PNG", {}))
_IMAGE_OPEN_LOCK = Lock()


def thumbnail_cache_paths(source, directory, width, metadata, *, include_legacy=False):
    identity = f"{os.path.abspath(source)}|{metadata.st_mtime_ns}|{metadata.st_size}|{width}"
    key = hashlib.sha256(f"thumbnail-v3|{identity}".encode("utf-8", "surrogatepass")).hexdigest()
    directory = Path(directory)
    paths = tuple(directory / f"{key}.{extension}" for extension, _, _ in _THUMBNAIL_FORMATS)
    if include_legacy:
        legacy = hashlib.sha1(f"2|{identity}".encode("utf-8", "ignore")).hexdigest()
        paths += tuple(directory / f"{legacy}.{extension}" for extension, _, _ in _THUMBNAIL_FORMATS)
    return paths


def _inside(root, source):
    root = Path(root).resolve()
    return source.resolve().is_relative_to(root)


@contextmanager
def _open_thumbnail_source(source, local_root, pixel_limit):
    with _IMAGE_OPEN_LOCK:
        try:
            image = Image.open(source)
        except Image.DecompressionBombError:
            if not _inside(local_root, source):
                raise
            original_limit = Image.MAX_IMAGE_PIXELS
            try:
                Image.MAX_IMAGE_PIXELS = pixel_limit
                image = Image.open(source)
            finally:
                Image.MAX_IMAGE_PIXELS = original_limit
            if image.width * image.height > pixel_limit:
                image.close()
                raise ValueError(f"图片像素超过预览上限（{pixel_limit:,}）")
    with image:
        yield image


def _encode_thumbnail(image, targets):
    for target, (extension, encoding, options) in zip(targets, _THUMBNAIL_FORMATS):
        with BytesIO() as output:
            try:
                image.save(output, encoding, **options)
            except (OSError, ValueError, KeyError):
                if extension == "png":
                    raise
                continue
            return write_media_snapshot(target, output.getvalue(), deduplicate=False), f"image/{extension}"


def _cached_thumbnail(targets):
    for target in targets:
        if target.is_file():
            return target, f"image/{target.suffix[1:]}"
    return None


def cached_thumbnail(source, directory, width, *, video, local_root, pixel_limit, build_lock, build_slots):
    source = Path(source)
    metadata = source.stat()
    if not S_ISREG(metadata.st_mode):
        raise FileNotFoundError(source)
    if source.suffix.lower() == ".svg":
        return source, "image/svg+xml"

    width = min(MAX_THUMBNAIL_EDGE, max(MIN_THUMBNAIL_EDGE, width or 512))
    targets = thumbnail_cache_paths(source, directory, width, metadata)
    cached = _cached_thumbnail(targets)
    if cached:
        return cached

    with build_lock(source):
        cached = _cached_thumbnail(targets)
        if cached:
            return cached
        with build_slots:
            if video:
                with Image.open(BytesIO(video_poster(source, width))) as frame:
                    return _encode_thumbnail(frame, targets)
            with _open_thumbnail_source(source, local_root, pixel_limit) as image:
                with suppress(OSError, ValueError, NotImplementedError):
                    image.draft("RGB", (width, width))
                image.thumbnail((width, width), Image.Resampling.LANCZOS)
                with ImageOps.exif_transpose(image) as oriented:
                    with oriented.convert("RGBA" if has_alpha(oriented) else "RGB") as output:
                        return _encode_thumbnail(output, targets)


def jpeg_cache_paths(source, directory, width, metadata):
    identity = f"{os.path.abspath(source)}|{metadata.st_mtime_ns}|{metadata.st_size}|{width}|jpg"
    key = hashlib.sha256(f"jpeg-v2|{identity}".encode("utf-8", "surrogatepass")).hexdigest()
    legacy_key = hashlib.sha1(identity.encode("utf-8", "ignore")).hexdigest()
    directory = Path(directory)
    return directory / f"{key}.jpg", directory / f"{legacy_key}.jpg"


def cached_jpeg(source, directory, width, *, build_lock):
    source = Path(source)
    metadata = source.stat()
    if not S_ISREG(metadata.st_mode):
        raise FileNotFoundError(source)

    width = min(MAX_JPEG_EDGE, max(0, width))
    target, _ = jpeg_cache_paths(source, directory, width, metadata)
    if target.is_file():
        return target

    with build_lock(source):
        if target.is_file():
            return target
        with _IMAGE_OPEN_LOCK:
            original = Image.open(source)
        with original, ImageOps.exif_transpose(original) as oriented:
            if width:
                oriented.thumbnail((width, width), Image.Resampling.LANCZOS)
            with rgb_on_white(oriented) as image, BytesIO() as output:
                image.save(output, "JPEG", quality=86)
                return write_media_snapshot(target, output.getvalue(), deduplicate=False)


def remove_cached_previews(source, directory):
    directory = Path(directory)
    if not directory.is_dir():
        return 0
    try:
        metadata = Path(source).stat()
    except OSError:
        return 0
    removed = 0
    for width in range(MAX_JPEG_EDGE + 1):
        candidates = jpeg_cache_paths(source, directory, width, metadata)
        if MIN_THUMBNAIL_EDGE <= width <= MAX_THUMBNAIL_EDGE:
            candidates += thumbnail_cache_paths(source, directory, width, metadata, include_legacy=True)
        for candidate in candidates:
            try:
                candidate.unlink()
                removed += 1
            except OSError:
                pass
    return removed
