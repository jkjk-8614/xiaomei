"""Move local assets and annotations as one reversible filesystem change."""

import logging
import os
import shutil
import uuid
from contextlib import contextmanager
from pathlib import Path

from local_asset_catalog import ANNOTATION_SUFFIXES, annotation_path, is_link, media_type
from media_storage import move_file_without_replacing


_LOGGER = logging.getLogger(__name__)


def _choose_destination(root, source, relative, in_use, rename):
    destination = root / relative
    image = media_type(source.name)[0] == "image"
    annotated = image and any(annotation_path(source, suffix).is_file() for suffix in ANNOTATION_SUFFIXES)
    candidate = destination
    for _ in range(32):
        sidecars = [annotation_path(candidate, suffix) for suffix in ANNOTATION_SUFFIXES] if image else []
        if not (any(os.path.lexists(path) for path in (candidate, *sidecars))
                or (annotated and _has_image_sibling(candidate))
                or in_use(source.relative_to(root).as_posix(), candidate.relative_to(root).as_posix())):
            return candidate, sidecars
        if rename:
            break
        candidate = destination.with_name(f"{destination.stem}_{uuid.uuid4().hex[:6]}{destination.suffix}")
    raise FileExistsError(destination)


def _has_image_sibling(source):
    stem = os.path.normcase(source.stem)
    return any(other != source and os.path.normcase(other.stem) == stem and other.is_file()
               and media_type(other.name)[0] == "image" for other in source.parent.iterdir())


def _copy_annotation(source, destination):
    with source.open("rb") as reader:
        writer = destination.open("xb")
        try:
            with writer:
                shutil.copyfileobj(reader, writer)
        except OSError:
            destination.unlink()
            raise


def _undo(changes):
    for source, destination, copied in reversed(changes):
        try:
            if copied:
                destination.unlink()
            else:
                move_file_without_replacing(destination, source)
        except OSError:
            _LOGGER.error("Could not restore a local asset file after a failed move", exc_info=True)


@contextmanager
def rename_folder(source, destination):
    source, destination = Path(source), Path(destination)
    if is_link(source):
        raise ValueError("不支持重命名链接文件夹")
    if os.path.lexists(destination):
        raise FileExistsError(destination)
    source.rename(destination)
    try:
        yield
    except BaseException:
        try:
            if os.path.lexists(source):
                raise FileExistsError(source)
            destination.rename(source)
        except OSError:
            _LOGGER.error("Could not restore a local asset folder after a failed rename", exc_info=True)
        raise


@contextmanager
def remove_empty_folders(folders):
    removed = []
    try:
        for folder in folders:
            folder.rmdir()
            removed.append(folder)
        yield
    except BaseException:
        for folder in reversed(removed):
            try:
                folder.mkdir(exist_ok=True)
            except OSError:
                _LOGGER.error("Could not restore a local asset folder after a failed deletion", exc_info=True)
        raise


@contextmanager
def relocate(directory, pairs, *, in_use, rename=False):
    root = Path(directory).resolve()
    applied, result = [], []
    try:
        for relative, requested in pairs:
            if relative == requested:
                continue
            source = root / relative
            changes = []
            try:
                if source.is_symlink() or not source.is_file():
                    raise FileNotFoundError(source)
                destination, sidecars = _choose_destination(root, source, requested, in_use, rename)
                originals = [annotation_path(source, suffix) for suffix in ANNOTATION_SUFFIXES] if sidecars else []
                companions = [(original, target) for original, target in zip(originals, sidecars)
                              if original.is_file() and not original.is_symlink()]
                shared = bool(companions) and _has_image_sibling(source)
                for original, target in companions:
                    if shared:
                        _copy_annotation(original, target)
                    else:
                        move_file_without_replacing(original, target)
                    changes.append((original, target, shared))
                move_file_without_replacing(source, destination)
                changes.append((source, destination, False))
            except OSError:
                _undo(changes)
                if rename:
                    raise
                continue
            applied.extend(changes)
            result.append((relative, destination.relative_to(root).as_posix()))
        yield result
    except BaseException:
        _undo(applied)
        raise
