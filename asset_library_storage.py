"""Filesystem storage for asset library categories and imported media."""

import logging
import os
from pathlib import Path, PureWindowsPath
import shutil
import tempfile
import uuid
from itertools import count
from urllib.parse import quote

import asset_kernel
from media_paths import path_under


_LOGGER = logging.getLogger(__name__)


def category_path(root, directory):
    relative = str(directory or "").strip().replace("\\", "/")
    parts = relative.split("/")
    if any(
        part in {"", ".", ".."} or part.endswith((".", " ")) or PureWindowsPath(part).is_reserved()
        for part in parts
    ):
        return None
    path = path_under(root, relative)
    return Path(path) if path else None


def _image_categories(catalog):
    for library in catalog["libraries"]:
        for category in library.get("categories") or ():
            if isinstance(category, dict) and (category.get("type") or "image") == "image":
                yield category


def create_category_folder(root, catalog, name):
    root = Path(root)
    root.mkdir(parents=True, exist_ok=True)
    reserved = {
        os.path.normcase(str(path))
        for category in _image_categories(catalog)
        if (path := category_path(root, category.get("dir"))) is not None
    }
    base = asset_kernel.display_name(name or "分组", "分组").strip(" .") or "分组"
    if PureWindowsPath(base).is_reserved():
        base = f"_{base}"
    for number in count(1):
        candidate = root / (base if number == 1 else f"{base}_{number}")
        if os.path.normcase(str(candidate.absolute())) in reserved:
            continue
        try:
            candidate.mkdir()
        except FileExistsError:
            continue
        return candidate


def provision_category_folders(root, catalog):
    """Prepare directories for future imports and keep saved media addresses valid."""
    created = []
    for category in _image_categories(catalog):
        existing = category_path(root, category.get("dir"))
        try:
            if existing is not None:
                try:
                    existing.mkdir(parents=True, exist_ok=True)
                except FileExistsError:
                    pass
                else:
                    continue
            folder = create_category_folder(root, catalog, category.get("name"))
        except OSError:
            _LOGGER.warning("Could not prepare an asset library folder", exc_info=True)
            continue
        category["dir"] = folder.name
        created.append(folder)
    return created


def remove_empty_folder(folder):
    try:
        folder.rmdir()
    except OSError:
        _LOGGER.debug("Asset library directory could not be removed", exc_info=True)


def copy_media(root, source, filename, directory=""):
    root = Path(root).absolute()
    folder = category_path(root, directory) if directory else root
    if folder is None:
        raise ValueError("Invalid asset library directory")
    folder.mkdir(parents=True, exist_ok=True)
    name = f"lib_{uuid.uuid4().hex[:12]}_{filename}"
    target = folder / name
    with tempfile.NamedTemporaryFile(dir=folder, suffix=".tmp", delete=False) as stage:
        staged = Path(stage.name)
    try:
        shutil.copy2(source, staged)
        os.replace(staged, target)
    finally:
        staged.unlink(missing_ok=True)
    relative = target.relative_to(root).as_posix()
    return name, "/assets/library/" + quote(relative, safe="/")
