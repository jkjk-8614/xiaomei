"""Persistent template libraries shared by the canvases and asset manager."""

import json
import logging
import os
import re
import time
import uuid
from contextlib import contextmanager
from pathlib import Path
from threading import Lock

from asset_kernel import display_name


_SYSTEM = "system"
_CATEGORIES = {
    "view": "视角", "storyboard": "分镜", "character": "角色",
    "product": "产品", "lighting": "光影", "custom": "我的",
}
_UNSAFE_ID = re.compile(r"[^A-Za-z0-9_-]+")
_TEMPLATE_FIELDS = ("name", "category", "scene", "positive", "negative")
_TEMPLATE_METADATA = ("id", "params", "favorite", "created_at", "updated_at")
_AMBIGUOUS_TEMPLATE = "多个提示词库存在同一模板，请指定提示词库"


class PromptTemplateError(ValueError):
    def __init__(self, status, message):
        super().__init__(message)
        self.status = status


def _now():
    return time.time_ns() // 1_000_000


def _time(value, fallback):
    try:
        return int(value or fallback)
    except (TypeError, ValueError, OverflowError):
        return fallback


def _identifier(value, limit):
    return _UNSAFE_ID.sub("_", str(value or ""))[:limit]


def _category(value):
    key = _identifier(value, 40)
    return "custom" if not key or key in {"mine", "my", "personal"} else key


def _new_id(prefix, length=12):
    return prefix + "_" + uuid.uuid4().hex[:length]


def _legacy_id(prefix, location):
    digest = uuid.uuid5(uuid.NAMESPACE_URL, "xiaomei-prompt-templates:" + location)
    return prefix + "_" + digest.hex[:12]


def _records(value):
    return value if isinstance(value, list) else []


def _normalize_template(raw, fallback_id, timestamp):
    created = _time(raw.get("created_at"), timestamp)
    return {
        **raw,
        "id": _identifier(raw.get("id") or raw.get("item_id"), 60) or fallback_id,
        "name": display_name(raw.get("name"), "提示词"),
        "category": _category(raw.get("category")),
        "scene": str(raw.get("scene") or ""),
        "positive": str(raw.get("positive") or raw.get("text") or ""),
        "negative": str(raw.get("negative") or ""),
        "params": raw["params"] if isinstance(raw.get("params"), dict) else {},
        "favorite": bool(raw.get("favorite")),
        "created_at": created,
        "updated_at": _time(raw.get("updated_at"), created),
    }


def _normalize_categories(raw, is_system):
    if not isinstance(raw, list) and is_system:
        return [{"id": key, "name": name} for key, name in _CATEGORIES.items()]
    groups = {}
    for group in _records(raw):
        if not isinstance(group, dict):
            continue
        key = _category(group.get("id") or group.get("name"))
        if is_system or key not in _CATEGORIES:
            groups.setdefault(key, {**group, "id": key, "name": display_name(group.get("name"), key)})
    return list(groups.values())


def _template_view(template):
    view = {key: template[key] for key in (*_TEMPLATE_FIELDS, *_TEMPLATE_METADATA)}
    for key in ("scene", "positive", "negative"):
        view[key] = view[key].strip()
    return view


def _library_view(library):
    view = {key: library[key] for key in ("id", "name", "type", "readonly", "system")}
    view["categories"] = [{"id": group["id"], "name": group["name"]} for group in library["categories"]]
    view["items"] = [_template_view(item) for item in library["items"]]
    return view


def _response(data, **fields):
    return {
        "library": {
            "active_library_id": data["active_library_id"],
            "libraries": [_library_view(library) for library in data["libraries"]],
            "updated_at": data["updated_at"],
        },
        **fields,
    }


def _get_library(data, library_id, *, allow_default=False):
    selected = str(library_id or data["active_library_id"])
    if allow_default:
        selected = selected.strip()
    for library in data["libraries"]:
        if library["id"] == selected:
            return library
    if allow_default:
        return data["libraries"][0]
    raise PromptTemplateError(404, "提示词库不存在")


