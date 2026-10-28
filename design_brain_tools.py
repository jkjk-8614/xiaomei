"""设计大脑 · Bot 团队工具集（P3）。

每个工具都是「服务端校验 + 复用现有能力」，不新造执行链：

- ``brain.profile.read``        读审美档案摘要
- ``brain.references.search``   检索个人参考库
- ``brain.references.analyze``  分析一张参考图（六字段，写回参考库）
- ``brain.plan.compose``        产出结构化方案（复用 PLANNER_SYSTEM）
- ``brain.generate.submit``     提交生图任务（复用画布任务，幂等）
- ``brain.generate.status``     查任务与产物
- ``brain.review.check``        视觉质检（复用 REVIEWER_SYSTEM）
- ``brain.team.*``              建/改 Bot 与群（仅主 Bot）
- ``brain.task.confirm/cancel`` 确认或取消已有设计任务

``brain.workflow.run`` 与 ``brain.memory.*`` 由回合引擎直接处理（它们依赖
回合状态），这里只登记其余工具。工具结果一律作为「不可信资料」回灌给模型，
不作为指令执行。
"""
from __future__ import annotations

import asyncio
from design_brain_skills import select_skill
import base64
import json
import mimetypes
import re
import uuid
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from design_brain_bots import REVIEWER_SYSTEM, compose_batched_plan, resolve_plan_image_params, BotConfirmRequest
from design_brain_store import (image_requirements, apply_plan_requirements,
                                apply_sku_plan, apply_ecommerce_plan, guard_append_edits)
from design_brain_visual_rules import infer_task_type, sku_series_mode
from design_brain_store import DesignBrainError, now_ms

GENERATE_QUICK_WAIT_SECONDS = 8
GENERATE_WATCH_SECONDS = 600
GENERATE_POLL_INTERVAL = 2.0
ANALYZE_IMAGE_MAX_BYTES = 3 * 1024 * 1024
SIZE_RE = re.compile(r"^\d{3,4}x\d{3,4}$")

