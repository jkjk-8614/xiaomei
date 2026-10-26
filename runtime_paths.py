"""Keep mutable desktop state separate from the installed application files.

Older Xiaomei Canvas releases stored their database beside the application
files.  An in-place desktop update replaces (and, for NSIS, deletes) the whole
installation directory before the new process starts, so migrating only at
startup is too late once the old directory is gone.  The installer preserves
the legacy directories before it removes the old application; the helpers in
this module then merge that preserved copy into the user data root.

Two historical layouts have to be supported:

* ``<install>/resources/app/data/canvases`` (the normal packaged layout), and
* ``<install>/resources/app/data/data/canvases`` (older migration code copied
  ``data`` into an already existing ``data`` directory, producing a second
  level).

The merge never replaces an existing user file.  JSON collections
(``projects.json``, ``api_providers.json`` and ``api_key_profiles.json``) are
merged by stable ID so a new, empty installation cannot hide old projects or
model configuration.
"""

from __future__ import annotations

import copy
import errno
import hashlib
import json
import os
import re
import shutil
import sqlite3
import tempfile
import time
from pathlib import Path
from typing import Any, Iterable

# Bump this when the migration rules change.  A user who still has any of the
# older one-shot markers must run the new pass once.
MIGRATION_VERSION = 3

_LEGACY_TOP_LEVEL_DIRS = ("data", "assets", "output", ".xiaomei-data")
_LEGACY_TOP_LEVEL_FILES = ("history.json", "global_config.json")
_BULK_DATA_CHILDREN = {
    "models",
    "browser_agent_profile",
    "commerce_analysis_browser_profile",
    "media_previews",
    "asset_trash",
}
_BULK_TOP_LEVEL = {"output", ".xiaomei-data"}

_PROJECTS_FILE = "projects.json"
_PROVIDERS_FILE = "api_providers.json"
_KEY_PROFILES_FILE = "api_key_profiles.json"

_PROVIDER_LIST_FIELDS = ("image_models", "chat_models", "video_models", "vision_models", "models")
_PROVIDER_DICT_FIELDS = ("model_names", "model_protocols", "model_input_modalities")
_PROVIDER_ENTRY_FIELDS = ("rh_apps", "rh_workflows", "ms_loras")

_MODEL_KEY_FIELDS = ("id", "model", "name", "value", "label")
_ENTRY_KEY_FIELDS = ("id", "workflowId", "appId", "key", "name")


def resolve_roots(fallback_project_root: str | Path) -> tuple[Path, Path]:
    project = Path(os.path.expandvars(os.path.expanduser(
        os.environ.get("XIAOMEI_CANVAS_PROJECT_ROOT") or str(fallback_project_root)
    ))).resolve()
    configured_data = os.path.expandvars(os.path.expanduser(
        os.environ.get("XIAOMEI_CANVAS_DATA_ROOT") or str(project)
    ))
    data = Path(configured_data)
    if not data.is_absolute():
        data = project / data
    return project, data.resolve()


# ---------------------------------------------------------------------------
# Small filesystem helpers
# ---------------------------------------------------------------------------


def _resolved(path: Path) -> Path:
    try:
        return path.resolve()
    except OSError:
        return path.absolute()


def _is_cross_device(error: OSError) -> bool:
    """Return True when Windows refused a rename because of the volume."""
    winerror = getattr(error, "winerror", None)
    return winerror == 17 or getattr(error, "errno", None) == errno.EXDEV


def _should_defer_bulk(error: OSError) -> bool:
    """Large trees should never block startup on a rename we cannot do.

    Cross-volume moves and permission/sharing failures are both handled by the
    background copier.  A permission failure is more likely for an installation
    under Program Files, where the uninstaller can write but the desktop user
    cannot delete the preserved tree.
    """
    if _is_cross_device(error):
        return True
    return getattr(error, "winerror", None) in {5, 32, 33}


def _atomic_write_text(path: Path, text: str) -> bool:
    """Replace a text file atomically while keeping its contents private."""
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary_path = None
    try:
        fd, temporary_path = tempfile.mkstemp(
            prefix=f".{path.name}.", suffix=".tmp", dir=path.parent
        )
        with os.fdopen(fd, "w", encoding="utf-8", newline="") as handle:
            handle.write(text)
            handle.flush()
            try:
                os.fsync(handle.fileno())
            except OSError:
                pass
        os.replace(temporary_path, path)
        temporary_path = None
        return True
    except OSError:
        return False
    finally:
        if temporary_path:
            try:
                os.remove(temporary_path)
            except OSError:
                pass


def _atomic_write_json(path: Path, payload: Any) -> bool:
    return _atomic_write_text(
        path,
        json.dumps(payload, ensure_ascii=False, indent=2) + "\n",
    )


def _read_json(path: Path) -> tuple[bool, Any]:
    if path.is_symlink() or not path.is_file():
        return False, None
    try:
        return True, json.loads(path.read_text(encoding="utf-8-sig"))
    except (OSError, ValueError, TypeError):
        return False, None


def _read_text(path: Path) -> str | None:
    if path.is_symlink() or not path.is_file():
        return None
    try:
        return path.read_text(encoding="utf-8-sig")
    except (OSError, UnicodeError):
        return None


def _backup_unreadable(path: Path) -> Path | None:
    """Move a broken JSON file aside instead of silently overwriting it."""
    try:
        stamp = time.strftime("%Y%m%d-%H%M%S")
        backup = path.with_name(f"{path.name}.invalid-{stamp}")
        suffix = 1
        while backup.exists():
            backup = path.with_name(f"{path.name}.invalid-{stamp}-{suffix}")
            suffix += 1
        os.replace(path, backup)
        return backup
    except OSError:
        return None


def _copy_file_missing(source: Path, target: Path) -> int:
    """Copy one file only when the target does not exist yet.

    The data is written beside the target and renamed into place so a process
    crash cannot leave a half-written canvas or configuration file.
    """
    if source.is_symlink() or not source.is_file():
        return 0
    if target.exists() or target.is_symlink():
        return 0
    target.parent.mkdir(parents=True, exist_ok=True)
    temporary_path = None
    try:
        fd, temporary_path = tempfile.mkstemp(
            prefix=f".{target.name}.", suffix=".migrating", dir=target.parent
        )
        os.close(fd)
        shutil.copy2(source, temporary_path)
        # A running app may have created the file while it was being copied.
        # Never replace a file that appeared in the meantime.
        if target.exists() or target.is_symlink():
            os.remove(temporary_path)
            temporary_path = None
            return 0
        os.replace(temporary_path, target)
        temporary_path = None
        return 1
    except OSError:
        raise
    finally:
        if temporary_path:
            try:
                os.remove(temporary_path)
            except OSError:
                pass


def _copy_tree_missing(source: Path, target: Path) -> int:
    """Recursively copy files that do not exist in *target*."""
    if source.is_symlink() or not source.exists():
        return 0
    if source.is_file():
        return _copy_file_missing(source, target)
    if not source.is_dir():
        return 0
    source_resolved = _resolved(source)
    target_resolved = _resolved(target)
    if source_resolved == target_resolved or source_resolved in target_resolved.parents:
        return 0
    copied = 0
    for current, directories, files in os.walk(source):
        directories[:] = [
            name for name in directories if not (Path(current) / name).is_symlink()
        ]
        relative = Path(current).relative_to(source)
        target_directory = target / relative
        target_directory.mkdir(parents=True, exist_ok=True)
        for name in files:
            copied += _copy_file_missing(Path(current) / name, target_directory / name)
    return copied


def _move_or_merge(
    source: Path,
    target: Path,
    *,
    bulk: bool = False,
    deferred: list[dict[str, str]] | None = None,
) -> int:
    """Move a path into place, or merge it when the destination exists.

    A same-volume rename is used whenever possible.  Large directories that
    would require a cross-volume copy are deferred so the application can
    start; ``migrate_pending_bulk_data`` copies them in the background.
    """
    if source.is_symlink() or not source.exists():
        return 0
    if source.is_file():
        return _copy_file_missing(source, target)
    if not source.is_dir():
        return 0
    if not target.exists():
        target.parent.mkdir(parents=True, exist_ok=True)
        try:
            os.replace(source, target)
            return 1
        except OSError as error:
            if bulk and deferred is not None and _should_defer_bulk(error):
                deferred.append({"source": str(source), "target": str(target)})
                return 0
            return _copy_tree_missing(source, target)
    if not target.is_dir():
        return 0
    copied = 0
    for child in sorted(source.iterdir(), key=lambda item: item.name.lower()):
        copied += _move_or_merge(
            child,
            target / child.name,
            bulk=bulk,
            deferred=deferred,
        )
    return copied


