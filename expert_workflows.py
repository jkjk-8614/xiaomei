"""Persistent runs for the expert workflow inside a smart canvas node."""

from __future__ import annotations

import asyncio
import hashlib
import json
import re
import time
import uuid
from pathlib import Path
from typing import Any, Callable

from fastapi import HTTPException
from pydantic import BaseModel, Field


EXPERT_ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,80}$")
RUN_ID_RE = re.compile(r"^[a-f0-9]{32}$")


class ExpertRunRequest(BaseModel):
    canvas_id: str = Field(min_length=1, max_length=120)
    node_id: str = Field(min_length=1, max_length=120)
    workflow: dict[str, Any]
    message: str = Field(default="", max_length=100000)
    images: list[str] = Field(default_factory=list)
    videos: list[str] = Field(default_factory=list)
    attachments: list[dict[str, Any]] = Field(default_factory=list)
    resume_from: str = ""
    resume_after_step: int = -1
    edited_output: str = ""


def _digest(value: Any) -> str:
    encoded = json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(encoded.encode("utf-8")).hexdigest()


def _ordered_experts(workflow: dict[str, Any]) -> list[dict[str, Any]]:
    experts = workflow.get("experts")
    edges = workflow.get("edges")
    if not isinstance(experts, list) or not 1 <= len(experts) <= 12:
        raise HTTPException(status_code=422, detail="专家协作需要 1–12 位专家")
    if not isinstance(edges, list):
        raise HTTPException(status_code=422, detail="请连接输入、专家和输出")
    by_id: dict[str, dict[str, Any]] = {}
    for raw in experts:
        if not isinstance(raw, dict):
            raise HTTPException(status_code=422, detail="专家配置无效")
        expert_id = str(raw.get("id") or "")
        if not EXPERT_ID_RE.fullmatch(expert_id) or expert_id in {"input", "output"} or expert_id in by_id:
            raise HTTPException(status_code=422, detail="专家 ID 重复或无效")
        name = str(raw.get("name") or "").strip()
        skill_id = str(raw.get("skill_id") or "").strip()
        provider = str(raw.get("provider") or "").strip()
        model = str(raw.get("model") or "").strip()
        if not name or len(name) > 80 or not skill_id or not provider or not model:
            raise HTTPException(status_code=422, detail=f"专家「{name or expert_id}」需要名称、Skill、平台和模型")
        if len(str(raw.get("instruction") or "")) > 3000 or len(str(raw.get("output_format") or "")) > 1500:
            raise HTTPException(status_code=422, detail=f"专家「{name}」的职责或交付要求过长")
        by_id[expert_id] = {
            "id": expert_id,
            "name": name,
            "skill_id": skill_id,
            "provider": provider,
            "model": model,
            "instruction": str(raw.get("instruction") or "").strip(),
            "output_format": str(raw.get("output_format") or "").strip(),
            "pause_after": bool(raw.get("pause_after")),
        }
    next_id: dict[str, str] = {}
    incoming: dict[str, str] = {}
    valid_sources = {"input", *by_id}
    valid_targets = {"output", *by_id}
    for edge in edges:
        if not isinstance(edge, dict):
            raise HTTPException(status_code=422, detail="专家连线无效")
        source, target = str(edge.get("from") or ""), str(edge.get("to") or "")
        if source not in valid_sources or target not in valid_targets or source == target:
            raise HTTPException(status_code=422, detail="专家连线包含不存在的节点")
        if source in next_id or target in incoming:
            raise HTTPException(status_code=422, detail="当前流程每位专家只能连接一位下一步专家")
        next_id[source], incoming[target] = target, source
    if len(next_id) != len(by_id) + 1 or "input" not in next_id or "output" not in incoming:
        raise HTTPException(status_code=422, detail="请把全部专家从输入依次连接到输出")
    ordered, visited = [], set()
    current = next_id["input"]
    while current != "output":
        if current not in by_id or current in visited:
            raise HTTPException(status_code=422, detail="专家流程存在循环连线")
        visited.add(current)
        ordered.append(by_id[current])
        current = next_id.get(current, "")
    if len(visited) != len(by_id):
        raise HTTPException(status_code=422, detail="有专家尚未连接到流程")
    return ordered


