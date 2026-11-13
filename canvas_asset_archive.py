"""Build a ZIP from the media explicitly selected for a canvas download."""

from itertools import count
from pathlib import Path, PureWindowsPath
from tempfile import SpooledTemporaryFile
from unicodedata import normalize
from urllib.parse import quote, unquote, urlsplit
from zipfile import ZIP_DEFLATED, ZipFile

from fastapi import HTTPException
from starlette.responses import StreamingResponse

from asset_kernel import display_name


_MEMORY_LIMIT = 8 * 1024 * 1024
_CHUNK_SIZE = 256 * 1024


def _safe_name(label, fallback):
    leaf = str(label or "").replace("\\", "/").rsplit("/", 1)[-1]
    name = display_name(leaf, fallback, limit=len(leaf)).strip(" .") or fallback
    return "_" + name if PureWindowsPath(name).is_reserved() else name


def _zip_filename(requested):
    name = _safe_name(requested, "canvas-output-images.zip")
    return name if name.lower().endswith(".zip") else f"{name}.zip"


def _unique_name(name, names):
    path = Path(name)
    for number in count(1):
        candidate = name if number == 1 else f"{path.stem}-{number}{path.suffix}"
        key = normalize("NFC", candidate).casefold()
        if key not in names:
            return candidate, key


def _url_leaf(url):
    try:
        return unquote(urlsplit(url).path)
    except ValueError:
        return ""


class ArchiveDownload(StreamingResponse):
    def __init__(self, archive, filename, size):
        self._archive = archive
        headers = {
            "Content-Disposition": f"attachment; filename*=UTF-8''{quote(filename, safe='')}",
            "Content-Length": str(size),
        }
        super().__init__(self._chunks(), media_type="application/zip", headers=headers)

    def _chunks(self):
        while chunk := self._archive.read(_CHUNK_SIZE):
            yield chunk

    async def __call__(self, scope, receive, send):
        try:
            await super().__call__(scope, receive, send)
        finally:
            self._archive.close()


def download(items, filename, resolve_local, fetch_remote):
    archive = SpooledTemporaryFile(max_size=_MEMORY_LIMIT, mode="w+b")
    names = set()
    try:
        with ZipFile(archive, "w", compression=ZIP_DEFLATED, strict_timestamps=False) as output:
            for url, label, allow_basename in items:
                path = resolve_local(url, allow_basename)
                if path:
                    original = Path(path).name
                else:
                    try:
                        remote = fetch_remote(url)
                    except Exception:
                        continue
                    if remote is None:
                        continue
                    original = _url_leaf(url)
                safe = _safe_name(label or original, f"image-{len(names) + 1}.bin")
                member, key = _unique_name(safe, names)
                if path:
                    output.write(path, member)
                else:
                    output.writestr(member, remote[0])
                names.add(key)
        if not names:
            raise HTTPException(status_code=404, detail="没有可下载的本地图片")
        size = archive.tell()
        archive.seek(0)
        return ArchiveDownload(archive, _zip_filename(filename), size)
    except BaseException:
        archive.close()
        raise