def _merge_tree_move(source: Path, target: Path) -> int:
    """Move files from *source* into *target*, leaving conflicting files.

    This is used while flattening ``data/data``.  A plain copy would leave the
    nested directory behind, and the subsequent generic import could move that
    leftover back to ``data/data``, undoing the repair.
    """
    if source.is_symlink() or not source.exists():
        return 0
    if source.is_file():
        if target.exists() or target.is_symlink():
            return 0
        target.parent.mkdir(parents=True, exist_ok=True)
        try:
            os.replace(source, target)
            return 1
        except OSError:
            return _copy_file_missing(source, target)
    if not source.is_dir():
        return 0
    target.mkdir(parents=True, exist_ok=True)
    moved = 0
    try:
        children = sorted(source.iterdir(), key=lambda item: item.name.lower())
    except OSError:
        return 0
    for child in children:
        destination = target / child.name
        if not destination.exists() and not destination.is_symlink():
            try:
                os.replace(child, destination)
                moved += 1
                continue
            except OSError:
                pass
        if child.is_dir() and destination.is_dir():
            moved += _merge_tree_move(child, destination)
        # An existing file wins; the legacy duplicate is left in place.
    try:
        source.rmdir()
    except OSError:
        pass
    return moved


def _quarantine_nested_path(path: Path, data_dir: Path) -> bool:
    """Move a duplicate nested entry to a hidden folder instead of deleting it."""
    backup_dir = data_dir / ".legacy-nested-duplicates"
    try:
        backup_dir.mkdir(parents=True, exist_ok=True)
        destination = backup_dir / path.name
        if destination.exists() or destination.is_symlink():
            destination = backup_dir / f"{path.stem}-{time.time_ns()}{path.suffix}"
        os.replace(path, destination)
        return True
    except OSError:
        return False


def _flatten_nested_data(data_dir: Path) -> int:
    """Fold ``data/data/*`` back into ``data/*``.

    The old installer copied the whole data directory into a data directory
    that already existed.  Files were preserved, but the application only ever
    looked at ``data/canvases`` and never at ``data/data/canvases``.
    """
    if data_dir.is_symlink() or not data_dir.is_dir():
        return 0
    moved = 0
    for _ in range(16):
        nested = data_dir / "data"
        if nested.is_symlink() or not nested.is_dir():
            break
        try:
            children = sorted(nested.iterdir(), key=lambda item: item.name.lower())
        except OSError:
            break
        for child in children:
            destination = data_dir / child.name
            if not destination.exists() and not destination.is_symlink():
                try:
                    os.replace(child, destination)
                    moved += 1
                except OSError:
                    moved += _copy_tree_missing(child, destination)
            elif child.is_dir() and destination.is_dir():
                moved += _merge_tree_move(child, destination)
            elif child.is_file() and destination.is_file():
                # The canonical file wins, but collection files must still be
                # merged first or a nested projects.json would be invisible.
                name = child.name.lower()
                if name == _PROJECTS_FILE:
                    _merge_projects(child, destination)
                elif name == _PROVIDERS_FILE:
                    _merge_api_providers(child, destination)
                elif name == _KEY_PROFILES_FILE:
                    _merge_key_profiles(child, destination)
                _quarantine_nested_path(child, data_dir)
            else:
                # A file/directory type conflict: keep the canonical entry
                # and preserve the nested copy in the hidden duplicate folder.
                _quarantine_nested_path(child, data_dir)
        try:
            nested.rmdir()
        except OSError:
            # Conflicting names remain.  Keep them in place rather than
            # deleting anything; the next run can try again after the user
            # removes the conflict.
            break
        if not nested.exists():
            continue
        break
    return moved


def _import_plain_file(source: Path, target: Path) -> int:
    if not source.exists():
        return 0
    if target.exists() or target.is_symlink():
        return 0
    return _copy_file_missing(source, target)


# ---------------------------------------------------------------------------
# JSON collection merges
# ---------------------------------------------------------------------------


def _projects_list(payload: Any) -> list[dict[str, Any]] | None:
    values = payload.get("projects") if isinstance(payload, dict) else payload
    if not isinstance(values, list):
        return None
    return [item for item in values if isinstance(item, dict) and item.get("id")]


def _merge_projects(source_path: Path, target_path: Path) -> int:
    """Merge project records by ID; the current user file always wins."""
    if not source_path.is_file() or source_path.is_symlink():
        return 0
    source_ok, source_payload = _read_json(source_path)
    if not source_ok:
        return 0
    source_projects = _projects_list(source_payload)
    if source_projects is None:
        return 0

    if not target_path.is_file() or target_path.is_symlink():
        return _copy_file_missing(source_path, target_path)

    target_ok, target_payload = _read_json(target_path)
    if not target_ok:
        _backup_unreadable(target_path)
        return _copy_file_missing(source_path, target_path)
    target_projects = _projects_list(target_payload)
    if target_projects is None:
        return 0

    existing_ids = {str(item.get("id") or "") for item in target_projects}
    additions = []
    for item in source_projects:
        project_id = str(item.get("id") or "")
        if not project_id or project_id in existing_ids:
            continue
        additions.append(copy.deepcopy(item))
        existing_ids.add(project_id)
    if not additions:
        return 0
    merged = list(target_projects) + additions
    if isinstance(target_payload, dict):
        output = dict(target_payload)
        output["projects"] = merged
    else:
        output = {"projects": merged}
    if not _atomic_write_json(target_path, output):
        return 0
    return len(additions)


def _model_key(value: Any) -> str:
    if isinstance(value, str):
        return value.strip()
    if isinstance(value, dict):
        for key in _MODEL_KEY_FIELDS:
            text = str(value.get(key) or "").strip()
            if text:
                return text
    try:
        return json.dumps(value, ensure_ascii=False, sort_keys=True)
    except (TypeError, ValueError):
        return str(value)


def _entry_key(value: Any) -> str:
    if isinstance(value, dict):
        for key in _ENTRY_KEY_FIELDS:
            text = str(value.get(key) or "").strip()
            if text:
                return text
    if isinstance(value, str):
        return value.strip()
    try:
        return json.dumps(value, ensure_ascii=False, sort_keys=True)
    except (TypeError, ValueError):
        return str(value)


def _merge_list_field(target: dict[str, Any], key: str, source_value: Any) -> int:
    if not isinstance(source_value, list):
        return 0
    current = target.get(key)
    if not isinstance(current, list):
        current = []
    existing = {_model_key(item) for item in current}
    changed = 0
    for item in source_value:
        item_key = _model_key(item)
        if not item_key or item_key in existing:
            continue
        current.append(copy.deepcopy(item))
        existing.add(item_key)
        changed += 1
    if changed:
        target[key] = current
    elif key not in target and current:
        target[key] = current
    return changed


def _merge_dict_field(target: dict[str, Any], key: str, source_value: Any) -> int:
    if not isinstance(source_value, dict):
        return 0
    current = target.get(key)
    if not isinstance(current, dict):
        current = {}
    changed = 0
    for item_key, item_value in source_value.items():
        if item_key not in current:
            current[str(item_key)] = copy.deepcopy(item_value)
            changed += 1
    if changed:
        target[key] = current
    return changed


def _merge_entry_list_field(target: dict[str, Any], key: str, source_value: Any) -> int:
    if not isinstance(source_value, list):
        return 0
    current = target.get(key)
    if not isinstance(current, list):
        current = []
    existing = {_entry_key(item) for item in current}
    changed = 0
    for item in source_value:
        item_key = _entry_key(item)
        if not item_key or item_key in existing:
            continue
        current.append(copy.deepcopy(item))
        existing.add(item_key)
        changed += 1
    if changed:
        target[key] = current
    return changed