TOOL_SPECS: Dict[str, Dict[str, Any]] = {
    "brain.profile.read": {
        "pack": "pack.read", "args": {},
        "desc": "读个人审美档案摘要（风格/色彩/构图/光线/氛围标签、品牌词、禁用词、默认尺寸）",
    },
    "brain.references.search": {
        "pack": "pack.read",
        "args": {"query": "关键词", "category": "品类", "purpose": "用途", "limit": "1-12"},
        "desc": "检索个人参考素材库，返回标题、分类、分析文本与图片地址",
    },
    "brain.references.analyze": {
        "pack": "pack.plan", "args": {"item_id": "ref_ 开头的参考编号"},
        "desc": "分析一张参考图的风格/色彩/构图/光线/氛围/备注，并写回参考库",
    },
    "brain.plan.compose": {
        "pack": "pack.plan",
        "args": {"brief": "任务描述", "reference_ids": ["参考编号"], "shot_count": "总张数，正整数；系统自动分批规划"},
        "desc": "产出设计方案：方向、锁定约束、每张图的提示词/尺寸/验收标准",
    },
    "brain.generate.submit": {
        "pack": "pack.execute",
        "args": {"prompt": "完整提示词", "size": "1024x1024", "resolution": "1k|2k|4k", "count": "1-2",
                 "reference_images": ["图片地址"]},
        "desc": "提交生图任务；不传 reference_images 时默认带上本轮用户附的商品图",
    },
    "brain.generate.status": {
        "pack": "pack.execute", "args": {"task_id": "生图任务编号"},
        "desc": "查询生图任务状态与产物地址",
    },
    "brain.review.check": {
        "pack": "pack.review",
        "args": {"image": "图片地址", "acceptance": ["验收点"], "prompt": "这张图的提示词"},
        "desc": "按验收标准检查一张生成图，输出问题、证据与修正建议",
    },
    "brain.team.create_bot": {
        "pack": "pack.team",
        "args": {"name": "名字", "role": "角色", "personality": "性格与说话方式", "task": "任务与交付要求", "instructions": "工作说明",
                 "avatar": {"shape": "star|bunny|moon|gumdrop|kitty|acorn|peanut", "color": "#RRGGBB"},
                 "capabilities": ["pack.read"], "model": {"provider": "", "model": ""}},
        "desc": "新建一个 Bot（仅主 Bot）",
    },
    "brain.team.update_bot": {
        "pack": "pack.team",
        "args": {"bot_id": "bot_ 开头", "name": "", "role": "", "personality": "", "task": "", "instructions": "",
                 "avatar": {"shape": "star|bunny|moon|gumdrop|kitty|acorn|peanut", "color": "#RRGGBB"},
                 "capabilities": [], "status": "active|archived"},
        "desc": "修改 Bot 的名字、角色、人格、任务、说明、能力或归档（仅主 Bot）",
    },
    "brain.team.create_group": {
        "pack": "pack.team",
        "args": {"name": "群名", "members": ["bot_id"], "notice": "群公告",
                 "admin_bot_id": "bot_id", "relay_limit": "2-40"},
        "desc": "新建项目群（仅主 Bot）",
    },
    "brain.team.update_group": {
        "pack": "pack.team",
        "args": {"group_id": "grp_ 开头", "name": "", "notice": "", "members": [],
                 "admin_bot_id": "", "reply_mode": "admin_first|round_robin"},
        "desc": "修改群名、公告、成员、管理员或回答方式（仅主 Bot）",
    },
    "brain.task.confirm": {
        "pack": "pack.workflow",
        "args": {"task_id": "job_ 开头", "approved": True,
                 "expected_revision": "当前方案design.revision", "confirmation": "direction|generate|batch",
                 "direction_id": "选定方向ID（确认方向时必填）", "feedback": "用户的组合意见",
                 "shot_edits": [{"id": "shot_1", "prompt": "改后的提示词", "size": "1024x1536"}]},
        "desc": "确认（或拒绝）等待中的设计方案；可在确认前改某张图的提示词与尺寸",
    },
    "brain.task.cancel": {
        "pack": "pack.workflow", "args": {"task_id": "job_ 开头", "reason": "原因"},
        "desc": "取消一个设计任务，已提交的生图任务会一并取消",
    },
    "brain.task.append": {
        "pack": "pack.workflow", "args": {"task_id": "任务编号", "count": "追加屏数，至少1", "feedback": "追加内容"},
        "desc": "为已交付的详情页继续加屏，保留原图与视觉框架，新增方案待用户确认；屏数没有总上限",
    },
}


def _tool_line(name: str) -> str:
    spec = TOOL_SPECS[name]
    args = spec.get("args") or {}
    if args:
        sample = json.dumps({key: (value[0] if isinstance(value, list) and value else value)
                             for key, value in list(args.items())[:4]}, ensure_ascii=False)
    else:
        sample = "{}"
    return f"- {name} {sample}：{spec['desc']}"


def _clean(value: Any, limit: int) -> str:
    return str(value or "").strip()[:limit]


def _data_url(path: Path) -> str:
    if not path.is_file():
        return ""
    if path.stat().st_size > ANALYZE_IMAGE_MAX_BYTES:
        return ""
    mime = mimetypes.guess_type(str(path))[0] or "image/jpeg"
    return f"data:{mime};base64," + base64.b64encode(path.read_bytes()).decode("ascii")


def _usage_tokens(response: Any) -> int:
    raw = (response or {}).get("raw_usage") if isinstance(response, dict) else None
    if not isinstance(raw, dict):
        return 0
    for key in ("total_tokens", "total_token_count", "tokens"):
        try:
            value = int(raw.get(key) or 0)
        except (TypeError, ValueError):
            value = 0
        if value:
            return value
    try:
        return int(raw.get("prompt_tokens") or 0) + int(raw.get("completion_tokens") or 0)
    except (TypeError, ValueError):
        return 0


