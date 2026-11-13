"""Prompt cases and the images they preserve or reference."""

import json
import os
import re
import shutil
import time
import uuid
from contextlib import contextmanager
from pathlib import Path
from threading import Lock

from PIL import Image

import media_formats
import media_paths
from asset_kernel import display_name
from design_brain_store import (
    normalize_case_analysis,
    normalize_case_origin,
    normalize_case_profile_links,
    normalize_media_asset_ref,
)


_DEFAULT_CATEGORIES = {
    "product": "商品主图", "detail": "详情页", "scene": "场景图",
    "portrait": "人物/模特", "advertising": "广告/海报",
}
_INVALID_ID = re.compile(r"[^A-Za-z0-9_-]+")
_INVALID_CATEGORY_NAME = re.compile(r"[\x00-\x1f<>:\\|?*]+")
_SPACES = re.compile(r"\s+")
_REMOTE_IMAGE = ("http://", "https://", "data:image/")
_MISSING_COVER = "提示词案例封面素材不存在，请先保留画布结果后再收藏"


class PromptCaseError(ValueError):
    def __init__(self, status, message):
        super().__init__(message)
        self.status = status


def _now():
    return time.time_ns() // 1_000_000


def _dict(value):
    return value if isinstance(value, dict) else {}


def _list(value):
    return value if isinstance(value, list) else []


def _text(value):
    return str(value or "").strip()


def _integer(value, default=0):
    try:
        return int(value or default)
    except (TypeError, ValueError, OverflowError):
        return default


def _id(value):
    return _INVALID_ID.sub("_", str(value or ""))[:60]


def _category_id(value):
    return _id(value) or "product"


def _category_name(value, fallback):
    return (_SPACES.sub(" ", _INVALID_CATEGORY_NAME.sub(" ", _text(value))).strip() or fallback)[:40]


def _categories(values):
    if not isinstance(values, list):
        return [{"id": key, "name": name, "builtin": True} for key, name in _DEFAULT_CATEGORIES.items()]
    categories = {}
    for group in values:
        if not isinstance(group, dict):
            continue
        key = _category_id(group.get("id") or group.get("name"))
        if key != "uncategorized":
            categories.setdefault(key, {
                **group,
                "id": key,
                "name": _category_name(group.get("name"), key),
                "builtin": bool(group.get("builtin") or key in _DEFAULT_CATEGORIES),
            })
    return list(categories.values())


def _tags(value):
    return list(dict.fromkeys(
        tag for raw in _list(value)[:30] if (tag := _SPACES.sub(" ", _text(raw))[:40])
    ))


def _media(raw, name, *, reference=False):
    row = {"url": raw} if isinstance(raw, str) else _dict(raw)
    url = _text(row.get("url") or row.get("source_url"))
    if not url:
        return {}
    item = {
        "url": url,
        "source_url": _text(row.get("source_url") or row.get("original_url") or url),
        "name": _SPACES.sub(" ", _text(row.get("name") or name))[:160],
        "kind": "image",
    }
    if row.get("missing_snapshot"):
        item["missing_snapshot"] = True
    for key in ("width", "height", "natural_w", "natural_h"):
        size = _integer(row.get(key))
        if size > 0:
            item[key] = size
    asset = normalize_media_asset_ref(row.get("asset_ref_id"))
    if asset:
        item["asset_ref_id"] = asset
    if reference:
        item.update({key: row[key] for key in ("role", "node_id", "image_index") if row.get(key) not in (None, "")})
    return item


def _media_list(values, label, *, reference=False):
    items = (_media(item, f"{label} {index}", reference=reference)
             for index, item in enumerate(_list(values), 1))
    return [item for item in items if item]


def _source(row, variants):
    urls = [_text(value) for value in _list(row.get("media_urls"))]
    if not any(urls):
        urls = [item["source_url"] or item["url"] for item in variants]
    run_at = str(row.get("run_at") or "")
    return {
        "canvas_id": _text(row.get("canvas_id"))[:120],
        "canvas_title": _text(row.get("canvas_title"))[:160],
        "node_id": _text(row.get("node_id"))[:120],
        "run_at": _integer(run_at),
        "media_urls": list(dict.fromkeys(filter(None, urls)))[:32],
    }


