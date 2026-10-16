"""External inspiration catalog for the local visual workspace."""

import json
import io
import hashlib
import html
import os
import re
import sqlite3
import stat
import tempfile
import threading
import time
import zipfile
from contextlib import contextmanager
from functools import lru_cache
from pathlib import Path
from urllib.parse import quote, unquote, urljoin, urlsplit

import requests
from fastapi import HTTPException
from pydantic import BaseModel
from starlette.concurrency import run_in_threadpool


LEADER_BASE = "https://cdn.leaderai.top/oss/moban-image"
H3_BASE = "https://raw.githubusercontent.com/MiniMax-AI/MiniMax-H3/main/scripts/readme"
H3_REPO = "https://github.com/MiniMax-AI/MiniMax-H3"
H3_COMMUNITY_REPO = "https://github.com/BeatAPI/awesome-minimax-h3-prompts"
H3_COMMUNITY_ARCHIVE = "https://codeload.github.com/BeatAPI/awesome-minimax-h3-prompts/zip/refs/heads/main"
SOURCES = {
    "leaderai": {"name": "LeaderAI", "url": "https://www.leaderai.top/#/preset-prompt-page", "kind": "案例目录"},
    "minimax_h3": {"name": "MiniMax H3 官方", "url": H3_REPO, "kind": "官方案例"},
    "minimax_h3_community": {"name": "MiniMax H3 中文案例", "url": H3_COMMUNITY_REPO, "kind": "社区案例"},
    "moke": {"name": "MOKE SkillHub", "url": "https://www.mokeaigc.com/skill.html", "kind": "Skill 索引"},
    "youmind_seedance": {"name": "YouMind Seedance 2", "url": "https://github.com/YouMind-OpenLab/awesome-seedance-2-prompts", "kind": "GitHub 案例", "repo": "YouMind-OpenLab/awesome-seedance-2-prompts", "model": "Seedance 2.0", "media": "video"},
    "glidea_banana": {"name": "Banana Prompt Quicker", "url": "https://github.com/glidea/banana-prompt-quicker", "kind": "GitHub 案例", "repo": "glidea/banana-prompt-quicker", "model": "Nano Banana", "media": "image", "format": "glidea"},
    "freestyle_gpt_image": {"name": "Freestylefly GPT Image 2", "url": "https://github.com/freestylefly/awesome-gpt-image-2", "kind": "GitHub 案例", "repo": "freestylefly/awesome-gpt-image-2", "model": "GPT Image 2", "media": "image", "format": "freestyle"},
    "zerolu_gpt_image": {"name": "Awesome GPT Image", "url": "https://github.com/ZeroLu/awesome-gpt-image", "kind": "GitHub 案例", "repo": "ZeroLu/awesome-gpt-image", "model": "GPT Image 2", "media": "image"},
    "youmind_gpt_image": {"name": "YouMind GPT Image 2", "url": "https://github.com/YouMind-OpenLab/awesome-gpt-image-2", "kind": "GitHub 案例", "repo": "YouMind-OpenLab/awesome-gpt-image-2", "model": "GPT Image 2", "media": "image"},
    "youmind_banana": {"name": "YouMind Nano Banana Pro", "url": "https://github.com/YouMind-OpenLab/awesome-nano-banana-pro-prompts", "kind": "GitHub 案例", "repo": "YouMind-OpenLab/awesome-nano-banana-pro-prompts", "model": "Nano Banana Pro", "media": "image"},
    "zerolu_banana": {"name": "Awesome Nano Banana Pro", "url": "https://github.com/ZeroLu/awesome-nanobanana-pro", "kind": "GitHub 案例", "repo": "ZeroLu/awesome-nanobanana-pro", "model": "Nano Banana Pro", "media": "image"},
    "picotrex_banana": {"name": "PicoTrex Nano Banana", "url": "https://github.com/PicoTrex/Awesome-Nano-Banana-images", "kind": "GitHub 案例", "repo": "PicoTrex/Awesome-Nano-Banana-images", "model": "Nano Banana", "media": "image"},
    "youmind_gemini": {"name": "YouMind Gemini 3", "url": "https://github.com/YouMind-OpenLab/awesome-gemini-3-prompts", "kind": "GitHub 案例", "repo": "YouMind-OpenLab/awesome-gemini-3-prompts", "model": "Gemini 3", "media": "workflow"},
    "youmind_grok": {"name": "YouMind Grok Imagine", "url": "https://github.com/YouMind-OpenLab/awesome-grok-imagine-prompts", "kind": "GitHub 案例", "repo": "YouMind-OpenLab/awesome-grok-imagine-prompts", "model": "Grok Imagine", "media": "video"},
}

H3_SCRIPTS = (
    ("t2va", "文生有声视频", "文生视频", "reproducible-768p-t2va-request.sh"),
    ("fl2va", "首尾帧生成有声视频", "首尾帧", "reproducible-768p-fl2va-request.sh"),
    ("ref2va", "多模态参考生成有声视频", "多参考", "reproducible-768p-ref2va-request.sh"),
)

_LOCK = threading.RLock()


class FavoriteRequest(BaseModel):
    favorite: bool


class InstallSkillRequest(BaseModel):
    replace: bool = False


