"""Reuse identical immutable generated media without writing another file."""
import hashlib
import os
import tempfile
import threading

_lock = threading.RLock()
_hashes = {}


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


def write_media_snapshot(path, payload):
    """Return an existing immutable snapshot, or atomically save a new one."""
    directory = os.path.dirname(os.path.abspath(path))
    os.makedirs(directory, exist_ok=True)
    digest = hashlib.sha256(payload).digest()
    with _lock:
        for entry in os.scandir(directory):
            # Adapter output filenames can be overwritten in place. Only reuse
            # immutable snapshots created by this application's naming policy.
            if not (entry.name[:8].isdigit() and entry.name[8:9] == '_'):
                continue
            try:
                if entry.is_file() and entry.stat().st_size == len(payload) and file_digest(entry.path) == digest:
                    return entry.path
            except OSError:
                continue
        fd, temporary = tempfile.mkstemp(dir=directory, suffix='.tmp')
        try:
            with os.fdopen(fd, 'wb') as stream:
                stream.write(payload)
            os.replace(temporary, path)
        finally:
            if os.path.exists(temporary):
                os.unlink(temporary)
    return path