def _case_view(raw, category_ids, timestamp):
    prompt = _dict(raw.get("prompt"))
    display = _text(prompt.get("display") or raw.get("display_prompt") or raw.get("prompt_text"))
    mode = "refs" if raw.get("media_mode") == "refs" else "copy"
    variants = _media_list(raw.get("variants"), "变体")
    if not variants or (mode == "copy" and not display):
        return None
    category = _id(raw.get("category"))
    if category not in category_ids:
        category = next(iter(category_ids), "")
    created = _integer(raw.get("created_at"), timestamp)
    first_line = display.splitlines()[0][:40] if display else ""
    return {
        "id": raw["id"],
        "title": display_name(raw.get("title") or first_line, "生成案例"),
        "category": category,
        "tags": _tags(raw.get("tags")),
        "note": _text(raw.get("note"))[:2000],
        "cover": _media(raw.get("cover"), "封面") or dict(variants[0]),
        "variants": variants,
        "prompt": {"display": display, "request": _text(prompt.get("request") or raw.get("request_prompt") or display)},
        "settings": _dict(raw.get("settings")),
        "references": _media_list(raw.get("references"), "参考图", reference=True),
        "source": _source(_dict(raw.get("source")), variants),
        "media_mode": mode,
        "analysis": normalize_case_analysis(raw.get("analysis")),
        "profile_links": normalize_case_profile_links(raw.get("profile_links")),
        "origin": normalize_case_origin(raw.get("origin")),
        "use_count": max(0, _integer(raw.get("use_count"))),
        "last_used_at": max(0, _integer(raw.get("last_used_at"))),
        "favorite": bool(raw.get("favorite")),
        "created_at": created,
        "updated_at": _integer(raw.get("updated_at"), created),
    }


def _category_ids(data):
    return dict.fromkeys(group["id"] for group in data["categories"])


def _cases(data):
    category_ids = _category_ids(data)
    visited = set()
    for raw in data["cases"]:
        if not isinstance(raw, dict) or raw["id"] in visited:
            continue
        item = _case_view(raw, category_ids, data["updated_at"])
        if item:
            visited.add(raw["id"])
            yield raw, item


def _find_case(data, case_id):
    category_ids = _category_ids(data)
    for raw in data["cases"]:
        if isinstance(raw, dict) and raw["id"] == case_id:
            case = _case_view(raw, category_ids, data["updated_at"])
            if case:
                return raw, case
    raise PromptCaseError(404, "提示词案例不存在")


def _searchable(case):
    prompt = case["prompt"]
    settings = case["settings"]
    values = [case["title"], case["note"], prompt["display"], prompt["request"],
              settings.get("model"), settings.get("provider_id"), case["source"]["canvas_title"], *case["tags"]]
    return " ".join(str(value or "") for value in values).lower()


def _asset_ids(entries):
    ids = {}
    for row in entries:
        url = _text(row.get("url"))
        key = normalize_media_asset_ref(row.get("asset_ref_id"))
        if url and key:
            ids[url] = key
    return ids