def _merge_provider(target: dict[str, Any], source: dict[str, Any]) -> int:
    """Fill in missing provider settings without replacing user choices.

    A new installation creates an empty default entry for the same provider
    ID.  Copying ``api_providers.json`` only when the target is missing would
    therefore lose the old model lists while keeping the API key, which is the
    exact "key exists but no models" symptom users reported.
    """
    changed = 0
    handled = {
        "id",
        *_PROVIDER_LIST_FIELDS,
        *_PROVIDER_DICT_FIELDS,
        *_PROVIDER_ENTRY_FIELDS,
    }
    for key, value in source.items():
        if key in handled:
            continue
        if key not in target or target[key] is None or target[key] == "" or target[key] == [] or target[key] == {}:
            if value is not None and value != "" and value != [] and value != {}:
                target[key] = copy.deepcopy(value)
                changed += 1
    for key in _PROVIDER_LIST_FIELDS:
        changed += _merge_list_field(target, key, source.get(key))
    for key in _PROVIDER_DICT_FIELDS:
        changed += _merge_dict_field(target, key, source.get(key))
    for key in _PROVIDER_ENTRY_FIELDS:
        changed += _merge_entry_list_field(target, key, source.get(key))
    # A user who had manually curated model lists must keep that mode; the new
    # installation's default value is False.
    if source.get("model_selection_managed") and not target.get("model_selection_managed"):
        target["model_selection_managed"] = True
        changed += 1
    return changed


def _merge_api_providers(source_path: Path, target_path: Path) -> int:
    """Union provider records by ID and restore missing model lists."""
    if not source_path.is_file() or source_path.is_symlink():
        return 0
    source_ok, source_payload = _read_json(source_path)
    if not source_ok or not isinstance(source_payload, list):
        return 0
    if not target_path.is_file() or target_path.is_symlink():
        return _copy_file_missing(source_path, target_path)
    target_ok, target_payload = _read_json(target_path)
    if not target_ok or not isinstance(target_payload, list):
        _backup_unreadable(target_path)
        return _copy_file_missing(source_path, target_path)

    target_providers = [item for item in target_payload if isinstance(item, dict)]
    by_id = {
        str(item.get("id") or ""): item
        for item in target_providers
        if item.get("id")
    }
    changed = 0
    for source_provider in source_payload:
        if not isinstance(source_provider, dict):
            continue
        provider_id = str(source_provider.get("id") or "").strip()
        if not provider_id:
            continue
        target_provider = by_id.get(provider_id)
        if target_provider is None:
            target_provider = copy.deepcopy(source_provider)
            target_providers.append(target_provider)
            by_id[provider_id] = target_provider
            changed += 1
            continue
        changed += _merge_provider(target_provider, source_provider)
    if not changed:
        return 0
    if not _atomic_write_json(target_path, target_providers):
        return 0
    return changed


def _history_key(value: Any) -> str:
    if isinstance(value, dict):
        for key in ("id", "task_id", "history_id", "filename", "file", "url", "image_url", "created_at"):
            text = str(value.get(key) or "").strip()
            if text:
                return f"{key}:{text}"
    try:
        return json.dumps(value, ensure_ascii=False, sort_keys=True)
    except (TypeError, ValueError):
        return str(value)


def _merge_history(source_path: Path, target_path: Path) -> int:
    """Keep both the current and legacy generation history."""
    if not source_path.is_file() or source_path.is_symlink():
        return 0
    source_ok, source_payload = _read_json(source_path)
    if not source_ok or not isinstance(source_payload, list):
        # A legacy file may be an old/partial format.  Preserve it verbatim
        # rather than dropping it just because it is not a JSON list.
        if not target_path.is_file() or target_path.is_symlink():
            return _copy_file_missing(source_path, target_path)
        return 0
    if not target_path.is_file() or target_path.is_symlink():
        return _copy_file_missing(source_path, target_path)
    target_ok, target_payload = _read_json(target_path)
    if not target_ok or not isinstance(target_payload, list):
        _backup_unreadable(target_path)
        return _copy_file_missing(source_path, target_path)
    existing = {_history_key(item) for item in target_payload}
    additions = []
    for item in source_payload:
        item_key = _history_key(item)
        if not item_key or item_key in existing:
            continue
        additions.append(copy.deepcopy(item))
        existing.add(item_key)
    if not additions:
        return 0
    merged = list(target_payload) + additions
    if not _atomic_write_json(target_path, merged):
        return 0
    return len(additions)


def _record_id(value: Any, keys: tuple[str, ...] = ("id", "key")) -> str:
    if not isinstance(value, dict):
        return ""
    for key in keys:
        text = str(value.get(key) or "").strip()
        if text:
            return text
    return ""


def _fill_missing_fields(target: dict[str, Any], source: dict[str, Any], skip: set[str]) -> int:
    changed = 0
    for key, value in source.items():
        if key in skip:
            continue
        if key not in target or target[key] is None or target[key] == "" or target[key] == [] or target[key] == {}:
            if value is not None and value != "" and value != [] and value != {}:
                target[key] = copy.deepcopy(value)
                changed += 1
    return changed


def _truthy_flag(value: Any) -> bool:
    if isinstance(value, str):
        return value.strip().lower() in {"1", "true", "yes", "on"}
    return bool(value)


def _promote_favorite(target: dict[str, Any], source: dict[str, Any]) -> int:
    if not _truthy_flag(source.get("favorite")):
        return 0
    if not _truthy_flag(target.get("favorite")):
        target["favorite"] = True
        return 1
    return 0


def _merge_category_list(
    target_categories: Any,
    source_categories: Any,
    merge: Any = None,
) -> tuple[int, dict[str, str], list[dict[str, Any]]]:
    """Merge ``{id,name}`` categories by id, then by name.

    The app allows renaming built-in categories while keeping their id, so id
    matching comes first.  Name matching prevents a re-created default category
    from appearing twice when an old release used a different id.
    """
    target = target_categories if isinstance(target_categories, list) else []
    by_id = {
        str(item.get("id") or ""): item
        for item in target
        if isinstance(item, dict) and item.get("id")
    }
    by_name = {
        str(item.get("name") or "").strip().casefold(): item
        for item in target
        if isinstance(item, dict) and str(item.get("name") or "").strip()
    }
    changed = 0
    id_map: dict[str, str] = {}
    for source_category in source_categories if isinstance(source_categories, list) else []:
        if not isinstance(source_category, dict):
            continue
        source_id = _record_id(source_category, ("id",))
        source_name = str(source_category.get("name") or "").strip()
        if not source_id:
            continue
        target_category = by_id.get(source_id)
        if target_category is None and source_name:
            target_category = by_name.get(source_name.casefold())
        if target_category is not None:
            target_id = _record_id(target_category, ("id",)) or source_id
            id_map[source_id] = target_id
            if merge is not None:
                changed += int(merge(target_category, source_category) or 0)
            else:
                changed += _fill_missing_fields(target_category, source_category, {"id"})
            continue
        copied = copy.deepcopy(source_category)
        target.append(copied)
        by_id[source_id] = copied
        if source_name:
            by_name[source_name.casefold()] = copied
        id_map[source_id] = source_id
        changed += 1
    return changed, id_map, [item for item in target if isinstance(item, dict)]


def _prompt_item_signature(item: Any) -> str:
    if not isinstance(item, dict):
        return ""
    name = str(item.get("name") or "").strip()
    positive = str(item.get("positive") or "").strip()
    negative = str(item.get("negative") or "").strip()
    if not (name or positive):
        return ""
    raw = f"{name}\0{positive}\0{negative}".encode("utf-8")
    return hashlib.sha256(raw).hexdigest()


def _merge_prompt_library_items(
    target_library: dict[str, Any],
    source_library: dict[str, Any],
    category_map: dict[str, str],
) -> int:
    target_items = [
        item for item in target_library.get("items", [])
        if isinstance(item, dict)
    ] if isinstance(target_library.get("items"), list) else []
    target_by_id = {
        _record_id(item, ("id",)): item
        for item in target_items
        if _record_id(item, ("id",))
    }
    target_signatures = {
        _prompt_item_signature(item): item
        for item in target_items
        if _prompt_item_signature(item)
    }
    changed = 0
    for source_item in source_library.get("items", []) if isinstance(source_library.get("items"), list) else []:
        if not isinstance(source_item, dict):
            continue
        source_id = _record_id(source_item, ("id",))
        if not source_id:
            continue
        target_item = target_by_id.get(source_id)
        signature = _prompt_item_signature(source_item)
        if target_item is None and signature:
            # Built-in template ids changed between releases; keep the target
            # copy but still restore the user's favorite flag.
            target_item = target_signatures.get(signature)
        if target_item is not None:
            changed += _promote_favorite(target_item, source_item)
            changed += _fill_missing_fields(
                target_item,
                source_item,
                {"id", "favorite", "category"},
            )
            continue
        copied = copy.deepcopy(source_item)
        category = str(copied.get("category") or "")
        if category in category_map:
            copied["category"] = category_map[category]
        copied["favorite"] = _truthy_flag(copied.get("favorite"))
        target_items.append(copied)
        target_by_id[source_id] = copied
        if signature:
            target_signatures[signature] = copied
        changed += 1
    if changed:
        target_library["items"] = target_items
    return changed


