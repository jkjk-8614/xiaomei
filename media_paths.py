"""Resolve persisted canvas media addresses against the configured storage roots."""

import os
from pathlib import PurePosixPath, PureWindowsPath
from urllib.parse import quote, unquote, urlsplit
from urllib.request import url2pathname


_STORAGE_PREFIX = "/api/storage-files/"
_LOCAL_HOSTS = {"127.0.0.1", "localhost", "::1"}

# 上传素材 / 生成素材 / 本地素材 三个目录内部再按媒体类型分层：
# 新素材进入 图片 / 视频 / 音频 子目录，其余产物（txt、json、psd、zip 等）保持原目录。
# 旧版平铺文件不搬动，读取时仍然优先使用原路径。
MEDIA_TYPE_FOLDERS = {"image": "图片", "video": "视频", "audio": "音频"}
MEDIA_TYPE_FOLDER_NAMES = frozenset(MEDIA_TYPE_FOLDERS.values())
_MEDIA_IMAGE_EXTS = {
    ".png", ".jpg", ".jpeg", ".webp", ".gif", ".svg", ".bmp", ".avif",
    ".tif", ".tiff", ".heic", ".heif", ".apng",
}
_MEDIA_VIDEO_EXTS = {".mp4", ".webm", ".mov", ".m4v", ".avi", ".mkv", ".flv", ".mpeg", ".mpg"}
_MEDIA_AUDIO_EXTS = {".mp3", ".wav", ".flac", ".ogg", ".m4a", ".aac"}


def media_type_for(name):
    """Return "image"/"video"/"audio" for a media filename, otherwise ""."""
    suffix = PurePosixPath(str(name or "").replace("\\", "/")).suffix.lower()
    if suffix in _MEDIA_VIDEO_EXTS:
        return "video"
    if suffix in _MEDIA_AUDIO_EXTS:
        return "audio"
    if suffix in _MEDIA_IMAGE_EXTS:
        return "image"
    return ""


def media_type_folder(name):
    kind = media_type_for(name)
    return MEDIA_TYPE_FOLDERS[kind] if kind else ""


def typed_relative(relative):
    """Put a root-relative media path into its 图片/视频/音频 folder (idempotent)."""
    clean = str(relative or "").replace("\\", "/").strip("/")
    if not clean:
        return clean
    head, _, name = clean.rpartition("/")
    if head.rsplit("/", 1)[-1] in MEDIA_TYPE_FOLDER_NAMES:
        return clean
    folder = media_type_folder(name)
    if not folder:
        return clean
    return f"{head}/{folder}/{name}" if head else f"{folder}/{name}"


def _relative_candidate(root, relative):
    """Join ``relative`` under ``root`` without touching the filesystem."""
    root = os.path.abspath(str(root or ""))
    clean = str(relative or "").replace("\\", "/").lstrip("/")
    if not clean:
        return None
    candidate = os.path.abspath(os.path.join(root, clean.replace("/", os.sep)))
    if os.path.normcase(candidate) == os.path.normcase(root) or not _inside(root, candidate):
        return None
    return candidate


def stored_relative(folder, relative):
    """Existing flat files keep their address; new media gets a type folder."""
    relative = str(relative or "").replace("\\", "/").lstrip("/")
    existing = _relative_candidate(folder, relative)
    if existing and os.path.exists(existing):
        return relative
    return typed_relative(relative)


def write_path(root, relative):
    """Path for writing media: type folder applied and parent directory created."""
    target = _relative_candidate(root, typed_relative(relative))
    if target is None:
        raise ValueError("生成文件路径不在存储目录内")
    os.makedirs(os.path.dirname(target), exist_ok=True)
    return target


def absolute_local_image_path(value):
    path = str(value or "").strip().strip("\"'").strip()
    if not path:
        raise ValueError("本地图片路径为空")

    if path[:5].lower() == "file:":
        try:
            uri = urlsplit(path)
        except ValueError as exc:
            raise ValueError("只支持本机图片路径") from exc
        authority = uri.netloc
        if os.name == "nt" and _windows_drive(authority):
            # Older clients sent the drive as the file URI authority.
            encoded_path = f"/{authority}{uri.path}"
        elif authority.lower() in {"", "localhost"}:
            encoded_path = uri.path
        else:
            raise ValueError("只支持本机图片路径")
        try:
            path = url2pathname(encoded_path)
        except (OSError, ValueError) as exc:
            raise ValueError("只支持本机绝对图片路径") from exc

    if "\0" not in path:
        if os.name == "nt":
            windows_path = PureWindowsPath(path.removeprefix("/"))
            if windows_path.root and _windows_drive(windows_path.drive):
                return os.path.abspath(windows_path)
        elif os.path.isabs(path):
            return os.path.abspath(path)
    raise ValueError("只支持本机绝对图片路径")


def _windows_drive(value):
    return len(value) == 2 and value[0].isascii() and value[0].isalpha() and value[1] == ":"


def parse_address(value, *, allow_loopback=False):
    if isinstance(value, dict):
        value = value.get("url")
    if not isinstance(value, str) or not value:
        return None
    try:
        parsed = urlsplit(value)
        if parsed.scheme or parsed.netloc:
            if not allow_loopback or parsed.scheme not in ("http", "https") or parsed.hostname not in _LOCAL_HOSTS:
                return None
            if parsed.username is not None or parsed.password is not None:
                return None
        path = unquote(parsed.path).replace("\\", "/")
    except ValueError:
        return None
    if path.startswith(_STORAGE_PREFIX):
        bucket, _, relative = path[len(_STORAGE_PREFIX):].lstrip("/").partition("/")
        return (bucket, relative) if bucket and relative else None
    for mount in ("/assets", "/output"):
        if path.startswith(mount + "/"):
            relative = path[len(mount) + 1:].lstrip("/")
            return (mount, relative) if relative else None
    return None


def _inside(root, path):
    try:
        shared = os.path.commonpath((root, path))
    except ValueError:
        return False
    return os.path.normcase(shared) == os.path.normcase(root)


def path_under(root, relative):
    if not root or not relative:
        return None
    relative = str(relative).replace("\\", "/").lstrip("/")
    if not relative or ":" in relative or any(ord(char) < 32 for char in relative):
        return None
    root = os.path.abspath(root)
    candidate = os.path.abspath(os.path.join(root, relative))
    if os.path.normcase(candidate) == os.path.normcase(root) or not _inside(root, candidate):
        return None
    try:
        if _inside(os.path.realpath(root), os.path.realpath(candidate)):
            return candidate
    except OSError:
        pass
    return None


def first_file(roots, relative):
    for root in roots:
        candidate = path_under(root, relative)
        if candidate and os.path.isfile(candidate):
            return candidate
    return None


def output_url(folder, assets_root, name, category):
    relative = stored_relative(folder, name)
    target = path_under(folder, relative)
    if target is None:
        raise ValueError("生成文件路径不在存储目录内")
    assets_root = os.path.abspath(assets_root)
    if _inside(assets_root, target):
        asset_rel = os.path.relpath(target, assets_root)
        if path_under(assets_root, asset_rel):
            return "/assets/" + quote(asset_rel.replace("\\", "/"), safe="/")
    bucket = "upload" if category == "input" else "generated"
    relative = os.path.relpath(target, folder).replace("\\", "/")
    return f"{_STORAGE_PREFIX}{bucket}/" + quote(relative, safe="/")
