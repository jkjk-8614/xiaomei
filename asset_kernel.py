"""Catalog, path, and filter helpers.

Runtime always uses this module. Query parameters, stored flags, and request
headers do not choose another implementation.
"""
from __future__ import annotations

import os
import re
import uuid
from typing import Any, Iterable, Mapping

_ILLEGAL_NAME = re.compile(r'[\\/:*?"<>|\x00-\x1f]+')
_SLUG = re.compile(r"[^A-Za-z0-9_-]+")
_TAG_SPLIT = re.compile(r"[,，、/|;；\n]+")
_SPACE = re.compile(r"\s+")
_UPLOAD_STEM = re.compile(r"[^0-9A-Za-z\u4e00-\u9fff._-]+")
_QUERY_SPLIT = re.compile(r"\s+")

BUCKETS = ("upload", "generated", "local")
VIDEO_EXT = {".mp4", ".webm", ".mov", ".m4v", ".avi", ".mkv", ".mpeg", ".mpg"}
AUDIO_EXT = {".mp3", ".wav", ".m4a", ".aac", ".ogg", ".flac"}
IMAGE_EXT = {".png", ".jpg", ".jpeg", ".webp", ".gif", ".svg"}
WORKFLOW_EXT = {".json", ".zip"}
FILTER_VIDEO = {"mp4", "webm", "mov", "m4v", "avi", "mkv", "flv"}
FILTER_AUDIO = {"mp3", "wav", "flac", "ogg", "m4a", "aac"}
FILTER_KINDS = {"image", "video", "audio", "text"}
FILTER_DIMENSIONS = ("color", "materials", "style", "use_case", "tags")
AVATAR_PAIRS = (
    ("provider_id", "provider_id", ""),
    ("project_name", "project_name", "default"),
    ("task_id", "avatar_task_id", ""),
    ("status", "avatar_status", ""),
    ("detail", "avatar_detail", ""),
    ("asset_uri", "asset_uri", ""),
    ("asset_id", "asset_id", ""),
    ("registered_at", "registered_at", 0),
)
EXT_BY_KIND = {
    "image": IMAGE_EXT,
    "video": VIDEO_EXT,
    "audio": AUDIO_EXT,
    "workflow": WORKFLOW_EXT,
}
FALLBACK_EXT = {"image": ".png", "video": ".mp4", "audio": ".mp3", "workflow": ".zip"}


def selected() -> bool:
    """The next asset path is the only runtime path."""
    return True


def display_name(value: Any, fallback: str = "asset", limit: int = 120) -> str:
    raw = value if value not in (None, "") else fallback
    text = _ILLEGAL_NAME.sub("_", str(raw)).strip()
    if not text:
        text = str(fallback or "")
    clipped = text[:limit]
    return clipped or str(fallback or "")


def folder_label(value: Any) -> dict:
    base = os.path.basename(str(value or "").strip())
    cleaned = display_name(base, "", 120)
    cleaned = cleaned.strip(" ._")[:60]
    if not cleaned:
        return {"error": "文件夹名称不能为空", "status": 400}
    return {"name": cleaned}


def file_stem(value: Any) -> dict:
    base = os.path.splitext(os.path.basename(str(value or "").strip()))[0]
    cleaned = display_name(base, "", 120).strip(" ._")[:120]
    if not cleaned:
        return {"error": "文件名称不能为空", "status": 400}
    return {"name": cleaned}


def upload_stem(filename: Any, fallback: str = "file", extension: str = "", already_stem: bool = False) -> str:
    source = str(filename or "")
    base = source if already_stem else os.path.splitext(os.path.basename(source))[0]
    cleaned = _UPLOAD_STEM.sub("_", base).strip("_") or fallback
    cleaned = cleaned[:60]
    suffix = str(extension or "").lower()
    if suffix and cleaned.lower().endswith(suffix):
        cleaned = cleaned[: -len(suffix)].rstrip(".") or fallback
    return cleaned[:60]


