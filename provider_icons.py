"""API 平台站点图标（favicon）的抓取与本地缓存。

平台列表里的图标统一由 `/api/provider-icon?url=<base_url>` 提供：第一次请求会
按 base_url 的站点来源（scheme://host[:port]）去站点取图标，成功后落到运行数据
目录的 `data/provider_icons/`，之后直接读缓存，断网也能显示。

本模块只做纯逻辑（解析页面里的 <link rel="icon">、识别图片格式、读写缓存），
真正的网络请求由调用方通过 `fetch_bytes(url, max_bytes)` 注入，便于测试。
"""
from __future__ import annotations

import hashlib
import os
import re
import tempfile
import time
from html.parser import HTMLParser
from urllib.parse import quote, urljoin, urlsplit, urlunsplit

# 图标本身很少变，缓存一个月；取不到时记一次 miss，半小时内不再重复请求站点。
CACHE_TTL_SECONDS = 30 * 24 * 3600
MISS_TTL_SECONDS = 30 * 60
MAX_ICON_BYTES = 512 * 1024
MAX_PAGE_BYTES = 512 * 1024

# 常见的接口子域前缀：api.6789api.com → 6789api.com 更容易拿到品牌图标。
SUBDOMAIN_PREFIXES = {"api", "api2", "www", "open", "gateway", "relay", "proxy", "cdn", "llm", "v1"}

# 有些 API 站点自己不放 favicon（例如 maas.qianwenaiapi.com 整站 404），
# 平台名能对上已知品牌时改用品牌官网的图标。
BRAND_ORIGINS = (
    ("https://chat.qwen.ai/", ("千问", "通义", "qwen", "tongyi")),
    ("https://www.deepseek.com/", ("deepseek", "深度求索", "深度搜索")),
    ("https://www.doubao.com/", ("豆包", "doubao")),
    ("https://www.kimi.com/", ("kimi", "月之暗面", "moonshot")),
    ("https://bigmodel.cn/", ("智谱", "bigmodel", "zhipu", "glm")),
    ("https://hunyuan.tencent.com/", ("混元", "hunyuan")),
    ("https://yiyan.baidu.com/", ("文心", "yiyan", "ernie")),
    ("https://www.minimaxi.com/", ("minimax",)),
    ("https://siliconflow.cn/", ("硅基流动", "siliconflow")),
    ("https://platform.stepfun.com/", ("阶跃", "stepfun")),
)

_ICON_REL_RE = re.compile(r"(?:^|\s)(?:shortcut\s+)?icon(?:\s|$)|apple-touch-icon|mask-icon|fluid-icon", re.IGNORECASE)
_SIZE_RE = re.compile(r"^\s*(\d+)\s*[xX×]\s*(\d+)")
_MEDIA_TYPES = {
    "ico": "image/x-icon",
    "png": "image/png",
    "gif": "image/gif",
    "jpg": "image/jpeg",
    "svg": "image/svg+xml",
    "webp": "image/webp",
}


def normalize_site_origin(value):
    """把 base_url（可能带 /v1 之类路径）收敛成站点来源；不合法返回空串。"""
    text = str(value or "").strip()
    if not text or not re.match(r"^https?://", text, re.IGNORECASE):
        return ""
    try:
        parsed = urlsplit(text)
        port = parsed.port
    except ValueError:
        return ""
    host = (parsed.hostname or "").lower()
    if not host:
        return ""
    netloc = f"[{host}]" if ":" in host else host
    if port:
        netloc = f"{netloc}:{port}"
    return urlunsplit((parsed.scheme.lower(), netloc, "/", "", ""))


def parent_origin(origin):
    """api.6789api.com → https://6789api.com/；识别不出来时返回空串。"""
    parsed = urlsplit(origin)
    host = (parsed.hostname or "").lower()
    labels = host.split(".")
    if len(labels) < 3 or labels[0] not in SUBDOMAIN_PREFIXES:
        return ""
    return urlunsplit((parsed.scheme, ".".join(labels[1:]), "/", "", ""))


