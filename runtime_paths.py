"""Keep mutable desktop state separate from the installed application files."""

from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import tempfile
from pathlib import Path


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


def _copy_missing(source: Path, target: Path) -> int:
    if source.is_symlink() or not source.exists():
        return 0
    if source.is_file():
        if target.exists() or target.is_symlink():
            return 0
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, target)
        return 1
    if not source.is_dir():
        return 0
    # Never walk into a destination nested under the legacy source.
    if source.resolve() == target.resolve() or source.resolve() in target.resolve().parents:
        return 0
    copied = 0
    for current, directories, files in os.walk(source):
        directories[:] = [name for name in directories if not (Path(current) / name).is_symlink()]
        for name in files:
            copied += _copy_missing(Path(current) / name, target / Path(current).relative_to(source) / name)
    return copied


def _merge_missing_projects(project_root: Path, data_root: Path) -> int:
    """Merge legacy project records without replacing the user's current file.

    Desktop upgrades intentionally keep an existing ``projects.json`` intact.
    That is safe for ordinary files, but project metadata is a collection: an
    older install may already contain the default record while the canvases
    copied beside it still refer to additional projects.  Merge by stable ID
    so existing names, ordering and tombstones always win, while records that
    only exist in the legacy install remain visible.
    """
    source_path = project_root / "data" / "projects.json"
    target_path = data_root / "data" / "projects.json"
    if not source_path.is_file() or not target_path.is_file():
        return 0
    try:
        source_data = json.loads(source_path.read_text(encoding="utf-8-sig"))
        target_data = json.loads(target_path.read_text(encoding="utf-8-sig"))
    except (OSError, ValueError, TypeError):
        return 0
    source_projects = source_data.get("projects") if isinstance(source_data, dict) else source_data
    target_projects = target_data.get("projects") if isinstance(target_data, dict) else target_data
    if not isinstance(source_projects, list) or not isinstance(target_projects, list):
        return 0

    existing_ids = {
        str(item.get("id") or "")
        for item in target_projects
        if isinstance(item, dict) and item.get("id")
    }
    additions = [
        item for item in source_projects
        if isinstance(item, dict)
        and item.get("id")
        and str(item.get("id")) not in existing_ids
    ]
    if not additions:
        return 0

    merged_projects = list(target_projects) + additions
    merged_data = dict(target_data) if isinstance(target_data, dict) else {"projects": merged_projects}
    merged_data["projects"] = merged_projects
    target_path.parent.mkdir(parents=True, exist_ok=True)
    temporary_path = None
    try:
        fd, temporary_path = tempfile.mkstemp(
            prefix=f".{target_path.name}.", suffix=".tmp", dir=target_path.parent
        )
        with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as handle:
            json.dump(merged_data, handle, ensure_ascii=False, indent=2)
            handle.flush()
            try:
                os.fsync(handle.fileno())
            except OSError:
                pass
        os.replace(temporary_path, target_path)
        temporary_path = None
    except (OSError, TypeError, ValueError):
        return 0
    finally:
        if temporary_path:
            try:
                os.remove(temporary_path)
            except OSError:
                pass
    return len(additions)


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


def _merge_missing_env_entries(project_root: Path, data_root: Path) -> int:
    """Restore absent/blank environment entries without replacing saved keys."""
    source_path = project_root / "API" / ".env"
    target_path = data_root / "API" / ".env"
    if not source_path.is_file() or not target_path.is_file():
        return 0
    try:
        source_text = source_path.read_text(encoding="utf-8-sig")
        target_text = target_path.read_text(encoding="utf-8-sig")
    except OSError:
        return 0

    pattern = re.compile(r"^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$")

    def entries(text: str):
        result = {}
        for index, line in enumerate(text.splitlines(keepends=True)):
            match = pattern.match(line.rstrip("\r\n"))
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
    additions = []
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


