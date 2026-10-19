"""Connect autonomous agents to the existing project, model and canvas executors."""
from __future__ import annotations

import asyncio
import copy
import json
import re
import secrets
from pathlib import Path

from fastapi import HTTPException, Request
from fastapi.responses import JSONResponse
from pydantic import Field

from multi_agent_runtime import (ALL_TOOLS, COMMANDS, MULTI_SETTINGS, PAID_REQUEST_SCOPE, MultiAgentRuntime, RunRequest, StrictModel,
                                 TERMINAL, descendant)
from multi_agent_store import AgentError, AgentRunStore, digest, now


class ScopedInput(StrictModel):
    project_id: str = Field(pattern=r"^[A-Za-z0-9_-]{1,80}$")
    canvas_id: str = Field(pattern=r"^[A-Za-z0-9_-]{1,80}$")


class ApprovalInput(ScopedInput):
    approved: bool


class ClaimInput(ScopedInput):
    client_id: str = Field(min_length=1, max_length=120)


class ReceiptInput(ScopedInput):
    lease_token: str = Field(min_length=1, max_length=120)
    node_ids: list[str] = Field(default_factory=list, max_length=40)
    status: str = Field(pattern=r"^(applied|failed)$")
    error: str = Field(default="", max_length=1000)


class RetryInput(ScopedInput):
    instructions: str = Field(default="", max_length=8000)


def canvas_digest(canvas):
    return digest({"nodes": canvas.get("nodes", []), "connections": canvas.get("connections", [])})


def node_digest(node):
    return digest({k: v for k, v in node.items() if k not in {
        "_collab_updated_at", "_agent_action_ids", "runStartedAt", "runElapsedMs", "runFinishedAt",
        "runState", "runStateAt", "running", "pending", "queued", "pendingTasks"}})


def node_media(node):
    return [m["url"] if isinstance(m, dict) else m for m in (node.get("images") or [])
            if isinstance(m, str) or isinstance(m, dict) and isinstance(m.get("url"), str)]


