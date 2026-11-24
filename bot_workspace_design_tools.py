"""P4 设计大脑核心能力迁移到小美 Bot 工作区工具集。

复用现有设计大脑存储、规划、规则与质检模块（绝不重写第三套）：
- ``design.profile.read``        读取个人审美档案与隐私开关
- ``design.references.search``   检索个人参考素材库
- ``design.references.analyze``  使用当前 Bot 视觉模型分析参考图并写回（遵守隐私开关）
- ``design.plan.compose``        复用 compose_batched_plan 生成结构化分镜方案（不直接生图）
- ``design.batch.canvas_plan``   将确认后的批量方案转为画布 multi_agent 受控执行（未确认先进审批）
- ``design.review.check``        本地像素/比例核查 + 视觉模型质检（无法判断标 needs_human）
"""
from __future__ import annotations

import asyncio
import base64
import json
import mimetypes
from pathlib import Path
from typing import Any, Dict, List, Optional, Set

from pydantic import BaseModel, ConfigDict, Field

from bot_workspace_store import BotWorkspaceError, sha256_json
from design_brain_bots import REVIEWER_SYSTEM, compose_batched_plan, resolve_plan_image_params
from design_brain_quality import inspect_image
from design_brain_store import (
    DesignBrainError,
    DesignProfileStore,
    ReferenceItemStore,
    image_requirements,
)
from design_brain_visual_rules import infer_task_type

ANALYZE_IMAGE_MAX_BYTES = 3 * 1024 * 1024


class _StrictDesignArgs(BaseModel):
    model_config = ConfigDict(extra="forbid")


class DesignProfileReadArgs(_StrictDesignArgs):
    pass


class DesignReferencesSearchArgs(_StrictDesignArgs):
    query: str = Field(default="", max_length=80)
    category: str = Field(default="", max_length=40)
    purpose: str = Field(default="", max_length=40)
    expression: str = Field(default="", max_length=40)
    tag: str = Field(default="", max_length=40)
    limit: int = Field(default=6, ge=1, le=12)


class DesignReferencesAnalyzeArgs(_StrictDesignArgs):
    item_id: str = Field(min_length=1, max_length=60)
    force: bool = False


class DesignPlanComposeArgs(_StrictDesignArgs):
    brief: str = Field(min_length=1, max_length=4000)
    reference_ids: List[str] = Field(default_factory=list, max_length=6)
    shot_count: int = Field(default=0, ge=0, le=24)


class DesignBatchCanvasPlanArgs(_StrictDesignArgs):
    plan_title: str = Field(default="批量电商视觉方案", max_length=120)
    direction: str = Field(default="", max_length=1000)
    shots: List[Dict[str, Any]] = Field(min_length=1, max_length=24)
    source_node_ids: List[str] = Field(default_factory=list, max_length=40)
    source_images: List[str] = Field(default_factory=list, max_length=40)
    confirmed: bool = False
    idempotency_key: str = Field(default="", max_length=120)


class DesignReviewCheckArgs(_StrictDesignArgs):
    image: str = Field(min_length=1, max_length=2000)
    expected_size: str = Field(default="", max_length=24)
    acceptance: List[str] = Field(default_factory=list, max_length=12)
    prompt: str = Field(default="", max_length=2000)
    product_images: List[str] = Field(default_factory=list, max_length=6)


def _clean(value: Any, limit: int) -> str:
    return str(value or "").strip()[:limit]


def _parse_json_obj(text: str) -> Optional[Dict[str, Any]]:
    raw = str(text or "").strip()
    if raw.startswith("```"):
        cut = raw.find("\n")
        tail = raw.rfind("```")
        if cut >= 0 and tail > cut:
            raw = raw[cut + 1:tail].strip()
    try:
        parsed = json.loads(raw)
        if isinstance(parsed, dict):
            return parsed
    except ValueError:
        pass
    s, e = raw.find("{"), raw.rfind("}")
    if s >= 0 and e > s:
        try:
            parsed = json.loads(raw[s:e + 1])
            if isinstance(parsed, dict):
                return parsed
        except ValueError:
            return None
    return None


def _file_to_data_url(path: Path) -> str:
    if not path.is_file() or path.stat().st_size > ANALYZE_IMAGE_MAX_BYTES:
        return ""
    mime = mimetypes.guess_type(str(path))[0] or "image/jpeg"
    return f"data:{mime};base64," + base64.b64encode(path.read_bytes()).decode("ascii")


