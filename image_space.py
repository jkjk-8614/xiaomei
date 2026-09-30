"""Image-space filtering and classification overrides."""
import copy
import os
import re


def merge_classification(raw, normalize):
    raw = raw if isinstance(raw, dict) else {}
    ai = normalize(raw.get("ai", raw))
    manual = copy.deepcopy(raw.get("manual") or {})
    effective = copy.deepcopy(ai)
    if "summary" in manual:
        effective["summary"] = manual["summary"]
    if "tags" in manual:
        effective["tags"] = manual["tags"]
    effective["categories"].update(manual.get("categories") or {})
    result = normalize(effective)
    result.update(ai=ai, manual=manual)
    return result


def replace_ai(previous, new, normalize):
    return merge_classification({"ai": new, "manual": (previous or {}).get("manual", {})}, normalize)


def matches_filters(item, filters):
    classification = item.get("classification") or {}
    categories = classification.get("categories") or {}
    tags = classification.get("tags") or []
    ext = os.path.splitext(str(item.get("url") or item.get("name") or "").split("?")[0])[1].lower().lstrip(".")
    kind = item.get("kind")
    if kind not in {"image", "video", "audio", "text"}:
        kind = "video" if ext in {"mp4", "webm", "mov", "m4v", "avi", "mkv"} else "image"
    if filters.get("kind") and kind != filters["kind"]:
        return False
    if filters.get("format") and ext not in filters["format"].lower().split(","):
        return False
    for dimension in ("color", "materials", "style", "use_case", "tags"):
        wanted = [t.strip().lower() for t in re.split(r"[,，、\n]+", str(filters.get(dimension) or "")) if t.strip()]
        actual = tags if dimension == "tags" else categories.get(dimension, [])
        if wanted and not any(t in [str(v).lower() for v in actual] for t in wanted):
            return False
    width = item.get("width") or item.get("natural_w") or 0
    height = item.get("height") or item.get("natural_h") or 0
    shape = filters.get("shape")
    minimum = int(filters.get("min_edge") or 0)
    if (shape or minimum) and not (width and height):
        return False
    if minimum and min(width, height) < minimum:
        return False
    if shape == "landscape" and width <= height:
        return False
    if shape == "portrait" and width >= height:
        return False
    if shape == "square" and width != height:
        return False
    if filters.get("annotated") == "manual" and not classification.get("manual"):
        return False
    if filters.get("annotated") == "missing" and (tags or categories or classification.get("summary")):
        return False
    query = str(filters.get("query") or "").strip().lower()
    text = " ".join(str(item.get(k) or "") for k in ("name", "url", "folder", "rel", "file"))
    text += " " + str(classification.get("summary") or "") + " " + " ".join(tags)
    text += " " + " ".join(str(v) for values in categories.values() for v in values)
    return all(word in text.lower() for word in query.split())