def _find_template(data, template_id, library_id=""):
    libraries = [_get_library(data, library_id)] if library_id else data["libraries"]
    matches = [item for library in libraries for item in library["items"] if item["id"] == template_id]
    if not matches:
        raise PromptTemplateError(404, "提示词不存在")
    if len(matches) > 1:
        raise PromptTemplateError(409, _AMBIGUOUS_TEMPLATE)
    return matches[0]


class PromptTemplateLibrary:
    def __init__(self, path, preset_path, write_json):
        self._path = Path(path)
        self._preset_path = Path(preset_path)
        self._write_json = write_json
        self._lock = Lock()

    def presets(self):
        try:
            with self._preset_path.open(encoding="utf-8-sig") as source:
                entries = json.load(source)
        except (OSError, ValueError) as exc:
            logging.getLogger(__name__).warning("无法读取内置提示词模板：%s", exc)
            return []
        return [{**entry, "builtin": True} for entry in _records(entries) if isinstance(entry, dict)]

    def _normalize(self, raw, timestamp):
        records = _records(raw.get("libraries"))
        if not any(isinstance(item, dict) and item.get("id") == _SYSTEM for item in records):
            records = [{"id": _SYSTEM, "items": self.presets()}, *records]
        libraries = {}
        for index, library in enumerate(records):
            if not isinstance(library, dict):
                continue
            key = _identifier(library.get("id"), 60) or _legacy_id("lib", str(index))
            if key in libraries:
                continue
            is_system = key == _SYSTEM
            items = {}
            for position, item in enumerate(_records(library.get("items"))):
                if not isinstance(item, dict):
                    continue
                item_id = _identifier(item.get("id") or item.get("item_id"), 60)
                if not item_id:
                    item_id = _legacy_id("tpl", f"{key}/{position}")
                if item_id not in items:
                    items[item_id] = _normalize_template(item, item_id, timestamp)
            libraries[key] = {
                **library,
                "id": key,
                "name": display_name(library.get("name"), "系统提示词库" if is_system else "提示词库"),
                "type": "prompt",
                "readonly": False,
                "system": is_system,
                "categories": _normalize_categories(library.get("categories"), is_system),
                "items": list(items.values()),
            }

        active = str(raw.get("active_library_id") or _SYSTEM)
        return {
            **raw,
            "active_library_id": active if active in libraries else _SYSTEM,
            "libraries": list(libraries.values()),
            "updated_at": _time(raw.get("updated_at"), timestamp),
        }

    def _read(self, *, initialize=False):
        try:
            with self._path.open(encoding="utf-8-sig") as source:
                raw = json.load(source)
                timestamp = os.fstat(source.fileno()).st_mtime_ns // 1_000_000
        except FileNotFoundError:
            data = self._normalize({}, _now())
            if initialize:
                self._write_json(self._path, data)
            return data
        except (OSError, ValueError, RecursionError) as exc:
            raise PromptTemplateError(409, "无法读取提示词库文件，请检查文件后重试") from exc
        if not isinstance(raw, dict) or ("libraries" in raw and not isinstance(raw["libraries"], list)):
            raise PromptTemplateError(409, "提示词库文件格式不正确，请检查文件后重试")
        return self._normalize(raw, timestamp)

    def snapshot(self):
        with self._lock:
            return _response(self._read(initialize=True))

    @contextmanager
    def _edit(self):
        with self._lock:
            data = self._read()
            yield data
            data["updated_at"] = max(_now(), data["updated_at"] + 1)
            self._write_json(self._path, data)

    def create_library(self, name):
        with self._edit() as data:
            library = {
                "id": _new_id("lib"), "name": display_name(name, "提示词库"), "type": "prompt",
                "readonly": False, "system": False, "categories": [], "items": [],
            }
            data["libraries"].append(library)
            data["active_library_id"] = library["id"]
        return _response(data, prompt_library=_library_view(library))

    def rename_library(self, library_id, name):
        with self._edit() as data:
            library = _get_library(data, library_id)
            library["name"] = display_name(name, library["name"])
        return _response(data, prompt_library=_library_view(library))

    def delete_library(self, library_id):
        if library_id == _SYSTEM:
            raise PromptTemplateError(400, "系统提示词库不能删除，可以删除其中的提示词")
        with self._edit() as data:
            library = _get_library(data, library_id)
            data["libraries"].remove(library)
            if data["active_library_id"] == library_id:
                data["active_library_id"] = _SYSTEM
        return _response(data)

    def add_template(self, library_id, fields):
        if not str(fields.get("positive") or "").strip():
            raise PromptTemplateError(400, "提示词内容不能为空")
        with self._edit() as data:
            library = _get_library(data, library_id, allow_default=not library_id)
            item = _normalize_template(fields, _new_id("tpl"), _now())
            library["items"].insert(0, item)
            data["active_library_id"] = library["id"]
        return _response(data, item=_template_view(item))

    def update_template(self, template_id, library_id, fields):
        with self._edit() as data:
            item = _find_template(data, template_id, library_id)
            if fields.get("name"):
                item["name"] = display_name(fields["name"], "提示词")
            if fields.get("category"):
                item["category"] = _category(fields["category"])
            if str(fields.get("positive") or "").strip():
                item["positive"] = fields["positive"]
            for key in ("scene", "negative"):
                if key in fields:
                    item[key] = fields[key]
            item["updated_at"] = _now()
        return _response(data, item=_template_view(item))

    def set_favorite(self, template_id, favorite, library_id=""):
        with self._edit() as data:
            item = _find_template(data, template_id, library_id)
            item.update(favorite=favorite, updated_at=_now())
        return _response(data, item=_template_view(item))

    def delete_templates(self, ids, library_id="", *, single=False):
        keys = set(filter(None, ids))
        if not keys:
            raise PromptTemplateError(400, "没有选择提示词")
        removed = 0
        with self._edit() as data:
            libraries = [_get_library(data, library_id)] if library_id else data["libraries"]
            if not library_id:
                seen = set()
                for library in libraries:
                    selected = keys.intersection(item["id"] for item in library["items"])
                    if selected & seen:
                        raise PromptTemplateError(409, _AMBIGUOUS_TEMPLATE)
                    seen.update(selected)
            for library in libraries:
                items = library["items"]
                library["items"] = [item for item in items if item["id"] not in keys]
                removed += len(items) - len(library["items"])
            if single and not removed:
                raise PromptTemplateError(404, "提示词不存在")
        return _response(data, removed=1 if single else removed)

    def add_category(self, library_id, name):
        with self._edit() as data:
            library = _get_library(data, library_id, allow_default=True)
            used = {group["id"] for group in library["categories"]}
            group_id = _new_id("pcat", 10)
            while group_id in used:
                group_id = _new_id("pcat", 10)
            category = {"id": group_id, "name": display_name(name, "新分组")}
            library["categories"].append(category)
        return _response(data, category=category)

    def rename_category(self, category_id, name, library_id=""):
        name = display_name(name, "")
        if not name:
            raise PromptTemplateError(400, "分组名称不能为空")
        with self._edit() as data:
            libraries = [_get_library(data, library_id)] if library_id else data["libraries"]
            groups = [group for library in libraries for group in library["categories"]
                      if group["id"] == category_id]
            if not groups:
                raise PromptTemplateError(404, "分组不存在")
            for group in groups:
                group["name"] = name
        return _response(data)

    def delete_category(self, category_id, library_id=""):
        found = False
        with self._edit() as data:
            libraries = [_get_library(data, library_id)] if library_id else data["libraries"]
            for library in libraries:
                groups = library["categories"]
                kept = [group for group in groups if group["id"] != category_id]
                if len(kept) == len(groups):
                    continue
                found = True
                library["categories"] = kept
                fallback = kept[0]["id"] if kept else "custom"
                for item in library["items"]:
                    if item["category"] == category_id:
                        item["category"] = fallback
            if not found:
                raise PromptTemplateError(404, "分组不存在")
        return _response(data)