def media_kind(path: Any, content_type: str = "") -> str:
    ext = os.path.splitext(str(path or ""))[1].lower()
    header = str(content_type or "").lower()
    if ext in WORKFLOW_EXT:
        return "workflow"
    if ext in VIDEO_EXT or header.startswith("video/"):
        return "video"
    if ext in AUDIO_EXT or header.startswith("audio/"):
        return "audio"
    return "image"


def safe_extension(path: Any, kind: str) -> str:
    ext = os.path.splitext(str(path or ""))[1].lower()
    allowed = EXT_BY_KIND.get(kind, IMAGE_EXT)
    if ext in allowed:
        return ext
    return FALLBACK_EXT.get(kind, ".png")


def library_key(value: Any) -> str:
    raw = "" if value in (None, "") else str(value)
    if not raw:
        raw = "lib_" + uuid.uuid4().hex[:8]
    return _SLUG.sub("_", raw)[:40]


def relative_path(value: Any) -> dict:
    text = str(value or "").replace("\\", "/").strip().lstrip("/")
    if not text:
        return {"rel": ""}
    norm = os.path.normpath(text).replace("\\", "/")
    if norm in {"", "."}:
        return {"rel": ""}
    if norm == ".." or norm.startswith("../") or os.path.isabs(norm):
        return {"error": "非法路径", "status": 400}
    return {"rel": norm}


def contained(root: Any, value: Any) -> dict:
    checked = relative_path(value)
    if checked.get("error"):
        return checked
    base = os.path.abspath(str(root or ""))
    full = os.path.abspath(os.path.join(base, checked["rel"]))
    try:
        shared = os.path.commonpath([base, full])
    except ValueError:
        return {"error": "非法路径", "status": 400}
    if os.path.normcase(shared) != os.path.normcase(base):
        return {"error": "非法路径", "status": 400}
    return {"rel": checked["rel"], "path": full}


def storage_bucket(kind: Any) -> dict:
    key = str(kind or "").strip().lower()
    if key not in BUCKETS:
        return {"error": "未知存储目录", "status": 404}
    return {"bucket": key}


def _stamp(value: Any) -> int:
    if not isinstance(value, dict):
        return 0
    try:
        return int(float(value.get("created_at") or 0))
    except (TypeError, ValueError):
        return 0


def _fold_avatar(item: Any) -> None:
    if not isinstance(item, dict):
        return
    regs = item.get("registrations") if isinstance(item.get("registrations"), dict) else {}
    platform = str(item.get("platform") or "").strip()
    if platform and platform not in regs and (item.get("asset_uri") or item.get("avatar_task_id")):
        regs[platform] = {dest: item.get(src) or fallback for dest, src, fallback in AVATAR_PAIRS}
    item["registrations"] = regs
    for key in ("platform",) + tuple(src for _dest, src, _fallback in AVATAR_PAIRS):
        item.pop(key, None)


def blank_catalog(clock: int) -> dict:
    roles = (("characters", "角色", "image"), ("scenes", "场景", "image"), ("workflows", "工作流", "workflow"))
    categories = [{"id": role, "name": title, "type": kind, "items": []} for role, title, kind in roles]
    shelf = {"id": "default", "name": "默认资产库", "type": "asset", "categories": categories}
    return {
        "active_library_id": "default",
        "libraries": [shelf],
        "categories": categories,
        "updated_at": int(clock),
    }


def _sort_rows(catalog: dict) -> None:
    piles = []
    if isinstance(catalog.get("categories"), list):
        piles.extend(catalog["categories"])
    for shelf in catalog.get("libraries") or []:
        if isinstance(shelf, dict):
            piles.extend(shelf.get("categories") or [])
    seen = set()
    for pile in piles:
        marker = id(pile)
        if marker in seen or not isinstance(pile, dict):
            continue
        seen.add(marker)
        rows = pile.get("items")
        if isinstance(rows, list):
            rows.sort(key=_stamp, reverse=True)