def _data_root_of(executor: Any) -> Path:
    # 优先使用 host.DATA_DIR，或从 workspace.sqlite3 路径反推 data 根目录
    host_data = getattr(executor.host, "DATA_DIR", None)
    if host_data:
        return Path(host_data).resolve()
    return executor.store.path.parent.parent.resolve()


def _profile_store(executor: Any) -> DesignProfileStore:
    return DesignProfileStore(_data_root_of(executor))


def _reference_store(executor: Any) -> ReferenceItemStore:
    return ReferenceItemStore(_data_root_of(executor))


def _resolve_bot_vision_model(bot: Dict[str, Any], turn: Dict[str, Any], runtime: Any) -> Dict[str, str]:
    vis = bot.get("vision_model") or {}
    if vis.get("provider_id") and vis.get("model"):
        return runtime.validate_dynamic_model(vis["provider_id"], vis["model"], kind="chat_models")
    return runtime.resolve_chat_model(bot, turn)


async def _call_design_llm(
    host: Any,
    model: Dict[str, str],
    *,
    system: str,
    message: str,
    images: Optional[List[str]] = None,
    max_tokens: int = 2000,
) -> str:
    req = host.CanvasLLMRequest(
        message=message[:10000] or "继续",
        messages=[],
        system_prompt=system,
        images=list(images or [])[:8],
        provider=model["provider_id"],
        model=model["model"],
        allow_model_fallback=False,
        max_output_tokens=max_tokens,
    )
    resp = await asyncio.wait_for(host.canvas_llm(req), timeout=240)
    return str((resp or {}).get("text") or "").strip()


def _cloud_analysis_allowed(profile_state: Dict[str, Any]) -> bool:
    privacy = (profile_state.get("profile") or {}).get("privacy") or {}
    # 默认允许（与旧设计大脑行为一致），当用户显式设为 False 时严格禁止外发
    return privacy.get("allow_cloud_analysis", True) is not False