def brand_origin_for_name(name):
    """平台名能对上已知品牌时返回品牌官网来源，用于补一张可识别的图标。

    只做整名包含匹配（去掉空格、连字符后比较），别名至少两个字符，避免误命中。
    """
    text = re.sub(r"[\s\-_/·]+", "", str(name or "")).lower()
    if len(text) < 2:
        return ""
    for origin, aliases in BRAND_ORIGINS:
        for alias in aliases:
            if len(alias) >= 2 and alias in text:
                return origin
    return ""


class _IconLinkParser(HTMLParser):
    """收集页面里声明的站点图标，并按“越大越清晰”排序。"""

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.links = []
        self.base_href = ""

    def handle_starttag(self, tag, attrs):
        attributes = {str(key or "").lower(): str(value or "") for key, value in attrs}
        if tag == "base" and attributes.get("href") and not self.base_href:
            self.base_href = attributes["href"].strip()
            return
        if tag != "link":
            return
        rel = attributes.get("rel") or ""
        if not _ICON_REL_RE.search(rel):
            return
        href = (attributes.get("href") or "").strip()
        if not href or href.startswith(("data:", "javascript:")):
            return
        tier, size = _icon_rank(attributes, rel)
        self.links.append((tier, size, href))


def _icon_rank(attributes, rel):
    """给页面声明的图标排优先级，返回 (档位, 像素)，越小越靠前。

    首选站点自己声明的普通图标（SVG、≥64px 的 PNG、没写 sizes 的 PNG glyph）；
    其次是 16/32px 小图标，再是 apple-touch-icon（常带不透明底），最后才是
    没写尺寸的 .ico 和 mask-icon。
    """
    lowered = rel.lower()
    href = (attributes.get("href") or "").lower()
    path = href.split("?")[0]
    declared = _declared_size(attributes)
    is_svg = "svg" in (attributes.get("type") or "").lower() or path.endswith(".svg")
    if "mask-icon" in lowered:
        return 4, declared or 0
    if "apple-touch-icon" in lowered:
        return 2, declared or 180
    if is_svg:
        return 0, 512
    if declared is None:
        if path.endswith(".ico"):
            return 3, 32
        return 0, 96
    return (0, declared) if declared >= 64 else (1, declared)


def _declared_size(attributes):
    match = _SIZE_RE.match(attributes.get("sizes") or "")
    if not match:
        return None
    return min(max(int(match.group(1)), int(match.group(2))), 512)


def _encoded(url):
    """把中文/空格等非 ASCII 字符按 UTF-8 转义，http.client 只接受 ASCII 请求行。"""
    try:
        parts = urlsplit(url)
    except ValueError:
        return url
    return urlunsplit((
        parts.scheme,
        parts.netloc,
        quote(parts.path, safe="/%:@!$&'()*+,;=-._~"),
        quote(parts.query, safe="=&%:@!$'()*+,;/?-._~"),
        "",
    ))


def icon_candidates(origin, fetch_bytes):
    """按优先级给出候选图标地址。

    api.xxx.com 这类接口域名通常只返回 JSON，图标在主页域名上，所以先收集两个
    站点页面里声明的图标（本站优先），最后才用 /favicon.ico 兜底探测。
    """
    candidates = []
    sites = [site for site in (origin, parent_origin(origin)) if site]
    # 先看两个站点页面里声明的图标（本站优先），再退回 /favicon.ico 探测：
    # api.xxx.com 常常只放一个通用 ico，主页域名上的品牌图标才是用户认识的。
    for site in sites:
        page = fetch_bytes(site, MAX_PAGE_BYTES)
        if page:
            parser = _IconLinkParser()
            try:
                parser.feed(page.decode("utf-8", "ignore"))
            except Exception:
                parser.links = []
            base = urljoin(site, parser.base_href) if parser.base_href else site
            for _tier, _size, href in sorted(parser.links, key=lambda row: (row[0], -row[1])):
                candidates.append(urljoin(base, href))
    for site in sites:
        candidates.append(urljoin(site, "/favicon.ico"))
    return list(dict.fromkeys(_encoded(candidate) for candidate in candidates))