def normalize_catalog(raw: Any, clock: int) -> dict:
    catalog = raw if isinstance(raw, dict) else blank_catalog(clock)
    legacy = catalog.get("categories") if isinstance(catalog.get("categories"), list) else None
    shelves = catalog.get("libraries") if isinstance(catalog.get("libraries"), list) else []
    if not shelves:
        seed = blank_catalog(clock)
        shelves = [{
            "id": "default",
            "name": "默认资产库",
            "type": "asset",
            "categories": legacy if legacy is not None else seed["categories"],
        }]
    kept = []
    for shelf in shelves:
        if not isinstance(shelf, dict):
            continue
        shelf["id"] = library_key(shelf.get("id"))
        shelf["name"] = display_name(shelf.get("name") or "资产库", "资产库")
        groups = shelf.get("categories") if isinstance(shelf.get("categories"), list) else []
        if shelf.get("id") == "default" and not any(isinstance(group, dict) and group.get("type") == "workflow" for group in groups):
            groups.append({"id": "workflows", "name": "工作流", "type": "workflow", "items": []})
        for group in groups:
            if not isinstance(group, dict):
                continue
            for row in group.get("items") or []:
                _fold_avatar(row)
        shelf["categories"] = groups
        kept.append(shelf)
    if not kept:
        return blank_catalog(clock)
    active = str(catalog.get("active_library_id") or kept[0].get("id") or "default")
    if not any(shelf.get("id") == active for shelf in kept):
        active = kept[0].get("id") or "default"
    current = next(shelf for shelf in kept if shelf.get("id") == active)
    catalog["libraries"] = kept
    catalog["active_library_id"] = active
    catalog["categories"] = current.get("categories") or []
    try:
        catalog["updated_at"] = int(catalog.get("updated_at") or clock)
    except (TypeError, ValueError):
        catalog["updated_at"] = int(clock)
    _sort_rows(catalog)
    return catalog


def pick_library(catalog: Mapping[str, Any], library_id: str = "", strict: bool = False):
    shelves = [shelf for shelf in (catalog.get("libraries") or []) if isinstance(shelf, dict)]
    wanted = str(library_id or catalog.get("active_library_id") or "").strip()
    found = next((shelf for shelf in shelves if shelf.get("id") == wanted), None)
    if found is not None or strict:
        return found
    return shelves[0] if shelves else None


def find_group(catalog: Mapping[str, Any], category_id: str, library_id: str = ""):
    shelves = [shelf for shelf in (catalog.get("libraries") or []) if isinstance(shelf, dict)]
    preferred = str(library_id or "").strip()
    if preferred:
        shelves = [shelf for shelf in shelves if shelf.get("id") == preferred]
    for shelf in shelves:
        for group in shelf.get("categories") or []:
            if isinstance(group, dict) and group.get("id") == category_id:
                return shelf, group
    return None, None


def spawn_library(name: Any, library_id: str, image_id: str, workflow_id: str) -> dict:
    return {
        "id": library_id,
        "name": display_name(name, "资产库"),
        "type": "asset",
        "categories": [
            {"id": image_id, "name": "默认分组", "type": "image", "items": []},
            {"id": workflow_id, "name": "工作流", "type": "workflow", "items": []},
        ],
    }


def rename_library(catalog: dict, library_id: str, name: Any) -> dict:
    shelf = pick_library(catalog, library_id, strict=True)
    if shelf is None or shelf.get("id") != library_id:
        return {"error": "资产库不存在", "status": 404}
    shelf["name"] = display_name(name, shelf.get("name") or "资产库")
    return {"library": shelf}