def _moke_skill_location(case):
    if case["source_id"] != "moke" or case["kind"] != "skill" or not str(case["source_item_id"]).isdigit():
        raise HTTPException(400, "这个案例不是可导入的 MOKE Skill")
    url = urlsplit(case["source_url"])
    parts = [unquote(part) for part in url.path.strip("/").split("/")]
    if (url.scheme != "https" or url.netloc != "www.mokeaigc.com" or url.query or url.fragment
            or len(parts) != 4 or parts[0] != "skills"
            or not all(re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,119}", part) for part in parts[1:])):
        raise HTTPException(400, "Skill 来源地址无效，请重新同步 MOKE 来源")
    return parts[2], parts[3]


def _download_moke_skill(case, destination):
    namespace, slug = _moke_skill_location(case)
    base = f"https://www.mokeaigc.com/api/skills/{quote(namespace, safe='')}/{quote(slug, safe='')}"
    try:
        metadata = json.loads(_fetch(base + "?publicPage=skills", 1_000_000))
        item = metadata.get("item") if isinstance(metadata, dict) else None
        if (not isinstance(item, dict) or str(item.get("id")) != str(case["source_item_id"])
                or item.get("namespace") != namespace or item.get("slug") != slug
                or item.get("visibility") != "PUBLIC"):
            raise ValueError("原站 Skill 信息与本机索引不一致，请重新同步 MOKE 来源")
        if item.get("security_verdict") == "BLOCKED":
            raise ValueError("原站已将这个 Skill 标记为存在严重安全问题，无法直接导入")
        with requests.get(base + "/download", timeout=(8, 60), stream=True,
                          headers={"User-Agent": "XiaomeiCanvas-Inspiration/1.0"}) as response:
            response.raise_for_status()
            archive_path = Path(destination) / "skill.zip"
            size = 0
            with archive_path.open("wb") as output:
                for chunk in response.iter_content(65536):
                    size += len(chunk)
                    if size > 100 * 1024 * 1024:
                        raise ValueError("Skill 下载包超过 100 MB")
                    output.write(chunk)
        with zipfile.ZipFile(archive_path) as archive:
            members = archive.infolist()
            if len(members) > 500 or sum(info.file_size for info in members) > 100 * 1024 * 1024:
                raise ValueError("Skill 包文件数量或解压大小超过限制")
            for info in members:
                name = info.filename.replace("\\", "/")
                parts = name.rstrip("/").split("/")
                mode = (info.external_attr >> 16) & 0o170000
                if (not name or name.startswith("/") or name.lower() == "skill.zip"
                        or any(part in {"", ".", ".."} for part in parts)
                        or any(re.search(r'[<>:"|?*\x00-\x1f]', part) or part.endswith((" ", "."))
                               or re.fullmatch(r"(?i:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\..*)?", part)
                               for part in parts)
                        or mode == stat.S_IFLNK
                        or info.flag_bits & 1):
                    raise ValueError("Skill 包包含无效路径、链接或加密文件")
                target = Path(destination).joinpath(*parts)
                if info.is_dir():
                    target.mkdir(parents=True, exist_ok=True)
                else:
                    target.parent.mkdir(parents=True, exist_ok=True)
                    with archive.open(info) as source, target.open("wb") as output:
                        remaining = info.file_size
                        while remaining:
                            chunk = source.read(min(65536, remaining))
                            if not chunk:
                                raise ValueError("Skill 包文件不完整")
                            output.write(chunk)
                            remaining -= len(chunk)
        archive_path.unlink()
    except (requests.RequestException, RuntimeError, ValueError, zipfile.BadZipFile, OSError) as exc:
        raise HTTPException(502, f"无法从 MOKE 导入 Skill：{exc}") from exc


def _fetch(url, limit=9_000_000):
    try:
        with requests.get(url, timeout=(8, 30), stream=True, headers={"User-Agent": "XiaomeiCanvas-Inspiration/1.0"}) as response:
            response.raise_for_status()
            chunks = []
            size = 0
            for chunk in response.iter_content(65536):
                size += len(chunk)
                if size > limit:
                    raise ValueError("来源文件超过允许大小")
                chunks.append(chunk)
            return b"".join(chunks).decode("utf-8-sig")
    except (requests.RequestException, UnicodeError, ValueError) as exc:
        raise RuntimeError(f"读取来源失败：{exc}") from exc


def _fetch_archive(url, limit=30_000_000):
    try:
        with requests.get(url, timeout=(8, 60), stream=True, headers={"User-Agent": "XiaomeiCanvas-Inspiration/1.0"}) as response:
            response.raise_for_status()
            chunks, size = [], 0
            for chunk in response.iter_content(65536):
                size += len(chunk)
                if size > limit:
                    raise ValueError("来源压缩包超过允许大小")
                chunks.append(chunk)
            return b"".join(chunks)
    except (requests.RequestException, ValueError) as exc:
        raise RuntimeError(f"读取来源失败：{exc}") from exc


def _family(value):
    value = str(value or "").strip()
    lower = value.lower()
    for needle, family in (
        ("seedance", "Seedance"), ("nano banana", "Nano Banana"),
        ("nanobanana", "Nano Banana"), ("gpt image", "GPT Image"),
        ("gpt-image", "GPT Image"), ("gemini", "Gemini"),
        ("minimax", "MiniMax H3"), ("h3", "MiniMax H3"),
        ("grok", "Grok Imagine"), ("flux", "FLUX"),
    ):
        if needle in lower:
            return family
    return value[:80] if value else "未标注模型"


def _json(value):
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


@lru_cache(maxsize=4)
def _repo_chinese_cases(source_id):
    source = SOURCES[source_id]
    raw = _fetch(_repo_url(source, "README_zh.md"), 2_000_000)
    cases = {}
    for section in re.split(r"(?=^### )", raw, flags=re.M):
        if not section.startswith("### "):
            continue
        image = re.search(r'<img\b[^>]*\bsrc=["\']([^"\']+)', section, re.I)
        if not image:
            continue
        preview = html.unescape(image.group(1))
        marker = re.search(r"(?im)^#{4,6}\s+[^\n]*(?:提示词|Prompt)[^\n]*$", section)
        fence = re.search(r"(?ms)^```[^\n]*\n(.*?)\n```", section[marker.end():]) if marker else None
        prompt = fence.group(1).strip() if fence else ""
        title = re.sub(r"^(?:No\.\s*\d+|\d+(?:\.\d+)?\.?|例\s*\d+\s*:)\s*", "", section[4:].splitlines()[0]).strip(" -*：:")
        direct = re.search(r'https://[^\s"<>)]*\.mp4(?:\?[^\s"<>)]*)?', section, re.I)
        gallery = re.search(r"https://youmind\.com/[^\s)\"<>]*[?&]id=\d+", section)
        cases[preview] = {
            "title_zh": title if re.search(r"[\u3400-\u9fff]", title) else "",
            "prompt_zh": prompt if re.search(r"[\u3400-\u9fff]", prompt) else "",
            "video_url": html.unescape(direct.group(0)) if direct else "",
            "watch_url": gallery.group(0) if gallery else "",
        }
    return cases


@lru_cache(maxsize=4)
def _repo_video_catalog(source_id):
    return json.loads(_fetch(_repo_url(SOURCES[source_id], "video-urls.json"), 2_000_000))


def _repo_video_links(item, chinese=None):
    source = SOURCES[item["source_id"]]
    if chinese:
        direct_url = chinese.get("video_url") or ""
        gallery_url = chinese.get("watch_url") or ""
    else:
        lines = _fetch(_repo_url(source, "README.md"), 2_000_000).splitlines()
        title = item["title"].strip()
        start = next((index for index, line in enumerate(lines)
                      if line.startswith("### ") and re.sub(r"^(?:No\.\s*\d+|\d+(?:\.\d+)?\.?|例\s*\d+\s*:)\s*", "", line[4:].strip()).strip(" -*：:") == title), -1)
        if start < 0:
            return "", ""
        end = next((index for index in range(start + 1, len(lines)) if lines[index].startswith("### ")), len(lines))
        section = "\n".join(lines[start:end])
        direct = re.search(r'https://[^\s"<>)]*\.mp4(?:\?[^\s"<>)]*)?', section, re.I)
        gallery = re.search(r"https://youmind\.com/[^\s)\"<>]*[?&]id=\d+", section)
        direct_url = html.unescape(direct.group(0)) if direct else ""
        gallery_url = gallery.group(0) if gallery else ""
    if direct_url:
        return direct_url, ""
    if gallery_url:
        try:
            catalog = _repo_video_catalog(item["source_id"])
            gallery_id = re.search(r"[?&]id=(\d+)", gallery_url).group(1)
            url = str((catalog.get("prompts") or {}).get(gallery_id) or "")
            if url.startswith("https://") and urlsplit(url).path.lower().endswith(".mp4"):
                return url, ""
        except (RuntimeError, ValueError, TypeError, json.JSONDecodeError):
            pass
        return "", gallery_url
    return "", ""


def _leader_rows(kind):
    folder = "image_prompt" if kind == "image" else "video_prompt"
    stem = "imgs" if kind == "image" else "vids"
    raw = json.loads(_fetch(f"{LEADER_BASE}/{folder}/{stem}_index.json"))
    if not isinstance(raw, list) or not raw or not isinstance(raw[0], list):
        raise RuntimeError("LeaderAI 索引格式无法识别")
    keys = [part[0] if isinstance(part, list) else part for part in raw[0]]
    rows = []
    for values in raw[1:]:
        if not isinstance(values, list):
            continue
        item = dict(zip(keys, values))
        if not item.get("public") or not item.get("uuid"):
            continue
        identifier = str(item["uuid"])
        if not re.fullmatch(r"[A-Za-z0-9_-]{4,80}", identifier):
            continue
        model_tags = item.get("model_tags") if isinstance(item.get("model_tags"), list) else []
        model = str(model_tags[0]) if model_tags else ""
        images = item.get("imgs") if isinstance(item.get("imgs"), list) else []
        first = images[0][0] if images and isinstance(images[0], list) and images[0] else ""
        preview = f"{LEADER_BASE}/{folder}/{stem}_src/{identifier[0].lower()}/{identifier}/{first}" if first else ""
        rows.append({
            "id": f"leaderai:{kind}:{identifier}", "source_id": "leaderai", "source_item_id": identifier,
            "title": str(item.get("title") or "未命名案例")[:240], "kind": kind,
            "model_family": _family(model), "model_variant": model[:120],
            "task": str(item.get("catalog") or "")[:120], "author": str(item.get("author") or "LeaderAI")[:120],
            "tags": (item.get("tags") if isinstance(item.get("tags"), list) else [])[:30],
            "prompt": str(item.get("prompt_origin") or item.get("prompt_cn") or "")[:20000],
            "workflow": [], "preview_url": preview,
            "source_url": f"{LEADER_BASE}/{folder}/{stem}_src/{identifier[0].lower()}/{identifier}/meta.json",
            "license": "查看原站使用条款", "verified": False,
        })
    return rows


def _h3_rows():
    rows = []
    for code, title, task, filename in H3_SCRIPTS:
        script = _fetch(f"{H3_BASE}/{filename}", 100_000)
        match = re.search(r"--data-binary\s+@-\s+<<'JSON'\s*\n(.*?)\nJSON", script, re.S)
        if not match:
            raise RuntimeError(f"MiniMax H3 案例格式无法识别：{filename}")
        payload = json.loads(match.group(1))
        prompt = str(payload.get("prompt") or "")
        if not prompt:
            raise RuntimeError(f"MiniMax H3 案例缺少提示词：{filename}")
        target = payload.get("target") or {}
        conditions = payload.get("conditions") or []
        steps = ["阅读官方脚本，确认模型与运行环境", "准备脚本中要求的输入素材", "按原脚本提交生成并检查结果"]
        rows.append({
            "id": f"minimax_h3:{code}", "source_id": "minimax_h3", "source_item_id": code,
            "title": title, "kind": "video", "model_family": "MiniMax H3",
            "model_variant": "H3-Base-Ref2VA" if code == "ref2va" else "H3-Base-FL2VA",
            "task": task, "author": "MiniMax-AI", "tags": ["官方案例", task, "有声视频"],
            "prompt": prompt, "workflow": [
                {"step": text} for text in steps
            ] + [{"step": f"参考素材 {len(conditions)} 项；目标 {target.get('aspect_ratio', '原比例')}、{target.get('duration_seconds', '未指定')} 秒"}],
            "preview_url": f"/static/images/inspiration/minimax-h3-{code}.jpg",
            "video_url": f"https://raw.githubusercontent.com/MiniMax-AI/MiniMax-H3/main/assets/{code}.mp4",
            "source_url": f"{H3_REPO}/blob/main/scripts/readme/{filename}",
            "license": "MiniMax H3 Community License", "verified": True,
        })
    return rows


def _h3_community_rows():
    rows, seen = [], set()
    try:
        with zipfile.ZipFile(io.BytesIO(_fetch_archive(H3_COMMUNITY_ARCHIVE))) as archive:
            for member in archive.infolist():
                parts = member.filename.split("/")
                if (len(parts) != 3 or parts[1] != "prompts" or not parts[2].endswith(".json")
                        or member.file_size > 100_000):
                    continue
                item = json.loads(archive.read(member))
                if not isinstance(item, dict):
                    continue
                slug = str(item.get("slug") or "")
                prompt = str(item.get("prompt") or "").strip()
                title = item.get("title") or {}
                source = item.get("source") or {}
                if (not re.fullmatch(r"[a-z0-9]+(?:-[a-z0-9]+)*", slug)
                        or parts[2] != slug + ".json" or slug in seen or len(prompt) < 20
                        or not isinstance(title, dict) or not isinstance(source, dict)):
                    continue
                preview = str(item.get("thumbnail") or "")
                video = str(item.get("video") or "")
                media_prefix = f"https://media.beatapi.io/prompt-gallery/minimax-h3/{slug}/"
                if (not preview.startswith(media_prefix) or not preview.endswith(".jpg")
                        or not video.startswith(media_prefix) or not video.endswith(".webm")):
                    continue
                seen.add(slug)
                mode = str(item.get("mode") or "")
                task = {"text-to-video": "文生视频", "image-to-video": "图生视频",
                        "reference-to-video": "参考生视频", "multimodal": "多模态参考"}.get(mode, mode)
                original = str(source.get("url") or "")
                rows.append({
                    "id": f"minimax_h3_community:{slug}", "source_id": "minimax_h3_community",
                    "source_item_id": slug, "title": str(title.get("zh") or title.get("en") or slug)[:240],
                    "kind": "video", "model_family": "MiniMax H3", "model_variant": "MiniMax H3",
                    "task": task[:120], "author": str(source.get("name") or "BeatAPI Prompt Gallery")[:120],
                    "summary_zh": str((item.get("description") or {}).get("zh") or "")[:500],
                    "tags": ["社区案例", str(item.get("category") or ""), mode, str(item.get("duration") or "")],
                    "prompt": prompt[:20000], "workflow": [], "preview_url": preview,
                    "video_url": video,
                    "source_url": original if original.startswith("https://") else f"{H3_COMMUNITY_REPO}/blob/main/prompts/{slug}.json",
                    "license": "BeatAPI Prompt Gallery 整理；原作者保留提示词与媒体权利",
                    "verified": item.get("outputStatus") in {"source-verified", "output-verified"},
                })
    except (zipfile.BadZipFile, UnicodeError, ValueError, json.JSONDecodeError) as exc:
        raise RuntimeError(f"MiniMax H3 中文案例格式无法识别：{exc}") from exc
    if not rows:
        raise RuntimeError("MiniMax H3 中文案例中没有可收录的视频")
    return rows


def _moke_seed_rows():
    return [{
        "id": "moke:worldbuilding-v17", "source_id": "moke", "source_item_id": "worldbuilding-v17",
        "title": "世界观构建 Skill", "kind": "skill", "model_family": "通用",
        "model_variant": "", "task": "世界观／视觉设定", "author": "MOKE AIGC",
        "tags": ["Skill", "世界观", "视觉设定"], "prompt": "",
        "workflow": [{"step": "打开原始 Skill，查看输入要求、步骤与参考资料"},
                     {"step": "在原站确认版本与适用范围后，再决定是否安装"}],
        "preview_url": "", "source_url": SOURCES["moke"]["url"],
        "license": "查看原站使用条款", "verified": False,
    }]


def _moke_rows():
    posters, static_base = {}, ""
    try:
        page_html = _fetch(SOURCES["moke"]["url"], 300_000)
        base_match = re.search(r'data-moke-static-base="([^"]+)"', page_html)
        if base_match and base_match.group(1).startswith("https://zcdn.rytesa.cn/moke-v3/"):
            static_base = base_match.group(1).rstrip("/")
            poster_script = _fetch(f"{static_base}/runtime/skill-posters.js", 500_000)
            poster_match = re.fullmatch(r"\s*export default\s+(\{.*\})\s*;?\s*", poster_script, re.S)
            if poster_match:
                posters = json.loads(poster_match.group(1))
    except (RuntimeError, ValueError):
        pass

    rows = []
    seen = set()
    page_number = 1
    expected_total = None
    while True:
        url = f"https://www.mokeaigc.com/api/skills?publicPage=skills&sort=downloads&page={page_number}&limit=100"
        payload = json.loads(_fetch(url, 1_000_000))
        items = payload.get("items") if isinstance(payload, dict) else None
        pagination = payload.get("pagination") if isinstance(payload, dict) else None
        if not isinstance(items, list) or not isinstance(pagination, dict):
            raise RuntimeError("MOKE Skill 列表格式无法识别")
        try:
            total = int(pagination["total"])
        except (KeyError, TypeError, ValueError) as exc:
            raise RuntimeError("MOKE Skill 列表缺少总数") from exc
        if expected_total is None:
            expected_total = total
        if total < 1 or total > 10_000 or total != expected_total or not items:
            raise RuntimeError("MOKE Skill 列表分页不完整")
        for item in items:
            if not isinstance(item, dict) or item.get("visibility") != "PUBLIC":
                continue
            namespace, slug = str(item.get("namespace") or ""), str(item.get("slug") or "")
            identifier = str(item.get("id") or "")
            if not identifier.isdigit() or not namespace or not slug or identifier in seen:
                continue
            seen.add(identifier)
            handle = namespace.split("--", 1)[0] if "--" in namespace else str(item.get("owner_id") or "").removeprefix("moke:")
            handle = handle or "moke-creator"
            poster = posters.get(f"{namespace}/{slug}") if isinstance(posters, dict) else None
            poster = poster if isinstance(poster, dict) else {}
            poster_image = str(poster.get("image") or "")
            preview = urljoin(static_base + "/", poster_image) if static_base and poster_image.startswith("assets/skill-posters") and ".." not in poster_image else ""
            summary = str(item.get("summary_zh") or item.get("summary") or "").strip()[:1500]
            labels = item.get("labels") if isinstance(item.get("labels"), list) else []
            tags = [slug, str(item.get("group_name") or ""), str(item.get("front_category") or "")]
            tags.extend(str(label.get("display_name") or label.get("slug") or "") for label in labels if isinstance(label, dict))
            rows.append({
                "id": f"moke:{identifier}", "source_id": "moke", "source_item_id": identifier,
                "title": str(poster.get("title") or item.get("display_name") or slug)[:240],
                "kind": "skill", "model_family": "通用", "model_variant": "",
                "task": str(item.get("group_name") or item.get("front_category") or "")[:120],
                "author": str(item.get("owner_display_name") or handle)[:120],
                "tags": list(dict.fromkeys(tag for tag in tags if tag))[:30], "prompt": "",
                "workflow": [{"step": summary}] if summary else [], "preview_url": preview,
                "source_url": "https://www.mokeaigc.com/skills/" + "/".join(quote(part, safe="") for part in (handle, namespace, slug)),
                "license": "查看原站使用条款", "verified": False,
            })
        if len(seen) >= expected_total:
            break
        page_number += 1
        if page_number > 100:
            raise RuntimeError("MOKE Skill 列表分页超出范围")
    if len(seen) != expected_total:
        raise RuntimeError("MOKE Skill 列表分页不完整")
    return rows


def _repo_url(source, file):
    return f"https://raw.githubusercontent.com/{source['repo']}/main/{file}"


def _case_from_repo(source_id, source, token, title, prompt, task="", author="", preview="", line=0, tags=None):
    repo = source["repo"]
    link = f"https://github.com/{repo}/blob/main/README.md?plain=1#L{line}" if line else source["url"]
    return {
        "id": f"{source_id}:{token}", "source_id": source_id, "source_item_id": token,
        "title": title[:240], "kind": source["media"], "model_family": _family(source["model"]),
        "model_variant": source["model"], "task": task[:120], "author": (author or repo.split("/")[0])[:120],
        "tags": (tags or [])[:30], "prompt": prompt[:20000], "workflow": [],
        "preview_url": preview, "source_url": link,
        "license": "查看仓库许可与原作者授权", "verified": False,
    }


def _markdown_rows(source_id, source):
    raw = _fetch(_repo_url(source, "README.md"), 2_000_000)
    rows = []
    seen_tokens = set()
    current = None
    category = ""
    fenced = False
    line_number = 0

    def append_current():
        if not current:
            return
        title, lines, start_line, task = current
        section = "".join(lines)
        marker = re.search(r"(?im)^(?:#{4,6}\s+[^\n]*(?:prompt|提示词)|\*\*(?:prompt|提示词)[^\n]*\*\*)", section)
        if not marker:
            return
        fence = re.search(r"(?ms)^```[^\n]*\n(.*?)\n```", section[marker.end():])
        if not fence:
            return
        prompt = fence.group(1).strip()
        if len(prompt) < 15:
            return
        clean_title = re.sub(r"\[([^\]]+)\]\([^)]+\)", r"\1", title)
        clean_title = re.sub(r"^(?:No\.\s*\d+|\d+(?:\.\d+)?\.?|例\s*\d+\s*:)\s*", "", clean_title).strip(" -*：:")
        if not clean_title:
            return
        if task.lower() in {"all prompts", "featured prompts", "prompt gallery"}:
            task = ""
        preview = ""
        for match in re.finditer(r'<img\b[^>]*\bsrc=["\']([^"\']+)["\']|!\[[^\]]*\]\(([^)]+)\)', section, re.I):
            candidate = html.unescape(match.group(1) or match.group(2) or "")
            if any(skip in candidate.lower() for skip in ("shields.io", "badge", "trendshift")):
                continue
            preview = urljoin(_repo_url(source, "README.md"), candidate)
            break
        author_match = re.search(r"(?im)\*\*Author:\*\*\s*(?:\[([^\]]+)\]|([^\n|]+))", section)
        author = (author_match.group(1) or author_match.group(2)).strip() if author_match else ""
        token = hashlib.sha1(clean_title.encode("utf-8")).hexdigest()[:16]
        if token in seen_tokens:
            token = hashlib.sha1((clean_title + "\n" + preview + "\n" + author).encode("utf-8")).hexdigest()[:16]
        if token in seen_tokens:
            token = hashlib.sha1((clean_title + "\n" + prompt).encode("utf-8")).hexdigest()[:16]
        seen_tokens.add(token)
        rows.append(_case_from_repo(source_id, source, token, clean_title, prompt, task, author, preview, start_line, [task] if task else []))

    for line in raw.splitlines(keepends=True):
        line_number += 1
        if line.lstrip().startswith("```"):
            fenced = not fenced
        if not fenced and line.startswith("## "):
            category = re.sub(r"^[^A-Za-z\u4e00-\u9fff]+", "", line[3:].strip())[:120]
        if not fenced and line.startswith("### "):
            append_current()
            current = (line[4:].strip(), [], line_number, category)
        elif current:
            current[1].append(line)
    append_current()
    if not rows:
        raise RuntimeError(f"{source['name']} README 中没有可识别的独立提示词")
    return rows


def _structured_rows(source_id, source):
    if source["format"] == "glidea":
        raw = json.loads(_fetch(_repo_url(source, "prompts.json"), 3_000_000))
        if not isinstance(raw, list):
            raise RuntimeError("Banana Prompt Quicker 数据格式无法识别")
        rows = []
        for item in raw:
            if not isinstance(item, dict) or not item.get("prompt"):
                continue
            title = str(item.get("title") or "未命名案例")
            prompt = str(item["prompt"])
            token = hashlib.sha1((title + "\n" + str(item.get("preview") or "")).encode("utf-8")).hexdigest()[:16]
            row = _case_from_repo(source_id, source, token, title, prompt,
                                  str(item.get("sub_category") or item.get("category") or ""),
                                  str(item.get("author") or ""), str(item.get("preview") or ""),
                                  tags=[str(item.get("category") or ""), str(item.get("mode") or "")])
            if str(item.get("link") or "").startswith("https://"):
                row["source_url"] = item["link"]
            rows.append(row)
        return rows
    raw = json.loads(_fetch(_repo_url(source, "data/cases.json"), 3_000_000))
    cases = raw.get("cases") if isinstance(raw, dict) else None
    if not isinstance(cases, list):
        raise RuntimeError("Freestylefly 案例格式无法识别")
    rows = []
    for item in cases:
        if not isinstance(item, dict) or not item.get("id") or not item.get("prompt"):
            continue
        image = str(item.get("image") or "")
        preview = urljoin("https://gpt-image2.canghe.ai/", image) if image.startswith("/images/") else ""
        row = _case_from_repo(source_id, source, str(item["id"]), str(item.get("title") or "未命名案例"),
                              str(item["prompt"]), str(item.get("category") or ""),
                              str(item.get("sourceLabel") or ""), preview,
                              tags=[str(value) for value in item.get("styles") or []])
        if str(item.get("githubUrl") or "").startswith("https://"):
            row["source_url"] = item["githubUrl"]
        rows.append(row)
    return rows


def _github_rows(source_id):
    source = SOURCES[source_id]
    rows = _structured_rows(source_id, source) if source.get("format") else _markdown_rows(source_id, source)
    if not rows:
        raise RuntimeError("来源没有可收录的案例")
    return rows


def install_inspiration_library(app, host):
    database = Path(host.DATA_DIR) / "inspiration_library.sqlite3"

    @contextmanager
    def connect():
        database.parent.mkdir(parents=True, exist_ok=True)
        conn = sqlite3.connect(str(database), timeout=15)
        try:
            conn.row_factory = sqlite3.Row
            conn.execute("PRAGMA busy_timeout=15000")
            conn.execute("""CREATE TABLE IF NOT EXISTS cases (
            id TEXT PRIMARY KEY, source_id TEXT NOT NULL, source_item_id TEXT NOT NULL,
            title TEXT NOT NULL, kind TEXT NOT NULL, model_family TEXT NOT NULL,
            model_variant TEXT NOT NULL, task TEXT NOT NULL, author TEXT NOT NULL,
            tags_json TEXT NOT NULL, prompt TEXT NOT NULL, workflow_json TEXT NOT NULL,
            preview_url TEXT NOT NULL, source_url TEXT NOT NULL, license TEXT NOT NULL,
            verified INTEGER NOT NULL DEFAULT 0, favorite INTEGER NOT NULL DEFAULT 0,
            fetched_at INTEGER NOT NULL, video_url TEXT NOT NULL DEFAULT '',
            summary_zh TEXT NOT NULL DEFAULT ''
        )""")
            if not any(column[1] == "video_url" for column in conn.execute("PRAGMA table_info(cases)")):
                conn.execute("ALTER TABLE cases ADD COLUMN video_url TEXT NOT NULL DEFAULT ''")
            if not any(column[1] == "summary_zh" for column in conn.execute("PRAGMA table_info(cases)")):
                conn.execute("ALTER TABLE cases ADD COLUMN summary_zh TEXT NOT NULL DEFAULT ''")
            conn.execute("CREATE INDEX IF NOT EXISTS cases_filter ON cases(kind, model_family, source_id)")
            conn.execute("""CREATE TABLE IF NOT EXISTS source_sync (
            source_id TEXT PRIMARY KEY, synced_at INTEGER NOT NULL, item_count INTEGER NOT NULL,
            error TEXT NOT NULL DEFAULT ''
        )""")
            yield conn
            conn.commit()
        except Exception:
            conn.rollback()
            raise
        finally:
            conn.close()

    def upsert(rows, source_id, record_sync=True):
        stamp = int(time.time())
        row_stamp = time.time_ns()
        with _LOCK, connect() as conn:
            for row in rows:
                conn.execute("""INSERT INTO cases
                    (id,source_id,source_item_id,title,kind,model_family,model_variant,task,author,
                     tags_json,prompt,workflow_json,preview_url,source_url,license,verified,favorite,fetched_at,video_url,summary_zh)
                    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,COALESCE((SELECT favorite FROM cases WHERE id=?),0),?,?,?)
                    ON CONFLICT(id) DO UPDATE SET
                    title=excluded.title, kind=excluded.kind, model_family=excluded.model_family,
                    model_variant=excluded.model_variant, task=excluded.task, author=excluded.author,
                    tags_json=excluded.tags_json,
                    prompt=CASE WHEN cases.source_id='leaderai' AND excluded.prompt LIKE '%...'
                        AND length(cases.prompt)>length(excluded.prompt)
                        AND substr(cases.prompt,1,length(excluded.prompt)-3)=substr(excluded.prompt,1,length(excluded.prompt)-3)
                        THEN cases.prompt ELSE excluded.prompt END,
                    workflow_json=excluded.workflow_json,
                    preview_url=excluded.preview_url, video_url=excluded.video_url,
                    summary_zh=excluded.summary_zh,
                    source_url=excluded.source_url,
                    license=excluded.license, verified=excluded.verified, fetched_at=excluded.fetched_at""",
                    (row["id"], row["source_id"], row["source_item_id"], row["title"], row["kind"],
                     row["model_family"], row["model_variant"], row["task"], row["author"],
                     _json(row["tags"]), row["prompt"], _json(row["workflow"]), row["preview_url"],
                     row["source_url"], row["license"], int(row["verified"]), row["id"], row_stamp,
                     row.get("video_url", ""), row.get("summary_zh", "")))
            conn.execute("DELETE FROM cases WHERE source_id=? AND fetched_at<>? AND favorite=0", (source_id, row_stamp))
            if record_sync:
                conn.execute("""INSERT INTO source_sync(source_id,synced_at,item_count,error) VALUES(?,?,?,'')
                    ON CONFLICT(source_id) DO UPDATE SET synced_at=excluded.synced_at,
                    item_count=excluded.item_count,error=''""", (source_id, stamp, len(rows)))
        return {"source_id": source_id, "item_count": len(rows), "synced_at": stamp}

    # Local source entries are available offline on first visit.
    with connect() as conn:
        count = conn.execute("SELECT count(*) FROM cases WHERE source_id IN ('minimax_h3','moke')").fetchone()[0]
    if not count:
        upsert(_moke_seed_rows(), "moke", record_sync=False)
    with connect() as conn:
        conn.execute("UPDATE cases SET kind='skill' WHERE source_id='moke' AND kind='workflow'")

    def public(row, detail=False):
        result = dict(row)
        result.pop("_rank", None)
        result["tags"] = json.loads(result.pop("tags_json"))
        result["workflow"] = json.loads(result.pop("workflow_json"))
        result["verified"] = bool(result["verified"])
        result["favorite"] = bool(result["favorite"])
        if not detail:
            result.pop("prompt")
            result.pop("workflow")
        return result

    @app.get("/api/inspiration/sources")
    def sources():
        with connect() as conn:
            synced = {row["source_id"]: dict(row) for row in conn.execute("SELECT * FROM source_sync")}
            counts = {row["source_id"]: row["total"] for row in conn.execute("SELECT source_id,count(*) AS total FROM cases GROUP BY source_id")}
        return {"sources": [{"id": key, **value, **synced.get(key, {}), "local_count": counts.get(key, 0)} for key, value in SOURCES.items()]}

    @app.get("/api/inspiration/cases")
    def cases(q: str = "", kind: str = "", model: str = "", source: str = "", task: str = "",
              favorites: bool = False, page: int = 1, limit: int = 36):
        clauses, args = [], []
        if kind in {"image", "video", "workflow", "skill"}:
            clauses.append("kind=?"); args.append(kind)
        if model:
            clauses.append("model_family=?"); args.append(model[:80])
        if source in SOURCES:
            clauses.append("source_id=?"); args.append(source)
        if task:
            clauses.append("task=?"); args.append(task[:120])
        if favorites:
            clauses.append("favorite=1")
        if q.strip():
            clauses.append("(title LIKE ? OR task LIKE ? OR model_variant LIKE ? OR tags_json LIKE ? OR prompt LIKE ?)")
            pattern = f"%{q.strip()[:120]}%"
            args.extend([pattern] * 5)
        where = " WHERE " + " AND ".join(clauses) if clauses else ""
        page, limit = max(1, min(page, 10000)), max(1, min(limit, 100))
        with connect() as conn:
            total = conn.execute("SELECT count(*) FROM cases" + where, args).fetchone()[0]
            rows = conn.execute("SELECT * FROM (SELECT cases.*, ROW_NUMBER() OVER (PARTITION BY model_family ORDER BY verified DESC, fetched_at DESC, title) AS _rank FROM cases" + where + ") ORDER BY _rank, model_family LIMIT ? OFFSET ?",
                                (*args, limit, (page - 1) * limit)).fetchall()
            model_where = " WHERE kind=?" if kind in {"image", "video", "workflow", "skill"} else ""
            model_args = (kind,) if model_where else ()
            models = [dict(row) for row in conn.execute("SELECT model_family AS name,count(*) AS count FROM cases" + model_where + " GROUP BY model_family ORDER BY count DESC,name", model_args)]
            tasks = [dict(row) for row in conn.execute("SELECT task AS name,count(*) AS count FROM cases WHERE task<>'' GROUP BY task ORDER BY count DESC,name LIMIT 80")]
        return {"cases": [public(row) for row in rows], "total": total, "page": page, "limit": limit,
                "models": models, "tasks": tasks}

    @app.get("/api/inspiration/cases/{case_id}")
    def case_detail(case_id: str):
        with connect() as conn:
            row = conn.execute("SELECT * FROM cases WHERE id=?", (case_id,)).fetchone()
        if not row:
            raise HTTPException(404, "灵感案例不存在")
        item = public(row, True)
        if item["source_id"] == "leaderai":
            identifier = item["source_item_id"]
            folder = "image_prompt/imgs_src" if item["kind"] == "image" else "video_prompt/vids_src"
            url = f"{LEADER_BASE}/{folder}/{identifier[0].lower()}/{identifier}/meta.json"
            try:
                metadata = json.loads(_fetch(url, 500_000))
                if not isinstance(metadata, dict) or metadata.get("uuid") != identifier:
                    raise ValueError("案例编号不匹配")
                translated = metadata.get("prompt_cn")
                if isinstance(translated, str) and translated.strip():
                    item["prompt_zh"] = translated.strip()
                if item["kind"] == "video":
                    filename = metadata.get("vids")
                    if isinstance(filename, str) and filename.lower().endswith(".mp4") and "/" not in filename and "\\" not in filename:
                        item["video_url"] = url.rsplit("/", 1)[0] + "/" + quote(filename)
                if len(item["prompt"]) <= 48 and item["prompt"].endswith("..."):
                    prompt = metadata.get("prompt_origin") or metadata.get("prompt_cn") or ""
                    if not isinstance(prompt, str) or not prompt.strip():
                        raise ValueError("来源未提供完整提示词")
                    item["prompt"] = prompt
                    with _LOCK, connect() as conn:
                        conn.execute("UPDATE cases SET prompt=? WHERE id=? AND prompt=?",
                                     (prompt, case_id, row["prompt"]))
            except (RuntimeError, ValueError, TypeError, json.JSONDecodeError):
                if len(item["prompt"]) <= 48 and item["prompt"].endswith("..."):
                    item["prompt_incomplete"] = True
        elif item["source_id"].startswith("youmind_"):
            chinese = None
            try:
                chinese = _repo_chinese_cases(item["source_id"]).get(item["preview_url"])
                if chinese:
                    item["title_zh"] = chinese["title_zh"]
                    item["prompt_zh"] = chinese["prompt_zh"]
            except (RuntimeError, ValueError, TypeError, json.JSONDecodeError):
                pass
            if item["kind"] == "video":
                try:
                    item["video_url"], item["watch_url"] = _repo_video_links(item, chinese)
                except (RuntimeError, ValueError, TypeError, json.JSONDecodeError):
                    pass
        return {"case": item}

    @app.patch("/api/inspiration/cases/{case_id}/favorite")
    def favorite(case_id: str, payload: FavoriteRequest):
        with _LOCK, connect() as conn:
            updated = conn.execute("UPDATE cases SET favorite=? WHERE id=?", (int(payload.favorite), case_id))
            if not updated.rowcount:
                raise HTTPException(404, "灵感案例不存在")
        return {"id": case_id, "favorite": payload.favorite}

    @app.post("/api/inspiration/cases/{case_id}/install-skill")
    async def install_skill(case_id: str, payload: InstallSkillRequest):
        with connect() as conn:
            row = conn.execute("SELECT * FROM cases WHERE id=?", (case_id,)).fetchone()
        if not row:
            raise HTTPException(404, "灵感案例不存在")
        _moke_skill_location(row)
        if not all(hasattr(host, name) for name in (
            "AGENT_SKILL_UPLOAD_DIR", "_agent_skill_scan_package", "import_agent_skill_package",
            "AgentSkillPackageImportRequest",
        )):
            raise HTTPException(503, "本地 Skill 管理暂不可用")
        Path(host.AGENT_SKILL_UPLOAD_DIR).mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(prefix="moke-", dir=host.AGENT_SKILL_UPLOAD_DIR) as source_dir:
            await run_in_threadpool(_download_moke_skill, row, source_dir)
            try:
                scan = await run_in_threadpool(host._agent_skill_scan_package, source_dir)
            except (OSError, ValueError) as exc:
                raise HTTPException(422, f"下载的 Skill 包无法导入：{exc}") from exc
            if len(scan["skills"]) != 1 or scan["valid_count"] != 1:
                raise HTTPException(422, "下载包必须只包含一个有效的 SKILL.md")
            skill_id = scan["skills"][0]["id"]
            result = await host.import_agent_skill_package(host.AgentSkillPackageImportRequest(
                source_dir=source_dir, skill_ids=[skill_id], replace=payload.replace,
            ))
        return {"case_id": case_id, "skill_id": skill_id, **result}

    @app.post("/api/inspiration/sources/{source_id}/sync")
    def sync(source_id: str):
        if source_id not in SOURCES:
            raise HTTPException(404, "来源不存在")
        try:
            if source_id == "leaderai":
                rows = _leader_rows("image") + _leader_rows("video")
            elif source_id == "minimax_h3":
                rows = _h3_rows()
            elif source_id == "minimax_h3_community":
                rows = _h3_community_rows()
            elif source_id == "moke":
                rows = _moke_rows()
            else:
                rows = _github_rows(source_id)
            if not rows:
                raise RuntimeError("来源没有可收录的案例")
            result = upsert(rows, source_id)
            if source_id.startswith("youmind_"):
                _repo_chinese_cases.cache_clear()
                _repo_video_catalog.cache_clear()
            return result
        except (RuntimeError, ValueError, KeyError, json.JSONDecodeError) as exc:
            with _LOCK, connect() as conn:
                conn.execute("""INSERT INTO source_sync(source_id,synced_at,item_count,error) VALUES(?,0,0,?)
                    ON CONFLICT(source_id) DO UPDATE SET error=excluded.error""", (source_id, str(exc)[:400]))
            raise HTTPException(502, f"同步 {SOURCES[source_id]['name']} 失败：{exc}") from exc

    return {"database": database, "sources": SOURCES}
