"""Reuse identical immutable generated media without writing another file."""
import hashlib
import os
from pathlib import Path
import tempfile
import threading

_lock = threading.RLock()
_hashes = {}


def move_file_without_replacing(source, target):
    source, target = Path(source), Path(target)
    if os.name == "nt":
        source.rename(target)
        return
    os.link(source, target, follow_symlinks=False)
    try:
        source.unlink()
    except OSError:
        target.unlink()
        raise


def file_digest(path):
    stat = os.stat(path)
    key = (os.path.abspath(path), stat.st_ino, stat.st_size, stat.st_mtime_ns, stat.st_ctime_ns)
    if key not in _hashes:
        digest = hashlib.sha256()
        with open(path, 'rb') as stream:
            for chunk in iter(lambda: stream.read(1024 * 1024), b''):
                digest.update(chunk)
        _hashes[key] = digest.digest()
    return _hashes[key]


def _write_snapshot(path, payload, directory):
    fd, temporary = tempfile.mkstemp(dir=directory, suffix='.tmp')
    try:
        with os.fdopen(fd, 'wb') as stream:
            stream.write(payload)
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)
    return path


def write_media_snapshot(path, payload, *, deduplicate=True):
    """Return an existing immutable snapshot, or atomically save a new one."""
    directory = os.path.dirname(os.path.abspath(path))
    os.makedirs(directory, exist_ok=True)
    if not deduplicate:
        return _write_snapshot(path, payload, directory)
    digest = hashlib.sha256(payload).digest()
    extension = os.path.splitext(path)[1].lower()
    with _lock:
        # Keep the directory iterator closed even when an identical snapshot
        # is found and the function returns from inside the loop.  Returning
        # directly from a bare ``os.scandir`` iterator leaves its native handle
        # for garbage collection, which produced ResourceWarning under load.
        with os.scandir(directory) as entries:
            for entry in entries:
                # Adapter output filenames can be overwritten in place. Only reuse
                # immutable snapshots created by this application's naming policy.
                if not (entry.name[:8].isdigit() and entry.name[8:9] == '_' and entry.name.lower().endswith(extension)):
                    continue
                try:
                    if (entry.is_file(follow_symlinks=False) and entry.stat().st_size == len(payload)
                            and file_digest(entry.path) == digest):
                        return entry.path
                except OSError:
                    continue
        return _write_snapshot(path, payload, directory)