def drop_library(catalog: dict, library_id: str) -> dict:
    shelves = [shelf for shelf in (catalog.get("libraries") or []) if isinstance(shelf, dict)]
    if len(shelves) <= 1:
        return {"error": "至少保留一个资产库", "status": 400}
    if not any(shelf.get("id") == library_id for shelf in shelves):
        return {"error": "资产库不存在", "status": 404}
    catalog["libraries"] = [shelf for shelf in shelves if shelf.get("id") != library_id]
    if catalog.get("active_library_id") == library_id:
        catalog["active_library_id"] = catalog["libraries"][0].get("id")
    return {"ok": True}


def spawn_category(name: Any, category_id: str, kind: str, folder: str = "") -> dict:
    group = {
        "id": category_id,
        "name": display_name(name, "新文件夹"),
        "type": "workflow" if str(kind or "").lower() == "workflow" else "image",
        "items": [],
    }
    if group["type"] == "image" and folder:
        group["dir"] = folder
    return group


def rename_category(catalog: dict, category_id: str, library_id: str, name: Any) -> dict:
    _shelf, group = find_group(catalog, category_id, library_id)
    if group is None:
        return {"error": "分类不存在", "status": 404}
    group["name"] = display_name(name, group.get("name") or "新文件夹")
    return {"category": group}


def removal_plan(catalog: Mapping[str, Any], category_id: str, library_id: str = "") -> dict:
    shelf, group = find_group(catalog, category_id, library_id)
    if group is None:
        return {"error": "分类不存在", "status": 404}
    if group.get("type") == "workflow" and category_id == "workflows" and (shelf.get("id") or "") == "default":
        return {"error": "默认工作流分类不能删除", "status": 400}
    rows = [row for row in (group.get("items") or []) if isinstance(row, dict)]
    return {"library": shelf, "category": group, "items": rows}


def drop_category(catalog: dict, shelf: dict, category_id: str) -> None:
    shelf["categories"] = [group for group in (shelf.get("categories") or []) if not (isinstance(group, dict) and group.get("id") == category_id)]
    if catalog.get("active_library_id") == shelf.get("id"):
        catalog["categories"] = shelf.get("categories") or []


def rename_item(catalog: dict, item_id: str, name: Any, library_id="", category_id="", source_url=None) -> dict:
    locations = locate_items(catalog, [item_id], library_id, category_id)
    if source_url is not None:
        locations = [location for location in locations if location[2].get("url") == source_url]
        if not locations:
            return {"error": "源素材已变化，请刷新后重试", "status": 409}
    if not locations:
        return {"error": "资产不存在", "status": 404}
    if len(locations) > 1 and (library_id or category_id or source_url is not None):
        return {"error": "存在多条匹配素材，请指定来源分组", "status": 409}
    item = locations[0][2]
    item["name"] = display_name(name, item.get("name") or "asset")
    return {"item": item}


def locate_items(catalog: Mapping[str, Any], ids: Iterable[Any], library_id: str = "", category_id: str = "") -> list:
    wanted = {str(item) for item in ids if str(item)}
    found = []
    for shelf in catalog.get("libraries") or []:
        if not isinstance(shelf, dict):
            continue
        if library_id and shelf.get("id") != library_id:
            continue
        for group in shelf.get("categories") or []:
            if not isinstance(group, dict):
                continue
            if category_id and group.get("id") != category_id:
                continue
            for row in group.get("items") or []:
                if isinstance(row, dict) and row.get("id") in wanted:
                    found.append((shelf, group, row))
    return found


def detach_objects(catalog: dict, rows: Iterable[Any]) -> None:
    victims = {id(row) for row in rows}
    for shelf in catalog.get("libraries") or []:
        if not isinstance(shelf, dict):
            continue
        for group in shelf.get("categories") or []:
            if not isinstance(group, dict) or not isinstance(group.get("items"), list):
                continue
            group["items"] = [row for row in group["items"] if id(row) not in victims]