class ExpertWorkflowRuns:
    def __init__(
        self,
        directory: str | Path,
        invoke_llm: Callable,
        resolve_skill: Callable,
        model_choices: Callable,
        request_factory: Callable,
        save_json: Callable,
    ) -> None:
        self.directory = Path(directory)
        self.invoke_llm = invoke_llm
        self.resolve_skill = resolve_skill
        self.model_choices = model_choices
        self.request_factory = request_factory
        self.save_json = save_json
        self.active: dict[str, asyncio.Task] = {}
        self.live: dict[str, dict[str, Any]] = {}

    def _path(self, run_id: str) -> Path:
        if not RUN_ID_RE.fullmatch(run_id):
            raise HTTPException(status_code=400, detail="运行编号无效")
        return self.directory / f"{run_id}.json"

    def _save(self, run: dict[str, Any]) -> None:
        run["updated_at"] = time.time()
        self.save_json(str(self._path(run["id"])), run)

    def get(self, run_id: str) -> dict[str, Any]:
        if run_id in self.live:
            return self.live[run_id]
        path = self._path(run_id)
        try:
            with path.open("r", encoding="utf-8") as handle:
                run = json.load(handle)
        except FileNotFoundError as exc:
            raise HTTPException(status_code=404, detail="专家协作运行记录不存在") from exc
        except (OSError, ValueError) as exc:
            raise HTTPException(status_code=500, detail="专家协作运行记录无法读取") from exc
        if run.get("status") in {"queued", "running"}:
            run["status"] = "interrupted"
            run["error"] = "服务重启中断了本次运行；已完成的专家结果仍可继续使用"
            self._save(run)
        return run

    def list(self, canvas_id: str, node_id: str) -> list[dict[str, Any]]:
        if not canvas_id or not node_id:
            raise HTTPException(status_code=400, detail="请指定画布和专家协作节点")
        if not self.directory.exists():
            return []
        records = []
        for path in sorted(self.directory.glob("*.json"), key=lambda item: item.stat().st_mtime, reverse=True):
            try:
                run = self.get(path.stem)
            except HTTPException:
                continue
            if run.get("canvas_id") == canvas_id and run.get("node_id") == node_id:
                records.append({
                    "id": run["id"], "status": run.get("status"), "created_at": run.get("created_at"),
                    "updated_at": run.get("updated_at"), "name": run.get("name"),
                    "error": run.get("error", ""), "output": run.get("output", ""),
                })
            if len(records) >= 30:
                break
        return records

    async def start(self, payload: ExpertRunRequest) -> dict[str, Any]:
        ordered = _ordered_experts(payload.workflow)
        if not payload.message.strip() and not (payload.images or payload.videos or payload.attachments):
            raise HTTPException(status_code=422, detail="请在节点填写任务要求，或连接上游素材")
        if len(payload.images) > 20 or len(payload.videos) > 3 or len(payload.attachments) > 20:
            raise HTTPException(status_code=422, detail="本次连接的素材过多，请减少后重试")
        contexts = {}
        steps = []
        for expert in ordered:
            skill, context = self.resolve_skill(expert["skill_id"])
            if expert["model"] not in self.model_choices(expert["provider"]):
                raise HTTPException(status_code=422, detail=f"专家「{expert['name']}」的聊天模型不可用，请重新选择")
            skill_hash = hashlib.sha256(context.encode("utf-8")).hexdigest()
            contexts[expert["id"]] = context
            steps.append({
                **expert,
                "skill_name": str(skill.get("name") or skill.get("id") or expert["skill_id"]),
                "skill_hash": skill_hash,
                "status": "waiting", "input": "", "output": "", "error": "",
                "started_at": 0, "finished_at": 0,
            })
        flow_hash = _digest(ordered)
        input_hash = _digest({
            "message": payload.message, "images": payload.images, "videos": payload.videos,
            "attachments": payload.attachments,
        })
        start_index = 0
        if payload.resume_from:
            previous = self.get(payload.resume_from)
            if previous.get("canvas_id") != payload.canvas_id or previous.get("node_id") != payload.node_id:
                raise HTTPException(status_code=409, detail="所选运行记录不属于当前专家协作节点")
            if previous.get("flow_hash") != flow_hash or previous.get("input_hash") != input_hash:
                raise HTTPException(status_code=409, detail="任务输入或专家配置已变化，请开始一次新运行")
            last = payload.resume_after_step
            if last < -1 or last >= len(steps):
                raise HTTPException(status_code=422, detail="继续运行的位置无效")
            for index in range(last + 1):
                prior = previous["steps"][index]
                if prior.get("skill_hash") != steps[index]["skill_hash"]:
                    raise HTTPException(status_code=409, detail=f"Skill「{steps[index]['skill_name']}」已更新，请开始一次新运行")
                output = payload.edited_output.strip() if index == last and payload.edited_output else str(prior.get("output") or "").strip()
                if not output:
                    raise HTTPException(status_code=422, detail=f"专家「{steps[index]['name']}」没有可继续使用的结果")
                steps[index].update(status="reused", input=str(prior.get("input") or ""), output=output,
                                    started_at=prior.get("started_at", 0), finished_at=prior.get("finished_at", 0))
            start_index = last + 1
        run_id = uuid.uuid4().hex
        now = time.time()
        run = {
            "id": run_id, "canvas_id": payload.canvas_id, "node_id": payload.node_id,
            "name": str(payload.workflow.get("name") or "专家协作")[:80],
            "status": "queued", "created_at": now, "updated_at": now, "finished_at": 0,
            "parent_run_id": payload.resume_from, "flow_hash": flow_hash, "input_hash": input_hash,
            "input_summary": payload.message[:500], "image_count": len(payload.images),
            "attachment_count": len(payload.attachments), "steps": steps, "output": "", "error": "",
        }
        self.live[run_id] = run
        self._save(run)
        task = asyncio.create_task(self._execute(run, payload, contexts, start_index))
        self.active[run_id] = task
        task.add_done_callback(lambda _task: (self.active.pop(run_id, None), self.live.pop(run_id, None)))
        return run

    async def _execute(self, run: dict[str, Any], payload: ExpertRunRequest, contexts: dict[str, str], start_index: int) -> None:
        try:
            run["status"] = "running"
            self._save(run)
            for index in range(start_index, len(run["steps"])):
                step = run["steps"][index]
                preceding = run["steps"][index - 1] if index else None
                previous_text = str(preceding.get("output") or "").strip() if preceding else ""
                message = f"原始任务：\n{payload.message.strip() or '请分析连接的素材并完成任务。'}"
                if previous_text:
                    message += f"\n\n上一位专家「{preceding['name']}」的结果：\n{previous_text}"
                role = [f"你是「{step['name']}」。", step["instruction"],
                        f"交付要求：{step['output_format']}" if step["output_format"] else "",
                        "只完成当前专家的文字工作，不声称已执行外部操作或生图。",
                        contexts[step["id"]]]
                step.update(status="running", input=message, error="", started_at=time.time())
                self._save(run)
                try:
                    request = self.request_factory(
                        message=message, system_prompt="\n\n".join(item for item in role if item),
                        provider=step["provider"], model=step["model"],
                        images=payload.images, videos=payload.videos, attachments=payload.attachments,
                        allow_model_fallback=False,
                    )
                    result = await self.invoke_llm(request)
                    output = str(result.get("text") or "").strip()
                    if not output:
                        raise RuntimeError("聊天模型没有返回文字结果")
                    step.update(status="completed", output=output,
                                model_used=str(result.get("model") or step["model"]), finished_at=time.time())
                    self._save(run)
                except asyncio.CancelledError:
                    raise
                except Exception as exc:
                    detail = str(getattr(exc, "detail", None) or exc)
                    step.update(status="failed", error=detail[:1000], finished_at=time.time())
                    run.update(status="failed", error=f"专家「{step['name']}」运行失败：{detail[:500]}", finished_at=time.time())
                    self._save(run)
                    return
                if step["pause_after"] and index < len(run["steps"]) - 1:
                    run.update(status="paused", error="", finished_at=time.time())
                    self._save(run)
                    return
            run.update(status="completed", output=run["steps"][-1]["output"], error="", finished_at=time.time())
            self._save(run)
        except asyncio.CancelledError:
            for step in run["steps"]:
                if step["status"] == "running":
                    step.update(status="cancelled", finished_at=time.time())
            run.update(status="cancelled", error="已停止专家协作运行", finished_at=time.time())
            self._save(run)
        except Exception as exc:
            run.update(status="failed", error=f"专家协作运行失败：{str(exc)[:500]}", finished_at=time.time())
            self._save(run)

    def cancel(self, run_id: str) -> dict[str, Any]:
        run = self.get(run_id)
        task = self.active.get(run_id)
        if task and not task.done():
            task.cancel()
        elif run.get("status") in {"paused", "queued", "running"}:
            run.update(status="cancelled", error="已停止专家协作运行", finished_at=time.time())
            self._save(run)
        return run


def install_expert_workflows(app, *, data_dir, invoke_llm, resolve_skill, model_choices, request_factory, save_json):
    service = ExpertWorkflowRuns(
        Path(data_dir) / "expert_workflow_runs", invoke_llm, resolve_skill,
        model_choices, request_factory, save_json,
    )

    @app.post("/api/expert-workflows/runs")
    async def create_expert_workflow_run(payload: ExpertRunRequest):
        return await service.start(payload)

    @app.get("/api/expert-workflows/runs")
    async def list_expert_workflow_runs(canvas_id: str, node_id: str):
        return {"runs": service.list(canvas_id, node_id)}

    @app.get("/api/expert-workflows/runs/{run_id}")
    async def get_expert_workflow_run(run_id: str):
        return service.get(run_id)

    @app.post("/api/expert-workflows/runs/{run_id}/cancel")
    async def cancel_expert_workflow_run(run_id: str):
        return service.cancel(run_id)

    return service