class PromptCaseLibrary:
    def __init__(self, path, media_root, resolve_media_file, write_json):
        self._path = Path(path)
        self._media_root = Path(media_root)
        self._resolve_media_file = resolve_media_file
        self._write_json = write_json
        self._lock = Lock()

    def _read(self):
        try:
            with self._path.open(encoding="utf-8-sig") as source:
                data = json.load(source)
                timestamp = os.fstat(source.fileno()).st_mtime_ns // 1_000_000
        except FileNotFoundError:
            data = {}
            timestamp = _now()
        except (OSError, ValueError, RecursionError) as exc:
            raise PromptCaseError(409, "无法读取提示词案例库文件，请检查文件后重试") from exc
        if not isinstance(data, dict) or ("cases" in data and not isinstance(data["cases"], list)):
            raise PromptCaseError(409, "提示词案例库文件格式不正确，请检查文件后重试")
        data["version"] = 1
        data["updated_at"] = _integer(data.get("updated_at"), timestamp)
        data["categories"] = _categories(data.get("categories"))
        data.setdefault("cases", [])
        for index, row in enumerate(data["cases"]):
            if not isinstance(row, dict):
                continue
            key = _id(row.get("id"))
            if not key:
                key = "case_" + uuid.uuid5(uuid.NAMESPACE_URL, f"xiaomei-prompt-cases:{index}").hex[:12]
            row["id"] = key
        return data

    def _save(self, data):
        data["updated_at"] = _now()
        self._write_json(self._path, data)

    @contextmanager
    def _edit(self):
        with self._lock:
            data = self._read()
            yield data
            self._save(data)

    def list_cases(self, query, category, sort, limit, offset, media_mode):
        with self._lock:
            data = self._read()
        term = _SPACES.sub(" ", _text(query)).lower()
        group = _category_id(category) if _text(category) else ""
        mode = _text(media_mode).lower()
        cases = [case for _, case in _cases(data)
                 if (not group or case["category"] == group)
                 and (mode not in ("copy", "refs") or case["media_mode"] == mode)
                 and (not term or term in _searchable(case))]
        if sort == "used":
            cases.sort(key=lambda case: (case["use_count"], case["last_used_at"], case["created_at"]), reverse=True)
        elif sort == "title":
            cases.sort(key=lambda case: case["title"].lower())
        else:
            cases.sort(key=lambda case: case["created_at"], reverse=True)
        start, size = max(0, offset), max(1, min(500, limit))
        return {
            "cases": cases[start:start + size], "categories": data["categories"],
            "total": len(cases), "offset": start, "limit": size, "updated_at": data["updated_at"],
        }

    def index(self):
        with self._lock:
            data = self._read()
        entries = [{
            "id": case["id"],
            "media_urls": sorted(case["source"]["media_urls"]),
            "cover_url": case["cover"]["url"],
        } for _, case in _cases(data)]
        by_media = {url: entry["id"] for entry in entries for url in entry["media_urls"]}
        return {"cases": entries, "by_media_url": by_media, "updated_at": data["updated_at"]}

    def get(self, case_id):
        with self._lock:
            data = self._read()
        _, case = _find_case(data, case_id)
        return {"case": case, "categories": data["categories"]}

    def _prepare_media(self, raw, label, *, asset_ids, required, snapshot=None, reference=False):
        item = _media(raw, label, reference=reference)
        if not item:
            return None
        url = item["url"]
        item["source_url"] = url
        path = self._resolve_media_file(url)
        if not path or not Path(path).is_file():
            if url.startswith(_REMOTE_IMAGE):
                item["missing_snapshot"] = True
            elif required:
                raise PromptCaseError(400, _MISSING_COVER)
            else:
                return None
        elif snapshot:
            directory, filename = snapshot
            if not media_formats.content_type(path).startswith("image/"):
                if required:
                    raise PromptCaseError(400, "提示词案例只支持图片结果")
                return None
            destination = directory / (filename + Path(path).suffix.lower())
            shutil.copy2(path, destination)
            item["url"] = f"/assets/prompt_cases/{directory.name}/{destination.name}"
            try:
                with Image.open(destination) as image:
                    item["width"], item["height"] = image.size
            except (OSError, ValueError, Image.DecompressionBombError):
                pass
        if url in asset_ids:
            item["asset_ref_id"] = asset_ids[url]
        return item

    def _prepare_set(self, values, directory, mode):
        refs = mode == "refs"
        assets = _asset_ids(values["asset_refs"]) if refs else {}
        input_variants = values["variants"]
        chosen = max(0, min(values["cover_index"], len(input_variants) - 1))
        groups = []
        cover = None
        for field, prefix, label, maximum in (
            ("variants", "variant", "变体", 32),
            ("references", "reference", "参考图", 32 if refs else 16),
        ):
            is_reference = field == "references"
            items = []
            for index, raw in enumerate(values[field][:maximum]):
                required = not is_reference and index == chosen
                filename = f"{prefix}-{index + 1:02d}"
                name = "参考图" if refs and is_reference else f"{label if refs else prefix} {index + 1}"
                snapshot = (directory, filename) if directory is not None else None
                item = self._prepare_media(raw, name, asset_ids=assets, required=required,
                                           snapshot=snapshot, reference=is_reference)
                if item:
                    items.append(item)
                    if required:
                        cover = item
            groups.append(items)
        variants, references = groups
        if not variants:
            message = "提示词案例至少需要一张图片" if refs else "提示词案例没有可保存的图片"
            raise PromptCaseError(400, message)
        if refs:
            cover = next((item for item in variants if not item.get("missing_snapshot")), variants[0])
        return variants, dict(cover or variants[0]), references

    def create(self, values):
        mode = "refs" if _text(values["media_mode"]).lower() == "refs" else "copy"
        prompt = values["prompt"]
        display = _text(prompt.get("display"))
        if not display and (mode == "copy" or not _text(values["title"])):
            raise PromptCaseError(400, "提示词案例缺少可编辑提示词")
        variants = [item for item in values["variants"] if _text(item.get("url") or item.get("source_url"))]
        if not variants:
            raise PromptCaseError(400, "提示词案例至少需要一张图片")
        values = {**values, "variants": variants}
        source = dict(values["source"])
        if not any(_text(url) for url in _list(source.get("media_urls"))):
            source["media_urls"] = [_text(item.get("url") or item.get("source_url")) for item in variants]
        source = _source(source, [])
        with self._lock:
            data = self._read()
            urls = set(source["media_urls"])
            for _, existing in _cases(data):
                if urls.intersection(existing["source"]["media_urls"]):
                    return {"case": existing, "existing": True, "categories": data["categories"]}
            case_id = "case_" + uuid.uuid4().hex[:12]
            directory = None
            try:
                if mode == "copy":
                    new_directory = self._media_root / case_id
                    new_directory.mkdir(parents=True)
                    directory = new_directory
                images, cover, references = self._prepare_set(values, directory, mode)
                stamp = _now()
                raw = {
                    "id": case_id, "title": values["title"], "category": values["category"],
                    "tags": values["tags"], "note": values["note"], "settings": values["settings"],
                    "prompt": {"display": display, "request": _text(prompt.get("request") or display)},
                    "variants": images, "cover": cover, "references": references, "source": source,
                    "media_mode": mode, "created_at": stamp, "updated_at": stamp,
                }
                if mode == "refs":
                    raw.update({field: values[field] for field in ("analysis", "profile_links", "origin")})
                case = _case_view(raw, _category_ids(data), stamp)
                data["cases"].insert(0, case)
                self._save(data)
            except Exception:
                if directory is not None:
                    shutil.rmtree(directory, ignore_errors=True)
                raise
        return {"case": case, "existing": False, "categories": data["categories"]}

    def update(self, case_id, fields):
        with self._edit() as data:
            raw, _ = _find_case(data, case_id)
            if fields.get("category") is not None:
                category = _category_id(fields["category"])
                if category not in _category_ids(data):
                    raise PromptCaseError(400, "提示词案例分类不存在")
                raw["category"] = category
            for key in ("tags", "note", "favorite", "analysis", "profile_links"):
                if fields.get(key) is not None:
                    raw[key] = fields[key]
            if fields.get("title") is not None:
                raw["title"] = display_name(fields["title"], "生成案例")
            raw["updated_at"] = _now()
            case = _case_view(raw, _category_ids(data), data["updated_at"])
        return {"case": case, "categories": data["categories"]}

    def delete(self, case_id):
        with self._lock:
            data = self._read()
            _, case = _find_case(data, case_id)
            data["cases"] = [item for item in data["cases"]
                             if not isinstance(item, dict) or item["id"] != case_id]
            self._save(data)
            if case["media_mode"] == "copy":
                path = media_paths.path_under(self._media_root, case_id)
                if path:
                    shutil.rmtree(path, ignore_errors=True)
        return {"ok": True, "deleted": case_id, "remaining": sum(1 for _ in _cases(data))}

    def use(self, case_id):
        with self._edit() as data:
            raw, case = _find_case(data, case_id)
            stamp = _now()
            updates = {"use_count": case["use_count"] + 1, "last_used_at": stamp, "updated_at": stamp}
            raw.update(updates)
            case.update(updates)
        return {"case": case}

    def add_category(self, name):
        name = _category_name(name, display_name(name, "新分类"))
        with self._edit() as data:
            if any(group["name"].lower() == name.lower() for group in data["categories"]):
                raise PromptCaseError(409, "分类名称已存在")
            category = {"id": "casecat_" + uuid.uuid4().hex[:10], "name": name, "builtin": False}
            data["categories"].append(category)
        return {"category": category, "categories": data["categories"]}

    def rename_category(self, category_id, name):
        name = _category_name(name, display_name(name, ""))
        if not name:
            raise PromptCaseError(400, "分类名称不能为空")
        with self._edit() as data:
            group = next((item for item in data["categories"] if item["id"] == category_id), None)
            if group is None:
                raise PromptCaseError(404, "分类不存在")
            group["name"] = name
        return {"categories": data["categories"]}

    def delete_category(self, category_id):
        if category_id == "uncategorized":
            with self._lock:
                data = self._read()
            return {"categories": data["categories"], "cases": [case for _, case in _cases(data)], "deleted": category_id}
        with self._edit() as data:
            kept = [group for group in data["categories"] if group["id"] != category_id]
            if len(kept) == len(data["categories"]):
                raise PromptCaseError(404, "分类不存在")
            fallback = kept[0]["id"] if kept else ""
            stamp = _now()
            for row in data["cases"]:
                if isinstance(row, dict) and _id(row.get("category")) == category_id:
                    row.update(category=fallback, updated_at=stamp)
            data["categories"] = kept
        return {"categories": kept, "cases": [case for _, case in _cases(data)], "deleted": category_id}