def _parse_json(text: str) -> Optional[Dict[str, Any]]:
    raw = str(text or "").strip()
    if raw.startswith("```"):
        start, end = raw.find("\n"), raw.rfind("```")
        if start >= 0 and end > start:
            raw = raw[start + 1:end].strip()
    try:
        parsed = json.loads(raw)
        return parsed if isinstance(parsed, dict) else None
    except ValueError:
        pass
    start, end = raw.find("{"), raw.rfind("}")
    if start >= 0 and end > start:
        try:
            parsed = json.loads(raw[start:end + 1])
            return parsed if isinstance(parsed, dict) else None
        except ValueError:
            return None
    return None


class DesignToolbox:
    def __init__(self, host, team, orchestrator, profile_store, references, memory=None, usage=None):
        self.host = host
        self.team = team
        self.orchestrator = orchestrator
        self.profile_store = profile_store
        self.references = references
        self.memory = memory
        self.usage = usage
        self.watchers: set = set()
        self.image_jobs: Dict[str, Dict[str, Any]] = {}

    def image_work(self) -> List[Dict[str, Any]]:
        return [{key: value for key, value in item.items() if key != "watcher"}
                for item in self.image_jobs.values()]

    async def stop_image(self, task_id: str, chat_id: str, bot_id: str, *, notify: bool = True) -> None:
        entry = self.image_jobs.get(task_id)
        if not entry or entry["chat_id"] != chat_id or entry["bot_id"] != bot_id:
            raise DesignBrainError("work_changed", "这项生图工作已结束，请刷新后重试", 409)
        try:
            await asyncio.wait_for(self.host.cancel_canvas_image_task(task_id), timeout=20)
        except Exception as exc:
            raise DesignBrainError("stop_failed", "停止生图失败，请检查任务状态后重试", 502) from exc
        watcher = entry.get("watcher")
        if watcher and watcher is not asyncio.current_task():
            watcher.cancel()
            await asyncio.gather(watcher, return_exceptions=True)
        self.image_jobs.pop(task_id, None)
        if notify:
            self.team.append_message(chat_id, role="system", kind="activity",
                                     text="已停止该成员的生图任务。", task_id=task_id)

    async def close(self) -> None:
        for task in list(self.watchers):
            if not task.done():
                task.cancel()

    # -- 可用性 ----------------------------------------------------------

    def available(self, bot: Dict[str, Any]) -> List[str]:
        capabilities = set(bot.get("capabilities") or [])
        return [name for name, spec in TOOL_SPECS.items() if spec["pack"] in capabilities]

    def describe(self, bot: Dict[str, Any]) -> str:
        names = self.available(bot)
        if not names:
            return ""
        return "可用工具（每次只能调用一个，结果会回到你手里）：\n" + "\n".join(_tool_line(name) for name in names)

    # -- 分发 ------------------------------------------------------------

    async def invoke(self, name: str, args: Dict[str, Any], *, bot: Dict[str, Any],
                     chat: Dict[str, Any], group: Optional[Dict[str, Any]]) -> Tuple[Dict[str, Any], bool]:
        spec = TOOL_SPECS.get(name)
        if not spec:
            return {"error": f"工具 {name} 未登记"}, False
        if spec["pack"] not in (bot.get("capabilities") or []):
            return {"error": "当前 Bot 没有该工具权限"}, False
        handler = getattr(self, "_" + name.replace(".", "_"), None)
        if not handler:
            return {"error": f"工具 {name} 未实现"}, False
        try:
            result = await handler(args or {}, bot=bot, chat=chat, group=group)
            return result, True
        except DesignBrainError as exc:
            return {"error": exc.message}, False
        except Exception as exc:  # 工具失败不拖垮回合
            return {"error": str(exc)[:300]}, False

    # -- 模型 ------------------------------------------------------------

    def _models(self, chat: Dict[str, Any], bot: Dict[str, Any]) -> Dict[str, Dict[str, str]]:
        defaults = chat.get("defaults") or {}

        def pick(*candidates: Any) -> Dict[str, str]:
            for candidate in candidates:
                if isinstance(candidate, dict) and candidate.get("provider") and candidate.get("model"):
                    return {"provider": str(candidate["provider"]), "model": str(candidate["model"])}
            return {"provider": "", "model": ""}

        return {
            "chat": pick(bot.get("model"), defaults.get("chat")),
            "vision": pick(bot.get("vision_model"), defaults.get("vision"), bot.get("model"), defaults.get("chat")),
            "image": pick(bot.get("image_model"), defaults.get("image")),
        }

    def _check_budget(self, chat_id: str) -> None:
        if not self.usage:
            return
        limit = int(self.team.settings().get("daily_llm_limit") or 0)
        if limit <= 0:
            return
        used = int(self.usage.chat_today(chat_id).get("llm") or 0)
        if used >= limit:
            raise DesignBrainError(
                "budget_exceeded",
                f"今日该会话模型调用已达上限（{limit} 次）。可以改用标准流水线，或明天再继续。",
                429,
            )

    async def _llm(self, chat: Dict[str, Any], bot: Dict[str, Any], model: Dict[str, str],
                   system: str, message: str,
                   images: Optional[List[str]] = None, max_tokens: int = 1600) -> str:
        if not model.get("provider") or not model.get("model"):
            raise DesignBrainError("no_model", "还没有选择对话模型", 422)
        self._check_budget(chat["id"])
        skill = chat.get("_skill")
        if skill is None:
            messages = self.team.list_messages(chat["id"], after=0, limit=200)["messages"]
            last_user = next((item for item in reversed(messages) if item["role"] == "user"), {})
            skill = select_skill(self.host, last_user.get("text") or message,
                                 str((last_user.get("meta") or {}).get("skill_id") or ""))
        payload = self.host.CanvasLLMRequest(
            message=message[:8000] or "继续",
            system_prompt=system,
            provider=model["provider"],
            model=model["model"],
            images=list(images or []),
            allow_model_fallback=True,
            max_output_tokens=max_tokens,
            skill_id=(skill or {}).get("skill_id", ""),
        )
        response = await asyncio.wait_for(self.host.canvas_llm(payload), timeout=240)
        if self.usage:
            self.usage.record(chat["id"], bot.get("id", ""), llm=1, tokens=_usage_tokens(response))
        return str((response or {}).get("text") or "")

    # -- 资料读取 --------------------------------------------------------

    async def _brain_profile_read(self, args: Dict[str, Any], **_: Any) -> Dict[str, Any]:
        state = self.profile_store.read()
        profile = state["profile"]
        aesthetics = {}
        for group_name, entries in (profile.get("aesthetics") or {}).items():
            aesthetics[group_name] = [
                {"tag": entry.get("tag"), "weight": entry.get("weight")}
                for entry in (entries or [])[:8]
            ]
        return {
            "revision": state["revision"],
            "aesthetics": aesthetics,
            "brand_words": (profile.get("tone") or {}).get("brand_words") or [],
            "banned_words": (profile.get("tone") or {}).get("banned_words") or [],
            "task_defaults": profile.get("task_defaults") or {},
        }

    async def _brain_references_search(self, args: Dict[str, Any], **_: Any) -> Dict[str, Any]:
        filters = {
            "q": _clean(args.get("query"), 80),
            "category": _clean(args.get("category"), 40),
            "purpose": _clean(args.get("purpose"), 40),
            "expression": _clean(args.get("expression"), 40),
            "tag": _clean(args.get("tag"), 40),
        }
        limit = max(1, min(12, int(args.get("limit") or 6)))
        page = self.references.list({key: value for key, value in filters.items() if value}, limit=limit)
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
        return {"total": page.get("total", len(items)), "items": items}

    async def _brain_references_analyze(self, args: Dict[str, Any], *,
                                        chat: Dict[str, Any], bot: Dict[str, Any], **_: Any) -> Dict[str, Any]:
        item_id = _clean(args.get("item_id"), 60)
        item = self.references.get(item_id)
        analysis = item.get("analysis") or {}
        if analysis.get("status") == "ready" and analysis.get("content"):
            return {"id": item_id, "cached": True, "analysis": analysis.get("content")}
        media = (item.get("file") or {}).get("thumb") or (item.get("file") or {}).get("media")
        if not media:
            raise DesignBrainError("invalid_reference", "这张参考图缺少文件", 422)
        image = _data_url(self.references.root / media)
        if not image:
            raise DesignBrainError("invalid_reference", "参考图无法读取或文件过大", 422)
        system = ("你是电商视觉参考分析助手。只输出一个 JSON 对象："
                  '{"purpose":"这张图适合的用途","composition":"构图","material":"材质表现",'
                  '"lighting":"光线","takeaways":"可借鉴点","restrictions":"使用限制或要避免的点"}；'
                  "每项不超过 60 字，只描述画面里看得到的，不要编造。")
        models = self._models(chat, bot)
        text = await self._llm(chat, bot, models["vision"], system, "分析这张参考图。",
                               images=[image], max_tokens=700)
        data = _parse_json(text) or {}
        content = {key: _clean(data.get(key), 200)
                   for key in ("purpose", "composition", "material", "lighting", "takeaways", "restrictions")}
        if not any(content.values()):
            raise DesignBrainError("analysis_failed", "模型没有返回可用的分析内容", 502)
        self.references.set_analysis(item_id, "ready", content=content,
                                     provider=models["vision"]["provider"],
                                     model=models["vision"]["model"])
        return {"id": item_id, "cached": False, "analysis": content}

    # -- 方案 ------------------------------------------------------------

    async def _brain_plan_compose(self, args: Dict[str, Any], *,
                                  chat: Dict[str, Any], bot: Dict[str, Any], **_: Any) -> Dict[str, Any]:
        brief = _clean(args.get("brief"), 4000)
        if not brief:
            raise DesignBrainError("invalid_plan", "缺少任务描述 brief", 422)
        profile = await self._brain_profile_read({}, bot=bot)
        references = []
        for item_id in (args.get("reference_ids") or [])[:4]:
            try:
                item = self.references.get(_clean(item_id, 60))
            except DesignBrainError:
                continue
            references.append({
                "id": item.get("id"),
                "title": item.get("title"),
                "analysis": (item.get("analysis") or {}).get("content") or {},
            })
        requirements = image_requirements(brief)
        shot_count = requirements.get("image_count") or int(args.get("shot_count") or 2)
        if shot_count < 1:
            raise DesignBrainError("invalid_plan", "图片总张数必须是正整数", 422)
        requirements["image_count"] = shot_count
        models = self._models(chat, bot)
        message = json.dumps({"任务描述": brief, "审美档案": profile, "参考案例": references}, ensure_ascii=False)
        async def request_plan(system, message, tokens):
            text = await self._llm(chat, bot, models["chat"], system, message, max_tokens=tokens)
            data = _parse_json(text)
            if not data:
                raise DesignBrainError("invalid_plan", "模型没有返回有效的方案 JSON", 502)
            return data
        typed_brief = {"goal": brief, "task_type": infer_task_type(brief), **requirements}
        plan = await compose_batched_plan(request_plan, typed_brief, message)
        plan["shots"] = resolve_plan_image_params(self.host, plan["shots"], models["image"]["model"])
        return plan

    # -- 生图 ------------------------------------------------------------

    async def _brain_generate_submit(self, args: Dict[str, Any], *,
                                     chat: Dict[str, Any], bot: Dict[str, Any], **_: Any) -> Dict[str, Any]:
        prompt = _clean(args.get("prompt"), 4000)
        if not prompt:
            raise DesignBrainError("invalid_generate", "缺少提示词 prompt", 422)
        last_user = next((item for item in reversed(
            self.team.list_messages(chat["id"], after=0, limit=40)["messages"])
            if item["role"] == "user"), None)
        if sku_series_mode({"goal": prompt, "source_text": (last_user or {}).get("text") or ""}):
            raise DesignBrainError("invalid_generate", "SKU 展示请用 brain.workflow.run 提交整组任务，共用固定场景与基准图；不要逐张独立生图", 422)
        if infer_task_type((last_user or {}).get("text") or prompt) in ("main_image", "detail_images"):
            raise DesignBrainError("invalid_generate", "主图与详情页请交给设计总监用 brain.workflow.run 按整组规范规划；已有图的修改使用任务工作台", 422)
        size = _clean(args.get("size"), 20) or "1024x1024"
        if not SIZE_RE.match(size):
            raise DesignBrainError("invalid_generate", "尺寸格式应为 1024x1024", 422)
        models = self._models(chat, bot)
        if not models["image"]["provider"]:
            raise DesignBrainError("no_image_model", "请先在会话底部选择生图模型", 422)
        references = [value for value in (args.get("reference_images") or [])
                      if isinstance(value, str) and value.strip()]
        if not references:
            references = list(((last_user or {}).get("meta") or {}).get("product_images") or [])
        skill = chat.get("_skill") or select_skill(
            self.host, (last_user or {}).get("text") or prompt,
            str(((last_user or {}).get("meta") or {}).get("skill_id") or ""))
        payload = self.host.OnlineImageRequest(
            prompt=prompt,
            provider_id=models["image"]["provider"],
            model=models["image"]["model"],
            size=size,
            resolution=str(args.get("resolution") or "").lower(),
            aspect_ratio=str(args.get("aspect_ratio") or ""),
            n=max(1, min(2, int(args.get("count") or 1))),
            client_request_id=f"dtool_{chat['id']}_{uuid.uuid4().hex[:10]}",
            history_source="design_brain",
            skill_id=skill.get("skill_id", ""),
            skill_name=skill.get("name", ""),
            skill_applied=bool(skill.get("skill_id")),
            reference_images=[self.host.AIReference(url=url, role=f"image_{index + 1}", kind="image")
                              for index, url in enumerate(references)],
        )
        response = await self.host.create_canvas_image_task(payload)
        task_id = str((response or {}).get("task_id") or "")
        if not task_id:
            raise DesignBrainError("generate_failed", "生图服务未返回任务编号", 502)
        self.image_jobs[task_id] = {"task_id": task_id, "chat_id": chat["id"],
                                    "bot_id": bot["id"], "started_at": now_ms()}
        try:
            result = await self._wait_for_image(task_id, GENERATE_QUICK_WAIT_SECONDS)
        except asyncio.CancelledError:
            if task_id in self.image_jobs:
                try:
                    await self.stop_image(task_id, chat["id"], bot["id"], notify=False)
                except DesignBrainError:
                    self._watch_image_task(task_id, chat, bot)
                    self.team.append_message(
                        chat["id"], role="system", kind="activity",
                        text="成员已停止，但已提交的生图任务未能停止，可在团队动态中重试。")
            raise
        if result.get("status") == "running":
            # 长任务不占发言位：先回执，后台盯到终态再补一张结果卡。
            self._watch_image_task(task_id, chat, bot)
        else:
            self.image_jobs.pop(task_id, None)
        return result

    async def _brain_generate_status(self, args: Dict[str, Any], **_: Any) -> Dict[str, Any]:
        task_id = _clean(args.get("task_id"), 60)
        if not task_id:
            raise DesignBrainError("invalid_generate", "缺少 task_id", 422)
        try:
            task = await self.host.get_canvas_image_task(task_id)
        except Exception as exc:
            raise DesignBrainError("task_not_found", f"查询生图任务失败：{exc}", 404) from exc
        return self._trim_image_task(task, task_id)

    async def _wait_for_image(self, task_id: str, seconds: int) -> Dict[str, Any]:
        deadline = now_ms() + max(1, seconds) * 1000
        while now_ms() < deadline:
            await asyncio.sleep(GENERATE_POLL_INTERVAL)
            try:
                task = await self.host.get_canvas_image_task(task_id)
            except Exception:
                continue
            status = str(task.get("status") or "")
            if status in {"succeeded", "completed", "success", "done", "failed", "error", "cancelled"}:
                return self._trim_image_task(task, task_id)
        return {"task_id": task_id, "status": "running",
                "note": f"超过 {seconds} 秒仍在生成，后台会继续跟进；也可以用 brain.generate.status 再查"}

    def _watch_image_task(self, task_id: str, chat: Dict[str, Any], bot: Dict[str, Any]) -> None:
        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            return
        task = loop.create_task(self._watch_image(task_id, chat, bot))
        self.watchers.add(task)
        entry = self.image_jobs.setdefault(task_id, {"task_id": task_id, "chat_id": chat["id"],
                                                     "bot_id": bot["id"], "started_at": now_ms()})
        entry["watcher"] = task
        task.add_done_callback(self.watchers.discard)
        task.add_done_callback(lambda finished: self.image_jobs.pop(task_id, None)
                               if self.image_jobs.get(task_id, {}).get("watcher") is finished else None)

    async def _watch_image(self, task_id: str, chat: Dict[str, Any], bot: Dict[str, Any]) -> None:
        deadline = now_ms() + GENERATE_WATCH_SECONDS * 1000
        while now_ms() < deadline:
            await asyncio.sleep(GENERATE_POLL_INTERVAL)
            try:
                remote = await self.host.get_canvas_image_task(task_id)
            except Exception:
                continue
            status = str(remote.get("status") or "")
            if status not in {"succeeded", "completed", "success", "done",
                              "failed", "error", "cancelled"}:
                continue
            result = self._trim_image_task(remote, task_id)
            outputs = result.get("outputs") or []
            text = ("生图任务已停止" if status == "cancelled" else
                    f"生成完成，共 {len(outputs)} 张" if outputs else
                    f"生成失败：{result.get('error') or '未知原因'}")
            try:
                self.team.append_message(
                    chat["id"], role="bot", bot_id=bot["id"], kind="result", status="done",
                    text=text, task_id=task_id,
                    meta={"tool": "brain.generate.submit", "task_id": task_id, "images": outputs},
                )
            except DesignBrainError:
                pass
            return
        try:
            self.team.append_message(
                chat["id"], role="system", kind="activity", status="sent",
                text=f"生图任务 {task_id} 超过 10 分钟仍未完成，已停止跟进，可稍后用 brain.generate.status 查询。",
            )
        except DesignBrainError:
            pass

    def _trim_image_task(self, task: Dict[str, Any], task_id: str) -> Dict[str, Any]:
        result = task.get("result") if isinstance(task.get("result"), dict) else {}
        outputs = [item.get("url") for item in (result.get("image_items") or [])
                   if isinstance(item, dict) and item.get("url")]
        return {
            "task_id": task_id,
            "status": str(task.get("status") or ""),
            "outputs": outputs,
            "error": _clean(task.get("error") or task.get("message"), 300),
        }

    # -- 质检 ------------------------------------------------------------

    async def _brain_review_check(self, args: Dict[str, Any], *,
                                  chat: Dict[str, Any], bot: Dict[str, Any], **_: Any) -> Dict[str, Any]:
        image = _clean(args.get("image"), 2000)
        if not image:
            raise DesignBrainError("invalid_review", "缺少图片地址 image", 422)
        acceptance = [str(value)[:120] for value in (args.get("acceptance") or [])[:6]]
        prompt = _clean(args.get("prompt"), 3000)
        message = json.dumps({
            "这张图的用途/提示词": prompt,
            "验收点": acceptance or ["商品结构完整", "材质真实", "构图与视觉层次达标"],
        }, ensure_ascii=False)
        models = self._models(chat, bot)
        text = await self._llm(chat, bot, models["vision"], REVIEWER_SYSTEM, message,
                               images=[image], max_tokens=1200)
        data = _parse_json(text)
        if not data:
            return {"verdict": "needs_human", "issues": [],
                    "note": "模型未返回可解析的检查结果，请人工确认"}
        return data

    # -- 团队 ------------------------------------------------------------

    def _require_main(self, bot: Dict[str, Any]) -> None:
        if not bot.get("is_main"):
            raise DesignBrainError("forbidden", "只有主 Bot 能管理团队", 403)

    async def _brain_team_create_bot(self, args: Dict[str, Any], *, bot: Dict[str, Any], **_: Any) -> Dict[str, Any]:
        self._require_main(bot)
        return self.team.create_bot(args)

    async def _brain_team_update_bot(self, args: Dict[str, Any], *, bot: Dict[str, Any], **_: Any) -> Dict[str, Any]:
        self._require_main(bot)
        bot_id = _clean(args.pop("bot_id", ""), 60)
        if not bot_id:
            raise DesignBrainError("invalid_bot", "缺少 bot_id", 422)
        return self.team.update_bot(bot_id, args)

    async def _brain_team_create_group(self, args: Dict[str, Any], *, bot: Dict[str, Any], **_: Any) -> Dict[str, Any]:
        self._require_main(bot)
        result = self.team.create_group(args)
        return {"group": result["group"], "chat_id": result["chat"]["id"]}

    async def _brain_team_update_group(self, args: Dict[str, Any], *, bot: Dict[str, Any], **_: Any) -> Dict[str, Any]:
        self._require_main(bot)
        group_id = _clean(args.pop("group_id", ""), 60)
        if not group_id:
            raise DesignBrainError("invalid_group", "缺少 group_id", 422)
        result = self.team.update_group(group_id, args)
        return {"group": result["group"], "chat_id": result["chat"]["id"]}

    # -- 任务 ------------------------------------------------------------

    async def _brain_task_confirm(self, args: Dict[str, Any], **_: Any) -> Dict[str, Any]:
        if not self.orchestrator:
            raise DesignBrainError("workflow_unavailable", "标准流水线未启用", 503)
        task_id = _clean(args.get("task_id"), 60)
        task = await self.orchestrator.confirm_task(task_id, BotConfirmRequest(**args))
        return {"task_id": task_id, "status": task["status"], "design": task.get("design")}

    async def _brain_task_cancel(self, args: Dict[str, Any], **_: Any) -> Dict[str, Any]:
        if not self.orchestrator:
            raise DesignBrainError("workflow_unavailable", "标准流水线未启用", 503)
        task_id = _clean(args.get("task_id"), 60)
        task = await self.orchestrator.cancel(task_id, _clean(args.get("reason"), 200) or "主 Bot 取消任务")
        return {"task_id": task_id, "status": task.get("status")}

    async def _brain_task_append(self, args: Dict[str, Any], **_: Any) -> Dict[str, Any]:
        if not self.orchestrator:
            raise DesignBrainError("workflow_unavailable", "标准流水线未启用", 503)
        try:
            raw_count = args.get("count")
            if isinstance(raw_count, bool) or not re.fullmatch(r"[1-9][0-9]*", str(raw_count or "")):
                raise ValueError()
            count = int(raw_count)
        except (TypeError, ValueError):
            raise DesignBrainError("invalid_plan", "追加屏数必须为正整数", 422) from None
        task = self.orchestrator.append_detail_screens(_clean(args.get("task_id"), 60), count, _clean(args.get("feedback"), 2000))
        return {"task_id": task["id"], "status": task["status"], "image_count": task["brief"]["image_count"]}