class CanvasAgentAdapter:
    def __init__(self, host, store):
        self.host, self.store = host, store
        self.runtime = MultiAgentRuntime(store, self)

    def safe_error(self, exc):
        if isinstance(exc, AgentError):
            return exc.message
        value = getattr(exc, "detail", str(exc))
        if isinstance(exc, asyncio.TimeoutError):
            value = "模型连接超时，请检查网络、系统代理或更换模型后重试"
        return self.host.project_agent_safe_error(value) or "操作未完成，请检查模型与网络后重试"

    def canvas(self, run):
        canvas = self.host.load_canvas(run["canvas_id"])
        if str(canvas.get("project") or self.host.DEFAULT_PROJECT_ID) != run["project_id"]:
            raise AgentError("project_mismatch", "画布已移动到其他项目，任务已停止等待", 403)
        projects = self.host.ensure_default_project()
        if not any(p.get("id") == run["project_id"] and not p.get("deleted_at") for p in projects):
            raise AgentError("project_deleted", "项目不存在或已移入回收站", 403)
        return canvas

    def validate_model(self, provider_id, model, kind="chat_models"):
        provider = self.host.get_api_provider_exact(provider_id)
        if kind == "chat_models" and str(provider.get("protocol") or "") in {"codex", "gemini-cli", "jimeng"}:
            raise AgentError("api_model_required", "智能分工请选择普通 API 对话模型；Codex Harness 可从原 Agent 入口使用", 422)
        choices = provider.get(kind) or []
        ids = {str(m.get("id") or m.get("name")) if isinstance(m, dict) else str(m) for m in choices}
        if model not in ids:
            raise AgentError("model_unavailable", "所选模型不在当前平台列表，请在 API 设置中拉取并选择模型", 422)
        return provider

    def choices(self):
        return [{k: p.get(k) for k in ("id", "name", "chat_models", "image_models", "video_models")}
                for p in self.host.load_api_providers() if p.get("enabled", True) and str(p.get("protocol") or "") not in {"codex", "gemini-cli", "jimeng"}]

    def context(self, payload, canvas):
        by_id = {str(n["id"]): n for n in canvas.get("nodes", []) if isinstance(n, dict) and n.get("id")}
        if set(payload.source_node_ids) - set(by_id):
            raise AgentError("invalid_source", "引用节点不在当前画布中，请重新选择", 422)
        allowed = {u for n in by_id.values() for u in node_media(n)}
        if set(payload.source_images) - allowed:
            raise AgentError("invalid_source", "引用图必须先保存到当前项目画布中", 422)
        for url in payload.source_images:
            if not self.host.output_file_from_url(url):
                raise AgentError("invalid_source", "当前引用图无法读取，请重新上传", 422)
        memories = self.host.PROJECT_AGENT_STORE.read(payload.project_id)
        source_images = list(dict.fromkeys(payload.source_images or [u for ident in payload.source_node_ids for u in node_media(by_id[ident])]))
        if len(source_images) > 40:
            raise AgentError("source_limit", "本次参考图超过40张，请缩小范围", 422)
        return {"memories": [{"type": m["type"], "text": m["text"]} for m in memories["memories"] if m.get("status") == "confirmed"][-30:],
                "memory_revision": memories["revision"], "source_node_ids": payload.source_node_ids,
                "source_images": source_images, "canvas": self.public_canvas(canvas),
                "generation_preferences": {k: v for k, v in payload.generation_preferences.items() if k in MULTI_SETTINGS},
                "model_choices": self.choices()}

    def project_assets(self, run):
        result = []
        for record in self.host.list_canvases():
            if record.get("deleted_at") or str(record.get("project") or self.host.DEFAULT_PROJECT_ID) != run["project_id"]:
                continue
            canvas = self.host.load_canvas(record["id"])
            if str(canvas.get("project") or self.host.DEFAULT_PROJECT_ID) != run["project_id"]:
                continue
            for node in canvas.get("nodes", []):
                if node_media(node):
                    result.append({"canvas_id": canvas["id"], "node_id": node["id"], "urls": node_media(node)})
            if len(result) >= 200:
                break
        # Uploaded assets can be assigned to a project before being placed on a canvas.
        registry = getattr(self.host, "ASSET_REGISTRY", None)
        if registry is not None:
            known = {url for item in result for url in item["urls"]}
            for asset in registry.records():
                metadata = asset.get("metadata") or {}
                url = asset.get("canonical_url") or ""
                if asset.get("deleted_at") or metadata.get("upload_project_id") != run["project_id"] or url in known:
                    continue
                if url and self.host.output_file_from_url(url):
                    result.append({"asset_id": asset["id"], "name": metadata.get("upload_name") or asset.get("name"), "urls": [url]})
                    known.add(url)
                if len(result) >= 200:
                    break
        return result[:200]

    @staticmethod
    def public_canvas(canvas):
        return {"nodes": [{k: n.get(k) for k in ("id", "type", "title", "text", "prompt", "promptDraftText")}
                          | {"media": node_media(n), "settings": {k: v for k, v in (n.get("runSettings") or {}).items() if k in MULTI_SETTINGS}}
                          for n in canvas.get("nodes", []) if isinstance(n, dict)][:100],
                "connections": canvas.get("connections", [])[:200]}

    async def model(self, run, task, prompt):
        canvas = self.canvas(run)
        self.validate_model(task["provider_id"], task["model"])
        images = list(run["context"]["source_images"])
        images.extend(u for u in task.get("vision_images", []) if u not in images)
        for message in task["messages"][-3:]:
            if message["role"] != "user":
                continue
            try:
                value = json.loads(message["content"].split("：", 1)[1])["result"]
                for image in value.get("image_urls", []):
                    if image not in images:
                        images.append(image)
            except (ValueError, KeyError, IndexError, TypeError):
                continue
        allowed = {u for node in canvas.get("nodes", []) for u in node_media(node)}
        if set(images) - allowed:
            raise AgentError("source_changed", "任务引用图已移出当前画布，请核对后新建任务", 403)
        videos = [u for u in images if self.host.is_video_reference_value(u)]
        images = [u for u in images if self.host.is_image_reference_value(u)]
        if len(videos) > 3:
            raise AgentError("vision_limit", "每次最多检查三个视频，请分配独立检查任务", 422)
        # No other agent's chat history is included; dependencies are explicit result summaries.
        payload = self.host.CanvasLLMRequest(message="按职责决定下一步工具调用；完成后提交真实结果。",
            system_prompt=prompt, messages=copy.deepcopy(task["messages"]), images=images, videos=videos,
            provider=task["provider_id"], model=task["model"], allow_model_fallback=False,
            max_output_tokens=run["limits"]["max_output_tokens"], transport_retries=0)
        return await self.host.canvas_llm(payload)

    def media_token_estimate(self, urls):
        return sum(24576 if self.host.is_video_reference_value(url) else 4096 for url in urls)

    def validate_refs(self, run, refs):
        canvas = self.canvas(run)
        nodes = {str(n["id"]): n for n in canvas.get("nodes", []) if n.get("id")}
        urls = {u for n in nodes.values() for u in node_media(n)}
        with self.store.transaction() as db:
            tasks = {t["task_id"] for t in self.store.rows(db, "tasks", run["run_id"])}
            actions = {a["action_id"] for a in self.store.rows(db, "actions", run["run_id"])}
        for ref in refs:
            valid = ref["id"] in (nodes if ref["kind"] == "node" else urls if ref["kind"] in {"image", "video"} else tasks if ref["kind"] == "task" else actions)
            if not valid:
                raise AgentError("invalid_ref", "结果引用不在当前项目和本次运行中", 403)

    def read_tool(self, run, task, tool, args):
        canvas = self.canvas(run)
        if tool == "canvas.read":
            return self.public_canvas(canvas)
        if tool == "canvas.list_assets":
            return {"assets": self.project_assets(run), "scope": "current_project"}
        by_id = {n["id"]: n for n in canvas.get("nodes", [])}
        if set(args["node_ids"]) - set(by_id):
            raise AgentError("node_scope", "只能读取当前画布的节点", 403)
        image_urls = []
        reports = []
        for ident in args["node_ids"]:
            node = by_id[ident]
            urls = node_media(node)
            for url in urls:
                if url not in image_urls and self.host.output_file_from_url(url):
                    image_urls.append(url)
            report = {"node_id": ident, "image_urls": urls, "error": node.get("runError") or ""}
            if tool in {"canvas.check_geometry", "canvas.check_product"}:
                from product_fidelity import normalize, product_mask, load_image
                from geometry_validator import GeometryValidator
                from physical_dimensions import validatePhysicalDimensions
                config = normalize(node.get("fidelityConfig") or (node.get("runSettings") or {}).get("productFidelity") or {})
                dimensions = config.get("dimensions") or {}
                geometry = GeometryValidator.unknown("未配置产品物理尺寸或产品蒙版，需要人工复核")
                if dimensions.get("enabled") and validatePhysicalDimensions(dimensions)["valid"] and urls:
                    try:
                        sources = run["context"]["source_images"]
                        if sources:
                            source = load_image(sources[0], self.host.output_file_from_url)
                            mask = product_mask(source, config, self.host.output_file_from_url)
                            generated = load_image(urls[0], self.host.output_file_from_url)
                            geometry = GeometryValidator.from_images(source, mask, generated, dimensions)
                    except (ValueError, OSError, KeyError, TypeError) as exc:
                        geometry = GeometryValidator.unknown(self.safe_error(exc))
                report["geometry"] = geometry
                report["product_review"] = "实际图片将在下一轮提交给当前视觉模型；未读图或几何 unknown 时必须标记人工复核"
                report["saved_fidelity_reports"] = [m.get("product_fidelity") or m.get("fidelity_report") for m in node.get("images", []) if isinstance(m, dict) and (m.get("product_fidelity") or m.get("fidelity_report"))]
            reports.append(report)
        return {"reports": reports, "image_urls": image_urls}

    def validate_command(self, run, op):
        canvas = self.canvas(run)
        nodes = {n["id"]: n for n in canvas.get("nodes", [])}
        tool, args = op["tool"], op["args"]
        if tool == "canvas.use_project_asset":
            allowed = {u for entry in self.project_assets(run) for u in entry["urls"]}
            if args["url"] not in allowed or not self.host.output_file_from_url(args["url"]):
                raise AgentError("asset_scope", "素材不属于当前项目或已不可读取，请在素材库重新选择", 403)
            return {"resources": [], "canvas_digest": canvas_digest(canvas), "node_digest": digest({}), "local_gpu": False}
        target = op["target"]
        ident = target.get("node_id", "") if isinstance(target, dict) else target
        resource_ids = []
        if tool not in {"canvas.create_node", "canvas.connect", "canvas.disconnect", "canvas.arrange"}:
            resource_ids.append(ident)
        if tool in {"canvas.connect", "canvas.disconnect"}:
            resource_ids.extend([args["from"], args["to"]])
            if args["from"] == args["to"]:
                raise AgentError("connection_cycle", "节点不能连接自己", 422)
            if tool == "canvas.connect":
                graph = {k: [] for k in nodes}
                for conn in canvas.get("connections", []):
                    if conn.get("from") in graph:
                        graph[conn["from"]].append(conn["to"])
                pending, seen = [args["to"]], set()
                while pending:
                    key = pending.pop()
                    if key == args["from"]:
                        raise AgentError("connection_cycle", "连线会形成循环", 422)
                    if key not in seen:
                        seen.add(key)
                        pending.extend(graph.get(key, []))
        if tool == "canvas.arrange":
            resource_ids.extend(args["node_ids"])
        if tool == "canvas.move_node" and args.get("relative_to"):
            resource_ids.append(args["relative_to"])
        if set(resource_ids) - set(nodes):
            raise AgentError("node_scope", "目标节点不在当前画布中，请先读取真实节点 ID", 403)
        local_gpu, authorized_model = False, None
        if tool == "canvas.run_node":
            node = nodes[ident]
            settings = node.get("runSettings") or {}
            local_gpu = settings.get("engine") == "comfy" or node.get("type") == "smart-comfy-workflow"
            if node.get("type") not in {"smart-paint", "smart-comfy-workflow"}:
                raise AgentError("unsupported_executor", "自主运行目前支持绘画节点和已有 ComfyUI 工作流节点", 422)
            if node.get("pending") or node.get("running") or node.get("queued") or node.get("pendingTasks"):
                raise AgentError("resource_conflict", "该节点已有任务，请先查询结果")
            if not local_gpu:
                if settings.get("engine", "api") != "api":
                    raise AgentError("unsupported_executor", "当前节点来源尚未连接自主执行，请使用画布原入口", 422)
                is_video = settings.get("apiKind") == "video"
                self.validate_model(settings.get("videoProvider") if is_video else settings.get("provider_id"),
                                    settings.get("videoModel") if is_video else settings.get("model"),
                                    "video_models" if is_video else "image_models")
                authorized_model = {"provider_id": settings.get("videoProvider") if is_video else settings.get("provider_id"),
                                    "model": settings.get("videoModel") if is_video else settings.get("model"),
                                    "kind": "video" if is_video else "image"}
                provider = self.host.get_api_provider_exact(authorized_model["provider_id"])
                if str(provider.get("protocol") or "") in {"codex", "gemini-cli", "jimeng"}:
                    raise AgentError("unsupported_executor", "此 CLI 生图尚未接入自主任务，请通过原画布入口运行", 422)
            # Use successful inputs only; never implicitly start a second paid upstream branch.
            incoming = [c["from"] for c in canvas.get("connections", []) if c.get("to") == ident]
            for source_id in incoming:
                source = nodes.get(source_id) or {}
                if source.get("type") in {"smart-paint", "smart-loop", "smart-agent", "smart-expert-workflow"}:
                    if source.get("type") == "smart-paint" and not node_media(source) or source.get("type") != "smart-paint" and not source.get("outputText"):
                        raise AgentError("upstream_not_ready", "请先完成上游任务，再运行此节点")
        if tool == "canvas.create_node":
            settings = args.setdefault("settings", {})
            if args.get("type") == "smart-paint":
                inherited = run["context"]["generation_preferences"]
                args["settings"] = {**inherited, **settings, "count": 1}
        for key, value in args.get("settings", {}).items():
            if key in {"customRatioWidth", "customRatioHeight", "count", "videoDuration"}:
                if isinstance(value, bool) or not isinstance(value, (int, float)) or value <= 0 or value > (60 if key == "videoDuration" else 16384):
                    raise AgentError("invalid_settings", "画布尺寸和数量必须是有效数值", 422)
            elif not isinstance(value, str) or len(value) > 300:
                raise AgentError("invalid_settings", "画布生成设置必须使用有效文本值", 422)
        if "settings" in args and args["settings"].get("count", 1) != 1:
            raise AgentError("batch_denied", "每个自主生成操作只允许一张图片，请分配独立任务", 422)
        if tool == "image.remove_background":
            local_gpu = True
            if args.get("batch") or args.get("all_images"):
                raise AgentError("batch_denied", "自主去背景请为每张产品图分配独立操作", 422)
        watched = set(resource_ids)
        if tool == "canvas.run_node":
            pending = list(watched)
            while pending:
                current = pending.pop()
                for connection in canvas.get("connections", []):
                    source = connection.get("from")
                    if connection.get("to") == current and source in nodes and source not in watched:
                        watched.add(source)
                        pending.append(source)
        relevant_connections = [c for c in canvas.get("connections", []) if c.get("to") in watched
                                or c.get("from") in resource_ids]
        return {"resources": [run["canvas_id"] + ":" + key for key in sorted(set(resource_ids))],
                "canvas_digest": canvas_digest(canvas),
                "node_digest": digest({"nodes": {key: node_digest(nodes[key]) for key in sorted(watched)},
                                       "connections": relevant_connections}),
                "local_gpu": local_gpu, "authorized_model": authorized_model}

    def before_generation(self, payload, kind):
        action_id = getattr(payload, "multi_agent_action_id", "")
        if not action_id:
            return None
        with self.store.transaction() as db:
            action = self.store.get(db, "actions", action_id)
            run = self.store.get(db, "runs", action["run_id"])
            if action["operation"]["tool"] != "canvas.run_node" or run["cancel_requested"] or action["status"] == "cancelled":
                raise AgentError("cancelled", "代理任务已停止，不再提交生成", 409)
            if not action.get("approved") or not secrets.compare_digest(action.get("lease_token", ""), getattr(payload, "multi_agent_execution_token", "") or ""):
                raise AgentError("approval_required", "此操作尚未获得当前画布的执行许可", 403)
            if payload.project_id != run["project_id"]:
                raise AgentError("project_mismatch", "生成请求不属于当前项目", 403)
            signature = digest({k: v for k, v in payload.model_dump().items() if k not in {"multi_agent_execution_token"}})
            if action.get("request_signature") and action["request_signature"] != signature:
                raise AgentError("idempotency_conflict", "同一生成操作的参数不能改变")
            if action["generation_task_ids"]:
                return {"task_id": action["generation_task_ids"][0], "status": "queued", "recovered": True}
            if action["status"] != "claimed":
                raise AgentError("submission_unknown", "请求状态待核对，请恢复已有任务；不会自动重新生图")
            canvas = self.canvas(run)
            if kind == "image" and payload.n != 1:
                raise AgentError("batch_denied", "每个代理操作只允许一次生成", 422)
            if kind == "comfy" and not action["local_gpu"] or kind != "comfy" and action["local_gpu"]:
                raise AgentError("executor_mismatch", "生成方式与已确认的画布节点不一致", 403)
            if kind != "comfy":
                permitted = action.get("authorized_model") or {}
                if permitted and (payload.provider_id != permitted.get("provider_id") or payload.model != permitted.get("model") or kind != permitted.get("kind")):
                    raise AgentError("model_changed", "生成模型与已确认的节点不一致，请重新规划", 403)
                self.validate_model(payload.provider_id, payload.model, "video_models" if kind == "video" else "image_models")
                references = list(getattr(payload, "reference_images", []) if kind == "image" else getattr(payload, "images", []))
                if kind == "video":
                    references.extend(getattr(payload, "videos", []))
                    references.extend(getattr(payload, "audios", []))
                allowed = {u for node in canvas.get("nodes", []) for u in node_media(node)}
                if any((ref if isinstance(ref, str) else ref.url) not in allowed for ref in references):
                    raise AgentError("reference_scope", "生成引用图不属于当前画布", 403)
            action.update(status="executing", stage="executing", request_signature=signature, generation_kind=kind)
            self.store.put(db, "actions", action)
            self.store.event(db, run["run_id"], action["task_id"], "execution_started", action_id=action_id)
        return None

    def generation_submitted(self, action_id, task_id):
        if not action_id:
            return
        with self.store.transaction() as db:
            action = self.store.get(db, "actions", action_id)
            action.update(generation_task_ids=[task_id], stage="generation_result")
            if action["status"] != "cancelled":
                action["status"] = "waiting_result"
            self.store.put(db, "actions", action)
            self.store.event(db, action["run_id"], action["task_id"], "generation_submitted", action_id=action_id, generation_task_ids=[task_id])

    def preparation_failed(self, action_id, error):
        with self.store.transaction() as db:
            action = self.store.get(db, "actions", action_id)
            if action["status"] not in TERMINAL and not action["generation_task_ids"]:
                action.update(status="failed", error=self.safe_error(error))
                self.store.put(db, "actions", action)
                self.store.event(db, action["run_id"], action["task_id"], "execution_failed", action_id=action_id, message=action["error"])

    def ensure_generation_active(self, action_id):
        # Local workflow preparation can outlive a stop or application recovery.
        with self.store.transaction() as db:
            action = self.store.get(db, "actions", action_id)
            run = self.store.get(db, "runs", action["run_id"])
            if (run["cancel_requested"] or run["recovery_required"] or run["status"] in TERMINAL
                    or action["status"] != "executing"):
                raise AgentError("cancelled", "代理任务已停止或等待恢复，未启动本地生成", 409)

    async def video(self, payload, original):
        existing = self.before_generation(payload, "video")
        if existing:
            raise AgentError("submission_unknown", "视频任务已经提交，请等待原任务结果")
        action_id = payload.multi_agent_action_id
        plain = payload.model_copy(update={"multi_agent_action_id": "", "multi_agent_execution_token": ""})
        paid_scope = PAID_REQUEST_SCOPE.set(True)
        try:
            result = await original(plain)
        except BaseException as exc:
            with self.store.transaction() as db:
                action = self.store.get(db, "actions", action_id)
                if action["status"] != "cancelled":
                    action.update(status="waiting_result", error="视频提交结果待核对，请检查平台任务；不会自动重提")
                    self.store.put(db, "actions", action)
            raise
        finally:
            PAID_REQUEST_SCOPE.reset(paid_scope)
        with self.store.transaction() as db:
            action = self.store.get(db, "actions", action_id)
            action["server_result"] = result
            if action["status"] != "cancelled":
                action.update(status="waiting_result", stage="generation_result")
            self.store.put(db, "actions", action)
        return result

    async def reconcile(self, run_id):
        with self.store.transaction() as db:
            run = self.store.get(db, "runs", run_id)
            actions = self.store.rows(db, "actions", run_id)
        for action in actions:
            if action["status"] in TERMINAL or action["status"] in {"registered", "awaiting_approval"}:
                continue
            # A lost POST receipt is recovered by the existing durable generation ID.
            if not action["generation_task_ids"] and action["operation"]["tool"] == "canvas.run_node":
                found = self.host._find_canvas_task_by_client_request_id(action["client_request_id"])
                if found and found.get("project_id") == run["project_id"]:
                    self.generation_submitted(action["action_id"], found["id"])
            with self.store.transaction() as db:
                current = self.store.get(db, "actions", action["action_id"])
            if current["generation_task_ids"]:
                task_id = current["generation_task_ids"][0]
                try:
                    remote = await (self.host.get_canvas_comfy_task(task_id) if current.get("local_gpu") else self.host.get_canvas_image_task(task_id))
                    remote = remote.get("task", remote)
                except HTTPException:
                    continue
                if remote.get("project_id") != run["project_id"]:
                    raise AgentError("generation_scope", "已有生成任务不属于当前项目", 403)
                status = remote.get("status")
                with self.store.transaction() as db:
                    current = self.store.get(db, "actions", current["action_id"])
                    if current["status"] in TERMINAL:
                        continue
                    if status in {"failed", "error", "cancelled"}:
                        error = str(remote.get("error") or remote.get("message") or "生成失败")
                        status_code = int(remote.get("status_code") or 500)
                        unknown = (remote.get("recoverable") or remote.get("recovery_id")
                                   or remote.get("upstream_task_id") and not remote.get("result")
                                   or current["paid"] and (status_code >= 500 or status_code == 408)
                                   or re.search(r"未知|不明|可能.*计费|重启|中断|确认.*扣费|submission.*unknown", error, re.I))
                        current.update(status="waiting_result" if unknown else "failed", error=self.safe_error(error),
                                       stage="generation_result", submission_unknown=bool(unknown))
                    elif status in {"completed", "succeeded", "success", "done"}:
                        current.update(server_result=remote.get("result") or {}, stage="acceptance")
                    self.store.put(db, "actions", current)
            # Mutations/results must be present in the authoritative saved canvas.
            self.try_complete(current, run)

    def try_complete(self, action, run):
        canvas = self.canvas(run)
        affected = [n for n in canvas.get("nodes", []) if action["action_id"] in n.get("_agent_action_ids", [])]
        receipt = action.get("receipt") or {}
        if not receipt and affected:
            receipt = {"node_ids": [n["id"] for n in affected]}
        if not receipt:
            return
        tool = action["operation"]["tool"]
        if tool == "canvas.run_node":
            if not action.get("server_result"):
                return
            urls = self.result_urls(action["server_result"])
            if not urls or not urls.issubset({u for n in canvas.get("nodes", []) for u in node_media(n)}):
                return
            result = {"node_ids": receipt.get("node_ids", []), "image_urls": sorted(urls), "generation_task_ids": action["generation_task_ids"]}
        else:
            op_args = action["operation"]["args"]
            if tool in {"canvas.connect", "canvas.disconnect"}:
                exists = any(c.get("from") == op_args["from"] and c.get("to") == op_args["to"] and c.get("kind", "flow") == op_args.get("kind", "input") for c in canvas.get("connections", []))
                if exists != (tool == "canvas.connect"):
                    return
            if tool == "canvas.delete_node":
                target = action["operation"]["target"]
                ident = target.get("node_id") if isinstance(target, dict) else target
                if any(n["id"] == ident for n in canvas.get("nodes", [])):
                    return
            if tool != "canvas.delete_node" and not affected:
                return
            result = {"node_ids": receipt.get("node_ids", [])}
        with self.store.transaction() as db:
            fresh = self.store.get(db, "actions", action["action_id"])
            if fresh["status"] in TERMINAL:
                return
            fresh.update(status="completed", stage="acceptance", result=result, error="")
            self.store.put(db, "actions", fresh)
            self.store.event(db, action["run_id"], action["task_id"], "canvas_result", action_id=action["action_id"], result=result)

    @staticmethod
    def result_urls(value):
        result = set()
        def walk(item):
            if isinstance(item, list):
                for child in item:
                    walk(child)
            elif isinstance(item, dict):
                for key, child in item.items():
                    if key in {"url", "image_url", "file_url"} and isinstance(child, str) and child.startswith(("/assets/", "/output/", "/api/storage-file")):
                        result.add(child)
                    elif key in {"images", "image_items", "videos", "outputs", "result", "files"}:
                        if isinstance(child, list):
                            for url in child:
                                if isinstance(url, str) and url.startswith("/"):
                                    result.add(url)
                        walk(child)
        walk(value)
        return result

    async def cancel_generations(self, run_id):
        with self.store.transaction() as db:
            actions = self.store.rows(db, "actions", run_id)
        for action in actions:
            if action["status"] != "cancelled":
                continue
            for task_id in action["generation_task_ids"]:
                try:
                    if action["local_gpu"]:
                        await self.host.cancel_canvas_comfy_task(task_id)
                    else:
                        await self.host.cancel_canvas_image_task(task_id)
                except HTTPException:
                    pass