def _merge_prompt_library(target_library: dict[str, Any], source_library: dict[str, Any]) -> int:
    category_changed, category_map, categories = _merge_category_list(
        target_library.get("categories"),
        source_library.get("categories"),
    )
    if category_changed:
        target_library["categories"] = categories
    changed = category_changed
    changed += _merge_prompt_library_items(target_library, source_library, category_map)
    changed += _fill_missing_fields(
        target_library,
        source_library,
        {"id", "categories", "items"},
    )
    return changed


def _merge_prompt_libraries(source_path: Path, target_path: Path) -> int:
    if not source_path.is_file() or source_path.is_symlink():
        return 0
    source_ok, source_payload = _read_json(source_path)
    if not source_ok or not isinstance(source_payload, dict):
        if not target_path.is_file() or target_path.is_symlink():
            return _copy_file_missing(source_path, target_path)
        return 0
    source_libraries = source_payload.get("libraries")
    if not isinstance(source_libraries, list):
        return 0
    if not target_path.is_file() or target_path.is_symlink():
        return _copy_file_missing(source_path, target_path)
    target_ok, target_payload = _read_json(target_path)
    if not target_ok or not isinstance(target_payload, dict):
        _backup_unreadable(target_path)
        return _copy_file_missing(source_path, target_path)

    target_libraries = [
        item for item in target_payload.get("libraries", [])
        if isinstance(item, dict)
    ] if isinstance(target_payload.get("libraries"), list) else []
    target_by_id = {
        _record_id(item, ("id",)): item
        for item in target_libraries
        if _record_id(item, ("id",))
    }
    changed = 0
    for source_library in source_libraries:
        if not isinstance(source_library, dict):
            continue
        library_id = _record_id(source_library, ("id",))
        if not library_id:
            target_libraries.append(copy.deepcopy(source_library))
            changed += 1
            continue
        target_library = target_by_id.get(library_id)
        if target_library is None:
            copied = copy.deepcopy(source_library)
            target_libraries.append(copied)
            target_by_id[library_id] = copied
            changed += 1
            continue
        changed += _merge_prompt_library(target_library, source_library)
    if not changed:
        return 0
    target_payload["libraries"] = target_libraries
    if not target_payload.get("active_library_id") and source_payload.get("active_library_id"):
        target_payload["active_library_id"] = source_payload["active_library_id"]
    if not _atomic_write_json(target_path, target_payload):
        return 0
    return changed


def _merge_prompt_cases(source_path: Path, target_path: Path) -> int:
    if not source_path.is_file() or source_path.is_symlink():
        return 0
    source_ok, source_payload = _read_json(source_path)
    if not source_ok or not isinstance(source_payload, dict):
        if not target_path.is_file() or target_path.is_symlink():
            return _copy_file_missing(source_path, target_path)
        return 0
    source_cases = source_payload.get("cases")
    if not isinstance(source_cases, list):
        return 0
    if not target_path.is_file() or target_path.is_symlink():
        return _copy_file_missing(source_path, target_path)
    target_ok, target_payload = _read_json(target_path)
    if not target_ok or not isinstance(target_payload, dict):
        _backup_unreadable(target_path)
        return _copy_file_missing(source_path, target_path)

    category_changed, category_map, categories = _merge_category_list(
        target_payload.get("categories"),
        source_payload.get("categories"),
    )
    if category_changed:
        target_payload["categories"] = categories
    changed = category_changed
    target_cases = [
        item for item in target_payload.get("cases", [])
        if isinstance(item, dict)
    ] if isinstance(target_payload.get("cases"), list) else []
    target_by_id = {
        _record_id(item, ("id",)): item
        for item in target_cases
        if _record_id(item, ("id",))
    }
    for source_case in source_cases:
        if not isinstance(source_case, dict):
            continue
        case_id = _record_id(source_case, ("id",))
        if not case_id:
            continue
        target_case = target_by_id.get(case_id)
        if target_case is not None:
            changed += _promote_favorite(target_case, source_case)
            changed += _fill_missing_fields(target_case, source_case, {"id", "favorite", "category"})
            continue
        copied = copy.deepcopy(source_case)
        category = str(copied.get("category") or "")
        if category in category_map:
            copied["category"] = category_map[category]
        copied["favorite"] = _truthy_flag(copied.get("favorite"))
        target_cases.append(copied)
        target_by_id[case_id] = copied
        changed += 1
    if not changed:
        return 0
    target_payload["cases"] = target_cases
    target_payload.setdefault("version", 1)
    if not _atomic_write_json(target_path, target_payload):
        return 0
    return changed


def _merge_asset_items(target_category: dict[str, Any], source_category: dict[str, Any]) -> int:
    target_items = [
        item for item in target_category.get("items", [])
        if isinstance(item, dict)
    ] if isinstance(target_category.get("items"), list) else []
    target_by_id = {
        _record_id(item, ("id", "key")): item
        for item in target_items
        if _record_id(item, ("id", "key"))
    }
    changed = 0
    for source_item in source_category.get("items", []) if isinstance(source_category.get("items"), list) else []:
        if not isinstance(source_item, dict):
            continue
        item_id = _record_id(source_item, ("id", "key"))
        if not item_id:
            continue
        target_item = target_by_id.get(item_id)
        if target_item is not None:
            changed += _promote_favorite(target_item, source_item)
            changed += _fill_missing_fields(target_item, source_item, {"id", "key", "favorite"})
            continue
        copied = copy.deepcopy(source_item)
        copied["favorite"] = _truthy_flag(copied.get("favorite"))
        target_items.append(copied)
        target_by_id[item_id] = copied
        changed += 1
    if changed:
        target_category["items"] = target_items
    return changed


def _merge_asset_category(target_category: dict[str, Any], source_category: dict[str, Any]) -> int:
    changed = _merge_asset_items(target_category, source_category)
    changed += _fill_missing_fields(target_category, source_category, {"id", "items"})
    return changed


def _merge_asset_library(target_library: dict[str, Any], source_library: dict[str, Any]) -> int:
    category_changed, _category_map, categories = _merge_category_list(
        target_library.get("categories"),
        source_library.get("categories"),
        _merge_asset_category,
    )
    if category_changed:
        target_library["categories"] = categories
    changed = category_changed
    changed += _merge_asset_items(target_library, source_library)
    changed += _fill_missing_fields(target_library, source_library, {"id", "categories", "items"})
    return changed


def _merge_asset_library_file(source_path: Path, target_path: Path) -> int:
    if not source_path.is_file() or source_path.is_symlink():
        return 0
    source_ok, source_payload = _read_json(source_path)
    if not source_ok or not isinstance(source_payload, dict):
        if not target_path.is_file() or target_path.is_symlink():
            return _copy_file_missing(source_path, target_path)
        return 0
    if not target_path.is_file() or target_path.is_symlink():
        return _copy_file_missing(source_path, target_path)
    target_ok, target_payload = _read_json(target_path)
    if not target_ok or not isinstance(target_payload, dict):
        _backup_unreadable(target_path)
        return _copy_file_missing(source_path, target_path)

    changed = 0
    target_libraries = [
        item for item in target_payload.get("libraries", [])
        if isinstance(item, dict)
    ] if isinstance(target_payload.get("libraries"), list) else []
    target_by_id = {
        _record_id(item, ("id",)): item
        for item in target_libraries
        if _record_id(item, ("id",))
    }
    for source_library in source_payload.get("libraries", []) if isinstance(source_payload.get("libraries"), list) else []:
        if not isinstance(source_library, dict):
            continue
        library_id = _record_id(source_library, ("id",))
        if not library_id:
            continue
        target_library = target_by_id.get(library_id)
        if target_library is None:
            copied = copy.deepcopy(source_library)
            target_libraries.append(copied)
            target_by_id[library_id] = copied
            changed += 1
            continue
        changed += _merge_asset_library(target_library, source_library)

    category_changed, _category_map, categories = _merge_category_list(
        target_payload.get("categories"),
        source_payload.get("categories"),
        _merge_asset_category,
    )
    changed += category_changed
    if category_changed:
        target_payload["categories"] = categories
    if not changed:
        return 0
    target_payload["libraries"] = target_libraries
    if not target_payload.get("active_library_id") and source_payload.get("active_library_id"):
        target_payload["active_library_id"] = source_payload["active_library_id"]
    if not _atomic_write_json(target_path, target_payload):
        return 0
    return changed


