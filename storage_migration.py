"""Read image-space settings and copy legacy files before switching roots."""

import json
import os
import shutil
import stat
import tempfile
from pathlib import Path

import media_paths
from media_storage import file_digest


class StorageConflict(ValueError):
    pass


def path_key(path):
    return os.path.normcase(os.path.realpath(path))


def contains(root, path):
    root, path = path_key(root), path_key(path)
    try:
        return os.path.commonpath((root, path)) == root
    except ValueError:
        return False


def absolute(value, fallback, base):
    text = str(value or "").strip()
    if not text:
        return os.path.abspath(fallback)
    if "\x00" in text:
        raise ValueError("存储目录路径包含无效字符")
    expanded = os.path.expanduser(os.path.expandvars(text))
    return os.path.abspath(os.path.join(base, expanded))


def read_config(path):
    try:
        with open(path, encoding="utf-8-sig") as stream:
            value = json.load(stream)
    except FileNotFoundError:
        return {}
    if not isinstance(value, dict):
        raise ValueError("存储目录配置应为 JSON 对象")
    return value


def infer_space(dirs, names, default):
    try:
        common = os.path.commonpath(list(dirs.values()))
    except ValueError:
        return default
    if not common:
        return default
    already_named = all(Path(dirs[key]).name == name for key, name in names.items())
    return common if already_named else os.path.join(common, "图片空间")


def _distinct_roots(values, active):
    seen = {path_key(active)}
    roots = []
    for value in values:
        key = path_key(value)
        if key not in seen:
            seen.add(key)
            roots.append(value)
    return roots


def settings(dirs, space, names, legacy, unified):
    return {
        "dirs": dirs,
        "image_space": space,
        "root": space,
        "folder_names": dict(names),
        "legacy_dirs": {key: paths[0] for key, paths in legacy.items() if paths},
        "legacy_roots": {key: paths for key, paths in legacy.items() if paths},
        "unified": unified,
    }


def decode(raw, defaults, names, default_space, base):
    dirs = {key: absolute(raw.get(key), fallback, base) for key, fallback in defaults.items()}
    explicit = raw.get("image_space") or raw.get("root")
    space = absolute(explicit, default_space, base) if explicit else infer_space(dirs, names, default_space)
    unified = bool(explicit) and all(path_key(dirs[key]) == path_key(Path(space, name)) for key, name in names.items())
    raw_lists = raw.get("legacy_roots") if isinstance(raw.get("legacy_roots"), dict) else {}
    raw_legacy = raw.get("legacy_dirs") if isinstance(raw.get("legacy_dirs"), dict) else {}
    legacy = {}
    for key, active in dirs.items():
        values = raw_lists.get(key)
        values = list(values) if isinstance(values, list) else []
        values.append(raw_legacy.get(key))
        paths = [absolute(value, active, base) for value in values if isinstance(value, str) and value.strip()]
        legacy[key] = _distinct_roots(paths, active)
    result = settings(dirs, space, names, legacy, unified)
    if not unified:
        for key, name in names.items():
            if path_key(dirs[key]) != path_key(Path(space, name)):
                result["legacy_dirs"].setdefault(key, dirs[key])
    return result


def change(previous, payload, names, default_space, base):
    explicit = str(payload.get("image_space") or payload.get("root") or "").strip()
    if explicit:
        space = absolute(explicit, previous["image_space"], base)
        dirs = {key: os.path.join(space, name) for key, name in names.items()}
    elif any(str(payload.get(key) or "").strip() for key in names):
        dirs = {key: absolute(payload.get(key), active, base) for key, active in previous["dirs"].items()}
        space = infer_space(dirs, names, default_space)
    else:
        return None
    legacy = {
        key: _distinct_roots([previous["dirs"][key], *previous["legacy_roots"].get(key, [])], active)
        for key, active in dirs.items()
    }
    return settings(dirs, space, names, legacy, bool(explicit))


def _linked(path):
    try:
        info = os.lstat(path)
    except FileNotFoundError:
        return True
    flags = getattr(info, "st_file_attributes", 0)
    return stat.S_ISLNK(info.st_mode) or bool(flags & getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0))


def walk_files(directory, *, skip_dirs=()):
    root = Path(directory)
    for current, folders, names in os.walk(root):
        folders[:] = sorted(name for name in folders if not name.startswith(skip_dirs)
                           and not _linked(Path(current, name)))
        for name in sorted(names):
            if name.startswith(".storage-migrate-") or (skip_dirs and name.startswith(".")):
                continue
            path = Path(current, name)
            try:
                if path.is_file() and not _linked(path):
                    yield path.relative_to(root), path
            except FileNotFoundError:
                continue


def _same_file_contents(left, right):
    if not right.is_file():
        return False
    return left.stat().st_size == right.stat().st_size and file_digest(left) == file_digest(right)


def check_shadowing(sources, destination):
    for relative, new in walk_files(destination):
        visible = media_paths.first_file(sources, relative)
        if visible and not _same_file_contents(Path(visible), new):
            raise StorageConflict(f"目标目录已有内容不同的同名文件。{relative}")


def migration_files(sources, destination, *, target_already_active=False):
    """Plan safe copies and retain old paths when a target would shadow them."""
    target = Path(destination)
    planned = {}
    parent_paths = set()
    skipped = 0
    for directory in sources:
        source = Path(directory)
        if not source.is_dir():
            continue
        if contains(source, target) or contains(target, source):
            raise StorageConflict("原目录和目标目录相互包含。请选择另一个图片空间。")
        for relative, old in walk_files(source):
            safe = media_paths.path_under(target, relative)
            if not safe:
                raise StorageConflict(f"目标文件路径超出图片空间。{relative}")
            new = Path(safe)
            key = path_key(new)
            primary = planned.get(key)
            if primary:
                if not _same_file_contents(old, primary[0]):
                    skipped += 1
                continue
            ancestors = [path_key(parent) for parent in new.parents]
            if key in parent_paths or any(parent in planned for parent in ancestors):
                raise StorageConflict(f"旧目录中同名素材和文件夹无法合并。{relative}")
            if new.exists() and (_linked(new) or not _same_file_contents(old, new)):
                if target_already_active:
                    skipped += 1
                    continue
                raise StorageConflict(f"目标目录已有内容不同的同名文件。{relative}")
            if any(parent.is_file() for parent in new.parents):
                if target_already_active:
                    skipped += 1
                    continue
                raise StorageConflict(f"目标目录中的同名文件挡住了素材文件夹。{relative}")
            planned[key] = (old, new)
            parent_paths.update(ancestors)
    return list(planned.values()), skipped


def copy_into_space(old, new):
    if new.exists():
        if not _linked(new) and _same_file_contents(old, new):
            return False
        raise StorageConflict(f"复制时发现目标文件内容已变化。{new.name}")
    new.parent.mkdir(parents=True, exist_ok=True)
    descriptor, name = tempfile.mkstemp(prefix=".storage-migrate-", suffix=".tmp", dir=new.parent)
    os.close(descriptor)
    temporary = Path(name)
    try:
        shutil.copy2(old, temporary)
        if not _same_file_contents(old, temporary):
            raise OSError("复制期间源素材发生变化")
        if os.name == "nt":
            temporary.rename(new)
        else:
            os.link(temporary, new)
    finally:
        temporary.unlink(missing_ok=True)
    return True


def remove_migrated_copy(old, new, protected_roots):
    if any(contains(root, old) for root in protected_roots):
        return False
    if not old.is_file() or _linked(old) or not _same_file_contents(old, new):
        return False
    old.unlink()
    return True
