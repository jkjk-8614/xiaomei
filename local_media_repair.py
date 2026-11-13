"""Repair legacy upload names and keep their annotation files together."""

import logging
import os
from pathlib import Path
import stat

import media_formats
import media_paths
from media_storage import move_file_without_replacing as _move


_LOGGER = logging.getLogger(__name__)
_REPAIRABLE_IMAGES = {".png", ".jpg", ".jpeg", ".gif", ".bmp", ".webp"}
_DUPLICATE_SUFFIXES = _REPAIRABLE_IMAGES | {".avif", ".mp4", ".webm", ".mov", ".m4v", ".flv"}
_ANNOTATIONS = (".txt", ".classification.json")
sniff_image = media_formats.sniff_image_extension


def _corrected_name(source):
    extension = source.suffix.lower()
    if extension not in _DUPLICATE_SUFFIXES:
        return source.name
    name = source.name
    if name.lower().endswith(extension * 2):
        shortened = name[:-len(extension)]
        if not os.path.lexists(source.with_name(shortened)):
            name = shortened
    if extension in _REPAIRABLE_IMAGES:
        with source.open("rb") as stream:
            actual = sniff_image(stream.read(16))
        if actual and actual != extension and (actual, extension) != (".jpg", ".jpeg"):
            name = name[:-len(extension)] + actual
    return name


def _mode(path):
    try:
        info = path.lstat()
    except OSError:
        return 0
    if getattr(info, "st_file_attributes", 0) & getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0):
        return 0
    return info.st_mode


def _annotations(source, target):
    if source.stem == target.stem:
        return []
    pairs = []
    for suffix in _ANNOTATIONS:
        original = source.with_name(source.stem + suffix)
        if stat.S_ISREG(_mode(original)):
            pairs.append((original, target.with_name(target.stem + suffix)))
    return pairs


def repair(directory, register_alias):
    root = Path(directory).resolve()
    repaired = 0
    for directory, subdirs, names in os.walk(root):
        folder = Path(directory)
        subdirs[:] = [
            name for name in subdirs
            if stat.S_ISDIR(_mode(folder / name))
            and media_paths.path_under(root, (folder / name).relative_to(root))
        ]
        for name in names:
            source = folder / name
            if not stat.S_ISREG(_mode(source)) or not media_paths.path_under(root, source.relative_to(root)):
                continue
            try:
                target = folder / _corrected_name(source)
                if target == source:
                    continue
                moves = [*_annotations(source, target), (source, target)]
                if any(os.path.lexists(destination) for _, destination in moves):
                    continue
                undo_alias = register_alias(source.relative_to(root).as_posix(), target.relative_to(root).as_posix())
                if undo_alias is None:
                    continue
            except OSError:
                _LOGGER.debug("Unable to plan an upload filename repair", exc_info=True)
                continue

            moved = []
            try:
                for original, destination in moves:
                    _move(original, destination)
                    moved.append((original, destination))
            except OSError:
                for original, destination in reversed(moved):
                    try:
                        _move(destination, original)
                    except OSError:
                        _LOGGER.warning("An upload annotation could not be moved back", exc_info=True)
                try:
                    undo_alias()
                except OSError:
                    _LOGGER.warning("An upload alias could not be moved back", exc_info=True)
                continue
            repaired += 1
    return repaired