def register_design_tools(executor: Any) -> None:
    """将 6 个设计大脑能力工具与审批回调挂载到 BotWorkspaceToolExecutor。"""
    from bot_workspace_tools import ToolSpec

    async def tool_profile_read(
        args: DesignProfileReadArgs, bot: Dict[str, Any], turn: Dict[str, Any], runtime: Any, effective: Set[str]
    ) -> Dict[str, Any]:
        state = _profile_store(executor).read()
        profile = state.get("profile") or {}
        aesthetics = {}
        for group_name, entries in (profile.get("aesthetics") or {}).items():
            aesthetics[group_name] = [
                {"tag": entry.get("tag"), "weight": entry.get("weight")}
                for entry in (entries or [])[:8]
            ]
        allow_cloud = _cloud_analysis_allowed(state)
        result = {
            "revision": state.get("revision", 0),
            "allow_cloud_analysis": allow_cloud,
            "aesthetics": aesthetics,
            "brand_words": (profile.get("tone") or {}).get("brand_words") or [],
            "banned_words": (profile.get("tone") or {}).get("banned_words") or [],
            "task_defaults": profile.get("task_defaults") or {},
        }
        return {
            "ok": True,
            "result": result,
            "display_text": f"已读取个人审美档案（版本 v{result['revision']}，云端视觉分析：{'已开启' if allow_cloud else '已关闭'}）",
        }

    async def tool_references_search(
        args: DesignReferencesSearchArgs, bot: Dict[str, Any], turn: Dict[str, Any], runtime: Any, effective: Set[str]
    ) -> Dict[str, Any]:
        refs = _reference_store(executor)
        filters = {
            "q": _clean(args.query, 80),
            "category": _clean(args.category, 40),
            "purpose": _clean(args.purpose, 40),
            "expression": _clean(args.expression, 40),
            "tag": _clean(args.tag, 40),
        }
        page = refs.list({k: v for k, v in filters.items() if v}, limit=args.limit)
        items = []
        for item in page.get("items") or []:
            content = (item.get("analysis") or {}).get("content") or {}
            items.append({
                "id": item.get("id"),
                "title": item.get("title") or (item.get("file") or {}).get("name") or "",
                "classification": item.get("classification") or {},
                "analysis": content if (item.get("analysis") or {}).get("status") == "ready" else {},
                "image_url": f"/api/design-brain/references/{item.get('id')}/image",
            })
        return {
            "ok": True,
            "result": {"total": page.get("total", len(items)), "items": items},
            "display_text": f"参考素材库检索到 {len(items)} 条参考（共 {page.get('total', len(items))} 条）",
        }

    async def tool_references_analyze(
        args: DesignReferencesAnalyzeArgs, bot: Dict[str, Any], turn: Dict[str, Any], runtime: Any, effective: Set[str]
    ) -> Dict[str, Any]:
        refs = _reference_store(executor)
        try:
            item = refs.get(args.item_id)
        except DesignBrainError as exc:
            raise BotWorkspaceError("reference_not_found", exc.message, exc.status) from exc
        analysis = item.get("analysis") or {}
        if not args.force and analysis.get("status") == "ready" and analysis.get("content"):
            return {
                "ok": True,
                "result": {"id": args.item_id, "cached": True, "analysis": analysis.get("content")},
                "display_text": f"已读取参考图「{item.get('title') or args.item_id}」的既有分析",
            }
        # 隐私开关校验：禁止在关闭云端分析时将本地参考图外发给云端模型
        if not _cloud_analysis_allowed(_profile_store(executor).read()):
            raise BotWorkspaceError(
                "privacy_disabled",
                "个人审美档案已关闭「允许云端图片分析」，未将参考图发送至模型；请先在设置开启或由人工填写参考说明",
                403,
            )
        media = (item.get("file") or {}).get("thumb") or (item.get("file") or {}).get("media")
        if not media:
            raise BotWorkspaceError("invalid_reference", "该参考素材缺少可用图片文件", 422)
        data_url = _file_to_data_url(refs.root / media)
        if not data_url:
            raise BotWorkspaceError("invalid_reference", "参考图无法读取或超过 3MB 上限", 422)

        model = _resolve_bot_vision_model(bot, turn, runtime)
        system = (
            "你是电商视觉参考分析助手。只输出一个 JSON 对象："
            '{"purpose":"这张图适合的用途","composition":"构图","material":"材质表现",'
            '"lighting":"光线","takeaways":"可借鉴点","restrictions":"使用限制或要避免的点"}；'
            "每项不超过 60 字，只描述画面里看得到的，不要编造。"
        )
        raw = await _call_design_llm(
            executor.host, model, system=system, message="请分析这张参考图的视觉语言。", images=[data_url], max_tokens=700
        )
        parsed = _parse_json_obj(raw) or {}
        content = {
            k: _clean(parsed.get(k), 200)
            for k in ("purpose", "composition", "material", "lighting", "takeaways", "restrictions")
        }
        if not any(content.values()):
            raise BotWorkspaceError("analysis_failed", "模型未返回有效的参考图分析 JSON", 502)
        refs.set_analysis(args.item_id, "ready", content=content, provider=model["provider_id"], model=model["model"])
        return {
            "ok": True,
            "result": {"id": args.item_id, "cached": False, "analysis": content},
            "display_text": f"已完成参考图「{item.get('title') or args.item_id}」分析并写回参考库",
        }

    async def tool_plan_compose(
        args: DesignPlanComposeArgs, bot: Dict[str, Any], turn: Dict[str, Any], runtime: Any, effective: Set[str]
    ) -> Dict[str, Any]:
        brief = _clean(args.brief, 4000)
        profile_out = await tool_profile_read(DesignProfileReadArgs(), bot, turn, runtime, effective)
        profile = profile_out["result"]
        refs_store = _reference_store(executor)
        ref_summaries = []
        for ref_id in args.reference_ids[:6]:
            try:
                item = refs_store.get(_clean(ref_id, 60))
                ref_summaries.append({
                    "id": item.get("id"),
                    "title": item.get("title"),
                    "analysis": (item.get("analysis") or {}).get("content") or {},
                })
            except DesignBrainError:
                continue

        requirements = image_requirements(brief)
        shot_count = int(requirements.get("image_count") or args.shot_count or 2)
        if shot_count < 1:
            raise BotWorkspaceError("invalid_plan", "分镜张数必须是正整数", 422)
        requirements["image_count"] = shot_count
        chat_model = runtime.resolve_chat_model(bot, turn)
        image_model_name = str((bot.get("image_model") or {}).get("model") or "")

        user_msg = json.dumps({"任务描述": brief, "审美档案": profile, "参考案例": ref_summaries}, ensure_ascii=False)

        async def request_plan(system: str, msg: str, tokens: int) -> Dict[str, Any]:
            text = await _call_design_llm(executor.host, chat_model, system=system, message=msg, max_tokens=tokens)
            parsed = _parse_json_obj(text)
            if not parsed:
                raise BotWorkspaceError("invalid_plan", "模型未返回有效的结构化方案 JSON", 502)
            return parsed

        typed_brief = {"goal": brief, "task_type": infer_task_type(brief), **requirements}
        plan = await compose_batched_plan(request_plan, typed_brief, user_msg)
        if hasattr(executor.host, "resolve_image_model_capabilities"):
            plan["shots"] = resolve_plan_image_params(executor.host, plan.get("shots") or [], image_model_name)

        shot_lines = [
            f"{idx + 1}. {s.get('purpose') or s.get('kind') or s.get('id')}（{s.get('size') or '默认画幅'}）"
            for idx, s in enumerate(plan.get("shots") or [])
        ]
        summary_text = (
            f"已生成结构化设计方案（共 {len(plan.get('shots') or [])} 张分镜，确认后再执行画布生成）：\n"
            f"方向：{plan.get('direction') or '按需求执行'}\n"
            + "\n".join(shot_lines)
        )
        return {
            "ok": True,
            "result": plan,
            "message_kind": "design_plan",
            "message_meta": {"design_plan": plan},
            "display_text": summary_text,
        }

    async def tool_batch_canvas_plan(
        args: DesignBatchCanvasPlanArgs, bot: Dict[str, Any], turn: Dict[str, Any], runtime: Any, effective: Set[str]
    ) -> Dict[str, Any]:
        # 严格检查画布写权限与范围
        project_id, canvas_id = executor._resolve_canvas_scope("", "", turn)
        canvas_policy = (turn.get("permission_snapshot") or {}).get("canvas_policy") or bot.get("canvas_policy") or {}
        if not canvas_policy.get("allow_canvas_writes", False):
            raise BotWorkspaceError("canvas_write_denied", f"「{bot['name']}」未被授予画布写入权限", 403)

        # 未经用户显式确认时，先创建审批卡挂起等待用户点击「允许」，绝不私自批量生图
        if not args.confirmed:
            idem = args.idempotency_key.strip() or f"batch_{turn['turn_id']}_{sha256_json(args.shots)[:10]}"
            approval = executor.store.create_approval(
                bot_id=bot["bot_id"],
                session_id=turn["session_id"],
                turn_id=turn["turn_id"],
                tool_name="design.batch.canvas_plan",
                args={
                    "plan_title": args.plan_title,
                    "direction": args.direction,
                    "shots": args.shots,
                    "source_node_ids": args.source_node_ids,
                    "source_images": args.source_images,
                    "project_id": project_id,
                    "canvas_id": canvas_id,
                    "idempotency_key": idem,
                },
                summary=f"确认将「{args.plan_title}」（共 {len(args.shots)} 张分镜）落入当前画布受控执行",
                risk_level="high",
            )
            return {
                "ok": True,
                "result": {"approval_id": approval["approval_id"], "shot_count": len(args.shots), "status": "awaiting_approval"},
                "suspend_status": "waiting_approval",
                "suspend_note": f"批量方案（{len(args.shots)} 张分镜）等待用户确认后再落画布",
                "message_kind": "approval",
                "message_meta": {"approval_id": approval["approval_id"], "shot_count": len(args.shots)},
                "display_text": f"批量方案「{args.plan_title}」（{len(args.shots)} 张）已准备就绪，请先确认允许后再写入画布。",
            }

        # 已确认 → 复用 canvas.dispatch_run 提交至 multi_agent 画布执行引擎
        from bot_workspace_tools import CanvasDispatchRunArgs
        shots_desc = "\n".join(
            f"- 分镜 {idx + 1} ({s.get('id') or f'shot_{idx + 1}'}): 尺寸 {s.get('size') or '1024x1024'}；用途 {s.get('purpose') or s.get('kind') or ''}；提示词：{str(s.get('prompt') or '')[:400]}"
            for idx, s in enumerate(args.shots)
        )
        dispatch_args = CanvasDispatchRunArgs(
            goal=f"执行已确认的批量设计方案「{args.plan_title}」（共 {len(args.shots)} 张分镜）",
            instructions=(
                f"设计方向：{args.direction}\n"
                "请严格按以下分镜清单在当前画布创建独立绘画节点、连接商品参考图并按审批规则执行，每张图独立任务且不覆盖原素材：\n"
                + shots_desc
            )[:8000],
            project_id=project_id,
            canvas_id=canvas_id,
            source_node_ids=list(args.source_node_ids),
            source_images=list(args.source_images),
            allow_canvas_writes=True,
            idempotency_key=args.idempotency_key.strip() or f"batch_{turn['turn_id']}_{sha256_json(args.shots)[:10]}",
        )
        return executor._tool_canvas_dispatch_run(dispatch_args, bot, turn, runtime, effective)

    async def on_batch_plan_approval_resolved(approval: Dict[str, Any], *, runtime: Any) -> Any:
        if approval.get("tool_name") != "design.batch.canvas_plan":
            return None
        turn_id = approval.get("turn_id") or ""
        if approval.get("status") != "approved":
            if turn_id:
                executor.store.append_message(
                    approval["session_id"],
                    bot_id=approval["bot_id"],
                    role="system",
                    kind="activity",
                    content="用户已拒绝该批量落画布方案，未执行任何画布写入或生图。",
                    turn_id=turn_id,
                )
                executor.store.update_turn(turn_id, status="completed", result_summary="用户已取消批量落画布方案")
            return {"status": "rejected"}

        raw_args = approval.get("args") or {}
        bot = executor.store.get_bot(approval["bot_id"])
        turn = executor.store.get_turn(turn_id)
        effective, _ = executor.effective_tools_for(bot, turn)
        confirmed_args = DesignBatchCanvasPlanArgs(
            plan_title=str(raw_args.get("plan_title") or "批量电商视觉方案"),
            direction=str(raw_args.get("direction") or ""),
            shots=list(raw_args.get("shots") or []),
            source_node_ids=list(raw_args.get("source_node_ids") or []),
            source_images=list(raw_args.get("source_images") or []),
            confirmed=True,
            idempotency_key=str(raw_args.get("idempotency_key") or ""),
        )
        outcome = await tool_batch_canvas_plan(confirmed_args, bot, turn, runtime, effective)
        next_status = outcome.get("suspend_status") or "waiting_result"
        executor.store.update_turn(turn_id, status=next_status, error=str(outcome.get("suspend_note") or ""))
        if outcome.get("display_text"):
            executor.store.append_message(
                approval["session_id"],
                bot_id=approval["bot_id"],
                role="tool",
                kind="task_card",
                content=str(outcome["display_text"]),
                meta={"tool": "design.batch.canvas_plan", "ok": True, **(outcome.get("message_meta") or {})},
                turn_id=turn_id,
            )
        runtime.notify()
        return outcome.get("result")

    async def tool_review_check(
        args: DesignReviewCheckArgs, bot: Dict[str, Any], turn: Dict[str, Any], runtime: Any, effective: Set[str]
    ) -> Dict[str, Any]:
        resolver = getattr(executor.host, "output_file_from_url", None)
        local_check = inspect_image(args.image, args.expected_size, resolver)

        # 若本机文件不可读或隐私关闭不允许外发云端，绝不胡说通过，必须标 needs_human
        if local_check["status"] == "unknown" or not _cloud_analysis_allowed(_profile_store(executor).read()):
            reason = (
                "个人审美档案已关闭云端视觉分析，仅完成本地像素检查，请人工复核画面细节"
                if local_check["status"] != "unknown"
                else "本机无法读取该图片文件，无法完成视觉核对，需人工复核"
            )
            verdict = "issues" if local_check["status"] == "fail" else "needs_human"
            issues = [
                {"severity": "major", "area": "composition", "description": txt, "evidence": args.image, "suggestion": "请核对原图与画幅比例"}
                for txt in local_check.get("issues") or []
            ]
            return {
                "ok": True,
                "result": {"verdict": verdict, "local_check": local_check, "issues": issues, "note": reason},
                "display_text": f"视觉质检结论：{verdict}（{reason}）",
            }

        # 本地可读且允许视觉分析：复用 REVIEWER_SYSTEM 进行视觉模型质检
        file_path = resolver(args.image) if callable(resolver) else None
        images_to_send = []
        if file_path and Path(file_path).is_file():
            img_data = _file_to_data_url(Path(file_path))
            if img_data:
                images_to_send.append(img_data)
        for prod_url in args.product_images[:3]:
            pfile = resolver(prod_url) if callable(resolver) else None
            if pfile and Path(pfile).is_file():
                pdata = _file_to_data_url(Path(pfile))
                if pdata:
                    images_to_send.append(pdata)
        if not images_to_send:
            return {
                "ok": True,
                "result": {"verdict": "needs_human", "local_check": local_check, "issues": [], "note": "图片过大或无法编码，需人工复核"},
                "display_text": "视觉质检结论：needs_human（图片无法提交视觉模型，请人工复核）",
            }

        model = _resolve_bot_vision_model(bot, turn, runtime)
        contract = json.dumps({
            "待检图片": args.image,
            "本地像素与比例检查": local_check,
            "验收标准": args.acceptance,
            "生成提示词": args.prompt,
        }, ensure_ascii=False)
        raw = await _call_design_llm(
            executor.host, model, system=REVIEWER_SYSTEM, message=contract, images=images_to_send, max_tokens=1000
        )
        parsed = _parse_json_obj(raw)
        if not parsed or parsed.get("verdict") not in ("pass", "issues", "needs_human"):
            return {
                "ok": True,
                "result": {"verdict": "needs_human", "local_check": local_check, "issues": [], "raw": raw[:500]},
                "display_text": "视觉质检结论：needs_human（模型未返回标准质检 JSON，请人工复核）",
            }

        verdict = parsed["verdict"]
        issues = list(parsed.get("issues") or [])
        if local_check["status"] == "fail":
            verdict = "issues"
            for txt in local_check.get("issues") or []:
                issues.append({"severity": "major", "area": "composition", "description": txt, "evidence": args.image, "suggestion": "调整输出尺寸与画幅比例"})
        return {
            "ok": True,
            "result": {"verdict": verdict, "local_check": local_check, "issues": issues},
            "display_text": f"视觉质检结论：{verdict}（发现 {len(issues)} 项问题）",
        }

    executor.register_tool(ToolSpec(
        name="design.profile.read",
        description="读取个人审美档案（风格/色彩/构图/光线/品牌词/禁用词与隐私开关）",
        args_model=DesignProfileReadArgs,
        handler=tool_profile_read,
        usage_hint="{}",
    ))
    executor.register_tool(ToolSpec(
        name="design.references.search",
        description="检索个人参考素材库（关键词/品类/用途/标签），返回分析结果与缩略图地址",
        args_model=DesignReferencesSearchArgs,
        handler=tool_references_search,
        usage_hint='{"query":"奶油风","limit":6}',
    ))
    executor.register_tool(ToolSpec(
        name="design.references.analyze",
        description="用当前 Bot 的视觉模型分析一张参考图的构图/材质/光线/借鉴点并写回参考库（遵守隐私开关）",
        args_model=DesignReferencesAnalyzeArgs,
        handler=tool_references_analyze,
        usage_hint='{"item_id":"ref_xxx"}',
    ))
    executor.register_tool(ToolSpec(
        name="design.plan.compose",
        description="结合审美档案与参考库生成结构化分镜设计方案（只做规划与提示词，不直接生图）",
        args_model=DesignPlanComposeArgs,
        handler=tool_plan_compose,
        usage_hint='{"brief":"为玻璃冷泡茶壶规划4张电商主图","shot_count":4}',
    ))
    executor.register_tool(ToolSpec(
        name="design.batch.canvas_plan",
        description="将批量分镜方案转为当前画布受控多代理执行任务（未确认前先发起审批，绝不私自批量生图）",
        args_model=DesignBatchCanvasPlanArgs,
        handler=tool_batch_canvas_plan,
        usage_hint='{"plan_title":"冷泡茶壶主图4张","direction":"清透冰萃风","shots":[{"id":"shot_1","purpose":"首图","size":"1024x1024","prompt":"..."}]}',
    ))
    executor.register_tool(ToolSpec(
        name="design.review.check",
        description="结合本地像素/画幅检查与视觉模型审查生成图质量，输出问题、证据与修正建议（无法可靠判断时标 needs_human）",
        args_model=DesignReviewCheckArgs,
        handler=tool_review_check,
        usage_hint='{"image":"/assets/out.png","expected_size":"1024x1024","acceptance":["商品主体完整","无错别字"]}',
    ))
    executor.register_approval_handler("design.batch.canvas_plan", on_batch_plan_approval_resolved)
