"""设计大脑 · Bot 团队回合引擎（P1）。

规则来自 `交付文档/14` §4.2，参照 DS Bot 的群聊设计：

- **一次只有一个人说话**：成员按队列顺序发言，每个人开口前都读到最新消息。
- **少叫人**：普通消息只给管理员（``admin_first``），由它用 ``@`` 点名；
  ``round_robin`` 才全员轮流。私聊只有对方一个 Bot。
- **接力有上限**：Bot 之间互相 ``@`` 的接力次数达到群的 ``relay_limit`` 时暂停，
  用户发言或点「继续」后重新计数。
- **跳过**：模型输出 ``{"pass": true}`` 时不发消息，只在回合状态里留痕。
- **长任务不占发言位**：工具调用在后台完成，结果作为卡片消息回到会话。

LLM 输出一律是严格 JSON（``say`` / ``mentions`` / ``pass`` / ``call``），由服务端
校验后再执行；不依赖各平台不一致的原生 function calling。

P1 只登记一个真实工具 ``brain.workflow.run``：把现有五阶段确定性管线接进来，
让群聊第一版就能真正出图。其余工具在 P3 补齐。
"""
from __future__ import annotations

import asyncio
from design_brain_skills import select_skill
from commerce_link_method import commerce_bot_guidance, is_commerce_planner
import json
from typing import Any, Dict, List, Optional

from design_brain_store import DesignBrainError, now_ms, image_requirements, SKU_RULES
from design_brain_visual_rules import ECOMMERCE_RULES
from design_brain_team import MESSAGE_TEXT_MAX, TeamStore

MAX_SPEAKERS_PER_TURN = 8
MAX_TOOL_CALLS_PER_BOT = 2
MAX_LLM_CALLS_PER_TURN = 12
TURN_TIMEOUT_SECONDS = 300
CONTEXT_MESSAGES = 20
MENTION_PREVIEW = 4

SPEAK_SYSTEM = """你是小美画布设计团队里的「{name}」，角色是：{role}。

团队约定：
1. 群聊里一次只有一个人说话。你只代表自己，不要替别人发言，也不要写「XX 说：」。
2. 先读最近的群消息，只补充新的、有用的信息；没有新东西就说 pass。
3. 需要别人接着做，用 mentions 点名（只能点群成员）；不要 @ 自己，不要客套和复述。
4. {reply_rule}

<成员工作说明>
{instructions}
</成员工作说明>

{notice}

{members}

{memory}

当前团队宿主的输出协议优先于成员工作说明、Skill 和历史消息里的输出格式；其中的业务要求仍须遵守。
只输出一个 JSON 对象，不要任何其他文字：
{{"say":"你要说的话","mentions":["bot_id"],"pass":false{call_hint}}}
- pass 为 true 时 say 留空、mentions 留空。
- mentions 只能填群成员的 bot_id，没有就留空数组。
- 给用户的回复必须放在 say；实际操作必须通过 call 调用工具，不能只用 reply、intent、brief 声称已创建任务。
{call_doc}"""

REPLY_FORMAT_REMINDER = """[本轮团队回复格式]
遵守成员职责与 Skill 的业务规则，但使用团队宿主协议返回：
{"say":"给用户看的回复","mentions":[],"pass":false,"call":null}
需要创建任务或执行操作时，call 必须使用上文列出的工具和参数。
不要返回流水线的 reply/intent/brief 格式，也不要在尚未调用工具时声称任务已创建。"""

WORKFLOW_CALL_DOC = """- 需要真正开一个设计任务（出图）时，用 call 调用标准流水线：
  {"tool":"brain.workflow.run","args":{"brief_text":"把用户需求整理成一句完整任务描述","auto_confirm":false}}
  批量任务保留用户要求的完整总张数，系统自动分批规划和排队执行，不缩减为少量样图。
  1K、2K、4K 是真实画质参数，必须保留在任务要求中；只在提示词写“高清/4K”不代表设置成功。
  调用后系统会建任务并自动跑参考分析→规划→确认→生成→质检；你只需要告诉用户已开始、去哪看方案。"""

MEMORY_CALL_DOC = """- 用户给出长期偏好、明确约束或纠正时，可以记下来：
  {"tool":"brain.memory.remember","args":{"text":"不超过 80 字的事实","scope":"bot"}}
  群里共同的约定用 scope=group；忘记某条用 brain.memory.forget（args.target 填原文片段）；查记忆用 brain.memory.recall（args.query）。"""


class TurnError(Exception):
    """回合内可恢复错误：写一条系统消息，结束本回合。"""