def sniff_icon(data):
    """按文件头识别图标格式，返回 (扩展名, MIME) 或 None。

    不信任上游的 Content-Type：很多站点把 favicon.ico 用 text/html 返回，
    也有把 PNG 塞进 .ico 的情况。
    """
    if not data:
        return None
    if data.startswith(b"\x00\x00\x01\x00") or data.startswith(b"\x00\x00\x02\x00"):
        return "ico", _MEDIA_TYPES["ico"]
    if data.startswith(b"\x89PNG\r\n\x1a\n"):
        return "png", _MEDIA_TYPES["png"]
    if data.startswith(b"GIF8"):
        return "gif", _MEDIA_TYPES["gif"]
    if data.startswith(b"\xff\xd8\xff"):
        return "jpg", _MEDIA_TYPES["jpg"]
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "webp", _MEDIA_TYPES["webp"]
    head = data[:2048].lstrip()
    if head.startswith(b"<?xml") or head.startswith(b"<svg"):
        if b"<svg" in data[:8192]:
            return "svg", _MEDIA_TYPES["svg"]
    return None


def download_icon(origin, fetch_bytes):
    """逐个候选地址尝试下载，返回 (data, (ext, media_type)) 或 None。"""
    for url in icon_candidates(origin, fetch_bytes):
        data = fetch_bytes(url, MAX_ICON_BYTES)
        if not data:
            continue
        kind = sniff_icon(data)
        if kind:
            return data, kind
    return None


def _cache_key(origin):
    return hashlib.sha1(origin.encode("utf-8")).hexdigest()[:24]


def _atomic_write(path, data):
    directory = os.path.dirname(path) or "."
    os.makedirs(directory, exist_ok=True)
    handle, temp_path = tempfile.mkstemp(prefix=".icon-", suffix=".tmp", dir=directory)
    try:
        with os.fdopen(handle, "wb") as stream:
            stream.write(data)
            stream.flush()
        for attempt in range(10):
            try:
                os.replace(temp_path, path)
                temp_path = ""
                return
            except PermissionError:
                if attempt == 9:
                    raise
                time.sleep(0.05)
    finally:
        if temp_path and os.path.exists(temp_path):
            try:
                os.remove(temp_path)
            except OSError:
                pass


def _find_cache_file(directory, origin):
    key = _cache_key(origin)
    try:
        names = os.listdir(directory)
    except OSError:
        return None
    for name in names:
        if not name.startswith(key + "."):
            continue
        ext = name[len(key) + 1:]
        if ext not in _MEDIA_TYPES:
            continue
        path = os.path.join(directory, name)
        if os.path.isfile(path):
            return path, ext
    return None


def store_icon(directory, origin, data, ext):
    """写入缓存；顺带清掉同一站点其它扩展名的旧文件。"""
    if not data or ext not in _MEDIA_TYPES:
        return ""
    try:
        os.makedirs(directory, exist_ok=True)
        key = _cache_key(origin)
        for name in os.listdir(directory):
            if name.startswith(key + ".") and not name.endswith("." + ext):
                try:
                    os.remove(os.path.join(directory, name))
                except OSError:
                    pass
        path = os.path.join(directory, f"{key}.{ext}")
        _atomic_write(path, data)
        clear_miss(directory, origin)
        return path
    except OSError:
        return ""


def read_cached_icon(directory, origin, ttl=CACHE_TTL_SECONDS, allow_stale=False):
    """读缓存，返回 (data, media_type) 或 None。过期时按 allow_stale 决定是否兜底。"""
    found = _find_cache_file(directory, origin)
    if not found:
        return None
    path, ext = found
    try:
        age = time.time() - os.path.getmtime(path)
        if age > ttl and not allow_stale:
            return None
        with open(path, "rb") as stream:
            data = stream.read()
    except OSError:
        return None
    if not data:
        return None
    return data, _MEDIA_TYPES[ext]


def miss_cached(directory, origin):
    """最近一次抓取失败且仍在冷却期内。"""
    path = os.path.join(directory, f"{_cache_key(origin)}.miss")
    try:
        if time.time() - os.path.getmtime(path) > MISS_TTL_SECONDS:
            return False
        return True
    except OSError:
        return False


def mark_miss(directory, origin):
    try:
        _atomic_write(os.path.join(directory, f"{_cache_key(origin)}.miss"), str(int(time.time())).encode("ascii"))
    except OSError:
        pass


def clear_miss(directory, origin):
    try:
        os.remove(os.path.join(directory, f"{_cache_key(origin)}.miss"))
    except OSError:
        pass
