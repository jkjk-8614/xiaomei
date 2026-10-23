"""Machine-readable capability declarations for Agent Skills.

A Skill states, in the ``capabilities`` key of its ``SKILL.md`` front matter,
which host capabilities it needs::

    ---
    name: ec-mainimage-planning
    description: ...
    capabilities: [canvas.image.generate, model.image]
    ---

The identifiers form a closed and versioned vocabulary so the host can answer
"can this Skill run here, and what is missing" instead of guessing from
prose.  The ``capabilities`` key on a Skill *record* keeps its historical
meaning (human readable Chinese labels such as ``对话指令``); the identifiers
are published separately as ``capability_ids``.

Unknown identifiers never break a Skill.  They are reported as warnings so a
typo cannot silently hide a real dependency.
"""

from __future__ import annotations

import re

# Bump when the vocabulary below changes in a way that breaks existing Skills.
CAPABILITY_CONTRACT_VERSION = 1

CAPABILITY_NAMESPACES: dict[str, dict[str, str]] = {
    "host": {"label": "宿主运行时", "summary": "小美画布自身提供的工作台能力"},
    "model": {"label": "模型通道", "summary": "需要在 API 设置中配置并可用的在线模型"},
    "canvas": {"label": "画布动作", "summary": "可以在画布上直接执行的生成或编辑动作"},
    "tool": {"label": "外部工具", "summary": "需要第三方服务、CLI 或本地桥接配合"},
    "data": {"label": "数据来源", "summary": "需要外部平台数据与账号授权"},
    "io": {"label": "文件与媒体", "summary": "本地文件、图片、视频、表格的读取与产出"},
}

CAPABILITY_REGISTRY: dict[str, dict[str, str]] = {
    # 宿主运行时
    "host.canvas": {"label": "节点画布", "summary": "小美画布的节点画布、连线与批量生成"},
    "host.agent": {"label": "Agent 对话", "summary": "Agent 对话面板与自主多代理编排"},
    "host.comfyui": {"label": "本地 ComfyUI", "summary": "本机 ComfyUI 工作流与节点界面"},
    "host.workflow": {"label": "工作流模板", "summary": "工作流模板的导入、导出与复用"},
    "host.market": {"label": "电商工作台", "summary": "一键主图、详情页与商品分析台"},
    "host.asset": {"label": "素材与历史", "summary": "素材库、历史记录与生成资产"},
    "host.schedule": {"label": "定时与采集任务", "summary": "定时任务与商品采集任务的调度"},
    "host.skill": {"label": "技能体系", "summary": "技能包、技能市场与宿主技能注册"},
    # 模型通道
    "model.text": {"label": "文本模型", "summary": "可用的文本/对话模型通道"},
    "model.image": {"label": "图像模型", "summary": "可用的图像生成模型通道"},
    "model.video": {"label": "视频模型", "summary": "可用的视频生成模型通道"},
    # 画布动作
    "canvas.image.generate": {"label": "画布生图", "summary": "在画布节点上生成图片"},
    "canvas.image.edit": {"label": "画布改图", "summary": "在画布节点上做局部重绘或编辑"},
    "canvas.image.upscale": {"label": "画布超分", "summary": "画布图片或视频的放大处理"},
    "canvas.video.generate": {"label": "画布生视频", "summary": "在画布节点上生成视频"},
    "canvas.node.run": {"label": "画布节点执行", "summary": "执行画布节点、连线和批量任务"},
    # 外部工具
    "tool.1688.search": {"label": "1688 搜索", "summary": "1688 商品与工业品搜索"},
    "tool.1688.supplier": {"label": "1688 找供应商", "summary": "1688 供应商与工厂检索"},
    "tool.1688.compare": {"label": "1688 比价选品", "summary": "1688 批量比价与选品"},
    "tool.amz.keywords": {"label": "亚马逊热搜", "summary": "亚马逊多站点热搜词抓取"},
    "tool.browser.collect": {"label": "浏览器采集", "summary": "浏览器会话与商品页采集"},
    "tool.office.render": {"label": "Office 渲染", "summary": "Word/Excel/PPT/PDF 的解析与渲染"},
    "tool.photoshop.bridge": {"label": "Photoshop 桥接", "summary": "本地 Photoshop 资源桥接"},
    "tool.cli.run": {"label": "CLI 执行", "summary": "调用本机已配置的 CLI 工具"},
    # 数据来源
    "data.market.1688": {"label": "1688 平台数据", "summary": "1688 平台商品与供应数据"},
    "data.market.amazon": {"label": "亚马逊平台数据", "summary": "亚马逊站点商品与关键词数据"},
    "data.market.ads": {"label": "生意参谋数据", "summary": "生意参谋搜索词与流量数据"},
    "data.shop.self": {"label": "自己店铺数据", "summary": "自有店铺后台经营数据"},
    # 文件与媒体
    "io.image.read": {"label": "读取图片", "summary": "读取并识别本地或上传的图片"},
    "io.video.read": {"label": "读取视频", "summary": "读取本地或上传的视频文件"},
    "io.video.frames": {"label": "抽取视频帧", "summary": "从视频中抽取关键帧用于分析"},
    "io.audio.read": {"label": "读取音频", "summary": "读取本地或上传的音频文件"},
    "io.office.read": {"label": "读取文档", "summary": "读取 Word/PPT/PDF 等文档内容"},
    "io.sheet.read": {"label": "读取表格", "summary": "读取 Excel/CSV 表格与关键列"},
    "io.sheet.write": {"label": "生成表格", "summary": "产出 Excel/CSV 表格文件"},
    "io.doc.write": {"label": "生成文档", "summary": "产出 Word/PPT 等文档文件"},
    "io.web.read": {"label": "读取网页", "summary": "读取网页正文与页面上下文"},
}

