"""Resolve registered project folders and enumerate their shareable media."""

import json
from pathlib import Path
from urllib.parse import quote

import media_formats
from storage_migration import walk_files


EXTENSIONS = frozenset("""
    .png .jpg .jpeg .webp .gif .bmp .mp4 .webm .mov .m4v .mkv .mp3 .wav .m4a .aac .ogg .flac
""".split())


def read_catalog(path):
    try:
        with open(path, encoding="utf-8-sig") as stream:
            raw = json.load(stream)
    except FileNotFoundError:
        return {"folders": []}
    if not isinstance(raw, dict) or not isinstance(raw.get("folders", []), list):
        raise ValueError("共享文件夹清单格式无效")
    return {**raw, "folders": [row for row in raw.get("folders", []) if isinstance(row, dict)]}


def registration_path(base, value):
    entered = str(value or "").strip().strip('"\'')
    if not entered:
        raise ValueError("请选择要登记的文件夹")
    root = Path(base).resolve()
    candidate = (root / entered).resolve()
    try:
        relative = candidate.relative_to(root)
    except ValueError as exc:
        raise ValueError("共享文件夹须位于项目目录内") from exc
    if relative == Path(".") or not candidate.is_dir():
        raise ValueError("请选择项目目录下已存在的子文件夹")
    return str(candidate), str(relative)


def tree(folder_id, directory, display, maximum):
    def branch(key, label):
        return {"id": f"{folder_id}:{key or '__root__'}", "name": label, "path": key, "items": [], "children": []}

    root = branch("", display or Path(directory).name or str(directory))
    if maximum <= 0:
        return root
    nodes = {"": root}
    encoded_id = quote(str(folder_id), safe="")
    count = 0
    for relative, file in walk_files(directory, skip_dirs=(".",)):
        if file.suffix.lower() not in EXTENSIONS:
            continue
        try:
            info = file.stat()
        except OSError:
            continue
        node = root
        parts = relative.parts[:-1]
        for index, part in enumerate(parts, 1):
            key = "/".join(parts[:index])
            child = nodes.get(key)
            if child is None:
                child = branch(key, part)
                nodes[key] = child
                node["children"].append(child)
            node = child
        address = relative.as_posix()
        node["items"].append({
            "id": f"{folder_id}:{address}", "name": file.name,
            "url": f"/api/shared-folders/{encoded_id}/file?path={quote(address)}",
            "kind": media_formats.content_type(file).partition("/")[0],
            "size": info.st_size, "lastModified": int(info.st_mtime * 1000),
            "relativePath": address, "folderId": folder_id,
        })
        count += 1
        if count >= maximum:
            break
    for node in nodes.values():
        node["items"].sort(key=lambda item: item["name"].casefold())
        node["children"].sort(key=lambda child: child["name"].casefold())
    return root
