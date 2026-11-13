"""Read the local asset library and its existing annotation files."""

import os
import re
import stat
from pathlib import Path, PurePosixPath
from urllib.parse import quote

from PIL import Image

import asset_annotations


_PREFIX = re.compile(r"up_[0-9a-f]{12}_(.+)")
_TYPES = (
    ("video", {".mp4", ".webm", ".mov", ".m4v", ".flv"}, ".mp4",
     {"webm": ".webm", "quicktime": ".mov"}),
    ("audio", {".mp3", ".wav", ".m4a", ".aac", ".ogg", ".flac"}, ".mp3",
     {"wav": ".wav", "ogg": ".ogg", "mp4": ".m4a"}),
    ("image", {".png", ".jpg", ".jpeg", ".webp", ".gif"}, ".png",
     {"jpeg": ".jpg", "webp": ".webp", "gif": ".gif"}),
)
_DIRECTORY_LINK_TAGS = {
    getattr(stat, "IO_REPARSE_TAG_MOUNT_POINT", 0xA0000003),
    getattr(stat, "IO_REPARSE_TAG_SYMLINK", 0xA000000C),
}
ANNOTATION_SUFFIXES = (".txt", ".classification.json")


def media_type(filename, content_type=""):
    extension = Path(filename or "").suffix.lower()
    mime = str(content_type or "").lower()
    for kind, extensions, fallback, aliases in _TYPES:
        if extension in extensions:
            return kind, extension
        if mime.startswith(kind + "/"):
            return kind, next((suffix for name, suffix in aliases.items() if name in mime), fallback)
    return None, extension


def display_name(relative):
    name = PurePosixPath(str(relative or "").replace("\\", "/")).name
    match = _PREFIX.fullmatch(name)
    return match[1] if match else name


def media_url(relative):
    encoded = quote(str(relative or "").replace("\\", "/"), safe="/")
    return f"/api/storage-files/local/{encoded}"


def annotation_path(source, suffix):
    return Path(source).with_suffix(suffix)


def read_caption(source):
    try:
        try:
            text = source.read_text(encoding="utf-8-sig")
        except UnicodeDecodeError:
            text = source.read_text(encoding="gb18030", errors="replace")
    except OSError:
        return "", ""
    return text, source.name


def item(directory, relative):
    path = directory / relative
    try:
        metadata = path.stat()
        size, modified = metadata.st_size, metadata.st_mtime
        # Windows/macOS expose the real creation time; other platforms fall back to the inode time.
        created = float(getattr(metadata, "st_birthtime", 0) or metadata.st_ctime or modified)
    except OSError:
        size, modified, created = 0, 0, 0
    kind, _ = media_type(relative)
    parent = PurePosixPath(relative).parent
    result = {
        "id": relative, "file": relative, "name": display_name(relative),
        "folder": parent.as_posix() if parent.parts else "", "url": media_url(relative),
        "kind": kind or "image", "size": size, "created_at": modified,
        "modified_at": modified, "birth_at": created or modified,
    }
    if kind != "image":
        return result
    try:
        with Image.open(path) as image:
            width, height = image.size
        result.update(natural_w=width, natural_h=height, width=width, height=height)
    except (OSError, ValueError, SyntaxError, Image.DecompressionBombError):
        pass
    caption = annotation_path(path, ".txt")
    classification = annotation_path(path, ".classification.json")
    result["caption"], result["caption_file"] = read_caption(caption) if _inside(directory, caption) else ("", "")
    if _inside(directory, classification):
        value = asset_annotations.read_classification(classification)
        if value:
            result["classification"] = value
    return result


def _inside(directory, path):
    try:
        return path.resolve().is_relative_to(directory.resolve())
    except (OSError, RuntimeError):
        return False


def _visible_entries(directory):
    with os.scandir(directory) as entries:
        for entry in entries:
            if not entry.name.startswith("."):
                yield entry


def _is_folder(entry):
    try:
        if not entry.is_dir(follow_symlinks=False):
            return False
        info = entry.stat(follow_symlinks=False)
    except OSError:
        return False
    return getattr(info, "st_reparse_tag", 0) not in _DIRECTORY_LINK_TAGS


def is_link(path):
    metadata = path.lstat()
    return stat.S_ISLNK(metadata.st_mode) or getattr(metadata, "st_reparse_tag", 0) in _DIRECTORY_LINK_TAGS


def child_folders(directory):
    return [entry.name for entry in _visible_entries(directory) if _is_folder(entry)]


def move_folder_order(orders, relative, destination=None):
    relative = PurePosixPath(relative)
    parent = relative.parent.as_posix() if relative.parent.parts else ""
    saved = orders.get(parent)
    old_name = relative.name
    new_name = PurePosixPath(destination).name if destination else None
    if isinstance(saved, list):
        orders[parent] = [new_name if name == old_name else name for name in saved if name != old_name or new_name]
    source = relative.as_posix()
    for key in list(orders):
        if key == source or key.startswith(source + "/"):
            positions = orders.pop(key)
            if destination:
                orders[destination + key[len(source):]] = positions
    return orders


def _folder(root, path, orders, register, flat_items):
    relative = path.relative_to(root).as_posix()
    is_root = relative == "."
    if is_root:
        relative = ""
    folders, files = [], []
    try:
        for entry in _visible_entries(path):
            if _is_folder(entry):
                folders.append(Path(entry.path))
            elif media_type(entry.name)[0] and entry.is_file() and _inside(root, Path(entry.path)):
                files.append(entry.name)
    except OSError:
        pass

    saved = orders.get(relative)
    if not isinstance(saved, list):
        saved = []
    positions = {name: index for index, name in enumerate(saved) if isinstance(name, str)}
    folders.sort(key=lambda folder: (positions.get(folder.name, len(saved)), folder.name.lower(), folder.name))
    files.sort(key=lambda name: (name.lower(), name))
    assets = [register((path / name).relative_to(root).as_posix()) for name in files]
    flat_items.extend(assets)
    children = [_folder(root, folder, orders, register, flat_items) for folder in folders]
    return {
        "id": relative or "__root__", "path": relative, "name": "全部上传" if is_root else path.name,
        "items": assets, "children": children, "count": len(assets) + sum(child["count"] for child in children),
    }


def tree(directory, orders, register):
    root = Path(directory)
    assets = []
    folders = _folder(root, root, orders, register, assets)
    assets.sort(key=lambda asset: asset["created_at"], reverse=True)
    return folders, assets


def removable_folder(directory, relative):
    root = Path(directory).resolve()
    start = root / relative
    if start == root or not _inside(root, start):
        raise ValueError("不支持删除链接文件夹")
    folders, files, media = [start], set(), []
    for folder in folders:
        if is_link(folder):
            raise ValueError("文件夹包含链接，已取消删除")
        with os.scandir(folder) as entries:
            for entry in entries:
                path = Path(entry.path)
                if is_link(path):
                    raise ValueError("文件夹包含链接，已取消删除")
                if entry.is_dir(follow_symlinks=False):
                    folders.append(path)
                else:
                    files.add(path)
                    if entry.is_file(follow_symlinks=False) and media_type(entry.name)[0]:
                        media.append(path)
    known = set(media)
    for path in media:
        known.update(annotation_path(path, suffix) for suffix in ANNOTATION_SUFFIXES)
    if files - known:
        raise ValueError("文件夹包含未纳入素材库的文件，已取消删除")
    return sorted(path.relative_to(root).as_posix() for path in media), list(reversed(folders))
