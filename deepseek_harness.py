"""Local DeepSeek Harness connector and design-task helpers.

The desktop Atelier application is intentionally treated as an external local
service.  This module only speaks HTTP to loopback addresses and never tries
to automate its window.  The endpoint is configurable because packaged
Harness builds may expose different route names.
"""

from __future__ import annotations

import asyncio
import os
import re
from typing import Any, Dict, Iterable, List, Optional
from urllib.parse import urlparse

import httpx


DEFAULT_HARNESS_URL = "http://127.0.0.1:47328"
DEFAULT_HARNESS_ENDPOINT = "/api/design/plan"
DESIGN_CATEGORIES = (
    ("ecommerce", "电商视觉"),
    ("poster", "海报设计"),
    ("brand", "品牌视觉"),
    ("social", "社交媒体视觉"),
)

DESIGN_PATTERNS = (
    r"主图|详情页|详情图|SKU图|直通车|电商|商品视觉|产品视觉|商品卡",
    r"海报|活动页|宣传图|广告图|banner|横幅|展架|传单",
    r"品牌视觉|品牌形象|logo|标志|VI|视觉识别|品牌色",
    r"小红书|抖音|朋友圈|社媒|社交媒体|封面|头像|帖子|内容视觉",
    r"配色|色板|字体|排版|版式|构图|视觉风格|风格方向|设计方向|设计方案|moodboard|情绪板",
)

_LOCAL_HOSTS = {"127.0.0.1", "localhost", "::1"}


def _clean(value: Any, limit: int = 2000) -> str:
    text = re.sub(r"[\x00-\x1f\x7f]", " ", str(value or ""))
    return re.sub(r"\s+", " ", text).strip()[:limit]


def classify_design_intent(message: str) -> Dict[str, Any]:
    """Classify visual-design requests without calling a model."""
    text = _clean(message, 4000)
    matched = [pattern for pattern in DESIGN_PATTERNS if re.search(pattern, text, re.I)]
    category = "ecommerce"
    if re.search(DESIGN_PATTERNS[0], text, re.I):
        category = "ecommerce"
    elif re.search(DESIGN_PATTERNS[1], text, re.I):
        category = "poster"
    elif re.search(DESIGN_PATTERNS[2], text, re.I):
        category = "brand"
    elif re.search(DESIGN_PATTERNS[3], text, re.I):
        category = "social"
    return {
        "is_design": bool(matched),
        "category": category,
        "category_label": dict(DESIGN_CATEGORIES).get(category, "电商视觉"),
        "signals": matched[:6],
    }


def _safe_loopback_url(value: str) -> str:
    raw = _clean(value, 500).rstrip("/") or DEFAULT_HARNESS_URL
    parsed = urlparse(raw)
    if parsed.scheme not in {"http", "https"} or parsed.hostname not in _LOCAL_HOSTS:
        raise ValueError("DeepSeek Harness 地址必须是本机 HTTP 地址")
    return raw