def _merge_asset_favorites(source_path: Path, target_path: Path) -> int:
    if not source_path.is_file() or source_path.is_symlink():
        return 0
    source_ok, source_payload = _read_json(source_path)
    if not source_ok or not isinstance(source_payload, dict):
        if not target_path.is_file() or target_path.is_symlink():
            return _copy_file_missing(source_path, target_path)
        return 0
    source_items = source_payload.get("items")
    if not isinstance(source_items, list):
        return 0
    if not target_path.is_file() or target_path.is_symlink():
        return _copy_file_missing(source_path, target_path)
    target_ok, target_payload = _read_json(target_path)
    if not target_ok or not isinstance(target_payload, dict):
        _backup_unreadable(target_path)
        return _copy_file_missing(source_path, target_path)

    target_items = [
        item for item in target_payload.get("items", [])
        if isinstance(item, dict)
    ] if isinstance(target_payload.get("items"), list) else []
    target_by_key = {
        _record_id(item, ("key",)): item
        for item in target_items
        if _record_id(item, ("key",))
    }
    changed = 0
    for source_item in source_items:
        if not isinstance(source_item, dict):
            continue
        key = _record_id(source_item, ("key",))
        if not key:
            continue
        target_item = target_by_key.get(key)
        if target_item is not None:
            changed += _fill_missing_fields(target_item, source_item, {"key"})
            continue
        copied = copy.deepcopy(source_item)
        target_items.append(copied)
        target_by_key[key] = copied
        changed += 1
    if not changed:
        return 0
    target_payload["items"] = target_items
    target_payload.setdefault("version", 1)
    if not _atomic_write_json(target_path, target_payload):
        return 0
    return changed


def _merge_model_modalities(source_path: Path, target_path: Path) -> int:
    """Merge the Harness input-modality cache without replacing newer entries."""
    if not source_path.is_file() or source_path.is_symlink():
        return 0
    source_ok, source_payload = _read_json(source_path)
    if not source_ok or not isinstance(source_payload, dict):
        return 0
    source_providers = source_payload.get("providers")
    if not isinstance(source_providers, dict):
        return 0
    if not target_path.is_file() or target_path.is_symlink():
        return _copy_file_missing(source_path, target_path)
    target_ok, target_payload = _read_json(target_path)
    if not target_ok or not isinstance(target_payload, dict):
        _backup_unreadable(target_path)
        return _copy_file_missing(source_path, target_path)
    target_providers = target_payload.get("providers")
    if not isinstance(target_providers, dict):
        target_payload["providers"] = copy.deepcopy(source_providers)
        if not _atomic_write_json(target_path, target_payload):
            return 0
        return len(source_providers)

    changed = 0
    for provider_id, source_models in source_providers.items():
        if not isinstance(source_models, dict):
            continue
        target_models = target_providers.get(provider_id)
        if not isinstance(target_models, dict):
            target_providers[provider_id] = copy.deepcopy(source_models)
            changed += 1
            continue
        for model_id, source_modalities in source_models.items():
            if model_id in target_models:
                continue
            target_models[model_id] = copy.deepcopy(source_modalities)
            changed += 1
    if not changed:
        return 0
    if not target_payload.get("updatedAt") and source_payload.get("updatedAt"):
        target_payload["updatedAt"] = source_payload["updatedAt"]
    if not _atomic_write_json(target_path, target_payload):
        return 0
    return changed


def _merge_inspiration_favorites(source_path: Path, target_path: Path) -> int:
    """Merge the inspiration catalog and preserve old favorite flags.

    The catalog is a SQLite database.  A new installation may have already
    synced a fresh catalog, so copying the old database only when the target is
    missing would lose the user's ``favorite`` flags.  Rows are inserted only
    when absent (the target catalog wins) and favorites are unioned.
    """
    if not source_path.is_file() or source_path.is_symlink():
        return 0
    if not target_path.is_file() or target_path.is_symlink():
        return _copy_file_missing(source_path, target_path)
    try:
        if target_path.stat().st_size == 0:
            _backup_unreadable(target_path)
            return _copy_file_missing(source_path, target_path)
    except OSError:
        pass

    try:
        connection = sqlite3.connect(str(target_path), timeout=30)
    except sqlite3.Error:
        if _backup_unreadable(target_path):
            return _copy_file_missing(source_path, target_path)
        return 0
    attached = False
    try:
        connection.execute("PRAGMA busy_timeout=30000")
        connection.execute("ATTACH DATABASE ? AS legacy", (str(source_path),))
        attached = True
        target_columns = [
            str(row[1])
            for row in connection.execute("PRAGMA main.table_info(cases)")
            if row[1]
        ]
        source_columns = [
            str(row[1])
            for row in connection.execute("PRAGMA legacy.table_info(cases)")
            if row[1]
        ]
        common = [name for name in target_columns if name in source_columns]
        if "id" not in common or len(common) < 2:
            return 0
        columns_sql = ", ".join(f'"{name}"' for name in common)
        connection.execute("BEGIN IMMEDIATE")
        inserted = connection.execute(
            f'INSERT OR IGNORE INTO main.cases ({columns_sql}) '
            f'SELECT {columns_sql} FROM legacy.cases'
        ).rowcount
        updated = 0
        if "favorite" in common:
            updated = connection.execute(
                "UPDATE main.cases SET favorite = 1 "
                "WHERE favorite = 0 AND id IN "
                "(SELECT id FROM legacy.cases WHERE favorite = 1)"
            ).rowcount
        connection.commit()
        return max(0, int(inserted or 0)) + max(0, int(updated or 0))
    except sqlite3.Error:
        try:
            connection.rollback()
        except sqlite3.Error:
            pass
        return 0
    finally:
        if attached:
            try:
                connection.execute("DETACH DATABASE legacy")
            except sqlite3.Error:
                pass
        connection.close()


def _merge_design_references(source_path: Path, target_path: Path) -> int:
    """Merge the design-brain reference library and its favorite flags."""
    if not source_path.is_file() or source_path.is_symlink():
        return 0
    source_ok, source_payload = _read_json(source_path)
    if not source_ok or not isinstance(source_payload, dict):
        if not target_path.is_file() or target_path.is_symlink():
            return _copy_file_missing(source_path, target_path)
        return 0
    source_items = source_payload.get("items")
    if not isinstance(source_items, list):
        return 0
    if not target_path.is_file() or target_path.is_symlink():
        return _copy_file_missing(source_path, target_path)
    target_ok, target_payload = _read_json(target_path)
    if not target_ok or not isinstance(target_payload, dict):
        _backup_unreadable(target_path)
        return _copy_file_missing(source_path, target_path)

    target_items = [
        item for item in target_payload.get("items", [])
        if isinstance(item, dict)
    ] if isinstance(target_payload.get("items"), list) else []
    target_by_id = {
        _record_id(item, ("id",)): item
        for item in target_items
        if _record_id(item, ("id",))
    }
    target_by_hash = {
        str(item.get("hash") or "").strip().lower(): item
        for item in target_items
        if str(item.get("hash") or "").strip()
    }
    changed = 0
    for source_item in source_items:
        if not isinstance(source_item, dict):
            continue
        item_id = _record_id(source_item, ("id",))
        digest = str(source_item.get("hash") or "").strip().lower()
        target_item = target_by_id.get(item_id) if item_id else None
        if target_item is None and digest:
            target_item = target_by_hash.get(digest)
        if target_item is not None:
            changed += _promote_favorite(target_item, source_item)
            changed += _fill_missing_fields(
                target_item,
                source_item,
                {"id", "hash", "favorite"},
            )
            continue
        copied = copy.deepcopy(source_item)
        copied["favorite"] = _truthy_flag(copied.get("favorite"))
        target_items.append(copied)
        if item_id:
            target_by_id[item_id] = copied
        if digest:
            target_by_hash[digest] = copied
        changed += 1
    if not changed:
        return 0
    target_payload["items"] = target_items
    target_payload.setdefault("version", 1)
    if not _atomic_write_json(target_path, target_payload):
        return 0
    return changed