def drop_empty_image_group(catalog: dict, library_id: str, category_id: str) -> str:
    if not category_id or not library_id:
        return ""
    for shelf in catalog.get("libraries") or []:
        if not isinstance(shelf, dict) or shelf.get("id") != library_id:
            continue
        group = next((item for item in (shelf.get("categories") or []) if isinstance(item, dict) and item.get("id") == category_id), None)
        if group and (group.get("type") or "image") == "image" and not group.get("items"):
            shelf["categories"] = [item for item in shelf.get("categories") or [] if item is not group]
            if catalog.get("active_library_id") == shelf.get("id"):
                catalog["categories"] = shelf.get("categories") or []
            return category_id
    return ""


def scoped_item_locations(catalog, ids, library_id, sources):
    locations = locate_items(catalog, ids, library_id)
    if sources is None:
        return locations
    expected = {(entry["category_id"], entry["id"], entry["url"]) for entry in sources}
    matches = [entry for entry in locations if (entry[1].get("id"), entry[2].get("id"), entry[2].get("url")) in expected]
    actual = {(group.get("id"), row.get("id"), row.get("url")) for _, group, row in matches}
    if actual != expected or len(matches) != len(expected) or {row["id"] for _, _, row in matches} != set(ids):
        return None
    return matches


def move_items(catalog: dict, ids: Iterable[Any], library_id: str, target_library_id: str, target_category_id: str, sources=None) -> dict:
    wanted = {str(item) for item in ids if str(item)}
    if not wanted:
        return {"error": "没有选择资产", "status": 400}
    target_shelf = pick_library(catalog, target_library_id, strict=bool(target_library_id))
    target = None
    if target_shelf is not None:
        for group in target_shelf.get("categories") or []:
            if isinstance(group, dict) and group.get("id") == target_category_id:
                target = group
                break
    if target is None:
        return {"error": "目标分组不存在", "status": 404}
    target_type = target.get("type") or "image"
    locations = scoped_item_locations(catalog, wanted, library_id, sources)
    if locations is None:
        return {"error": "源素材已变化，请刷新后重试", "status": 409}
    carried = [row for _, group, row in locations if group is not target and (group.get("type") or "image") == target_type]
    if sources is not None and len(carried) != len(locations):
        return {"error": "源分组与目标分组相同或类型不匹配", "status": 409}
    present = {row.get("id") for row in (target.get("items") or []) if isinstance(row, dict)}
    for row in carried:
        if row["id"] in present:
            return {"error": "目标或源分组存在同 ID 素材，请选择其他目标", "status": 409}
        present.add(row["id"])
    detach_objects(catalog, carried)
    target.setdefault("items", []).extend(carried)
    return {"moved": len(carried)}


