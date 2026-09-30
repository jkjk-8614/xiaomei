"""Persistent, compatibility-first media asset registry.

The application still serves media from its existing directories.  This store
only gives those files stable IDs, aliases, lineage, and a reversible trash
state; it never moves or scans user files by itself.  Callers own filesystem
operations and use this module as the durable metadata contract.
"""

from __future__ import annotations

import copy
import json
import os
import re
import tempfile
import threading
import time
import uuid
from typing import Any, Dict, Iterable, List, Optional
from urllib.parse import unquote


SCHEMA_VERSION = 1
ASSET_ID_RE = re.compile(r"^asset_[A-Za-z0-9_-]{6,80}$")


def now_ms() -> int:
    return int(time.time() * 1000)


def is_asset_id(value: Any) -> bool:
    return bool(ASSET_ID_RE.fullmatch(str(value or "").strip()))


def normalize_url(value: Any) -> str:
    """Normalize a URL enough for identity lookup without changing delivery."""
    text = str(value or "").strip().replace("\\", "/")
    if not text:
        return ""
    return text


def url_key(value: Any) -> str:
    """Return the compatibility lookup key for a media URL.

    Local media routes may gain cache-busting query strings, so those are not
    part of their identity.  Remote URLs retain query strings because they can
    identify different upstream resources.
    """
    url = normalize_url(value)
    if not url:
        return ""
    lowered = url.lower()
    if lowered.startswith(("/assets/", "/output/", "/api/storage-files/")):
        return unquote(url.split("?", 1)[0].split("#", 1)[0]).replace("\\", "/")
    return url.split("#", 1)[0]


def _asset_id() -> str:
    return f"asset_{uuid.uuid4().hex[:16]}"


def _int(value: Any, fallback: int = 0) -> int:
    try:
        return int(float(value))
    except (TypeError, ValueError):
        return fallback


def _clean_kind(value: Any) -> str:
    kind = str(value or "").strip().lower()
    return kind if kind in {"image", "video", "audio", "workflow", "file"} else "file"


def _clean_source(value: Any) -> str:
    source = re.sub(r"[^a-z0-9_-]+", "_", str(value or "legacy").strip().lower())
    return source[:48] or "legacy"


def _clean_name(value: Any, fallback: str = "素材") -> str:
    text = re.sub(r"[\x00-\x1f\x7f]", "", str(value or ""))
    text = re.sub(r"\s+", " ", text).strip()
    return text[:160] or fallback


def _clean_parent_ids(value: Any) -> List[str]:
    raw = value if isinstance(value, list) else [value]
    result: List[str] = []
    for item in raw:
        text = str(item or "").strip()
        if is_asset_id(text) and text not in result:
            result.append(text)
    return result


def _clean_metadata(value: Any) -> Dict[str, Any]:
    if not isinstance(value, dict):
        return {}
    try:
        copied = json.loads(json.dumps(value, ensure_ascii=False))
    except (TypeError, ValueError):
        return {}
    return copied if isinstance(copied, dict) else {}


def _default_store() -> Dict[str, Any]:
    return {
        "schema_version": SCHEMA_VERSION,
        "updated_at": now_ms(),
        "assets": {},
        "url_index": {},
    }