def _merge_key_profiles(source_path: Path, target_path: Path) -> int:
    """Merge account/profile metadata; the current selection remains active."""
    if not source_path.is_file() or source_path.is_symlink():
        return 0
    source_ok, source_payload = _read_json(source_path)
    if not source_ok or not isinstance(source_payload, dict):
        return 0
    source_providers = source_payload.get("providers")
    if not isinstance(source_providers, dict):
        return 0
    if not target_path.is_file() or target_path.is_symlink():
        return _copy_file_missing(source_path, target_path)
    target_ok, target_payload = _read_json(target_path)
    if not target_ok or not isinstance(target_payload, dict):
        _backup_unreadable(target_path)
        return _copy_file_missing(source_path, target_path)
    target_providers = target_payload.get("providers")
    if not isinstance(target_providers, dict):
        target_payload["providers"] = copy.deepcopy(source_providers)
        if not _atomic_write_json(target_path, target_payload):
            return 0
        return len(source_providers)

    changed = 0
    for provider_id, source_record in source_providers.items():
        if not isinstance(source_record, dict):
            continue
        target_record = target_providers.get(provider_id)
        if not isinstance(target_record, dict):
            target_providers[provider_id] = copy.deepcopy(source_record)
            changed += 1
            continue
        target_profiles = target_record.get("profiles")
        target_profiles = list(target_profiles) if isinstance(target_profiles, list) else []
        existing_ids = {
            str(item.get("id") or "")
            for item in target_profiles
            if isinstance(item, dict) and item.get("id")
        }
        source_profiles = source_record.get("profiles")
        if isinstance(source_profiles, list):
            for profile in source_profiles:
                profile_id = str(profile.get("id") or "") if isinstance(profile, dict) else ""
                if not profile_id or profile_id in existing_ids:
                    continue
                target_profiles.append(copy.deepcopy(profile))
                existing_ids.add(profile_id)
                changed += 1
        if target_record.get("profiles") != target_profiles:
            target_record["profiles"] = target_profiles
            changed += 1
        if not target_record.get("active_id") and source_record.get("active_id"):
            target_record["active_id"] = source_record["active_id"]
            changed += 1
    if not changed:
        return 0
    if not _atomic_write_json(target_path, target_payload):
        return 0
    return changed


_ENV_LINE = re.compile(r"^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$")


def _merge_env_entries(source_path: Path, target_path: Path) -> int:
    """Restore absent or blank environment entries without replacing keys."""
    if not source_path.is_file() or source_path.is_symlink():
        return 0
    if not target_path.is_file() or target_path.is_symlink():
        return _copy_file_missing(source_path, target_path)
    source_text = _read_text(source_path)
    target_text = _read_text(target_path)
    if source_text is None or target_text is None:
        return 0

    def entries(text: str):
        result: dict[str, tuple[int, str, str]] = {}
        for index, line in enumerate(text.splitlines(keepends=True)):
            match = _ENV_LINE.match(line.rstrip("\r\n"))
            if not match:
                continue
            value = match.group(2).strip().strip('"').strip("'")
            result[match.group(1)] = (index, value, line)
        return result

    source_entries = entries(source_text)
    target_entries = entries(target_text)
    if not source_entries:
        return 0
    target_lines = target_text.splitlines(keepends=True)
    additions: list[str] = []
    changed = 0
    for key, (_, source_value, source_line) in source_entries.items():
        target_entry = target_entries.get(key)
        if target_entry is None:
            if source_value:
                additions.append(source_line.rstrip("\r\n"))
            continue
        target_index, target_value, _ = target_entry
        if not target_value and source_value:
            newline = "\r\n" if target_lines[target_index].endswith("\r\n") else "\n"
            target_lines[target_index] = source_line.rstrip("\r\n") + newline
            changed += 1
    if additions:
        if target_lines and not target_lines[-1].endswith(("\n", "\r")):
            target_lines[-1] += "\n"
        target_lines.extend(f"{line}\n" for line in additions)
        changed += len(additions)
    if not changed:
        return 0
    return changed if _atomic_write_text(target_path, "".join(target_lines)) else 0


# ---------------------------------------------------------------------------
# Legacy source discovery
# ---------------------------------------------------------------------------


def _install_root_for(project_root: Path) -> Path:
    if project_root.name.lower() == "app" and project_root.parent.name.lower() == "resources":
        return project_root.parent.parent
    return project_root


def _pointer_paths(data_root: Path) -> list[Path]:
    """Read path pointers written by the installer before it removed old files."""
    paths: list[Path] = []
    pointer_file = data_root / ".legacy-install-paths.txt"
    candidates = [pointer_file]
    pointer_dir = data_root / ".legacy-install-paths"
    if pointer_dir.is_dir():
        candidates.extend(sorted(pointer_dir.glob("*.txt")))
    for candidate in candidates:
        if not candidate.is_file() or candidate.is_symlink():
            continue
        try:
            raw = candidate.read_bytes()
        except OSError:
            continue
        text = ""
        for encoding in ("utf-8-sig", "utf-16", "utf-16-le", "gb18030"):
            try:
                text = raw.decode(encoding)
                break
            except (UnicodeDecodeError, LookupError):
                continue
        if not text:
            continue
        for line in text.splitlines():
            value = line.strip().strip('"')
            if not value or value.startswith("#") or value.startswith(("{", "[")):
                continue
            paths.append(Path(value))
    return paths


def _sibling_preservation_roots(project_root: Path) -> list[Path]:
    install_root = _install_root_for(project_root)
    try:
        siblings = list(install_root.parent.glob("xiaomei-legacy-data-*"))
    except OSError:
        return []
    return [path for path in siblings if path.is_dir()]


def _source_has_payload(source: Path) -> bool:
    if source.is_symlink() or not source.is_dir():
        return False
    for name in _LEGACY_TOP_LEVEL_DIRS:
        path = source / name
        if path.is_dir() and not path.is_symlink():
            try:
                if next(path.iterdir(), None) is not None:
                    return True
            except OSError:
                return True
    for name in _LEGACY_TOP_LEVEL_FILES:
        if (source / name).is_file():
            return True
    env_path = source / "API" / ".env"
    if env_path.is_file():
        return True
    if (source / "API" / "openai-gpt-account-auth.json").is_file():
        return True
    workflows = source / "ComfyUI" / "workflows" / "custom"
    if workflows.is_dir() and not workflows.is_symlink():
        try:
            if next(workflows.iterdir(), None) is not None:
                return True
        except OSError:
            return True
    if (source / "workflows").is_dir() and not (source / "workflows").is_symlink():
        try:
            if next((source / "workflows").iterdir(), None) is not None:
                return True
        except OSError:
            return True
    return False


def discover_legacy_sources(
    project_root: Path,
    data_root: Path,
    extra_sources: Iterable[str | Path] = (),
) -> list[Path]:
    """Return every directory that may contain data from an older release."""
    project_root = _resolved(project_root)
    data_root = _resolved(data_root)
    candidates: list[Path] = []

    def add(value: str | Path | None) -> None:
        if not value:
            return
        path = _resolved(Path(value))
        if path == data_root:
            return
        # Never scan a directory that contains the destination, and never
        # scan the destination itself.
        if path in data_root.parents:
            return
        if not _source_has_payload(path):
            # The installer may have preserved the packaged app directory
            # as "<root>/app" or "<root>/root".
            for nested_name in ("app", "root", "resources/app"):
                nested = path / nested_name
                if _source_has_payload(nested):
                    candidates.append(_resolved(nested))
            return
        candidates.append(path)

    add(project_root)
    add(project_root / "resources" / "app")
    add(_install_root_for(project_root))

    for root in _sibling_preservation_roots(project_root):
        add(root)
        add(root / "app")
        add(root / "root")
        add(root / "resources" / "app")

    for relative in (".upgrade-backup", ".legacy-install-backups"):
        base = data_root / relative
        if not base.is_dir():
            continue
        try:
            children = sorted(base.iterdir(), key=lambda item: item.name.lower())
        except OSError:
            continue
        for child in children:
            add(child)
            add(child / "app")
            add(child / "root")
            add(child / "resources" / "app")

    for pointer in _pointer_paths(data_root):
        add(pointer)
        add(pointer / "app")
        add(pointer / "root")

    for extra in extra_sources:
        add(extra)
        add(Path(extra) / "app")
        add(Path(extra) / "root")

    deduplicated: list[Path] = []
    seen: set[str] = set()
    for candidate in candidates:
        key = str(candidate)
        if key in seen:
            continue
        seen.add(key)
        deduplicated.append(candidate)
    return deduplicated