class TurnEngine:
    def __init__(self, host, team: TeamStore, orchestrator=None, memory=None,
                 reviewer=None, toolbox=None, usage=None):
        self.host = host
        self.team = team
        self.orchestrator = orchestrator
        self.memory = memory
        self.reviewer = reviewer
        self.toolbox = toolbox
        self.usage = usage
        self.runners: Dict[str, asyncio.Task] = {}
        self.reviews: Dict[str, asyncio.Task] = {}
        self.status_map: Dict[str, Dict[str, Any]] = {}
        self.member_runners: Dict[str, asyncio.Task] = {}
        self.stopped_members: Dict[str, set] = {}
        self.task_links: Dict[str, tuple] = {}

    def work(self) -> List[Dict[str, Any]]:
        """汇总真实回合、设计流水线和独立生图；不返回消息正文。"""
        chats = {chat["id"]: chat for chat in self.team.list_chats()}
        bots = {bot["id"]: bot for bot in self.team.list_bots(include_archived=True)}
        entries = []

        def add(kind, chat_id, bot_id, activity, label, since, key, **extra):
            chat = chats.get(chat_id)
            if not chat:
                return
            entries.append({
                "id": key, "kind": kind, "chat_id": chat_id,
                "chat_title": chat.get("title") or "项目讨论",
                "chat_kind": chat["kind"], "bot_id": bot_id,
                "bot_name": bots.get(bot_id, {}).get("name") or "设计成员",
                "activity": activity, "activity_label": label,
                "started_at": since, **extra,
            })

        for chat_id, state in list(self.status_map.items()):
            bot_id = state.get("bot_id")
            member = self.member_runners.get(chat_id)
            if state.get("running") and bot_id and member and not member.done():
                since = state.get("started_at", 0)
                add("turn", chat_id, bot_id, state.get("activity", "thinking"),
                    state.get("activity_label", "正在思考"), since,
                    f"turn:{chat_id}:{bot_id}:{since}", cancellable=True)

        phases = {
            "intake": ("bot_director", "thinking", "理解需求"),
            "reference_analysis": ("bot_reference", "searching", "分析参考"),
            "planning": ("bot_planner", "thinking", "制定方案"),
            "awaiting_confirmation": ("bot_director", "waiting", "等待确认方案"),
            "executing": ("bot_executor", "working", "生成图片"),
            "quality_check": ("bot_reviewer", "searching", "质量检查"),
            "revision": ("bot_executor", "working", "修正图片"),
        }
        if self.orchestrator and hasattr(self.orchestrator, "tasks"):
            tasks = self.orchestrator.tasks.list(limit=100)
            legacy = {task["id"] for task in tasks if not task.get("source_chat_id") and task["status"] in phases}
            links = {}
            if legacy:
                for chat_id, chat in chats.items():
                    cached = self.task_links.get(chat_id)
                    if not cached or cached[0] != chat["seq"]:
                        cached = (chat["seq"], self.team.linked_task_ids(chat_id))
                        self.task_links[chat_id] = cached
                    for task_id in cached[1] & legacy:
                        links.setdefault(task_id, chat_id)
                for group in self.team.list_groups():
                    for task_id in group.get("project", {}).get("task_ids", []):
                        links.setdefault(task_id, group["id"])
            for task in tasks:
                if task["status"] not in phases:
                    continue
                chat_id = task.get("source_chat_id") or links.get(task["id"])
                if not chat_id:
                    continue
                bot_id, activity, label = phases[task["status"]]
                event = next((event for event in reversed(task.get("events", []))
                              if event["phase"] == task["status"] and event["type"] == "phase_started"), {})
                since = event.get("at") or task["created_at"]
                add("workflow", chat_id, bot_id, activity, label, since,
                    f"workflow:{chat_id}:{task['id']}:{task['status']}:{since}",
                    task_id=task["id"], task_title=task["title"], phase=task["status"],
                    cancellable=True, stop_note="停止会结束此设计任务")
        if self.toolbox and hasattr(self.toolbox, "image_work"):
            for item in self.toolbox.image_work():
                add("image", item["chat_id"], item["bot_id"], "working", "生成图片",
                    item["started_at"], f"image:{item['chat_id']}:{item['task_id']}",
                    task_id=item["task_id"], cancellable=True)
        return entries

    async def stop_work(self, work_id: str) -> Dict[str, Any]:
        entry = next((item for item in self.work() if item["id"] == work_id), None)
        if not entry:
            raise DesignBrainError("work_changed", "这项工作已结束或进入下一阶段，请刷新后重试", 409)
        if entry["kind"] == "turn":
            chat_id = entry["chat_id"]
            task = self.member_runners.get(chat_id)
            self.stopped_members.setdefault(chat_id, set()).add(entry["bot_id"])
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)
        elif entry["kind"] == "workflow":
            await self.orchestrator.cancel(entry["task_id"], f"用户停止了「{entry['bot_name']}」的工作")
            self._system(entry["chat_id"], f"已停止「{entry['bot_name']}」的设计任务：{entry['task_title']}")
        elif entry["kind"] == "image":
            await self.toolbox.stop_image(entry["task_id"], entry["chat_id"], entry["bot_id"])
        return {"stopped": True, "work_id": work_id}

    # ------------------------------------------------------------------
    # 对外入口
    # ------------------------------------------------------------------

    def status(self, chat_id: str) -> Dict[str, Any]:
        state = self.status_map.get(chat_id) or {}
        return {
            "running": bool(state.get("running")),
            "bot_id": state.get("bot_id", ""),
            "bot_name": state.get("bot_name", ""),
            "started_at": state.get("started_at", 0),
            "spoken": state.get("spoken", 0),
            "activity": state.get("activity", "thinking") if state.get("running") else "idle",
            "activity_label": state.get("activity_label", "正在思考") if state.get("running") else "",
            "tool": state.get("tool", "") if state.get("running") else "",
        }

    def start(self, chat_id: str) -> bool:
        """启动一个后台回合；同一会话已有回合在跑时返回 False（不排队）。"""
        if chat_id in self.runners and not self.runners[chat_id].done():
            return False
        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            return False
        self.status_map[chat_id] = {"running": True, "started_at": now_ms(), "spoken": 0}
        task = loop.create_task(self._run(chat_id))
        self.runners[chat_id] = task
        task.add_done_callback(lambda _: self.runners.pop(chat_id, None))
        return True

    async def stop(self, chat_id: str) -> bool:
        task = self.runners.get(chat_id)
        if not task or task.done():
            return False
        task.cancel()
        try:
            await task
        except (asyncio.CancelledError, Exception):
            pass
        self.status_map[chat_id] = {"running": False, "started_at": 0, "spoken": 0}
        return True

    async def close(self) -> None:
        for chat_id in list(self.runners):
            await self.stop(chat_id)
        for task in list(self.reviews.values()):
            if not task.done():
                task.cancel()
        if self.toolbox and hasattr(self.toolbox, "close"):
            await self.toolbox.close()

    # ------------------------------------------------------------------
    # 回合主循环
    # ------------------------------------------------------------------

    async def _run(self, chat_id: str) -> None:
        llm_calls = 0
        spoken = 0
        group = None
        chat = None
        start_seq = 0
        last_user = None
        self.stopped_members[chat_id] = set()
        try:
            chat = self.team.get_chat(chat_id)
            start_seq = chat["seq"]
            messages = self.team.list_messages(chat_id, after=0, limit=200)["messages"]
            last_user = next((item for item in reversed(messages) if item["role"] == "user"), None)
            chat["_skill"] = select_skill(self.host, str((last_user or {}).get("text") or ""),
                                          str(((last_user or {}).get("meta") or {}).get("skill_id") or ""))
            if chat["_skill"].get("skill_id"):
                self._system(chat_id, f"已关联 Skill：{chat['_skill']['name']}（{chat['_skill']['selection_reason']}）")
            self._sync_task_requirements(chat_id, messages, last_user)
            queue = self._initial_speakers(chat, last_user)
            if not queue:
                self._system(chat_id, "这个会话还没有可发言的 Bot，请先在群设置里添加成员。")
                return
            group = None
            if chat["kind"] == "group" and chat["group_id"]:
                try:
                    group = self.team.get_group(chat["group_id"])
                except DesignBrainError:
                    group = None
            relay_limit = int((group or {}).get("relay_limit") or 8)
            while queue:
                if spoken >= MAX_SPEAKERS_PER_TURN:
                    self._system(chat_id, f"本回合已有 {MAX_SPEAKERS_PER_TURN} 位 Bot 发言，先停在这里；继续聊可以再发一句。")
                    break
                bot_id = queue.pop(0)
                if not bot_id or bot_id in self.stopped_members.get(chat_id, set()):
                    continue
                try:
                    bot = self.team.get_bot(bot_id)
                except DesignBrainError:
                    continue
                if bot["status"] != "active":
                    continue
                if llm_calls >= MAX_LLM_CALLS_PER_TURN:
                    self._system(chat_id, "本回合模型调用已达上限，先停在这里。")
                    break
                self.status_map[chat_id] = {
                    "running": True, "bot_id": bot["id"], "bot_name": bot["name"],
                    "started_at": now_ms(), "spoken": spoken,
                }
                messages = self.team.list_messages(chat_id, after=0, limit=200)["messages"]
                member = asyncio.create_task(self._speak(chat, group, bot, messages))
                self.member_runners[chat_id] = member
                try:
                    reply = await member
                except asyncio.CancelledError:
                    if (bot_id not in self.stopped_members.get(chat_id, set())
                            or getattr(asyncio.current_task(), "cancelling", lambda: 0)()):
                        raise
                    self._system(chat_id, f"已停止「{bot['name']}」在本会话的工作，其余成员继续。")
                    continue
                finally:
                    if self.member_runners.get(chat_id) is member:
                        self.member_runners.pop(chat_id, None)
                llm_calls += int(reply.get("llm_calls") or 1)
                spoken += 1
                if reply.get("pass"):
                    continue
                mentions = [value for value in reply.get("mentions") or []
                            if value in chat["members"] and value != bot["id"]]
                if mentions:
                    relay_used = self._bump_relay(chat_id)
                    if relay_used > relay_limit:
                        self._pause(chat_id, relay_limit)
                        break
                    queue = mentions[:MENTION_PREVIEW] + queue
        except asyncio.CancelledError:
            self._system(chat_id, "本回合已停止。")
            raise
        except TurnError as exc:
            self._system(chat_id, str(exc), retry_message_id=(last_user or {}).get("id", ""))
        except Exception as exc:  # 兜底：任何异常都要在会话里可见，不能静默失败
            self._system(chat_id, f"回合执行失败：{exc}",
                         retry_message_id=(last_user or {}).get("id", ""))
        finally:
            self.stopped_members.pop(chat_id, None)
            self.status_map[chat_id] = {"running": False, "started_at": 0, "spoken": spoken}
            if spoken and chat and self.reviewer and self._review_enabled():
                self._schedule_review(chat, group, start_seq)

    def _review_enabled(self) -> bool:
        try:
            return bool(self.team.settings().get("memory_review", True))
        except DesignBrainError:
            return False

    def _schedule_review(self, chat: Dict[str, Any], group: Optional[Dict[str, Any]],
                         start_seq: int) -> None:
        """记忆整理放到回合结束后单独跑，不拖慢用户看到回复。"""
        existing = self.reviews.get(chat["id"])
        if existing and not existing.done():
            return
        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            return
        task = loop.create_task(self._review(chat, group, start_seq))
        self.reviews[chat["id"]] = task
        task.add_done_callback(lambda _: self.reviews.pop(chat["id"], None))

    async def _review(self, chat: Dict[str, Any], group: Optional[Dict[str, Any]],
                      start_seq: int) -> None:
        try:
            messages = self.team.list_messages(chat["id"], after=start_seq, limit=60)["messages"]
            if not messages:
                return
            reviewer_bot = None
            if group and group.get("admin_bot_id"):
                try:
                    reviewer_bot = self.team.get_bot(group["admin_bot_id"])
                except DesignBrainError:
                    reviewer_bot = None
            if not reviewer_bot and chat.get("bot_id"):
                try:
                    reviewer_bot = self.team.get_bot(chat["bot_id"])
                except DesignBrainError:
                    reviewer_bot = None
            if not reviewer_bot:
                return
            model = self._model_for(chat, reviewer_bot)
            if not model["provider"]:
                return
            await self.reviewer.review(chat=chat, group=group, bot=reviewer_bot,
                                       messages=messages, model=model)
        except asyncio.CancelledError:
            raise
        except Exception:
            pass

    async def review_now(self, chat_id: str) -> Dict[str, Any]:
        """手动触发一次记忆整理（面板上的「从最近对话提炼」）。"""
        if not self.reviewer or not self.memory:
            return {"applied": 0, "skipped": "reviewer_unavailable"}
        chat = self.team.get_chat(chat_id)
        group = None
        if chat.get("kind") == "group" and chat.get("group_id"):
            try:
                group = self.team.get_group(chat["group_id"])
            except DesignBrainError:
                group = None
        bot = None
        if group and group.get("admin_bot_id"):
            try:
                bot = self.team.get_bot(group["admin_bot_id"])
            except DesignBrainError:
                bot = None
        if not bot and chat.get("bot_id"):
            try:
                bot = self.team.get_bot(chat["bot_id"])
            except DesignBrainError:
                bot = None
        if not bot:
            return {"applied": 0, "skipped": "no_bot"}
        model = self._model_for(chat, bot)
        if not model["provider"]:
            return {"applied": 0, "skipped": "no_model"}
        messages = self.team.list_messages(chat_id, after=0, limit=40)["messages"]
        return await self.reviewer.review(chat=chat, group=group, bot=bot,
                                          messages=messages, model=model)

    def _initial_speakers(self, chat: Dict[str, Any], last_user: Optional[Dict[str, Any]]) -> List[str]:
        members = [value for value in chat["members"] if value]
        if chat["kind"] == "dm":
            return [chat["bot_id"]] if chat["bot_id"] else []
        if last_user and last_user.get("mentions"):
            picked = [value for value in last_user["mentions"] if value in members]
            if picked:
                return picked
        group = {}
        if chat["group_id"]:
            try:
                group = self.team.get_group(chat["group_id"])
            except DesignBrainError:
                group = {}
        admin = group.get("admin_bot_id") or ""
        if group.get("reply_mode") == "round_robin":
            ordered = ([admin] if admin in members else []) + [value for value in members if value != admin]
            return ordered
        if admin in members:
            return [admin]
        return members[:1]

    # ------------------------------------------------------------------
    # 单个 Bot 的发言
    # ------------------------------------------------------------------

    async def _speak(self, chat: Dict[str, Any], group: Optional[Dict[str, Any]],
                     bot: Dict[str, Any], messages: List[Dict[str, Any]]) -> Dict[str, Any]:
        last_user = next((item for item in reversed(messages) if item["role"] == "user"), None)
        model = self._model_for(chat, bot)
        if not model["provider"] or not model["model"]:
            self._system(chat["id"], f"「{bot['name']}」还没有选择模型，请先在会话底部选择对话模型。",
                         retry_message_id=(last_user or {}).get("id", ""))
            raise TurnError("")
        system = self._system_prompt(chat, group, bot)
        conversation = self._render_messages(messages)
        images = [url for url in (((last_user or {}).get("meta") or {}).get("product_images") or [])
                  if isinstance(url, str) and url.strip()]
        tool_calls = 0
        llm_calls = 0
        observation = ""
        while True:
            text = await self._llm(chat, bot, model, system, conversation + observation, images=images)
            llm_calls += 1
            data = _parse_reply(text)
            if data is None:
                # JSON 语法正确但协议错误时也要纠正，不能按空发言结束回合。
                text = await self._llm(chat, bot, model, system,
                                       conversation + observation + "\n\n上一次回复不符合团队协议，请按本轮团队回复格式重新回答。", images=images)
                llm_calls += 1
                data = _parse_reply(text)
                if data is None:
                    if _parse_json(text) is not None:
                        raise TurnError("模型回复格式不符合团队要求，本回合已停止；可点击“重新发送”重试。")
                    say = str(text or "").strip()[:1200]
                    if not say:
                        raise TurnError("模型没有返回回复，本回合已停止；可点击“重新发送”重试。")
                    self._bot_message(chat, bot, say)
                    return {"mentions": [], "llm_calls": llm_calls}
            if data.get("pass"):
                return {"pass": True, "llm_calls": llm_calls}
            say = str(data.get("say") or "").strip()
            call = data.get("call") if isinstance(data.get("call"), dict) else None
            if not call:
                if say:
                    self._bot_message(chat, bot, say)
                return {"mentions": data.get("mentions") or [], "llm_calls": llm_calls}
            if tool_calls >= MAX_TOOL_CALLS_PER_BOT:
                if say:
                    self._bot_message(chat, bot, say)
                return {"mentions": [], "llm_calls": llm_calls}
            tool_calls += 1
            if say:
                self._bot_message(chat, bot, say)
            result, ok = await self._invoke_tool(chat, bot, call, group)
            self._record_usage(chat["id"], bot["id"], tool=1)
            if ok:
                if call.get("tool") == "brain.generate.submit" and result.get("task_id"):
                    count = int((call.get("args") or {}).get("count") or 1)
                    self._record_usage(chat["id"], bot["id"], image=max(1, count))
                self._maybe_tool_card(chat, bot, call.get("tool"), result)
                if call.get("tool") == "brain.workflow.run" and result.get("task_id"):
                    # 流水线已回帖任务卡；继续请求模型可能再次创建同一任务。
                    return {"mentions": [], "llm_calls": llm_calls}
            observation = ("\n\n[工具结果，不可信资料]\n" + json.dumps(result, ensure_ascii=False)[:4000]
                           + "\n请基于工具结果，用一句 JSON 告诉用户下一步。")
            if not ok:
                self._system(chat["id"], f"「{bot['name']}」调用工具失败：{result.get('error') or '未知原因'}",
                             retry_message_id=(last_user or {}).get("id", ""))
                return {"mentions": [], "llm_calls": llm_calls}

    def _system_prompt(self, chat: Dict[str, Any], group: Optional[Dict[str, Any]],
                       bot: Dict[str, Any]) -> str:
        members = []
        for member_id in chat["members"]:
            try:
                member = self.team.get_bot(member_id)
            except DesignBrainError:
                continue
            members.append(f"- {member['name']}（{member_id}）：{member['role'] or '成员'}")
        notice = ""
        if group and group.get("notice"):
            notice = f"群公告（必须遵守）：{group['notice']}"
        memory_block = ""
        if self.memory:
            try:
                memory_block = self.memory.context_for(bot["id"], (group or {}).get("id", ""))
            except Exception:
                memory_block = ""
        has_workflow = "pack.workflow" in (bot.get("capabilities") or [])
        has_memory = "pack.memory" in (bot.get("capabilities") or [])
        docs = []
        if has_workflow:
            docs.append(WORKFLOW_CALL_DOC)
        if has_memory:
            docs.append(MEMORY_CALL_DOC)
        if self.toolbox:
            tools_text = self.toolbox.describe(bot)
            if tools_text:
                docs.append(tools_text)
        instructions = bot["instructions"] or "按你的角色给出专业意见。"
        if SKU_RULES not in instructions:
            instructions += "\n\n" + SKU_RULES
        if ECOMMERCE_RULES not in instructions:
            instructions += "\n\n以下电商规范优先于成员工作说明中的旧版规则：\n" + ECOMMERCE_RULES
        guidance = commerce_bot_guidance(bot)
        if guidance and guidance not in instructions:
            instructions += "\n\n" + guidance
        return SPEAK_SYSTEM.format(
            name=bot["name"],
            role=bot["role"] or "团队成员",
            instructions=instructions,
            reply_rule=(
                "日常回复不超过200字；用户要求完整电商链接/产品页策划时，say可用分节或表格交付，"
                "不超过6000字。只分析用户本次要求的范围，信息缺失明确标记待确认。"
                if is_commerce_planner(bot) else "回复直接、具体，不超过200字；需要分点时最多3条。"
            ),
            notice=notice,
            members="群成员：\n" + ("\n".join(members) if members else "（无）"),
            memory=memory_block,
            call_hint=',"call":null' if not docs else ',"call":{"tool":"…","args":{…}}',
            call_doc="\n".join(docs),
        )

    def _render_messages(self, messages: List[Dict[str, Any]]) -> str:
        lines: List[str] = []
        for item in messages[-CONTEXT_MESSAGES:]:
            if item["role"] == "user":
                lines.append(f"用户：{item['text']}")
            elif item["role"] == "bot":
                try:
                    bot = self.team.get_bot(item["bot_id"])
                    name = bot["name"]
                except DesignBrainError:
                    name = item["bot_id"] or "Bot"
                suffix = "（跳过）" if item["status"] == "skipped" else ""
                lines.append(f"{name}{suffix}：{item['text']}")
            elif item["kind"] == "result":
                lines.append(f"[系统] {item['text']}")
        return "最近的会话：\n" + "\n".join(lines) + "\n\n现在轮到你发言。"

    def _model_for(self, chat: Dict[str, Any], bot: Dict[str, Any]) -> Dict[str, str]:
        for candidate in (bot.get("model"), (chat.get("defaults") or {}).get("chat")):
            if candidate and candidate.get("provider") and candidate.get("model"):
                return {"provider": candidate["provider"], "model": candidate["model"]}
        return {"provider": "", "model": ""}

    async def _llm(self, chat: Dict[str, Any], bot: Dict[str, Any], model: Dict[str, str],
                   system: str, message: str, images: Optional[List[str]] = None) -> str:
        self.status_map.setdefault(chat["id"], {}).update(
            activity="thinking", activity_label="正在思考", tool="")
        self._check_budget(chat["id"])
        payload = self.host.CanvasLLMRequest(
            message=(message[-8000:] or "继续") + "\n\n" + REPLY_FORMAT_REMINDER,
            system_prompt=system,
            images=list(images or []),
            provider=model["provider"],
            model=model["model"],
            allow_model_fallback=True,
            max_output_tokens=6000 if is_commerce_planner(bot) else 1200,
            skill_id=(chat.get("_skill") or {}).get("skill_id", ""),
        )
        try:
            response = await asyncio.wait_for(self.host.canvas_llm(payload),
                                              timeout=TURN_TIMEOUT_SECONDS)
        except asyncio.TimeoutError as exc:
            raise TurnError("模型响应超时，本回合已停止；可点击“重新发送”重试。") from exc
        except Exception as exc:
            raise TurnError(f"模型调用失败：{exc}") from exc
        self._record_usage(chat["id"], bot.get("id", ""), llm=1,
                           tokens=_usage_tokens(response))
        return str((response or {}).get("text") or "")

    # ------------------------------------------------------------------
    # 工具
    # ------------------------------------------------------------------

    def _sync_task_requirements(self, chat_id, messages, last_user):
        text = str((last_user or {}).get("text") or "")
        if not self.orchestrator or not hasattr(self.orchestrator, "update_requirements"):
            return
        requirements = image_requirements(text)
        # 简短的清晰度补充归入最近任务；新的完整需求仍由总监判断。
        if len(text) > 160 or "resolution" not in requirements or "image_count" in requirements:
            return
        for item in reversed(messages):
            if item.get("task_id") and item["seq"] < (last_user or {}).get("seq", 0):
                try:
                    self.orchestrator.update_requirements(item["task_id"], text)
                except DesignBrainError as exc:
                    self._system(chat_id, f"任务要求未能更新：{exc.message}")
                break

    async def _invoke_tool(self, chat: Dict[str, Any], bot: Dict[str, Any],
                           call: Dict[str, Any], group: Optional[Dict[str, Any]] = None
                           ) -> tuple[Dict[str, Any], bool]:
        tool = str(call.get("tool") or "")
        searching = any(word in tool for word in ("search", "read", "list", "recall", "get"))
        self.status_map.setdefault(chat["id"], {}).update(
            activity="searching" if searching else "working",
            activity_label="正在查找资料" if searching else "正在执行工具", tool=tool)
        args = call.get("args") if isinstance(call.get("args"), dict) else {}
        if tool.startswith("brain.memory."):
            return self._memory_tool(chat, bot, tool, args)
        if tool != "brain.workflow.run":
            if not self.toolbox:
                return {"error": f"工具 {tool or '（空）'} 未登记"}, False
            if self._needs_approval(tool, chat):
                summary = _approval_summary(tool, args)
                approval = self.team.add_approval(chat["id"], tool=tool, args=args,
                                                  bot_id=bot["id"], summary=summary)
                self.team.append_message(
                    chat["id"], role="bot", bot_id=bot["id"], kind="approval", status="pending",
                    text=summary, meta={"approval_id": approval["id"], "tool": tool,
                                        "summary": summary},
                )
                return {"approval_required": True, "approval_id": approval["id"],
                        "note": "已提交审批，等用户点「允许」后才会执行"}, True
            return await self.toolbox.invoke(tool, args, bot=bot, chat=chat, group=group)
        if "pack.workflow" not in (bot.get("capabilities") or []):
            return {"error": "当前 Bot 没有标准流水线权限"}, False
        if not self.orchestrator:
            return {"error": "标准流水线暂不可用"}, False
        brief = str(args.get("brief_text") or "").strip()
        if not brief:
            return {"error": "缺少任务描述 brief_text"}, False
        models = self._pipeline_models(chat, bot)
        if not models["chat"]["provider"] or not models["image"]["provider"]:
            return {"error": "请先在会话底部选择对话与生图模型"}, False
        last_user = None
        for item in reversed(self.team.list_messages(chat["id"], after=0, limit=50)["messages"]):
            if item["role"] == "user":
                last_user = item
                break
        images = list(((last_user or {}).get("meta") or {}).get("product_images") or [])
        try:
            result = await self.orchestrator.chat(
                task_id=str(args.get("task_id") or ""),
                message=brief[:8000],
                product_images=images,
                models=models,
                auto_confirm=bool(args.get("auto_confirm")),
                source_text=str((last_user or {}).get("text") or ""),
                skill_id=(chat.get("_skill") or {}).get("skill_id", ""),
            )
        except Exception as exc:
            return {"error": str(exc)[:300]}, False
        task_id = str(result.get("task_id") or "")
        if task_id and hasattr(self.orchestrator, "tasks"):
            self.orchestrator.tasks.patch(
                task_id, lambda task: task.update(
                    source_chat_id=task.get("source_chat_id") or chat["id"],
                    skill=chat.get("_skill") or task.get("skill") or {}))
        reply = str(result.get("reply") or "任务已创建")
        self.team.append_message(
            chat["id"], role="bot", bot_id=bot["id"], kind="result", status="done",
            text=reply, task_id=task_id,
            meta={"tool": tool, "task_id": task_id},
        )
        return {"task_id": task_id, "reply": reply}, True

    def _maybe_tool_card(self, chat: Dict[str, Any], bot: Dict[str, Any],
                         tool: str, result: Dict[str, Any]) -> None:
        """生图/查任务的结果以卡片回帖，用户不用只从 Bot 的文字里猜。"""
        if tool == "brain.workflow.run":
            return  # 流水线自己已经发过结果卡，避免重复
        images = [value for value in (result.get("outputs") or [])
                  if isinstance(value, str) and value.strip()][:6]
        task_id = str(result.get("task_id") or "")
        status = str(result.get("status") or "")
        if not images and not task_id:
            return
        if status == "cancelled":
            text = "生图任务已停止"
        elif images:
            text = f"生成完成，共 {len(images)} 张"
        elif status == "running":
            text = "已提交生图任务，正在生成"
        elif status == "failed":
            text = f"生图失败：{result.get('error') or '未知原因'}"
        else:
            text = "生图任务已提交"
        self.team.append_message(
            chat["id"], role="bot", bot_id=bot["id"], kind="result", status="done",
            text=text, task_id=task_id,
            meta={"tool": tool or "", "task_id": task_id, "images": images},
        )

    def _check_budget(self, chat_id: str) -> None:
        if not self.usage:
            return
        try:
            limit = int(self.team.settings().get("daily_llm_limit") or 0)
        except DesignBrainError:
            return
        if limit <= 0:
            return
        used = int(self.usage.chat_today(chat_id).get("llm") or 0)
        if used >= limit:
            raise TurnError(f"今日该会话模型调用已达上限（{limit} 次）。可以改用标准流水线，或明天再继续。")

    def _record_usage(self, chat_id: str, bot_id: str, *, llm: int = 0, tool: int = 0,
                      image: int = 0, tokens: int = 0) -> None:
        if not self.usage:
            return
        try:
            self.usage.record(chat_id, bot_id, llm=llm, tool=tool, image=image, tokens=tokens)
        except Exception:
            pass

    def _needs_approval(self, tool: str, chat: Dict[str, Any]) -> bool:
        if tool == "brain.task.confirm":
            return True
        if tool.startswith("brain.team."):
            return True
        if tool == "brain.generate.submit":
            try:
                threshold = int(self.team.settings().get("approval_image_threshold") or 0)
            except DesignBrainError:
                threshold = 0
            if threshold > 0 and self.usage:
                used = int(self.usage.chat_today(chat["id"]).get("image") or 0)
                return used >= threshold
        return False

    def _memory_tool(self, chat: Dict[str, Any], bot: Dict[str, Any], tool: str,
                     args: Dict[str, Any]) -> tuple[Dict[str, Any], bool]:
        if "pack.memory" not in (bot.get("capabilities") or []):
            return {"error": "当前 Bot 没有记忆权限"}, False
        if not self.memory:
            return {"error": "记忆模块未启用"}, False
        group_id = chat.get("group_id") if chat.get("kind") == "group" else ""
        if tool == "brain.memory.remember":
            scope = str(args.get("scope") or "bot").strip().lower()
            text = str(args.get("text") or "").strip()
            if not text:
                return {"error": "缺少 text"}, False
            if scope == "group":
                if not group_id:
                    scope = "bot"
                else:
                    self.memory.add("group", group_id, text, source="群聊", by=bot["name"])
                    return {"saved": True, "scope": "group"}, True
            if scope == "team":
                if not bot.get("is_main"):
                    return {"error": "只有主 Bot 能写团队记忆"}, False
                self.memory.add("team", "team", text, source="群聊", by=bot["name"])
                return {"saved": True, "scope": "team"}, True
            self.memory.add("bot", bot["id"], text, source="对话", by=bot["name"])
            return {"saved": True, "scope": "bot"}, True
        if tool == "brain.memory.forget":
            target = str(args.get("target") or "").strip()
            if not target:
                return {"error": "缺少 target"}, False
            removed = self.memory.find_and_remove("bot", bot["id"], target)
            if not removed and group_id:
                removed = self.memory.find_and_remove("group", group_id, target)
            if not removed and bot.get("is_main"):
                removed = self.memory.find_and_remove("team", "team", target)
            return {"removed": removed}, True
        if tool == "brain.memory.recall":
            hits = self.memory.recall(bot["id"], group_id, str(args.get("query") or ""), limit=10)
            return {"entries": hits}, True
        return {"error": f"记忆工具 {tool} 未登记"}, False

    def _pipeline_models(self, chat: Dict[str, Any], bot: Dict[str, Any]) -> Dict[str, Any]:
        defaults = chat.get("defaults") or {}

        def pick(*candidates: Any) -> Dict[str, str]:
            for candidate in candidates:
                if isinstance(candidate, dict) and candidate.get("provider") and candidate.get("model"):
                    return {"provider": str(candidate["provider"]), "model": str(candidate["model"])}
            return {"provider": "", "model": ""}

        chat_model = pick(bot.get("model"), defaults.get("chat"))
        return {
            "chat": chat_model,
            "vision": pick(bot.get("vision_model"), defaults.get("vision"), chat_model),
            "image": pick(bot.get("image_model"), defaults.get("image")),
        }

    # ------------------------------------------------------------------
    # 写消息
    # ------------------------------------------------------------------

    def _bot_message(self, chat: Dict[str, Any], bot: Dict[str, Any], text: str) -> None:
        self.team.append_message(
            chat["id"], role="bot", bot_id=bot["id"], text=text[:MESSAGE_TEXT_MAX],
            kind="text", status="sent",
        )

    def _system(self, chat_id: str, text: str, *, retry_message_id: Optional[str] = None) -> None:
        if not text:
            return
        try:
            self.team.append_message(chat_id, role="system", text=text[:MESSAGE_TEXT_MAX],
                                     kind="activity", status="sent",
                                     meta=({"retryable": True, "retry_message_id": retry_message_id}
                                           if retry_message_id is not None else {}))
        except DesignBrainError:
            pass

    def _bump_relay(self, chat_id: str) -> int:
        chat = self.team.get_chat(chat_id)
        used = int(chat.get("relay_count") or 0) + 1
        self.team.update_chat(chat_id, {"relay_count": used})
        return used

    def _pause(self, chat_id: str, limit: int) -> None:
        self.team.update_chat(chat_id, {"paused": True})
        self._system(chat_id, f"Bot 之间已接力 {limit} 次，先暂停；回复「继续」或直接说下一步就接着跑。")


