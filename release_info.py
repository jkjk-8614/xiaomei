"""Read Xiaomei Canvas version information and its official release metadata."""

from datetime import date
from itertools import zip_longest
import json
from pathlib import Path
import re
from urllib.request import getproxies

import requests


REPOSITORY = "https://github.com/jkjk-8614/xiaomei"
DOWNLOAD_PAGE = f"{REPOSITORY}/releases/latest"
RELEASE_API = "https://api.github.com/repos/jkjk-8614/xiaomei/releases/latest"
_VERSION = re.compile(r"v?(\d{1,4})\.(\d{1,4})(?:\.(\d{1,4}))?", re.I)


def _version_key(value):
    match = _VERSION.fullmatch(str(value or "").strip())
    if not match:
        return ()
    major, minor, patch = match.groups()
    if patch is None:
        return int(major), 0, int(minor)
    return int(major), int(minor), int(patch)


def version_gt(left, right):
    """Compare third-party CLI versions with missing components treated as zero."""
    first = map(int, re.findall(r"\d+", str(left or "")))
    second = map(int, re.findall(r"\d+", str(right or "")))
    for a, b in zip_longest(first, second, fillvalue=0):
        if a != b:
            return a > b
    return False


def local_version(root):
    try:
        text = (Path(root) / "VERSION").read_text(encoding="utf-8-sig").strip()
    except (OSError, UnicodeError):
        text = ""
    return text.splitlines()[0].strip() if text else date.today().strftime("%Y.%m.%d")


def local_notes(static_root, version):
    try:
        with (Path(static_root) / "update-notes.json").open(encoding="utf-8-sig") as source:
            document = json.load(source)
    except (OSError, ValueError):
        document = {}
    if not isinstance(document, dict):
        document = {}
    history = document.get("history")
    if isinstance(history, list) and version:
        for entry in history:
            if not isinstance(entry, dict):
                continue
            label = str(entry.get("version") or "").strip()
            key = _version_key(label)
            if label == version or (key and key == _version_key(version)):
                document = entry
                break
    notes = []
    items = document.get("items")
    for item in items[:30] if isinstance(items, list) else ():
        if isinstance(item, dict):
            text = str(item.get("text") or item.get("title") or "").strip()
            kind = str(item.get("type") or "update").strip()
        else:
            text, kind = str(item or "").strip(), "update"
        if text:
            notes.append({"type": kind[:32], "text": text[:500]})
    return {
        "version": str(document.get("version") or version or "").strip(),
        "updated_at": str(document.get("updated_at") or document.get("date") or "").strip(),
        "items": notes,
    }


def _official_release():
    headers = {"Accept": "application/vnd.github+json", "User-Agent": "Xiaomei-Canvas"}
    status = 0
    tag = ""
    try:
        response = requests.get(
            RELEASE_API, headers=headers, timeout=5, proxies=getproxies() or None, allow_redirects=False,
        )
        status = response.status_code
        if status == 200:
            payload = response.json()
            if isinstance(payload, dict) and payload.get("draft") is False and payload.get("prerelease") is False:
                tag = str(payload.get("tag_name") or "").strip()
            if not _version_key(tag):
                tag = ""
                error = "GitHub 返回的正式版本信息无效。"
            else:
                error = ""
        else:
            error = f"GitHub 返回 HTTP {status}。"
    except requests.Timeout:
        error = "连接 GitHub 超时。"
    except ValueError:
        error = "GitHub 返回的正式版本信息无效。"
    except requests.RequestException:
        error = "无法连接 GitHub。"
    return {"ok": bool(tag), "status": status, "version": tag, "error": error, "source": "github", "url": RELEASE_API}


def check_release(current):
    github = _official_release()
    tag = github["version"]
    local = _version_key(current)
    return {
        "current": current,
        "github": github,
        "latest": {"source": "github", "version": tag} if tag else {},
        "update_available": bool(local and _version_key(tag) > local),
        "reachable": github["ok"],
        "release_url": DOWNLOAD_PAGE,
    }