class AssetRegistry:
    """Small JSON-backed asset registry with atomic persistence.

    The registry deliberately avoids holding absolute source paths in its core
    schema.  Callers may place private recovery data under ``metadata`` when a
    reversible filesystem operation needs it; API layers should omit that data
    from public responses.
    """

    def __init__(self, path: str):
        self.path = os.path.abspath(path)
        self._lock = threading.RLock()
        self._data: Optional[Dict[str, Any]] = None

    def _load_locked(self) -> Dict[str, Any]:
        if self._data is not None:
            return self._data
        try:
            with open(self.path, "r", encoding="utf-8-sig") as handle:
                raw = json.load(handle)
        except (FileNotFoundError, json.JSONDecodeError, OSError):
            raw = _default_store()
        self._data = self._normalize_store(raw)
        return self._data

    def _normalize_store(self, raw: Any) -> Dict[str, Any]:
        data = _default_store()
        if not isinstance(raw, dict):
            return data
        assets = raw.get("assets") if isinstance(raw.get("assets"), dict) else {}
        normalized_assets: Dict[str, Dict[str, Any]] = {}
        for candidate_id, raw_record in assets.items():
            if not is_asset_id(candidate_id) or not isinstance(raw_record, dict):
                continue
            record = self._normalize_record(candidate_id, raw_record)
            normalized_assets[candidate_id] = record
        data["assets"] = normalized_assets
        data["updated_at"] = _int(raw.get("updated_at"), now_ms())
        self._rebuild_url_index(data)
        return data

    def _normalize_record(self, asset_id: str, raw: Dict[str, Any]) -> Dict[str, Any]:
        created_at = _int(raw.get("created_at"), now_ms())
        canonical_url = normalize_url(raw.get("canonical_url") or raw.get("url"))
        aliases: List[str] = []
        for value in raw.get("aliases") if isinstance(raw.get("aliases"), list) else []:
            item = normalize_url(value)
            if item and item != canonical_url and item not in aliases:
                aliases.append(item)
        return {
            "id": asset_id,
            "name": _clean_name(raw.get("name")),
            "kind": _clean_kind(raw.get("kind")),
            "source": _clean_source(raw.get("source")),
            "canonical_url": canonical_url,
            "aliases": aliases,
            "derived_from": _clean_parent_ids(raw.get("derived_from")),
            "size": max(0, _int(raw.get("size"))),
            "mime": str(raw.get("mime") or "").strip()[:160],
            "created_at": created_at,
            "updated_at": _int(raw.get("updated_at"), created_at),
            "deleted_at": max(0, _int(raw.get("deleted_at"))),
            "metadata": _clean_metadata(raw.get("metadata")),
        }

    @staticmethod
    def _rebuild_url_index(data: Dict[str, Any]) -> None:
        index: Dict[str, str] = {}
        for asset_id, record in (data.get("assets") or {}).items():
            if not isinstance(record, dict):
                continue
            for value in [record.get("canonical_url"), *(record.get("aliases") or [])]:
                key = url_key(value)
                if key and key not in index:
                    index[key] = asset_id
        data["url_index"] = index

    def _write_locked(self) -> None:
        data = self._load_locked()
        data["updated_at"] = now_ms()
        os.makedirs(os.path.dirname(self.path), exist_ok=True)
        fd, temporary = tempfile.mkstemp(prefix=".asset_registry_", suffix=".tmp", dir=os.path.dirname(self.path))
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as handle:
                json.dump(data, handle, ensure_ascii=False, indent=2)
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(temporary, self.path)
        finally:
            try:
                if os.path.exists(temporary):
                    os.remove(temporary)
            except OSError:
                pass

    def get(self, asset_id: Any) -> Optional[Dict[str, Any]]:
        asset_id = str(asset_id or "").strip()
        with self._lock:
            record = self._load_locked().get("assets", {}).get(asset_id)
            return copy.deepcopy(record) if isinstance(record, dict) else None

    def find_by_url(self, value: Any, include_deleted: bool = True) -> Optional[Dict[str, Any]]:
        key = url_key(value)
        if not key:
            return None
        with self._lock:
            data = self._load_locked()
            asset_id = data.get("url_index", {}).get(key)
            record = data.get("assets", {}).get(asset_id) if asset_id else None
            if not isinstance(record, dict):
                return None
            if not include_deleted and _int(record.get("deleted_at")):
                return None
            return copy.deepcopy(record)

    def register(
        self,
        *,
        url: Any,
        requested_id: Any = "",
        name: Any = "",
        kind: Any = "file",
        source: Any = "legacy",
        derived_from: Any = None,
        size: Any = 0,
        mime: Any = "",
        created_at: Any = 0,
        metadata: Any = None,
    ) -> Optional[Dict[str, Any]]:
        canonical_url = normalize_url(url)
        if not canonical_url:
            return None
        desired_id = str(requested_id or "").strip() if is_asset_id(requested_id) else ""
        key = url_key(canonical_url)
        with self._lock:
            data = self._load_locked()
            assets = data.setdefault("assets", {})
            indexed_id = data.setdefault("url_index", {}).get(key) if key else ""
            if desired_id and desired_id in assets:
                asset_id = desired_id
            elif indexed_id and indexed_id in assets:
                asset_id = indexed_id
            else:
                asset_id = desired_id or _asset_id()
                while asset_id in assets:
                    asset_id = _asset_id()

            existing = assets.get(asset_id)
            if not isinstance(existing, dict):
                timestamp = _int(created_at, now_ms()) or now_ms()
                existing = {
                    "id": asset_id,
                    "name": _clean_name(name),
                    "kind": _clean_kind(kind),
                    "source": _clean_source(source),
                    "canonical_url": canonical_url,
                    "aliases": [],
                    "derived_from": _clean_parent_ids(derived_from),
                    "size": max(0, _int(size)),
                    "mime": str(mime or "").strip()[:160],
                    "created_at": timestamp,
                    "updated_at": now_ms(),
                    "deleted_at": 0,
                    "metadata": _clean_metadata(metadata),
                }
                assets[asset_id] = existing
                changed = True
            else:
                changed = False
                previous_url = normalize_url(existing.get("canonical_url"))
                if canonical_url and canonical_url != previous_url:
                    aliases = list(existing.get("aliases") or [])
                    if previous_url and previous_url not in aliases:
                        aliases.append(previous_url)
                    next_aliases = [item for item in aliases if item != canonical_url][-80:]
                    if existing.get("aliases") != next_aliases:
                        existing["aliases"] = next_aliases
                        changed = True
                    existing["canonical_url"] = canonical_url
                    changed = True
                if name:
                    next_name = _clean_name(name, existing.get("name") or "素材")
                    if existing.get("name") != next_name:
                        existing["name"] = next_name
                        changed = True
                if kind:
                    next_kind = _clean_kind(kind)
                    if existing.get("kind") != next_kind:
                        existing["kind"] = next_kind
                        changed = True
                if source:
                    next_source = _clean_source(source)
                    current_source = _clean_source(existing.get("source"))
                    # Canvas/history reads are references, not ownership.  Do
                    # not erase a known upload/generated/library origin just
                    # because the same URL is later opened on a canvas.
                    if (
                        (current_source in {"legacy", "canvas"} or next_source not in {"legacy", "canvas"})
                        and existing.get("source") != next_source
                    ):
                        existing["source"] = next_source
                        changed = True
                parent_ids = _clean_parent_ids(derived_from)
                if parent_ids and existing.get("derived_from") != parent_ids:
                    existing["derived_from"] = parent_ids
                    changed = True
                next_size = _int(size)
                if next_size > 0 and _int(existing.get("size")) != next_size:
                    existing["size"] = next_size
                    changed = True
                if mime:
                    next_mime = str(mime).strip()[:160]
                    if existing.get("mime") != next_mime:
                        existing["mime"] = next_mime
                        changed = True
                if isinstance(metadata, dict):
                    current_metadata = existing.get("metadata") if isinstance(existing.get("metadata"), dict) else {}
                    next_metadata = dict(current_metadata)
                    next_metadata.update(_clean_metadata(metadata))
                    if current_metadata != next_metadata:
                        existing["metadata"] = next_metadata
                        changed = True
                if _int(existing.get("deleted_at")):
                    existing["deleted_at"] = 0
                    changed = True
                if changed:
                    existing["updated_at"] = now_ms()

            if changed:
                self._rebuild_url_index(data)
                self._write_locked()
            return copy.deepcopy(existing)

    def update_metadata(self, asset_id: Any, values: Dict[str, Any]) -> Optional[Dict[str, Any]]:
        asset_id = str(asset_id or "").strip()
        with self._lock:
            data = self._load_locked()
            record = data.get("assets", {}).get(asset_id)
            if not isinstance(record, dict):
                return None
            metadata = record.get("metadata") if isinstance(record.get("metadata"), dict) else {}
            metadata.update(_clean_metadata(values))
            record["metadata"] = metadata
            record["updated_at"] = now_ms()
            self._write_locked()
            return copy.deepcopy(record)

    def trash(self, asset_id: Any, metadata: Optional[Dict[str, Any]] = None) -> Optional[Dict[str, Any]]:
        asset_id = str(asset_id or "").strip()
        with self._lock:
            data = self._load_locked()
            record = data.get("assets", {}).get(asset_id)
            if not isinstance(record, dict):
                return None
            if isinstance(metadata, dict):
                current = record.get("metadata") if isinstance(record.get("metadata"), dict) else {}
                current.update(_clean_metadata(metadata))
                record["metadata"] = current
            record["deleted_at"] = now_ms()
            record["updated_at"] = now_ms()
            self._write_locked()
            return copy.deepcopy(record)

    def restore(self, asset_id: Any) -> Optional[Dict[str, Any]]:
        asset_id = str(asset_id or "").strip()
        with self._lock:
            data = self._load_locked()
            record = data.get("assets", {}).get(asset_id)
            if not isinstance(record, dict):
                return None
            record["deleted_at"] = 0
            record["updated_at"] = now_ms()
            self._write_locked()
            return copy.deepcopy(record)

    def purge(self, asset_id: Any) -> bool:
        asset_id = str(asset_id or "").strip()
        with self._lock:
            data = self._load_locked()
            record = data.get("assets", {}).get(asset_id)
            if not isinstance(record, dict):
                return False
            data["assets"].pop(asset_id, None)
            self._rebuild_url_index(data)
            self._write_locked()
            return True

    def list(
        self,
        *,
        query: str = "",
        kind: str = "",
        source: str = "",
        include_deleted: bool = False,
        offset: int = 0,
        limit: int = 100,
    ) -> Dict[str, Any]:
        phrase = str(query or "").strip().lower()
        kind = str(kind or "").strip().lower()
        source = str(source or "").strip().lower()
        offset = max(0, _int(offset))
        limit = max(1, min(500, _int(limit, 100)))
        with self._lock:
            records = [copy.deepcopy(item) for item in self._load_locked().get("assets", {}).values() if isinstance(item, dict)]
        result = []
        for item in records:
            if not include_deleted and _int(item.get("deleted_at")):
                continue
            if kind and item.get("kind") != kind:
                continue
            if source and item.get("source") != source:
                continue
            if phrase:
                haystack = " ".join(
                    [
                        str(item.get("id") or ""),
                        str(item.get("name") or ""),
                        str(item.get("source") or ""),
                        str(item.get("canonical_url") or ""),
                    ]
                ).lower()
                if phrase not in haystack:
                    continue
            result.append(item)
        result.sort(key=lambda item: (bool(_int(item.get("deleted_at"))), -_int(item.get("updated_at"))))
        return {"total": len(result), "items": result[offset : offset + limit], "offset": offset, "limit": limit}

    def stats(self) -> Dict[str, int]:
        with self._lock:
            records = list(self._load_locked().get("assets", {}).values())
        return {
            "total": len(records),
            "active": sum(1 for item in records if not _int((item or {}).get("deleted_at"))),
            "trashed": sum(1 for item in records if _int((item or {}).get("deleted_at"))),
        }

    def records(self) -> List[Dict[str, Any]]:
        """Return a snapshot for maintenance operations such as path moves."""
        with self._lock:
            records = self._load_locked().get("assets", {}).values()
            return [copy.deepcopy(item) for item in records if isinstance(item, dict)]
