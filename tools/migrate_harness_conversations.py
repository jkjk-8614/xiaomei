"""Safely project Xiaomei Canvas conversations into the official Harness workspace.

The source JSON files remain untouched. The official Host can open the generated workspace
folder immediately; a later Host session importer can consume the manifest without guessing
at the user's private data files.
"""
from __future__ import annotations

import json
import os
import re
import shutil
from datetime import datetime, timezone
from pathlib import Path


def safe_name(value: str, fallback: str) -> str:
    value = re.sub(r"[\\/:*?\"<>|\r\n]+", " ", value).strip()
    return (value[:80] or fallback).strip()


def migrate(project_root: Path) -> dict:
    data_root = Path(os.environ.get("XIAOMEI_CANVAS_DATA_ROOT", project_root / "data"))
    source = data_root / "conversations"
    harness_root = project_root / ".xiaomei-data" / "deepseek-harness"
    target = harness_root / "imported-workspace"
    manifest_path = harness_root / "conversation-migration.json"
    target.mkdir(parents=True, exist_ok=True)
    # The imported workspace is an additive bridge for the official UI.  It is
    # deliberately kept separate from the user's source conversations so a
    # migration can be repeated without rewriting or deleting Xiaomei data.
    workspace_store = harness_root / "storages" / "workspace.json"
    manifest = {"version": 1, "workspace": str(target), "items": [], "failed": []}
    if not source.exists():
        manifest["status"] = "empty"
        manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
        return manifest
    # 小美画布按会话工作区分目录保存 JSON；旧版本曾经把文件直接放在
    # conversations 根目录。递归读取两种布局，避免 Harness 只显示“新会话”。
    conversation_files = sorted(path for path in source.rglob("*.json") if path.is_file())
    generated_outputs: set[Path] = set()
    for path in conversation_files:
        try:
            raw = json.loads(path.read_text(encoding="utf-8"))
            title = safe_name(str(raw.get("title") or path.stem), path.stem)
            parent_id = safe_name(path.parent.name, "root")
            output = target / f"{parent_id}-{safe_name(path.stem, 'conversation')}.md"
            generated_outputs.add(output)
            lines = [f"# {title}", "", f"> 从小美画布导入。源文件：`{path.name}`", ""]
            for message in raw.get("messages") or []:
                role = str(message.get("role") or "assistant").lower()
                label = "用户" if role == "user" else "助手" if role == "assistant" else role
                content = message.get("content") or message.get("text") or ""
                if isinstance(content, (dict, list)):
                    content = json.dumps(content, ensure_ascii=False, indent=2)
                lines += [f"## {label}", "", str(content).strip(), ""]
            output.write_text("\n".join(lines), encoding="utf-8")
            manifest["items"].append({"source": str(path), "output": str(output), "title": title})
        except Exception as exc:  # preserve the source and continue other records
            manifest["failed"].append({"source": str(path), "error": str(exc)})
    manifest["status"] = "complete" if not manifest["failed"] else "partial"
    # 清理上一次迁移留下、但源会话已经删除的桥接副本。只操作
    # imported-workspace 下由本脚本生成的 Markdown，不触碰原始会话。
    for stale in target.glob("*.md"):
        if stale not in generated_outputs:
            try:
                stale.unlink()
            except OSError:
                pass
    manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
    try:
        state = json.loads(workspace_store.read_text(encoding="utf-8")) if workspace_store.exists() else {}
        tables = state.setdefault("tables", {})
        workspaces = tables.setdefault("workspaces", {})
        workspace_ids = list(state.setdefault("global", {}).setdefault("workspaceIds", []))
        bridge_id = "xiaomei-history"
        if bridge_id not in workspace_ids:
            workspace_ids.append(bridge_id)
        now = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
        workspaces[bridge_id] = {
            **(workspaces.get(bridge_id) or {}),
            "path": str(target),
            "title": "小美画布历史",
            "sessionIds": list((workspaces.get(bridge_id) or {}).get("sessionIds") or []),
            "createdAt": (workspaces.get(bridge_id) or {}).get("createdAt") or now,
            "updatedAt": now,
        }
        state["unit"] = {"name": "workspace", "version": 2}
        state["global"].update({"initialized": True, "workspaceIds": workspace_ids})
        workspace_store.parent.mkdir(parents=True, exist_ok=True)
        workspace_store.write_text(json.dumps(state, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    except Exception as exc:
        manifest["workspace_warning"] = str(exc)
        manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
    return manifest


if __name__ == "__main__":
    root = Path(__file__).resolve().parents[1]
    result = migrate(root)
    print(json.dumps({"status": result["status"], "count": len(result["items"]), "failed": len(result["failed"])}, ensure_ascii=False))