def center_box(width: Any, height: Any):
    try:
        wide = int(width)
        high = int(height)
    except (TypeError, ValueError):
        return None
    side = min(wide, high)
    if side <= 0:
        return None
    left = max(0, (wide - side) // 2)
    top = max(0, (high - side) // 2)
    return (left, top, left + side, top + side)


def _tag(value: Any, limit: int = 24) -> str:
    text = _SPACE.sub(" ", str(value or "").strip())
    text = re.sub(r"^[#＃]+", "", text).strip(" ,，、;；|/")
    return text[:limit]


def _dimension_key(value: Any) -> str:
    raw = str(value or "").strip().lower()
    return re.sub(r"[^A-Za-z0-9_-]+", "_", raw)[:40]


def _bounded_tags(values: Any, limit: int, split_text: bool = False) -> list:
    if split_text and isinstance(values, str):
        values = _TAG_SPLIT.split(values)
    pieces = values if isinstance(values, list) else []
    chosen, known = [], set()
    for value in pieces:
        tag = _tag(value)
        if tag and tag not in known and len(chosen) < limit:
            known.add(tag)
            chosen.append(tag)
    return chosen


def clean_labels(raw: Any, clock: int, names: Mapping[str, str] | None = None) -> dict:
    source = raw if isinstance(raw, dict) else {}
    grouped = source.get("categories") if isinstance(source.get("categories"), dict) else {}
    titles = names or {}
    clean_categories, flat = {}, []
    for key, values in grouped.items():
        norm_key = _dimension_key(key)
        picked = _bounded_tags(values, 8, split_text=True) if norm_key else []
        if not picked:
            continue
        clean_categories[norm_key] = picked
        label = str(titles.get(norm_key) or norm_key)
        flat.extend({"dimension": norm_key, "label": label, "tag": tag} for tag in picked)
    clean_tags = _bounded_tags(source.get("tags"), 20)
    flat.extend({"dimension": "tags", "label": "标签", "tag": tag} for tag in clean_tags)
    unique = {}
    for item in flat:
        unique.setdefault(f"{item['dimension']}::{item['tag']}", item)
    return {
        "summary": str(source.get("summary") or "").strip()[:240],
        "categories": clean_categories,
        "tags": clean_tags,
        "flat": list(unique.values()),
        "updated_at": int(clock),
    }


def same_members(left: Iterable[Any], right: Iterable[Any]) -> bool:
    first = list(left)
    second = list(right)
    return len(first) == len(second) and set(first) == set(second)


def _extension_of(item: Mapping[str, Any]) -> str:
    text = str(item.get("url") or item.get("name") or "").split("?", 1)[0]
    return os.path.splitext(text)[1].lower().lstrip(".")


def _filter_kind(item: Mapping[str, Any]) -> str:
    kind = item.get("kind")
    if kind in FILTER_KINDS:
        return str(kind)
    ext = _extension_of(item)
    if ext in FILTER_VIDEO:
        return "video"
    if ext in FILTER_AUDIO:
        return "audio"
    return "image"


def matches(item: Mapping[str, Any] | None, filters: Mapping[str, Any] | None) -> bool:
    record = item or {}
    rules = filters or {}
    classification = record.get("classification") if isinstance(record.get("classification"), dict) else {}
    categories = classification.get("categories") if isinstance(classification.get("categories"), dict) else {}
    tags = classification.get("tags") if isinstance(classification.get("tags"), list) else []
    kind = _filter_kind(record)
    if rules.get("kind") and kind != rules.get("kind"):
        return False
    ext = _extension_of(record)
    if rules.get("format") and ext not in str(rules.get("format") or "").lower().split(","):
        return False
    for dimension in FILTER_DIMENSIONS:
        wanted = [piece.strip().lower() for piece in _TAG_SPLIT.split(str(rules.get(dimension) or "")) if piece.strip()]
        actual = tags if dimension == "tags" else categories.get(dimension, [])
        folded = [str(value).lower() for value in actual] if isinstance(actual, list) else []
        if wanted and not any(piece in folded for piece in wanted):
            return False
    try:
        width = int(record.get("width") or record.get("natural_w") or 0)
        height = int(record.get("height") or record.get("natural_h") or 0)
    except (TypeError, ValueError):
        width, height = 0, 0
    shape = rules.get("shape") or ""
    try:
        minimum = int(rules.get("min_edge") or 0)
    except (TypeError, ValueError):
        minimum = 0
    relation = {"landscape": width > height, "portrait": width < height, "square": width == height}
    if ((shape or minimum) and not (width and height)) or (minimum and min(width, height) < minimum):
        return False
    if shape in relation and not relation[shape]:
        return False
    manual = classification.get("manual")
    if rules.get("annotated") == "manual" and not manual:
        return False
    if rules.get("annotated") == "missing" and (tags or categories or classification.get("summary")):
        return False
    query = str(rules.get("query") or "").strip().lower()
    if not query:
        return True
    parts = [
        str(record.get(key) or "")
        for key in ("name", "url", "folder", "rel", "file")
    ]
    parts.append(str(classification.get("summary") or ""))
    parts.extend(str(tag) for tag in tags)
    for values in categories.values():
        if isinstance(values, list):
            parts.extend(str(value) for value in values)
    haystack = " ".join(parts).lower()
    return all(word in haystack for word in _QUERY_SPLIT.split(query) if word)