def _merge_missing_key_profiles(project_root: Path, data_root: Path) -> int:
    """Merge saved account names/IDs while leaving the current selection intact."""
    source_path = project_root / "data" / "api_key_profiles.json"
    target_path = data_root / "data" / "api_key_profiles.json"
    if not source_path.is_file() or not target_path.is_file():
        return 0
    try:
        source_data = json.loads(source_path.read_text(encoding="utf-8-sig"))
        target_data = json.loads(target_path.read_text(encoding="utf-8-sig"))
    except (OSError, ValueError, TypeError):
        return 0
    source_providers = source_data.get("providers") if isinstance(source_data, dict) else None
    target_providers = target_data.get("providers") if isinstance(target_data, dict) else None
    if not isinstance(source_providers, dict) or not isinstance(target_providers, dict):
        return 0

    changed = 0
    for provider_id, source_record in source_providers.items():
        if not isinstance(source_record, dict):
            continue
        target_record = target_providers.get(provider_id)
        if not isinstance(target_record, dict):
            target_providers[provider_id] = source_record
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
                target_profiles.append(profile)
                existing_ids.add(profile_id)
                changed += 1
        if target_record.get("profiles") != target_profiles:
            target_record["profiles"] = target_profiles
        if not target_record.get("active_id") and source_record.get("active_id"):
            target_record["active_id"] = source_record["active_id"]
            changed += 1
    if not changed:
        return 0
    if not _atomic_write_text(
        target_path,
        json.dumps(target_data, ensure_ascii=False, indent=2) + "\n",
    ):
        return 0
    return changed


def _merge_missing_runtime_metadata(project_root: Path, data_root: Path) -> int:
    return (
        _merge_missing_env_entries(project_root, data_root)
        + _merge_missing_key_profiles(project_root, data_root)
        + _merge_missing_projects(project_root, data_root)
    )


def migrate_legacy_data(project_root: Path, data_root: Path) -> int:
    """Import data left beside an old installation without replacing newer state."""
    if project_root == data_root:
        return 0
    marker_name = hashlib.sha256(str(project_root).encode("utf-8")).hexdigest()[:16]
    marker = data_root / f".legacy-install-migrated-{marker_name}"
    metadata_marker = data_root / f".legacy-install-metadata-merged-{marker_name}"
    if marker.exists():
        # Older releases may already have written the marker before the
        # collection-aware project merge was introduced.  Re-checking this
        # small metadata set keeps that upgrade self-healing.  Persist a
        # separate repair marker so a user who later removes a key is not
        # repeatedly repopulated from the legacy install.
        if metadata_marker.exists():
            return 0
        merged = _merge_missing_runtime_metadata(project_root, data_root)
        data_root.mkdir(parents=True, exist_ok=True)
        metadata_marker.write_text(str(project_root), encoding="utf-8")
        return merged
    paths = (
        "data", "assets", "output", "history.json", "global_config.json",
        "API/.env", "API/openai-gpt-account-auth.json", "ComfyUI/workflows/custom",
    )
    available = [relative for relative in paths if (project_root / relative).exists()]
    if not available:
        return 0
    copied = sum(_copy_missing(project_root / relative, data_root / relative) for relative in available)
    copied += _merge_missing_runtime_metadata(project_root, data_root)
    data_root.mkdir(parents=True, exist_ok=True)
    temporary = marker.with_name(marker.name + ".tmp")
    temporary.write_text(str(project_root), encoding="utf-8")
    temporary.replace(marker)
    metadata_marker.write_text(str(project_root), encoding="utf-8")
    return copied


def seed_workflows(project_root: Path, data_root: Path) -> int:
    """Make bundled workflow templates available in the writable workflow folder."""
    if project_root == data_root:
        return 0
    source = project_root / "ComfyUI" / "workflows"
    target = data_root / "ComfyUI" / "workflows"
    if not source.is_dir():
        return 0
    return sum(_copy_missing(path, target / path.relative_to(source))
               for path in source.rglob("*.json") if path.is_file())