# Capability identifiers the host can actually probe.  Everything else stays
# "not detected" on purpose: a wrong "available" is worse than an honest gap.
CAPABILITY_PROBES: dict[str, str] = {
    "model.text": "model_text",
    "model.image": "model_image",
    "model.video": "model_video",
    "host.comfyui": "comfyui",
}

_CAPABILITY_KEY = re.compile(r"^capabilities\s*:\s*(.*?)\s*$")
_BLOCK_ITEM = re.compile(r"^\s+-\s*(.+?)\s*$")


def parse_capability_ids(metadata: object) -> list[str]:
    """Read the top level ``capabilities`` list from a front matter block.

    Only a key at column zero counts, so a nested ``capabilities`` inside
    ``compatibility`` is not mistaken for the declaration.  Both the flow form
    (``capabilities: [a, b]``) and the block form are accepted.
    """

    lines = str(metadata or "").splitlines()
    for index, line in enumerate(lines):
        match = _CAPABILITY_KEY.match(line)
        if not match:
            continue
        value = match.group(1).strip()
        if value.startswith("[") and value.endswith("]"):
            items = value[1:-1].split(",")
        elif value:
            items = value.split(",")
        else:
            items = []
            for follow in lines[index + 1 :]:
                if not follow.strip():
                    continue
                item = _BLOCK_ITEM.match(follow)
                if not item:
                    break
                items.append(item.group(1))
        result: list[str] = []
        for item in items:
            token = str(item).strip().strip("'\"")
            if token and token not in result:
                result.append(token)
        return result
    return []


def unknown_capability_ids(ids: object) -> list[str]:
    """Return the identifiers that are not part of the closed vocabulary."""

    return [
        str(item)
        for item in (ids or [])
        if str(item) not in CAPABILITY_REGISTRY
    ]


def capability_catalog() -> list[dict]:
    """Describe every known capability, grouped by namespace."""

    entries = []
    for capability_id, entry in CAPABILITY_REGISTRY.items():
        entries.append({
            "id": capability_id,
            "namespace": capability_id.split(".", 1)[0],
            "namespace_label": CAPABILITY_NAMESPACES.get(capability_id.split(".", 1)[0], {}).get("label", ""),
            "label": entry["label"],
            "summary": entry["summary"],
            "probe": CAPABILITY_PROBES.get(capability_id, ""),
        })
    return entries


def capability_labels(ids: object) -> list[str]:
    """Map identifiers to their human readable labels, keeping unknown ids."""

    return [
        CAPABILITY_REGISTRY.get(str(item), {}).get("label", str(item))
        for item in (ids or [])
    ]


def evaluate_capabilities(ids: object, facts: object = None) -> list[dict]:
    """Report whether each declared capability is available in this host.

    ``facts`` maps probe names to booleans.  A capability without a probe is
    reported as ``None`` (not detected) rather than assumed to be present.
    """

    known = facts if isinstance(facts, dict) else {}
    results = []
    for capability_id in ids or []:
        key = str(capability_id)
        entry = CAPABILITY_REGISTRY.get(key)
        if entry is None:
            results.append({
                "id": key,
                "label": key,
                "available": None,
                "reason": "未登记的能力标识",
            })
            continue
        probe = CAPABILITY_PROBES.get(key)
        if probe is None:
            results.append({
                "id": key,
                "label": entry["label"],
                "available": None,
                "reason": "需要按技能自身配置确认",
            })
        elif probe in known:
            available = bool(known[probe])
            results.append({
                "id": key,
                "label": entry["label"],
                "available": available,
                "reason": "" if available else "当前环境尚未配置",
            })
        else:
            results.append({
                "id": key,
                "label": entry["label"],
                "available": None,
                "reason": "未检测",
            })
    return results
