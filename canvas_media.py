"""Read media references from classic and smart canvas documents."""

from collections import Counter
from hashlib import sha1
import json
import ntpath
from urllib.parse import unquote, urlsplit

import asset_kernel


LOCAL_PREFIXES = ("/assets/", "/output/", "/api/storage-files/")
TRACKED_PREFIXES = LOCAL_PREFIXES + ("http://", "https://")
_URL_FIELDS = (
    "url", "path", "src", "uri", "output", "output_url", "outputUrl", "video", "video_url", "videoUrl",
    "mp4_url", "mp4Url", "download_url", "downloadUrl", "preview_url", "previewUrl",
)
_SKIPPED = frozenset({"run", "runs", "settings", "params", "metadata", "meta", "prompt", "text", "caption", "logs"})
VISIBLE_KINDS = frozenset({"image", "video", "audio", "text"})
_MEDIA_PROPERTIES = ("natural_w", "natural_h", "width", "height", "size", "duration", "runMs")


def tracked_url(value):
    if isinstance(value, str):
        value = value.strip()
        if value.startswith(TRACKED_PREFIXES):
            return value
    return ""


def value_url(value):
    if isinstance(value, dict):
        for key in _URL_FIELDS:
            candidate = tracked_url(value.get(key))
            if candidate:
                return candidate
        return ""
    return tracked_url(value)


def decode_timeline(key, value):
    if key != "ltxTimelineData" or not isinstance(value, str):
        return None
    try:
        parsed = json.loads(value)
    except (ValueError, RecursionError):
        return None
    return parsed if isinstance(parsed, dict) else None


def walk(value, path="", *, skipped=_SKIPPED):
    pending = [(path, value)]
    while pending:
        location, current = pending.pop()
        url = value_url(current)
        if url:
            yield location, current, url
        if isinstance(current, list):
            pending.extend((f"{location}[{i}]", current[i]) for i in range(len(current) - 1, -1, -1))
        elif isinstance(current, dict):
            for key, child in reversed(current.items()):
                if key in skipped or (url and tracked_url(child) == url):
                    continue
                nested = decode_timeline(key, child)
                field = f"{location}.{key}" if location else str(key)
                pending.append((field, child if nested is None else nested))


def _path_from_url(url):
    try:
        return unquote(urlsplit(url).path)
    except ValueError:
        return ""


def kind(value, url):
    if isinstance(value, dict):
        hint = str(value.get("kind") or value.get("mediaKind") or value.get("type") or "").lower()
        for label in ("video", "audio", "text", "workflow"):
            if label in hint:
                return label
    return asset_kernel.media_kind(_path_from_url(url))


def _display_name(value, url, fallback):
    if isinstance(value, dict):
        for field in ("name", "filename", "file", "title"):
            if name := str(value.get(field) or "").strip():
                return asset_kernel.display_name(name, fallback)
    return asset_kernel.display_name(ntpath.basename(_path_from_url(url)), fallback)


def node_title(node):
    return str(node.get("title") or node.get("name") or node.get("label") or node.get("type") or "节点")[:120]


def visible_urls(canvas):
    for section in ("nodes", "logs"):
        values = canvas.get(section)
        if isinstance(values, list):
            for _, raw, url in walk(values):
                if kind(raw, url) in VISIBLE_KINDS:
                    yield url


def asset_rows(canvas, record, identify):
    nodes = canvas.get("nodes")
    if not isinstance(nodes, list):
        return []
    rows = []
    seen = set()
    canvas_id = str(record.get("id") or "")
    updated = record.get("updated_at") or 0
    created = record.get("created_at") or 0
    context = {
        "canvas_id": canvas_id,
        "canvas_title": record.get("title") or "未命名画布",
        "canvas_kind": record["kind"],
        "project": record["project"],
        "canvas_icon": record.get("icon") or "layers",
        "canvas_owner": record.get("owner") or "",
        "canvas_color": record.get("color") or "",
        "canvas_created_at": created,
        "canvas_updated_at": updated,
    }
    for index, node in enumerate(nodes):
        if not isinstance(node, dict):
            continue
        metadata = {
            "node_id": str(node.get("id") or f"node_{index}"),
            "node_title": node_title(node),
            "node_type": str(node.get("type") or ""),
            "created_at": node.get("created_at") or updated or created,
        }
        for location, raw, url in walk(node):
            if url in seen:
                continue
            seen.add(url)
            media_kind = kind(raw, url)
            if media_kind not in VISIBLE_KINDS:
                continue
            fallback = f"{record.get('title') or 'canvas'}-{len(rows) + 1}"
            media = {
                "id": sha1(f"{canvas_id}:{url}".encode("utf-8")).hexdigest()[:24],
                "asset_id": identify(canvas, raw, url),
                "url": url,
                "name": _display_name(raw, url, fallback),
                "kind": media_kind,
                "source_path": location,
            }
            if isinstance(raw, dict):
                media.update({field: raw[field] for field in _MEDIA_PROPERTIES if raw.get(field) is not None})
            rows.append({**context, **metadata, **media})
    return rows


def _clock(value):
    try:
        return int(value or 0)
    except (ValueError, TypeError, OverflowError):
        return 0


def project_index(entries, projects):
    canvases, assets = [], []
    canvas_counts, asset_counts = Counter(), Counter()
    for record, media in entries:
        canvases.append({**record, "asset_count": len(media)})
        assets.extend(media)
        canvas_counts[record["kind"]] += 1
        asset_counts[record["kind"]] += len(media)
    categories = [
        {"id": "all", "name": "全部画布", "count": len(assets), "canvas_count": len(canvases)},
        *(
            {"id": label, "name": name, "count": asset_counts[label], "canvas_count": canvas_counts[label]}
            for label, name in (("smart", "智能画布"), ("classic", "普通画布"))
        ),
    ]
    canvases.sort(key=lambda item: (not item.get("pinned"), -_clock(item.get("updated_at") or item.get("created_at"))))
    assets.sort(key=lambda item: _clock(item.get("canvas_updated_at") or item.get("created_at")), reverse=True)
    return {"categories": categories, "projects": projects, "canvases": canvases, "items": assets}