def install_multi_agent(app, host):
    adapter = CanvasAgentAdapter(host, AgentRunStore(Path(host.DATA_DIR) / "multi_agent" / "runs.sqlite3"))
    store, engine = adapter.store, adapter.runtime
    prefix = "/api/canvas-agent/multi"

    async def agent_error_handler(request, exc):
        return JSONResponse(status_code=exc.status, content={"detail": {"code": exc.code, "message": exc.message}})
    app.add_exception_handler(AgentError, agent_error_handler)

    def access(request, project_id, canvas_id="", run_id=""):
        host._project_agent_access(request, project_id, canvas_id)
        if run_id:
            with store.transaction() as db:
                return store.scoped(db, run_id, project_id, canvas_id)

    @app.on_event("startup")
    async def multi_agent_recovery():
        store.recover()

    @app.on_event("shutdown")
    async def multi_agent_shutdown():
        await engine.close()

    @app.get(prefix + "/config")
    async def config(request: Request):
        host._project_agent_local_access(request)
        from multi_agent_runtime import RunLimits, RunPolicy
        return {"enabled": True, "limits": RunLimits().model_dump(), "policy": RunPolicy().model_dump(),
                "tools": sorted(ALL_TOOLS), "canvas_tools": sorted(COMMANDS), "model_choices": adapter.choices()}

    @app.post(prefix + "/runs")
    async def create(payload: RunRequest, request: Request):
        access(request, payload.project_id, payload.canvas_id)
        if set(payload.allowed_tools) - ALL_TOOLS:
            raise AgentError("invalid_permissions", "工具权限包含未登记的项目", 422)
        if "agent.finish_task" not in payload.allowed_tools:
            raise AgentError("invalid_permissions", "主代理必须保留提交任务结果的权限", 422)
        adapter.validate_model(payload.provider_id, payload.model)
        canvas = adapter.canvas(payload.model_dump())
        context = adapter.context(payload, canvas)
        run, created = store.create(payload, context)
        if not run["recovery_required"]:
            engine.start(run["run_id"])
        return {"run_id": run["run_id"], "created": created, **store.snapshot(run["run_id"], payload.project_id)}

    @app.get(prefix + "/runs")
    async def history(request: Request, project_id: str, canvas_id: str = ""):
        access(request, project_id, canvas_id)
        return {"runs": store.history(project_id, canvas_id), "usage": store.usage(project_id)}

    @app.get(prefix + "/runs/{run_id}")
    async def status(run_id: str, request: Request, project_id: str, canvas_id: str, after: int = 0):
        run = access(request, project_id, canvas_id, run_id)
        if run["status"] not in TERMINAL:
            await adapter.reconcile(run_id)
        if not run["recovery_required"] and run["status"] not in TERMINAL:
            engine.start(run_id)
        return store.snapshot(run_id, project_id, canvas_id, max(0, after))

    @app.post(prefix + "/runs/{run_id}/interrupt")
    async def cancel(run_id: str, payload: ScopedInput, request: Request):
        access(request, payload.project_id, payload.canvas_id, run_id)
        await engine.cancel(run_id, payload.project_id)
        return {"ok": True}

    @app.post(prefix + "/runs/{run_id}/resume")
    async def resume(run_id: str, payload: ScopedInput, request: Request):
        run = access(request, payload.project_id, payload.canvas_id, run_id)
        if run["cancel_requested"] or run["status"] in TERMINAL:
            raise AgentError("terminal_run", "任务已结束，请新建任务或重试失败项")
        await adapter.reconcile(run_id)
        with store.transaction() as db:
            fresh = store.get(db, "runs", run_id)
            fresh.update(recovery_required=False, error="", status="queued")
            store.put(db, "runs", fresh)
            for task in store.rows(db, "tasks", run_id):
                if task.get("interrupted_model") and task["status"] not in TERMINAL:
                    task.update(status="queued", interrupted_model=False, error="")
                    store.put(db, "tasks", task)
            store.event(db, run_id, run["root_task_id"], "resumed", message="已核对已有生成记录，继续未提交的工作")
        engine.start(run_id)
        return store.snapshot(run_id, payload.project_id)

    @app.post(prefix + "/runs/{run_id}/tasks/{task_id}/retry")
    async def retry(run_id: str, task_id: str, payload: RetryInput, request: Request):
        run = access(request, payload.project_id, payload.canvas_id, run_id)
        with store.transaction() as db:
            task = store.get(db, "tasks", task_id)
            if task["run_id"] != run_id or task["status"] != "failed" or run["cancel_requested"]:
                raise AgentError("retry_denied", "只有本次运行中已失败的分析任务可以重试")
            pending = [a for a in store.rows(db, "actions", run_id) if a["task_id"] == task_id and a["status"] not in TERMINAL]
            if pending:
                raise AgentError("submission_unknown", "请先核对已有生成任务，不会重跑状态未知的操作")
            ancestors, cursor = [], task
            while cursor["parent_task_id"]:
                cursor = store.get(db, "tasks", cursor["parent_task_id"])
                if cursor["status"] == "cancelled":
                    raise AgentError("retry_denied", "上级任务已停止，请新建任务")
                ancestors.append(cursor)
            if payload.instructions:
                task["instructions"] = payload.instructions
            task.update(status="queued", error="", waiting_for=None)
            task["messages"].append({"role": "user", "content": "用户要求重试失败任务。保留此前步骤和生成回执，不重复提交已有操作。"})
            store.put(db, "tasks", task)
            previous = task_id
            for parent in ancestors:
                if parent["status"] in TERMINAL:
                    parent.update(status="waiting_result", error="", summary="", waiting_for={"task_id": previous})
                    store.put(db, "tasks", parent)
                previous = parent["task_id"]
            run.update(status="queued", recovery_required=False, error="")
            store.put(db, "runs", run)
            store.event(db, run_id, task_id, "retry", message="重试失败任务，保留已提交操作和用量")
        engine.start(run_id)
        return {"ok": True}

    @app.post(prefix + "/runs/{run_id}/tasks/{task_id}/cancel")
    async def cancel_task(run_id: str, task_id: str, payload: ScopedInput, request: Request):
        run = access(request, payload.project_id, payload.canvas_id, run_id)
        with store.transaction() as db:
            task = store.get(db, "tasks", task_id)
            if task["run_id"] != run_id:
                raise AgentError("not_found", "任务不属于本次运行", 404)
        if task_id == run["root_task_id"]:
            await engine.cancel(run_id, payload.project_id)
        else:
            await engine.cancel_remaining(run_id, task_id, "用户停止了此任务")
        return {"ok": True}

    @app.post(prefix + "/runs/{run_id}/actions/{action_id}/approve")
    async def approve(run_id: str, action_id: str, payload: ApprovalInput, request: Request):
        run = access(request, payload.project_id, payload.canvas_id, run_id)
        with store.transaction() as db:
            action = store.get(db, "actions", action_id)
            if action["run_id"] != run_id or action["status"] != "awaiting_approval" or run["cancel_requested"]:
                raise AgentError("approval_stale", "此操作已变更或结束，请刷新任务状态")
            if payload.approved:
                details = adapter.validate_command(run, action["operation"])
                action.update(status="registered", approved=True, expected_digest=details["canvas_digest"], expected_node_digest=details["node_digest"], error="")
            else:
                action.update(status="failed", approved=False, error="用户拒绝了此操作")
            store.put(db, "actions", action)
            store.event(db, run_id, action["task_id"], "approval", action_id=action_id, approved=payload.approved)
        engine.start(run_id)
        return {"ok": True}

    @app.post(prefix + "/runs/{run_id}/actions/{action_id}/claim")
    async def claim(run_id: str, action_id: str, payload: ClaimInput, request: Request):
        run = access(request, payload.project_id, payload.canvas_id, run_id)
        with store.transaction() as db:
            action = store.get(db, "actions", action_id)
            if action["run_id"] != run_id or run["cancel_requested"] or run["recovery_required"]:
                raise AgentError("execution_denied", "任务已停止或正在等待恢复")
            if action["status"] != "registered" or not action["approved"]:
                raise AgentError("already_claimed", "此操作已被接收或等待确认")
            # Only one browser may mutate a canvas graph at a time, across runs and projects.
            all_actions = [json.loads(row[0]) for row in db.execute("SELECT payload FROM actions")]
            if any(a["canvas_id"] == run["canvas_id"] and a["status"] == "claimed" for a in all_actions):
                raise AgentError("canvas_busy", "画布正在应用另一个操作，请稍候")
            if any(a["action_id"] != action_id and a["status"] in {"claimed", "executing", "waiting_result"} and set(a.get("resources", [])) & set(action["resources"]) for a in all_actions):
                raise AgentError("canvas_busy", "其他运行正在处理同一节点，请等待已有结果")
            if action["operation"]["tool"] == "canvas.run_node" and sum(
                a["run_id"] == run_id and a["operation"]["tool"] == "canvas.run_node"
                and a["status"] in {"claimed", "executing", "waiting_result"} for a in all_actions
            ) >= run["limits"]["concurrency"]:
                raise AgentError("generation_busy", "生成任务已达到本次并发上限，请等待已有结果")
            if action["local_gpu"] and any(a["local_gpu"] and a["status"] in {"claimed", "executing", "waiting_result"} for a in all_actions):
                raise AgentError("gpu_busy", "本地 GPU 正在执行另一任务，请稍候")
            details = adapter.validate_command(run, action["operation"])
            if details["node_digest"] != action["expected_node_digest"]:
                action.update(status="awaiting_approval", error="画布目标已修改，请核对操作后重新确认")
                store.put(db, "actions", action)
                # Return a committed conflict rather than rolling back the waiting state.
                return JSONResponse(status_code=409, content={"detail": {"code": "canvas_conflict", "message": action["error"]}})
            action.update(status="claimed", stage="executing", lease_token=secrets.token_hex(24), client_id=payload.client_id)
            store.put(db, "actions", action)
            return {"action": action}

    @app.post(prefix + "/runs/{run_id}/actions/{action_id}/resume-unsubmitted")
    async def resume_unsubmitted(run_id: str, action_id: str, payload: ScopedInput, request: Request):
        run = access(request, payload.project_id, payload.canvas_id, run_id)
        await adapter.reconcile(run_id)
        with store.transaction() as db:
            action = store.get(db, "actions", action_id)
            if action["run_id"] != run_id or run["cancel_requested"] or run["status"] in TERMINAL:
                raise AgentError("execution_denied", "任务已结束，不能继续生成")
            if action["operation"]["tool"] != "canvas.run_node" or action["status"] not in {"claimed", "waiting_result"} or action.get("request_signature") or action["generation_task_ids"]:
                raise AgentError("submission_unknown", "已有提交记录，请查询原任务结果；不能再次提交")
            # Invalidate the old browser before requeuing. before_generation is the sole submission gate.
            action.update(status="registered", stage="registered", lease_token="", resume_unsubmitted=True, error="")
            store.put(db, "actions", action)
            store.event(db, run_id, action["task_id"], "resumed_unsubmitted", action_id=action_id)
        return {"ok": True}

    @app.post(prefix + "/runs/{run_id}/actions/{action_id}/receipt")
    async def receipt(run_id: str, action_id: str, payload: ReceiptInput, request: Request):
        run = access(request, payload.project_id, payload.canvas_id, run_id)
        with store.transaction() as db:
            action = store.get(db, "actions", action_id)
            if action["run_id"] != run_id or not secrets.compare_digest(action.get("lease_token", ""), payload.lease_token):
                raise AgentError("invalid_lease", "此回执不属于当前画布执行器", 403)
            if action["status"] in TERMINAL:
                return {"ok": True, "status": action["status"]}
            if payload.status == "failed":
                # An executing paid POST can be accepted upstream even when its browser reports failure.
                uncertain = action["operation"]["tool"] == "canvas.run_node" and action["status"] != "claimed"
                action.update(status="waiting_result" if uncertain else "failed", error=payload.error or "画布执行未完成")
            else:
                action.update(status="waiting_result", receipt={"node_ids": payload.node_ids}, stage="generation_result" if action["operation"]["tool"] == "canvas.run_node" else "acceptance")
            store.put(db, "actions", action)
        adapter.try_complete(action, run)
        engine.start(run_id)
        return {"ok": True}

    return adapter
