"""Catalog and file operations for workflows saved in the asset library."""

from contextlib import contextmanager
import logging
import os
from pathlib import Path
from urllib.parse import quote
import uuid

from fastapi import HTTPException

import asset_kernel
import canvas_workflow_archive
from media_paths import path_under
from media_storage import write_media_snapshot


PREVIEW_LIMIT = 128 * 1024 * 1024
WORKFLOW_EXTENSIONS = (".json", ".zip")
_LIBRARY_URL = "/assets/library/"
_LOGGER = logging.getLogger(__name__)


def destination(catalog, library_id, category_id, *, strict=False):
    library = asset_kernel.pick_library(catalog, library_id, strict=strict)
    if library is None:
        raise HTTPException(status_code=404, detail="资产库不存在")
    categories = [category for category in library.get("categories") or () if isinstance(category, dict)]
    if not category_id:
        return library, next((category for category in categories if category.get("type") == "workflow"), None)
    category = next((category for category in categories if category.get("id") == category_id), None)
    if category is None:
        raise HTTPException(status_code=404, detail="工作流分类不存在")
    if category.get("type") != "workflow":
        raise HTTPException(status_code=400, detail="目标分组不是工作流分类")
    return library, category


def add_items(catalog, library_id, category_id, items, *, strict=False):
    library, category = destination(catalog, library_id, category_id, strict=strict)
    if category is None:
        category = asset_kernel.spawn_category("工作流", f"wf_{uuid.uuid4().hex[:12]}", "workflow")
        library.setdefault("categories", []).append(category)
    category.setdefault("items", []).extend(items)
    catalog["active_library_id"] = library["id"]


@contextmanager
def store(root, raw, filename, label, created_at, resolve_media):
    """Publish the workflow file, removing it if the catalog update fails."""
    if not raw:
        raise HTTPException(status_code=400, detail="工作流文件为空")
    basename = str(filename or "").replace("\\", "/").rsplit("/", 1)[-1]
    extension = Path(basename).suffix
    if extension.lower() in WORKFLOW_EXTENSIONS:
        stem = basename[:-len(extension)]
    else:
        stem, extension = basename, ".zip"
    clean_stem = asset_kernel.display_name(stem, "canvas-workflow").strip(" .") or "canvas-workflow"
    path = Path(root) / f"workflow_{uuid.uuid4().hex[:12]}_{clean_stem}{extension}"
    preview = canvas_workflow_archive.inspect_workflow(raw, extension.lower(), resolve_media)
    item = {
        **preview,
        "id": f"wf_{uuid.uuid4().hex[:12]}",
        "name": asset_kernel.display_name(label or clean_stem, "工作流"),
        "url": _LIBRARY_URL + quote(path.name, safe=""),
        "kind": "workflow",
        "type": "workflow",
        "format": extension[1:].lower(),
        "size": len(raw),
        "created_at": created_at,
    }
    write_media_snapshot(path, raw, deduplicate=False)
    try:
        yield item
    except BaseException:
        try:
            path.unlink(missing_ok=True)
        except OSError:
            _LOGGER.warning("Could not remove an uncommitted workflow file", exc_info=True)
        raise


def preview_upload(raw, filename, resolve_media):
    if len(raw) > PREVIEW_LIMIT:
        raise HTTPException(status_code=413, detail="工作流文件超过 128MB")
    return canvas_workflow_archive.inspect_workflow(raw, Path(filename or "").suffix.lower(), resolve_media)


def legacy_file_url(root, url):
    """Encode the exact filename stored by older versions when URL resolution fails."""
    if not isinstance(url, str) or not url.startswith(_LIBRARY_URL):
        return None
    filename = url[len(_LIBRARY_URL):]
    if "/" in filename or "\\" in filename:
        return None
    path = path_under(root, filename)
    if path and Path(path).is_file():
        return _LIBRARY_URL + quote(filename, safe="")
    return None


def preview_saved(catalog, item_id, resolve_media, *, library_id="", category_id="", source_url=None):
    matches = [
        item for _, category, item in asset_kernel.locate_items(catalog, [item_id], library_id, category_id)
        if category.get("type") == "workflow" and (source_url is None or item.get("url") == source_url)
    ]
    if source_url is not None and len(matches) != 1:
        raise HTTPException(status_code=409, detail="源工作流已变化，请刷新后重试")
    if not matches:
        raise HTTPException(status_code=404, detail="工作流不存在")
    path = resolve_media(matches[0].get("url"))
    if path and Path(path).is_file():
        try:
            with open(path, "rb") as source:
                if os.fstat(source.fileno()).st_size > PREVIEW_LIMIT:
                    raise HTTPException(status_code=413, detail="工作流文件超过 128MB")
                return preview_upload(source.read(PREVIEW_LIMIT + 1), path, resolve_media)
        except FileNotFoundError:
            pass
    raise HTTPException(status_code=404, detail="工作流文件不存在，请重新上传")