def _stat_token(path: Path) -> list[int] | None:
    try:
        stat = path.stat()
    except OSError:
        return None
    return [int(stat.st_mtime_ns), int(stat.st_size)]


def _dir_token(path: Path) -> list[int] | None:
    try:
        stat = path.stat()
    except OSError:
        return None
    return [int(stat.st_mtime_ns)]


def _source_fingerprint(source: Path) -> str:
    """A cheap fingerprint used to import each legacy source only once."""
    payload = {
        "data": _dir_token(source / "data"),
        "canvases": _dir_token(source / "data" / "canvases"),
        "assets": _dir_token(source / "assets"),
        "output": _dir_token(source / "output"),
        "api": _dir_token(source / "API"),
        "workflows": _dir_token(source / "ComfyUI" / "workflows"),
        "files": {
            name: _stat_token(source / name)
            for name in _LEGACY_TOP_LEVEL_FILES
        },
        "config": {
            name: _stat_token(source / "data" / name)
            for name in (_PROJECTS_FILE, _PROVIDERS_FILE, _KEY_PROFILES_FILE)
        },
    }
    return json.dumps(payload, ensure_ascii=False, sort_keys=True)


# ---------------------------------------------------------------------------
# Migration state and logging
# ---------------------------------------------------------------------------


def _state_path(data_root: Path, project_root: Path) -> Path:
    marker_name = hashlib.sha256(str(project_root).encode("utf-8")).hexdigest()[:16]
    return data_root / f".legacy-install-migrated-{marker_name}-v{MIGRATION_VERSION}.json"


def _load_state(path: Path) -> dict[str, Any]:
    ok, payload = _read_json(path)
    if not ok or not isinstance(payload, dict) or payload.get("version") != MIGRATION_VERSION:
        return {"version": MIGRATION_VERSION, "sources": {}, "updated_at": 0}
    sources = payload.get("sources")
    if not isinstance(sources, dict):
        sources = {}
    return {
        "version": MIGRATION_VERSION,
        "sources": {str(key): str(value) for key, value in sources.items()},
        "updated_at": int(payload.get("updated_at") or 0),
    }


def _save_state(path: Path, state: dict[str, Any]) -> None:
    state["version"] = MIGRATION_VERSION
    state["updated_at"] = int(time.time())
    _atomic_write_json(path, state)


def _pending_path(data_root: Path) -> Path:
    return data_root / ".legacy-bulk-pending.json"


def _write_pending(data_root: Path, additions: list[dict[str, str]]) -> None:
    if not additions:
        return
    path = _pending_path(data_root)
    ok, payload = _read_json(path)
    existing = payload if ok and isinstance(payload, list) else []
    seen = {
        (str(item.get("source") or ""), str(item.get("target") or ""))
        for item in existing
        if isinstance(item, dict)
    }
    for item in additions:
        key = (item.get("source", ""), item.get("target", ""))
        if key in seen:
            continue
        existing.append(item)
        seen.add(key)
    _atomic_write_json(path, existing)


def _log_migration(data_root: Path, message: str) -> None:
    line = f"[{time.strftime('%Y-%m-%d %H:%M:%S')}] {message}\n"
    try:
        log_dir = data_root / "logs"
        log_dir.mkdir(parents=True, exist_ok=True)
        with open(log_dir / "legacy-migration.log", "a", encoding="utf-8") as handle:
            handle.write(line)
    except OSError:
        pass
    try:
        print(f"旧版数据迁移：{message}")
    except Exception:
        pass


# ---------------------------------------------------------------------------
# Import one legacy source
# ---------------------------------------------------------------------------


def _import_source(
    source_root: Path,
    data_root: Path,
    deferred: list[dict[str, str]],
) -> int:
    source_root = _resolved(source_root)
    if source_root == data_root or not source_root.is_dir():
        return 0
    target_data = data_root / "data"
    target_data.mkdir(parents=True, exist_ok=True)
    copied = 0

    source_data = source_root / "data"
    if source_data.is_dir() and not source_data.is_symlink():
        copied += _flatten_nested_data(source_data)
        # Merge the collections before the generic copy.  The generic copy
        # never overwrites an existing target, so these helpers are the only
        # places where new records can be added to an existing installation.
        copied += _merge_projects(source_data / _PROJECTS_FILE, target_data / _PROJECTS_FILE)
        copied += _merge_api_providers(source_data / _PROVIDERS_FILE, target_data / _PROVIDERS_FILE)
        copied += _merge_key_profiles(source_data / _KEY_PROFILES_FILE, target_data / _KEY_PROFILES_FILE)
        copied += _merge_prompt_libraries(
            source_data / "prompt_libraries.json",
            target_data / "prompt_libraries.json",
        )
        copied += _merge_prompt_cases(
            source_data / "prompt_cases.json",
            target_data / "prompt_cases.json",
        )
        copied += _merge_asset_library_file(
            source_data / "asset_library.json",
            target_data / "asset_library.json",
        )
        copied += _merge_asset_favorites(
            source_data / "asset_favorites.json",
            target_data / "asset_favorites.json",
        )
        copied += _merge_model_modalities(
            source_data / "harness_model_modalities.json",
            target_data / "harness_model_modalities.json",
        )
        copied += _merge_inspiration_favorites(
            source_data / "inspiration_library.sqlite3",
            target_data / "inspiration_library.sqlite3",
        )
        copied += _merge_design_references(
            source_data / "design_brain" / "references" / "reference_items.json",
            target_data / "design_brain" / "references" / "reference_items.json",
        )
        try:
            children = sorted(source_data.iterdir(), key=lambda item: item.name.lower())
        except OSError:
            children = []
        for child in children:
            if child.name == "data":
                # _flatten_nested_data could not merge a conflicting nested
                # copy.  Never move it back to data/data; keep it in the
                # preserved source for manual recovery.
                _log_migration(data_root, f"保留未合并的嵌套数据副本：{child}")
                continue
            target_child = target_data / child.name
            if (
                deferred is not None
                and child.name in _BULK_DATA_CHILDREN
                and target_child.exists()
            ):
                # Merging a multi-gigabyte model or browser cache while the
                # backend starts would exceed the desktop client's startup
                # window.  The background worker merges it.
                deferred.append({"source": str(child), "target": str(target_child)})
                continue
            copied += _move_or_merge(
                child,
                target_child,
                bulk=child.name in _BULK_DATA_CHILDREN,
                deferred=deferred,
            )

    copied += _merge_history(source_root / "history.json", data_root / "history.json")
    copied += _merge_env_entries(
        source_root / "API" / ".env",
        data_root / "API" / ".env",
    )

    for name in ("assets", "output"):
        source = source_root / name
        if not source.is_dir() or source.is_symlink():
            continue
        target = data_root / name
        if deferred is not None and name in _BULK_TOP_LEVEL and target.exists():
            deferred.append({"source": str(source), "target": str(target)})
            continue
        copied += _move_or_merge(
            source,
            target,
            bulk=name in _BULK_TOP_LEVEL,
            deferred=deferred,
        )

    # API/.env was merged above; merge the rest of the directory (account
    # auth, provider-specific helper files, ...).
    api_source = source_root / "API"
    if api_source.is_dir() and not api_source.is_symlink():
        target_api = data_root / "API"
        target_api.mkdir(parents=True, exist_ok=True)
        try:
            children = sorted(api_source.iterdir(), key=lambda item: item.name.lower())
        except OSError:
            children = []
        for child in children:
            if child.name == ".env":
                continue
            copied += _move_or_merge(child, target_api / child.name)

    # Only user custom workflows are imported.  The installer preserves the
    # whole workflows folder, but copying the old bundled templates back would
    # prevent the new release's templates from taking effect.
    custom_workflows = source_root / "ComfyUI" / "workflows" / "custom"
    if custom_workflows.is_dir() and not custom_workflows.is_symlink():
        copied += _move_or_merge(
            custom_workflows,
            data_root / "ComfyUI" / "workflows" / "custom",
        )
    legacy_workflows = source_root / "workflows"
    if legacy_workflows.is_dir() and not legacy_workflows.is_symlink():
        copied += _move_or_merge(legacy_workflows, data_root / "workflows")

    harness = source_root / ".xiaomei-data"
    if harness.is_dir() and not harness.is_symlink():
        copied += _move_or_merge(
            harness,
            data_root / ".xiaomei-data",
            bulk=True,
            deferred=deferred,
        )

    for name in _LEGACY_TOP_LEVEL_FILES:
        if name == "history.json":
            continue  # merged above
        copied += _import_plain_file(source_root / name, data_root / name)

    return copied