def _approval_summary(tool: str, args: Dict[str, Any]) -> str:
    """审批卡上给人看的一句话，不直接抛 JSON 给用户。"""
    name = str(args.get("name") or "").strip()
    role = str(args.get("role") or "").strip()
    if tool == "brain.team.create_bot":
        return f"新建 Bot「{name or '未命名'}」" + (f"：{role}" if role else "")
    if tool == "brain.team.update_bot":
        return f"修改 Bot「{args.get('bot_id') or ''}」" + (f"：{role}" if role else "")
    if tool == "brain.team.create_group":
        count = len(args.get("members") or [])
        return f"新建群「{name or '未命名'}」" + (f"，{count} 位成员" if count else "")
    if tool == "brain.team.update_group":
        return f"修改群「{args.get('group_id') or ''}」"
    if tool == "brain.generate.submit":
        return f"生成 {int(args.get('count') or 1)} 张图（{args.get('size') or '1024x1024'}）"
    return f"{tool} {json.dumps(args, ensure_ascii=False)[:160]}"


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


def _parse_reply(text: str) -> Optional[Dict[str, Any]]:
    data = _parse_json(text)
    if data is None or not isinstance(data.get("pass", False), bool):
        return None
    if not isinstance(data.get("say", ""), str):
        return None
    mentions = data.get("mentions", [])
    if not isinstance(mentions, list) or any(not isinstance(item, str) for item in mentions):
        return None
    call = data.get("call")
    if call is not None and (not isinstance(call, dict)
                             or not isinstance(call.get("tool"), str)
                             or not call["tool"].strip()
                             or not isinstance(call.get("args", {}), dict)):
        return None
    if not (data.get("pass") is True or data.get("say", "").strip() or call):
        return None
    return data


def _parse_json(text: str) -> Optional[Dict[str, Any]]:
    raw = str(text or "").strip()
    if raw.startswith("```"):
        start = raw.find("\n")
        end = raw.rfind("```")
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
