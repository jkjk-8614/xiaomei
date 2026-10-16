"""Read-only canvas summaries and bounded local suggestion candidates."""
from __future__ import annotations

import hashlib
import json
import re
from typing import Any

TRIGGERS = {"assets_added", "asset_removed", "node_added", "node_deleted", "node_content_changed", "connection_changed", "prompt_committed", "task_succeeded", "task_failed", "canvas_opened"}
INTENTS = {"main_image", "detail_page", "organize_assets", "ask"}


def safe_error(value: Any) -> str:
    text = str(value or "")[:500]
    text = re.sub(r"https?://\S+", "[链接]", text, flags=re.I)
    text = re.sub(r"[A-Za-z]:\\[^\s，。]+", "[本地文件]", text)
    text = re.sub(r"(?i)(bearer|api[_-]?key|token)\s*[:=]?\s*[^\s,;]+", "[凭证]", text)
    return text[:180]


def summarize(canvas: dict) -> dict:
    nodes = [n for n in canvas.get("nodes", []) if isinstance(n, dict) and n.get("id")]
    node_ids = {str(n["id"]) for n in nodes}
    items = []
    assets = 0
    results = 0
    failed = 0
    running = 0
    failed_ids = []
    asset_ids = []
    image_urls = []
    for node in nodes:
        kind = str(node.get("type") or "")[:50]
        media = [m for m in (node.get("images") or []) if isinstance(m, dict) and m.get("url")]
        if kind in {"smart-upload", "smart-image"}:
            assets += len(media)
            if media: asset_ids.append(str(node["id"]))
            for item in media[:2]:
                url = str(item.get("url") or "")
                if url.startswith(("/assets/", "/output/")) and url not in image_urls:
                    image_urls.append(url)
        if kind == "smart-paint" or (kind == "smart-upload" and node.get("runAt")):
            results += len(media)
        error = safe_error(node.get("runError") or node.get("promptRunError"))
        if error:
            failed += 1
            failed_ids.append(str(node["id"]))
        if node.get("pending") or node.get("running") or node.get("queued"):
            running += 1
        prompt = str(node.get("promptDraftText") or node.get("text") or node.get("prompt") or "").strip()[:180]
        refs = [str(m.get("asset_ref_id") or hashlib.sha256(str(m.get("url") or "").encode()).hexdigest()[:16]) for m in media[:20]]
        items.append({"id": str(node["id"])[:100], "type": kind, "media_refs": refs, "prompt": prompt, "error": error, "has_result": bool(media and kind == "smart-paint")})
    connections = sorted([{"from": str(c.get("from") or ""), "to": str(c.get("to") or ""), "kind": str(c.get("kind") or "flow")}
                          for c in (canvas.get("connections") or []) if isinstance(c, dict) and str(c.get("from")) in node_ids and str(c.get("to")) in node_ids],
                         key=lambda c: (c["from"], c["to"], c["kind"]))
    semantic = {"nodes": sorted(items, key=lambda n: n["id"]), "connections": connections}
    digest = "sha256:" + hashlib.sha256(json.dumps(semantic, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
    return {"digest": digest, "node_count": len(nodes), "asset_count": assets, "result_count": results,
            "failed_count": failed, "running_count": running, "failed_node_ids": failed_ids[:8], "asset_node_ids": asset_ids[:8],
            "node_ids": node_ids, "image_urls": image_urls[:2], "semantic": semantic}


def progress(summary: dict, memories: list) -> dict:
    goals = [m for m in memories if m.get("type") == "goal" and m.get("status") == "confirmed"]
    todos = [m for m in memories if m.get("type") == "todo" and m.get("status") == "confirmed"]
    if summary["failed_count"]:
        stage = "blocked"
    elif summary["running_count"]:
        stage = "producing"
    elif summary["result_count"]:
        stage = "reviewing"
    elif goals:
        stage = "planning"
    else:
        stage = "new"
    return {"stage": stage, "goal": goals[-1]["text"] if goals else "", "todos": [m["text"] for m in todos[-5:]],
            "result_count": summary["result_count"], "failed_count": summary["failed_count"], "running_count": summary["running_count"]}


def candidate(trigger: str, summary: dict, memories: list) -> dict | None:
    state = progress(summary, memories)
    base = {"evidence_node_ids": [], "requires_confirmation": True, "kind": "local"}
    if trigger == "task_failed" and summary["failed_count"]:
        return {**base, "title": "有生成任务没完成", "body": f"有 {summary['failed_count']} 个任务失败了。要看看原因吗？",
                "evidence_node_ids": summary["failed_node_ids"],
                "options": [{"key": "review_failures", "label": "查看原因"}]}
    if trigger == "assets_added" and summary["asset_count"]:
        if state["goal"]:
            return {**base, "title": "素材已放进画布", "body": "这个项目已有目标。要接着安排下一步吗？",
                    "evidence_node_ids": summary["asset_node_ids"],
                    "options": [{"key": "continue_goal", "label": "接着做"}]}
        return {**base, "title": "画布里有新素材", "body": f"现在有 {summary['asset_count']} 张素材。想做主图、详情页，还是先整理素材？",
                "evidence_node_ids": summary["asset_node_ids"],
                "options": [{"key": "main_image", "label": "做主图"}, {"key": "detail_page", "label": "做详情页"}, {"key": "organize_assets", "label": "整理素材"}]}
    if trigger in {"task_succeeded", "canvas_opened"} and state["goal"] and state["todos"]:
        return {**base, "title": "接着做", "body": "这个项目还有已记录的待办。要从当前画布继续吗？",
                "options": [{"key": "continue_goal", "label": "接着做"}]}
    return None


def model_intent(raw: str) -> dict | None:
    try:
        parsed = json.loads(str(raw or "").strip())
    except (TypeError, ValueError):
        return None
    if not isinstance(parsed, dict) or parsed.get("kind") not in INTENTS or parsed.get("confidence") not in {"low", "medium", "high"}:
        return None
    return {"kind": parsed["kind"], "confidence": parsed["confidence"]}


def apply_model_intent(local: dict, intent: dict | None, summary: dict) -> dict:
    if not intent or local.get("title") != "画布里有新素材" or intent["confidence"] == "low":
        return local
    kind = intent["kind"]
    if kind == "main_image":
        local = {**local, "title": "要做商品主图吗？", "body": f"画布里有 {summary['asset_count']} 张素材。要先规划主图吗？"}
    elif kind == "detail_page":
        local = {**local, "title": "要做详情页吗？", "body": f"画布里有 {summary['asset_count']} 张素材。要先规划详情页吗？"}
    return {**local, "detected_intents": [intent]}