# ---------------------------------------------------------------------------
# Public migration entry points
# ---------------------------------------------------------------------------


def repair_orphan_projects(data_root: Path) -> int:
    """Make canvases whose project record disappeared visible again.

    A canvas is grouped by its ``project`` id.  If ``projects.json`` was lost
    but the canvas survived, the canvas exists on disk yet the UI cannot show
    it under any project.  Add a placeholder record instead of hiding it.
    """
    canvases_dir = data_root / "data" / "canvases"
    if not canvases_dir.is_dir():
        return 0
    projects_path = data_root / "data" / _PROJECTS_FILE
    if projects_path.is_file() and not projects_path.is_symlink():
        ok, payload = _read_json(projects_path)
        if not ok:
            _backup_unreadable(projects_path)
            projects = []
            payload = None
        else:
            projects = _projects_list(payload)
            if projects is None:
                projects = []
    else:
        projects = []
        payload = None

    known = {str(item.get("id") or "") for item in projects}
    known.add("default")
    missing: list[str] = []
    seen_missing: set[str] = set()
    try:
        files = sorted(canvases_dir.iterdir(), key=lambda item: item.name.lower())
    except OSError:
        return 0
    for path in files:
        if path.is_symlink() or not path.is_file() or path.suffix.lower() != ".json":
            continue
        ok, canvas = _read_json(path)
        if not ok or not isinstance(canvas, dict):
            continue
        if canvas.get("deleted_at"):
            continue
        project_id = str(canvas.get("project") or "").strip() or "default"
        if project_id in known or project_id in seen_missing:
            continue
        seen_missing.add(project_id)
        missing.append(project_id)
    if not missing:
        return 0

    orders: list[int] = []
    for item in projects:
        try:
            orders.append(int(item.get("order") or 0))
        except (TypeError, ValueError):
            orders.append(0)
    next_order = max(orders, default=0) + 1
    now = int(time.time() * 1000)
    for index, project_id in enumerate(missing):
        name = "恢复的项目" if index == 0 else f"恢复的项目 {index + 1}"
        projects.append({
            "id": project_id,
            "name": name,
            "order": next_order + index,
            "created_at": now,
            "updated_at": now,
        })
    if isinstance(payload, dict):
        output = dict(payload)
        output["projects"] = projects
    else:
        output = {"projects": projects}
    if not _atomic_write_json(projects_path, output):
        return 0
    return len(missing)


def migrate_legacy_data(
    project_root: str | Path,
    data_root: str | Path,
    extra_sources: Iterable[str | Path] = (),
) -> int:
    """Import data left beside an old installation without replacing newer state.

    The function is intentionally safe to call on every start.  Each legacy
    source is fingerprinted and imported once; the target files always win.
    """
    project_root = _resolved(Path(project_root))
    data_root = _resolved(Path(data_root))
    if project_root == data_root:
        return 0
    try:
        data_root.mkdir(parents=True, exist_ok=True)
        (data_root / "data").mkdir(parents=True, exist_ok=True)
    except OSError as error:
        _log_migration(data_root, f"无法创建数据目录：{error}")
        return 0

    copied = 0
    try:
        # Repair a previous bad copy even when the source is already gone.
        copied += _flatten_nested_data(data_root / "data")
    except OSError as error:
        _log_migration(data_root, f"整理嵌套数据目录失败：{error}")

    sources = discover_legacy_sources(project_root, data_root, extra_sources)
    state_path = _state_path(data_root, project_root)
    state = _load_state(state_path)
    state_changed = False
    deferred: list[dict[str, str]] = []
    failures: list[str] = []

    for source in sources:
        key = str(source)
        fingerprint = _source_fingerprint(source)
        if state["sources"].get(key) == fingerprint:
            continue
        try:
            imported = _import_source(source, data_root, deferred)
        except Exception as error:  # noqa: BLE001 - one source must not stop startup
            failures.append(f"{source}: {error}")
            _log_migration(data_root, f"从 {source} 导入失败，下次启动重试：{error}")
            continue
        # Record the fingerprint after the import: flattening or moving files
        # changes the source directory timestamps.
        state["sources"][key] = _source_fingerprint(source)
        state_changed = True
        copied += imported
        _log_migration(data_root, f"已从 {source} 导入 {imported} 个文件/目录")

    repair_marker = data_root / ".legacy-orphan-projects-repaired-v1"
    repaired = 0
    repair_ok = True
    if state_changed or not repair_marker.exists():
        try:
            repaired = repair_orphan_projects(data_root)
        except Exception as error:  # noqa: BLE001
            repair_ok = False
            repaired = 0
            _log_migration(data_root, f"修复孤立画布项目失败：{error}")
        if repaired:
            copied += repaired
            _log_migration(data_root, f"为 {repaired} 个丢失项目记录画布补充了项目")
        if repair_ok:
            try:
                repair_marker.write_text(str(data_root), encoding="utf-8")
            except OSError:
                pass

    if deferred:
        _write_pending(data_root, deferred)
        _log_migration(
            data_root,
            f"{len(deferred)} 个大目录需要跨盘复制，已转后台继续",
        )
    if state_changed or repaired:
        try:
            _save_state(state_path, state)
        except OSError as error:
            _log_migration(data_root, f"无法保存迁移记录：{error}")
    if failures:
        _log_migration(data_root, f"迁移完成但有 {len(failures)} 个来源失败，将在下次启动重试")
    return copied


def migrate_pending_bulk_data(project_root: str | Path, data_root: str | Path) -> int:
    """Copy large deferred directories that could not be renamed across disks."""
    project_root = _resolved(Path(project_root))
    data_root = _resolved(Path(data_root))
    if project_root == data_root:
        return 0
    path = _pending_path(data_root)
    ok, payload = _read_json(path)
    if not ok or not isinstance(payload, list):
        return 0
    remaining: list[dict[str, str]] = []
    copied = 0
    for item in payload:
        if not isinstance(item, dict):
            continue
        source = Path(str(item.get("source") or ""))
        target = Path(str(item.get("target") or ""))
        if not source.exists() or source.is_symlink():
            continue
        try:
            if target.exists():
                copied += _copy_tree_missing(source, target)
            else:
                target.parent.mkdir(parents=True, exist_ok=True)
                try:
                    os.replace(source, target)
                    copied += 1
                except OSError as error:
                    if _should_defer_bulk(error):
                        copied += _copy_tree_missing(source, target)
                    else:
                        raise
        except OSError as error:
            remaining.append(item)
            _log_migration(data_root, f"后台迁移失败 {source} -> {target}：{error}")
    if remaining:
        _atomic_write_json(path, remaining)
    else:
        try:
            os.remove(path)
        except OSError:
            pass
    if copied:
        _log_migration(data_root, f"后台完成 {copied} 个文件的跨盘迁移")
    return copied


def seed_workflows(project_root: str | Path, data_root: str | Path) -> int:
    """Make bundled workflow templates available in the writable workflow folder."""
    project_root = _resolved(Path(project_root))
    data_root = _resolved(Path(data_root))
    if project_root == data_root:
        return 0
    source = project_root / "ComfyUI" / "workflows"
    target = data_root / "ComfyUI" / "workflows"
    if not source.is_dir():
        return 0
    copied = 0
    for path in source.rglob("*.json"):
        if path.is_file() and not path.is_symlink():
            copied += _copy_file_missing(path, target / path.relative_to(source))
    return copied