class DeepSeekHarnessConnector:
    """Small, bounded connector for local Atelier/DeepSeek Harness builds."""

    def __init__(self) -> None:
        self.config_error = ""
        try:
            self.base_url = _safe_loopback_url(os.getenv("XIAOMEI_DEEPSEEK_HARNESS_URL", DEFAULT_HARNESS_URL))
        except ValueError as exc:
            self.base_url = DEFAULT_HARNESS_URL
            self.config_error = str(exc)
        self.endpoint = _clean(os.getenv("XIAOMEI_DEEPSEEK_HARNESS_ENDPOINT", DEFAULT_HARNESS_ENDPOINT), 300)
        if not self.endpoint.startswith("/"):
            self.endpoint = "/" + self.endpoint
        self.timeout = max(1.0, min(20.0, float(os.getenv("XIAOMEI_DEEPSEEK_HARNESS_TIMEOUT", "8"))))

    def _candidate_urls(self) -> List[str]:
        configured = f"{self.base_url}{self.endpoint}"
        candidates = [configured]
        if self.endpoint == DEFAULT_HARNESS_ENDPOINT:
            candidates.extend(
                f"{self.base_url}{path}"
                for path in ("/api/design", "/design/plan", "/api/harness/design", "/v1/design/plan")
            )
        return list(dict.fromkeys(candidates))

    async def status(self) -> Dict[str, Any]:
        """Probe only loopback endpoints; no user content is sent."""
        errors: List[str] = []
        async with httpx.AsyncClient(timeout=httpx.Timeout(self.timeout, connect=1.5)) as client:
            for url in [self.base_url, f"{self.base_url}/health", f"{self.base_url}/api/health", f"{self.base_url}/status"]:
                try:
                    response = await client.get(url)
                    if 200 <= response.status_code < 400:
                        return {
                            "available": True,
                            "base_url": self.base_url,
                            "endpoint": self.endpoint,
                            "status_code": response.status_code,
                            "detail": "本地 Harness 服务已响应；设计路由将在任务请求时确认。",
                        }
                    errors.append(f"{url} HTTP {response.status_code}")
                except Exception as exc:  # pragma: no cover - platform-specific socket errors
                    errors.append(str(exc)[:160])
        return {
            "available": False,
            "base_url": self.base_url,
            "endpoint": self.endpoint,
            "detail": self.config_error or "未发现可响应的本地 DeepSeek Harness 服务。",
            "errors": errors[-3:],
        }

    async def create_design_plan(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        body = {
            "task": "design_plan",
            "message": _clean(payload.get("message"), 12000),
            "category": _clean(payload.get("category"), 40),
            "category_label": _clean(payload.get("category_label"), 80),
            "reference_count": max(0, min(20, int(payload.get("reference_count") or 0))),
            "conversation_id": _clean(payload.get("conversation_id"), 120),
            "locale": "zh-CN",
        }
        last_error = ""
        async with httpx.AsyncClient(timeout=httpx.Timeout(self.timeout, connect=1.5)) as client:
            for url in self._candidate_urls():
                try:
                    response = await client.post(url, json=body, headers={"Accept": "application/json"})
                    if response.status_code == 404:
                        last_error = f"{url} HTTP 404"
                        continue
                    response.raise_for_status()
                    data = response.json()
                    if isinstance(data, dict):
                        return {"ok": True, "source": "deepseek-harness", "endpoint": url, "data": data}
                    last_error = "本地 Harness 返回了非对象 JSON"
                except Exception as exc:
                    last_error = str(exc)[:240]
        return {"ok": False, "source": "deepseek-harness", "error": last_error or "本地 Harness 没有可用设计接口"}


def normalize_design_plan(raw: Any, intent: Dict[str, Any], message: str) -> Dict[str, Any]:
    """Normalize a Harness response to the stable card contract."""
    data = raw if isinstance(raw, dict) else {}
    nested = data.get("plan") if isinstance(data.get("plan"), dict) else data
    directions = nested.get("directions") or nested.get("options") or []
    if isinstance(directions, str):
        directions = [directions]
    directions = [_clean(item, 300) for item in directions if _clean(item, 300)][:4]
    outputs = nested.get("outputs") or ["主视觉 1 张", "可选风格变体 2 张"]
    if isinstance(outputs, str):
        outputs = [outputs]
    return {
        "category": intent.get("category", "ecommerce"),
        "category_label": intent.get("category_label", "电商视觉"),
        "title": _clean(nested.get("title") or f"{intent.get('category_label', '视觉')}设计方案", 120),
        "summary": _clean(nested.get("summary") or nested.get("analysis") or message, 600),
        "directions": directions,
        "palette": _clean(nested.get("palette") or nested.get("colors") or "待根据产品与参考图确定", 300),
        "typography": _clean(nested.get("typography") or nested.get("fonts") or "建议使用清晰的中文无衬线字体，保持层级对比", 300),
        "layout": _clean(nested.get("layout") or nested.get("composition") or "主体明确，保留商品信息和行动文案的安全区", 400),
        "copy": _clean(nested.get("copy") or nested.get("copy_hierarchy") or "主标题 / 核心卖点 / 行动引导", 300),
        "prompt": _clean(nested.get("prompt") or nested.get("image_prompt") or message, 4000),
        "outputs": [_clean(item, 160) for item in outputs[:6]],
        "source": _clean(data.get("source") or "deepseek-harness", 40),
        "harness_status": "ready" if data else "fallback",
    }


def fallback_design_plan(intent: Dict[str, Any], message: str) -> Dict[str, Any]:
    """Return a useful, explicit plan when the local runtime is unavailable."""
    category = intent.get("category", "ecommerce")
    defaults = {
        "ecommerce": {
            "directions": ["主体聚焦：商品占画面 65%–75%，背景留出卖点安全区", "场景化表达：用材质、光线和使用场景传达品质", "对比型卖点：用少量结构化信息突出核心差异"],
            "palette": "产品主色 + 米白/浅灰中性色；行动文案使用一个高对比强调色",
            "typography": "中文无衬线标题，粗细分两级；数字和规格使用等宽或高可读字体",
            "layout": "商品主体优先，左/上放核心卖点，底部保留价格或行动区安全边距",
            "copy": "一句核心利益点 / 两到三个证据卖点 / 简短行动引导",
            "outputs": ["电商主图 1 张", "卖点变体 2 张", "详情页首屏延展 1 张"],
        },
        "poster": {
            "directions": ["大标题编辑风：强对比字体与留白", "图像主导：单一视觉焦点配短文案", "信息分层：标题、时间地点、行动按钮三级结构"],
            "palette": "一个主色、一个强调色和大面积留白，避免超过三种高饱和色",
            "typography": "标题使用醒目粗体，正文保持高可读性，数字信息统一字重",
            "layout": "先确定视觉焦点，再按阅读顺序排列标题、说明和行动入口",
            "copy": "事件/利益点标题 / 补充说明 / 时间地点或行动按钮",
            "outputs": ["主海报 1 张", "横版适配 1 张", "竖版适配 1 张"],
        },
        "brand": {
            "directions": ["克制现代：留白和稳定网格建立高级感", "亲和生活：柔和色彩与圆角形状降低距离感", "识别强化：围绕标志、色彩和图形纹理建立系统"],
            "palette": "主品牌色 + 辅助色 + 中性色，先保证小尺寸和深浅背景上的识别度",
            "typography": "标题与正文建立明确层级，中文字体优先考虑字面、笔画和屏幕可读性",
            "layout": "使用固定网格和安全区，让不同物料保持一致的边距和视觉节奏",
            "copy": "品牌主张 / 产品或服务利益点 / 可信证明",
            "outputs": ["品牌主视觉 1 张", "社交头像或标志应用 1 组", "品牌色与字体规范摘要"],
        },
        "social": {
            "directions": ["封面先行：前 1 秒能读懂主题", "生活方式：用场景和人物建立代入感", "知识卡片：用清晰信息层级提升收藏和转发"],
            "palette": "根据平台背景选择高识别主色，文字和主体保持足够对比度",
            "typography": "移动端优先，标题大而短，正文减少行长并保持足够行距",
            "layout": "重要主体和标题放在平台裁切安全区，底部预留互动或账号信息区域",
            "copy": "封面标题 / 一句利益点 / 互动或关注引导",
            "outputs": ["平台主图 1 张", "封面裁切变体 2 张", "配套文案结构 1 份"],
        },
    }
    return normalize_design_plan({**defaults.get(category, defaults["ecommerce"]), "prompt": message, "source": "local-fallback"}, intent, message)
