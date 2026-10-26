"""设计大脑多 BOT 编排：设计总监入口 + 专业 BOT 流水线。

架构约定（见 交付文档/13）：
- 编排是确定性状态机，不是角色聊天。每个阶段由对应 BOT 的处理函数执行，
  LLM 只在明确标注的步骤调用，且输出必须是受验证的结构化 JSON。
- 生成执行直接调用 main.py 的服务端内部函数（create/get/cancel_canvas_image_task），
  不经 HTTP 自调用、不新建平行任务系统；``design_run_id`` 透传复用既有
  任务→历史→DesignRun 追溯链。
- 防失控：client_request_id 幂等、按目标数量分批规划、自动修正 ≤1 轮、
  并行生图 ≤3、取消即时传播、质检不可判断标 needs_human。
- 隐私：发送给云端的内容只有任务简报、审美档案摘要、所选参考的分析文本
  与商品图/生成产物；生成前必须经过方案确认（除非用户对本任务勾选自动执行）。
"""
from __future__ import annotations

import asyncio
from copy import deepcopy
import math
from design_brain_skills import select_skill
from commerce_link_method import commerce_bot_guidance
import json
import hashlib
import re
import time
from typing import Any, Dict, List, Optional, Tuple

from fastapi import HTTPException, Request
from pydantic import BaseModel, Field
from design_brain_decisions import (
    DIRECTION_SYSTEM, REPAIR_SYSTEM, normalize_directions, distinct_directions,
    needs_exploration, analysis_only, review_contract, acceptance_status,
    snapshot_version, invalidate_confirmation,
    GROUP_REVIEW_SYSTEM,
)
from design_brain_quality import inspect_shot, inspect_group

from design_brain_store import (
    AgentTaskStore,
    AGENT_TASK_TERMINAL_STATUSES,
    DesignBrainError,
    now_ms,
    image_requirements,
    brief_image_requirements,
    apply_plan_requirements,
    apply_sku_plan,
    is_sku_brief,
    SKU_RULES,
    apply_ecommerce_plan,
    guard_append_edits,
)
from design_brain_visual_rules import ECOMMERCE_RULES, VisualRuleError, render_sku_image, task_kind, infer_task_type, sku_series_mode
from design_brain_api import (
    DATA_ROOT,
    EXPERIENCES,
    REFERENCES,
    RUNS,
    REVIEWS,
    STORE,
    _ensure_same_origin,
    _local_only_dependency,
)


PLANNING_BATCH_SIZE = 16
MAX_AUTO_REVISIONS = 1
MAX_USER_REVISIONS = 5
MAX_REPLANS = 5
GENERATION_CONCURRENCY = 3
REFERENCE_CANDIDATE_MAX = 24
REFERENCE_SELECT_MAX = 4
CANVAS_TASK_POLL_INTERVAL = 2.0
CANVAS_TASK_TIMEOUT_SECONDS = 15 * 60
CANVAS_TASK_TERMINAL = {"succeeded", "failed", "error", "cancelled", "completed", "success", "done"}

PURPOSE_BY_TASK_TYPE = {
    "main_image": "主图",
    "detail_images": "详情页",
    "creative": "创意展示",
    "other": "",
}

BOT_CATALOG = [
    {"id": "director", "name": "设计总监", "duty": "理解需求、生成任务单、安排执行顺序、汇总结果、判断是否需要确认", "tools": ["任务单", "阶段流转", "汇总交付"]},
    {"id": "reference", "name": "参考分析", "duty": "检索个人参考库，按品类/用途召回并筛选高相关案例与可借鉴点", "tools": ["参考素材库检索（只读）"]},
    {"id": "planner", "name": "设计规划", "duty": "制定设计方案：每张图的提示词/尺寸/用途、验收标准、锁定约束与可调项", "tools": ["审美档案摘要", "参考分析结果", "模型与 Skill 清单"]},
    {"id": "executor", "name": "生成执行", "duty": "按已确认方案提交生图任务、轮询结果、记录模型与参数", "tools": ["画布生图任务（幂等/可取消）"]},
    {"id": "reviewer", "name": "质量检查", "duty": "按验收标准检查结构/材质/构图/文案，输出问题+证据+建议", "tools": ["视觉模型检查"]},
]

DIRECTOR_SYSTEM = """你是小美画布的「设计总监 BOT」，个人设计大脑的唯一对话入口。你的职责：
1. 理解用户的电商设计需求（主图、详情页图、创意场景等），把描述整理成结构化任务单。
2. 判断应当直接回答，还是创建设计任务交给专业 BOT 流水线（参考分析→设计规划→[用户确认]→生成执行→质量检查→交付）。
3. 需要澄清时先提出最少必要的问题（一次最多 3 个）；信息足够时直接建任务，不要反复追问。
上下文里会给出：个人审美档案摘要、参考库概况、当前任务状态、用户本次消息与商品图数量。
你必须只输出一个 JSON 对象，不要输出任何其他文字，格式：
{"reply":"给用户看的回复，不超过120字，说明你做了什么或想问什么","intent":"create_task|answer|revise_plan|cancel_task","brief":{}}
intent 说明：
- create_task：创建新设计任务，必须给出完整 brief。
- answer：只是回答、闲聊或追问澄清，不建任务（brief 留空对象）。
- revise_plan：当前任务在等确认且用户提出修改意见，给出合并修改后的完整 brief。
- cancel_task：用户明确表示放弃当前任务。
brief 格式（create_task/revise_plan 时必填）：
{"task_type":"main_image|detail_images|creative|other","goal":"一句话任务目标","product":{"name":"商品名","category":"品类","features":["卖点或外观特征"],"constraints":["不可违反的结构或文案约束"]},"deliverables":[{"text":"交付物，例如：1 张主图"}],"image_count":0,"resolution":"","style_direction":"期望的视觉方向","need_confirmation":true}
image_count 是用户要求的总张数，未指定填 0；resolution 按用户要求填 1K/2K/4K，未指定留空。必须保留数量与清晰度要求。
规则：need_confirmation 默认 true（生成前必须让用户确认方案）；要生成的图超过 4 张时必须 true；只有用户在本次消息里明确要求跳过确认才可以 false。用户消息里提到的商品颜色、部件、文字、logo 等事实必须写进 product.constraints，不得臆造。"""

PLANNER_SYSTEM = """你是小美画布的「设计规划 BOT」。基于任务单、参考案例分析、审美档案与商品图制定可执行的设计方案。
只输出一个 JSON 对象，不要输出任何其他文字，格式：
{"direction":"整体视觉方向，80字内","rationale":"这样规划的理由，150字内","constraints_locked":["必须严格遵守的约束"],"flexible":["允许生成自由发挥的方面"],"acceptance":["整体验收标准"],"shots":[{"id":"shot_1","kind":"main_image|detail_image|scene|creative|other","purpose":"这张图的用途","prompt":"完整生图提示词（中文），包含主体、构图、材质、光线、背景与氛围","negative":"不希望出现的元素","size":"1024x1024","count":1,"acceptance":["这张图的验收点"]}]}
硬性要求：
1. shots 数量必须与本次规划批次要求匹配；总任务由系统分批完成，不能缩减总张数。
2. 1K、2K、4K 是结构化生图参数，分别在 resolution 中填 1k、2k、4k，不要靠在提示词里加清晰度文字代替参数。size 表示画幅尺寸，系统按所选模型解析实际像素。未指定时主图用 1024x1024，竖图用 1024x1536，横图用 1536x1024。逐张规划，每张 count=1。
3. 提示词必须落实参考案例的可借鉴点与审美档案偏好，明确规避 avoid（避免风格）项；不得写入商品不存在的内容。
4. 任务单 product.constraints 里的结构/文案约束必须体现在对应 prompt 中，并原样列入 constraints_locked。
5. 每张图至少 1 条可检查的验收点（结构、材质、构图或文案）。
6. 额外输出 adjustment_options 数组，给用户 3–5 个可点选的调整方向，每项格式为 {"label":"简短选项名称","feedback":"提交重新规划时的具体修改要求"}。选项结合本次商品和方案，说明可执行的变化，不得违背已锁定约束；可从构图、背景、光线、材质表现、分镜安排中选择。"""

REFERENCE_SYSTEM = """你是小美画布的「参考分析 BOT」。从候选参考案例中为当前设计任务挑选最相关的少数案例。
只输出一个 JSON 对象，不要输出任何其他文字，格式：
{"selected":[{"id":"参考案例id","score":0到1的相关度,"reason":"为何相关，60字内","takeaways":"本案可借鉴的点（构图/材质/光线/排版），80字内"}]}
最多选 {max_select} 条，宁缺毋滥；没有合适的就返回 {"selected":[]}。只能从候选列表里选，不得编造 id。"""

REVIEWER_SYSTEM = """你是小美画布的「质量检查 BOT」。根据任务与验收标准检查生成图片，你会看到：任务目标、这张图的用途、提示词、验收点、商品约束和图片本身。
只输出一个 JSON 对象，不要输出任何其他文字，格式：
{"verdict":"pass|issues|needs_human","issues":[{"severity":"critical|major|minor","area":"structure|material|composition|text|other","description":"具体问题","evidence":"画面哪里看到的证据","suggestion":"可执行的修正建议"}]}
判定规则：
- 商品结构、比例、部件明显错误 → critical（area=structure）。
- 材质明显失真（如木纹变塑料感）→ critical 或 major（area=material）。
- 任务有文字要求而图中文字错误/乱码 → critical（area=text）。
- 构图或视觉层次不达验收点 → major 或 minor（area=composition）。
- 看不清或无法可靠判断某项要求时，verdict 用 needs_human，并在 issues 里说明哪项无法判断；绝不假装检查通过。
- 没有问题时 verdict=pass 且 issues 为空数组。"""

DIRECTOR_SYSTEM += "\n\n" + ECOMMERCE_RULES + "\n" + SKU_RULES + "\nSKU仅换文字时输出series_mode=sku；用户明确要求换框色、照片或外观时输出series_mode=sku_variants。主图完整一组始终5张，测图创意任务用creative；详情的屏数写入image_count，未指定比例默认9:16。"
PLANNER_SYSTEM += "\n\n" + ECOMMERCE_RULES + "\n" + SKU_RULES + """
电商方案额外输出 visual_framework={"palette":["#HEX主色","#HEX辅色"],"fonts":["字体"],"style":"全组风格","brand":"Logo样式与固定位置，无品牌则写无Logo","product_pose":"全组产品造型、角度、机位与比例"}。
详情每张额外输出copy={"title":"4至8字利益点标题","subtitle":"15字内副标题","body":"精简真实正文"}。全组typography使用参考字级64/44/26pt、行距增加10px，所有屏标题字级一致。
每张按用户真实资料写清消费人群、场景、属性功能、好处与情感吸引力，核心卖点优先；不填虚构竞对结论。
文字模板SKU额外输出sku_scene（固定底图的场景、产品、品牌与构图，产品完整放在信息位以外区域），sku_layout（parameters/gifts/attributes三个固定文字位，每项为box:[x,y,w,h]的0至1坐标、font_pt:26、color与background复用palette中的HEX；不提供时使用默认信息位）。
文字模板SKU每张额外输出sku_values={"parameters":"真实参数文字","gifts":"真实赠品文字，无赠品可留空","attributes":"真实属性名称"}；不要在此对象放产品颜色、造型或背景等字段。整组主体只在无字底图生成一次，三个信息位文字由系统统一排版。
外观款式SKU输出共同场景sku_scene，每张输出sku_variant（本款实际框色、照片来源及组合等变化）与完整prompt；不输出sku_layout或sku_values，不强加文字信息位或擅自添加文案。相框照片必须使用用户提供的素材，明确图号和选用组合；保留用户要求的卡纸厚度、45度斜切开窗、嵌入关系和光影工艺。
SKU分镜全部使用同一size、count=1；文字模板整组统一修改模板，不能单独改变字体字号或产品；外观款式只允许用户指定的变化，其余共同场景与工艺锁定。
主图第1张1:1，其余4张2:3；详情每屏9:16，按全局序号安排商品/卖点/好处特性/强视觉/重复卖点。调整建议不得破坏本次硬性要求。"""
REFERENCE_SYSTEM += "\n\n" + ECOMMERCE_RULES + "\n" + SKU_RULES
REVIEWER_SYSTEM += "\n\n" + ECOMMERCE_RULES + "\n" + SKU_RULES + "\nSKU比较时以任务制作方式和本款方案为准。文字模板不得把无字底图算作待检产物，三个信息位以外变化按critical、area=composition报告；外观款式允许已确认的框色、照片和图案变化，检查共同场景与工艺，不能用文字模板规则误判。"
REVIEWER_SYSTEM += "\n\n" + commerce_bot_guidance({"id": "bot_reviewer"})

DIRECTOR_SYSTEM += '\n设计类型先于模板：海报、品牌、社交视觉和明确只要一张图的任务不套用完整五张主图规范。只分析、讨论、写提示词时intent=answer。brief额外输出direction_mode=fixed|explore；具体参考或明确改法用fixed，只有高级、简洁等模糊审美且需要新设计时用explore。'

DIRECTOR_SUMMARY_SYSTEM = """你是小美画布的「设计总监 BOT」。设计任务已经执行完毕，请向用户做交付总结。
只输出一个 JSON 对象，不要输出任何其他文字，格式：{"reply":"不超过150字的总结"}"""

# 团队 seed 用：把现有 BOT 的 system prompt 原样带进 Bot.instructions，
# 保证「设计总监」在团队形态下与旧管线行为一致。占位符在这里就换成具体
# 数值——instructions 是用户可编辑的纯文本，不能在运行时再格式化。
DESIGN_BOT_INSTRUCTIONS = {
    "bot_director": DIRECTOR_SYSTEM,
    "bot_reference": REFERENCE_SYSTEM.replace("{max_select}", str(REFERENCE_SELECT_MAX)),
    "bot_planner": PLANNER_SYSTEM,
    "bot_executor": (
        "你是小美画布的「生成执行 BOT」。按已确认方案逐张提交生图任务、轮询结果，"
        "记录使用的模型与参数，不擅自更改设计方向；任务失败时如实报告原因，不假装成功。"
    ) + "\n\n" + ECOMMERCE_RULES + "\n" + SKU_RULES,
    "bot_reviewer": REVIEWER_SYSTEM,
}


class BotFlowError(Exception):
    """阶段执行失败：任务标记 failed，可从该阶段恢复。"""


class BotCancelled(Exception):
    """用户取消了任务。"""


def parse_model_json(text: str) -> Optional[Dict[str, Any]]:
    raw = str(text or "").strip()
    if raw.startswith("```"):
        cut = raw.find("\n")
        tail = raw.rfind("```")
        if cut >= 0 and tail > cut:
            raw = raw[cut + 1:tail].strip()
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


def resolve_plan_image_params(host, shots, model):
    resolve = getattr(host, "resolve_image_generation_params", None)
    if callable(resolve):
        for shot in shots:
            if shot.get("resolution"):
                shot.update(resolve(shot["size"], shot["resolution"], shot.get("aspect_ratio", ""), model))
    return shots


async def compose_batched_plan(request, brief, message, *, on_batch=None, before_batch=None, initial_plan=None):
    brief = {**brief, "visual_rules_applied": True}
    requirements = brief_image_requirements(brief)
    expected = requirements["image_count"]
    total = expected or PLANNING_BATCH_SIZE
    combined = initial_plan
    all_shots = list((initial_plan or {}).get("shots") or [])
    for start in range(len(all_shots), total, PLANNING_BATCH_SIZE):
        if before_batch:
            before_batch()
        count = min(PLANNING_BATCH_SIZE, total - start)
        batch_requirements = {**requirements, "image_count": count if expected else 0}
        batch = {"total": expected, "start": start + 1, "end": start + count,
                 "count": count if expected else 0}
        system = PLANNER_SYSTEM if task_kind(brief) else PLANNER_SYSTEM.split("\n\n" + ECOMMERCE_RULES)[0]
        if task_kind(brief):
            system += "\n\n" + commerce_bot_guidance({"id": "bot_planner"})
        system += "\n本次规划批次（JSON）：" + json.dumps(batch, ensure_ascii=False)
        system += "\n张数与清晰度参数：" + json.dumps(requirements, ensure_ascii=False)
        if sku_series_mode(brief):
            system += "\n本任务SKU制作方式：" + sku_series_mode(brief)
        if expected:
            system += f"\n本次只输出第 {start + 1} 至 {start + count} 张，共 {count} 张，每张 count=1。"
        else:
            system += f"\n本次最多规划 {count} 张，不擅自增加用户未要求的交付物。"
        if combined:
            system += "\n延续首批的共同设计方向及场景：" + json.dumps({
                key: combined.get(key) for key in ("direction", "sku_scene", "sku_layout", "visual_framework", "constraints_locked", "acceptance")
            }, ensure_ascii=False)
            system += "\n已规划的商品与用途：" + json.dumps([
                {key: shot.get(key) for key in ("id", "purpose", "sku_variant")} for shot in all_shots
            ], ensure_ascii=False)
        for attempt in range(2):
            try:
                data = await request(system, message, min(16000, max(4000, count * 800)))
                shots = data.get("shots") or []
                if not isinstance(shots, list) or not shots:
                    raise DesignBrainError("invalid_plan", "规划结果缺少可执行分镜，请重新规划", 422)
                shots = apply_plan_requirements(batch_requirements, shots)
                if len(shots) > count:
                    raise DesignBrainError("invalid_plan", "本次规划返回了超出批次范围的图片，请只返回当前批次", 422)
                for index, shot in enumerate(shots):
                    shot["id"] = f"shot_{start + index + 1}"
                data["shots"] = shots
                if combined:
                    data["visual_framework"] = combined.get("visual_framework") or {}
                    if sku_series_mode(brief):
                        data["sku_scene"] = combined["sku_scene"]
                        data["sku_layout"] = combined.get("sku_layout") or {}
                apply_ecommerce_plan(brief, data, compose=True, offset=start)
                shots = apply_plan_requirements(batch_requirements, data["shots"])
                data["shots"] = shots
                apply_sku_plan(brief, data, compose=True)
                break
            except DesignBrainError as exc:
                if attempt:
                    context = f"第 {start + 1} 至 {start + count} 张规划未完成（任务共 {expected} 张）" if expected else "本批方案未完成"
                    raise DesignBrainError(exc.code, f"{context}：{exc.message}", exc.status) from exc
                system += f"\n上次方案未通过校验：{exc.message}。请完整输出当前批次。"
        if combined is None:
            combined = {**data, "shots": []}
        all_shots.extend(shots)
        combined["shots"] = list(all_shots)
        if on_batch:
            on_batch(combined, expected)
    combined["shots"] = apply_plan_requirements(brief, all_shots)
    apply_ecommerce_plan(brief, combined)
    return apply_sku_plan(brief, combined)


class DesignBotOrchestrator:
    def __init__(self, host, tasks: AgentTaskStore, *, references=None, experiences=None,
                 runs=None, profile=None):
        self.host = host
        self.tasks = tasks
        # 默认与 design_brain_api 共用同一批实例（同一数据文件）；单测可注入
        # 临时目录的隔离存储，避免污染真实运行数据。
        self.references = references if references is not None else REFERENCES
        self.experiences = experiences if experiences is not None else EXPERIENCES
        self.runs = runs if runs is not None else RUNS
        self.profile_store = profile if profile is not None else STORE
        self.runners: Dict[str, asyncio.Task] = {}

    # ------------------------------------------------------------------
    # 基础工具
    # ------------------------------------------------------------------

    def safe_error(self, exc: Exception) -> str:
        value = getattr(exc, "detail", None) or str(exc)
        if isinstance(exc, asyncio.TimeoutError):
            value = "模型连接超时，请检查网络、系统代理或更换模型后重试"
        sanitizer = getattr(self.host, "project_agent_safe_error", None)
        if callable(sanitizer):
            try:
                return sanitizer(value) or "操作未完成，请检查模型与网络后重试"
            except Exception:
                return str(value)[:300]
        return str(value)[:300]

    def _snapshot(self, task_id: str) -> Dict[str, Any]:
        try:
            return self.tasks.get(task_id)
        except DesignBrainError as error:
            raise BotFlowError(error.message) from error

    def _apply_plan_requirements(self, brief, shots, task):
        return resolve_plan_image_params(self.host, apply_plan_requirements(brief, shots),
                                         task["models"]["image"]["model"])

    def _patch(self, task_id: str, phase: str, change) -> Dict[str, Any]:
        def wrapped(task: Dict[str, Any]) -> None:
            change(task)
        return self.tasks.patch(task_id, wrapped)

    def _event(self, task_id: str, phase: str, event_type: str, note: str) -> None:
        try:
            self.tasks.add_event(task_id, phase, event_type, note)
        except DesignBrainError:
            pass

    def _bot_message(self, task_id: str, bot: str, text: str, phase: str = "") -> None:
        try:
            self.tasks.add_message(task_id, "bot", bot, text, phase)
        except DesignBrainError:
            pass

    def _guard_cancelled(self, task_id: str) -> None:
        task = self._snapshot(task_id)
        if task["status"] == "cancelled":
            raise BotCancelled()
        if task["status"] in AGENT_TASK_TERMINAL_STATUSES:
            raise BotCancelled(f"任务已结束（{task['status']}）")

    def _reserve_llm_call(self, task_id: str) -> None:
        if not task_id:
            return  # 任务创建前的总监对话：没有任务可计，不占用任务预算
        def reserve(t):
            if t["design"]["version"] and t["usage"]["llm_calls"] >= t["design"]["budget"]["llm_limit"]:
                raise BotFlowError("本任务模型调用已达上限，请查看已有结果后决定下一步")
            t["usage"]["llm_calls"] += 1
        self._patch(task_id, "", reserve)

    async def _llm_text(self, task_id: str, provider: str, model: str, system: str,
                        message: str, images: Optional[List[str]] = None,
                        max_output_tokens: int = 3000, skill_id: str = "", isolated: bool = False) -> Tuple[str, str]:
        self._reserve_llm_call(task_id)
        skill = (self._snapshot(task_id).get("skill") or {}) if task_id else {}
        selected = {} if isolated else select_skill(self.host, message, skill_id or skill.get("skill_id", ""))
        payload = self.host.CanvasLLMRequest(
            message=message[:8000] or "继续",
            system_prompt=system,
            images=list(images or []),
            provider=provider,
            model=model,
            allow_model_fallback=not isolated,
            max_output_tokens=max_output_tokens,
            skill_id=selected.get("skill_id", ""),
        )
        response = await asyncio.wait_for(self.host.canvas_llm(payload), timeout=300)
        return str(response.get("text") or ""), str(response.get("model") or model)

    async def _llm_json(self, task_id: str, provider: str, model: str, system: str,
                        message: str, images: Optional[List[str]] = None,
                        max_output_tokens: int = 3000, retry_note: str = "", isolated: bool = False) -> Dict[str, Any]:
        note = retry_note or "上一次输出不是合法 JSON，请严格只输出一个 JSON 对象。"
        for attempt in range(2):
            text, _ = await self._llm_text(task_id, provider, model, system,
                                           message if attempt == 0 else f"{message}\n\n{note}",
                                           images=images, max_output_tokens=max_output_tokens, isolated=isolated)
            parsed = parse_model_json(text)
            if parsed is not None:
                return parsed
        raise BotFlowError("模型未返回有效的结构化结果，已重试一次；请重试或更换模型")

    def validate_model_choice(self, provider: str, model: str, kind: str) -> None:
        if not str(provider or "").strip() or not str(model or "").strip():
            raise HTTPException(status_code=422, detail="请先选择对话与生图模型")
        try:
            info = self.host.get_api_provider_exact(provider)
        except HTTPException as exc:
            raise HTTPException(status_code=422, detail=f"所选平台不可用：{exc.detail}") from exc
        protocol = str(info.get("protocol") or "")
        field = "chat_models" if kind == "chat" else "image_models"
        if kind == "chat" and protocol in {"codex", "gemini-cli", "jimeng"}:
            raise HTTPException(status_code=422, detail="设计大脑请选择普通 API 对话模型；CLI 模型请在原入口使用")
        choices = info.get(field) or []
        ids = {str(item.get("id") or item.get("name")) if isinstance(item, dict) else str(item) for item in choices}
        if model not in ids:
            raise HTTPException(status_code=422, detail="所选模型不在当前平台列表，请在设置中重新拉取并选择")

    # ------------------------------------------------------------------
    # 上下文构建
    # ------------------------------------------------------------------

    def profile_summary(self) -> Dict[str, Any]:
        try:
            state = self.profile_store.read()
        except DesignBrainError:
            return {}
        profile = state.get("profile") or {}
        if not (profile.get("privacy") or {}).get("allow_cloud_analysis"):
            return {}
        aesthetics = profile.get("aesthetics") or {}
        summary: Dict[str, Any] = {}
        for group in ("style_tags", "color_preferences", "composition", "lighting", "mood", "avoid_tags"):
            values = [str(item.get("tag") or "") for item in (aesthetics.get(group) or []) if isinstance(item, dict)]
            values = [value for value in values if value][:10]
            if values:
                summary[group] = values
        tone = profile.get("tone") or {}
        banned = [str(value) for value in (tone.get("banned_words") or []) if str(value).strip()][:10]
        if banned:
            summary["banned_words"] = banned
        summary["revision"] = state.get("revision") or 0
        return summary

    def reference_facets(self) -> Dict[str, Any]:
        try:
            data = self.references.list({}, 1, 0)
        except DesignBrainError:
            return {"total": 0}
        return {"total": data.get("total") or 0}

    def _reference_candidates(self, brief: Dict[str, Any]) -> List[Dict[str, Any]]:
        product = brief.get("product") or {}
        terms = [str(product.get("category") or ""), str(product.get("name") or "")]
        purpose = PURPOSE_BY_TASK_TYPE.get(str(brief.get("task_type") or "")) or ""
        if purpose:
            terms.append(purpose)
        query = " ".join(part for part in terms if part).strip()[:80]
        filters: Dict[str, Any] = {"q": query} if query else {}
        try:
            data = self.references.list(filters, REFERENCE_CANDIDATE_MAX, 0)
        except DesignBrainError:
            return []
        items = data.get("items") or []
        keywords = {term for term in re.split(r"[\s/、，,]+", query) if len(term) >= 2}
        ranked: List[Dict[str, Any]] = []
        for item in items:
            classification = item.get("classification") or {}
            analysis = item.get("analysis") or {}
            content = analysis.get("content") or {}
            haystack = " ".join([
                str(item.get("title") or ""), str(classification.get("category") or ""),
                str(classification.get("purpose") or ""), str(classification.get("expression") or ""),
                " ".join(str(tag) for tag in (classification.get("tags") or [])),
                str(content.get("purpose") or ""), str(content.get("composition") or ""),
                str(content.get("material") or ""), str(content.get("lighting") or ""),
                str(content.get("takeaways") or ""),
            ])
            score = sum(1 for term in keywords if term and term in haystack)
            ranked.append({
                "id": item.get("id"), "title": item.get("title") or "", "score": score,
                "category": classification.get("category") or "", "purpose": classification.get("purpose") or "",
                "expression": classification.get("expression") or "",
                "analysis_ready": analysis.get("status") == "ready",
                "takeaways": str(content.get("takeaways") or "")[:200],
                "composition": str(content.get("composition") or "")[:160],
                "material": str(content.get("material") or "")[:160],
                "lighting": str(content.get("lighting") or "")[:160],
                "thumb_url": f"/api/design-brain/references/{item.get('id')}/image?variant=thumb",
            })
        ranked.sort(key=lambda entry: (entry["score"], entry["analysis_ready"]), reverse=True)
        return ranked

    def _experience_candidates(self, brief: Dict[str, Any]) -> List[Dict[str, Any]]:
        query = " ".join([str(brief.get("goal") or ""), str(brief.get("style_direction") or ""),
                           str((brief.get("product") or {}).get("category") or "")])
        try:
            return self.experiences.search_published(query, limit=6)
        except (AttributeError, DesignBrainError):
            return []

    # ------------------------------------------------------------------
    # 管线
    # ------------------------------------------------------------------

    def start(self, task_id: str) -> None:
        runner = self.runners.get(task_id)
        if runner and not runner.done():
            return
        job = asyncio.create_task(self.drive(task_id))
        self.runners[task_id] = job
        job.add_done_callback(
            lambda finished, key=task_id: self.runners.pop(key, None) if self.runners.get(key) is finished else None)

    async def close(self) -> None:
        for job in list(self.runners.values()):
            job.cancel()
        await asyncio.gather(*list(self.runners.values()), return_exceptions=True)

    def resume_open_tasks(self) -> None:
        """启动恢复：非终态且不在等待确认的任务重新进入管线。"""
        try:
            tasks = self.tasks.list(limit=100)
        except DesignBrainError:
            return
        for task in tasks:
            if task["status"] in ("intake", "reference_analysis", "planning",
                                  "executing", "quality_check", "revision"):
                self._event(task["id"], task["status"], "recovered", "服务启动，任务恢复执行")
                self.start(task["id"])

    async def drive(self, task_id: str) -> None:
        try:
            while True:
                task = self._snapshot(task_id)
                status = task["status"]
                if status in AGENT_TASK_TERMINAL_STATUSES or status == "awaiting_confirmation":
                    return
                if status == "intake" or status == "reference_analysis":
                    await self._phase_references(task)
                elif status == "planning":
                    await self._phase_planning(task)
                elif status == "executing":
                    await self._phase_execute(task)
                elif status == "quality_check":
                    await self._phase_review(task)
                elif status == "revision":
                    await self._phase_revision(task)
                else:
                    return
        except BotCancelled as exc:
            self._cancel_task(task_id, str(exc) or "任务已取消")
        except BotFlowError as exc:
            self._fail_task(task_id, str(exc))
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # noqa: BLE001 - 管线兜底，任务显式失败可恢复
            self._fail_task(task_id, self.safe_error(exc))

    def _fail_task(self, task_id: str, message: str) -> None:
        try:
            current = self.tasks.get(task_id)
            if current["status"] in AGENT_TASK_TERMINAL_STATUSES:
                return
            run_id = (current.get("execution") or {}).get("design_run_id") or ""
            if run_id:
                try:
                    self.runs.complete(run_id, False, error=message[:300], note="BOT 任务失败")
                except DesignBrainError:
                    pass
            resume_phase = current["status"] if current["status"] not in AGENT_TASK_TERMINAL_STATUSES else ""
            self.tasks.patch(task_id, lambda t: (
                t.__setitem__("status", "failed"),
                t.__setitem__("error", message[:600]),
                t.__setitem__("resume_phase", resume_phase),
                t["events"].append({"at": now_ms(), "phase": resume_phase, "type": "failed", "note": message[:400]}),
            ))
        except DesignBrainError:
            pass

    def _cancel_task(self, task_id: str, reason: str) -> None:
        try:
            current = self.tasks.get(task_id)
            if current["status"] in AGENT_TASK_TERMINAL_STATUSES:
                return
            self.tasks.patch(task_id, lambda t: (
                t.__setitem__("status", "cancelled"),
                t.__setitem__("error", ""),
                t["events"].append({"at": now_ms(), "phase": "", "type": "cancelled", "note": reason[:400]}),
            ))
        except DesignBrainError:
            pass

    # -- 参考分析 BOT --------------------------------------------------

    async def _phase_references(self, task: Dict[str, Any]) -> None:
        task_id = task["id"]
        self._guard_cancelled(task_id)
        self._event(task_id, "reference_analysis", "phase_started", "参考分析 BOT 检索个人参考库")
        candidates = self._reference_candidates(task["brief"]) if self.profile_summary() else []
        if not candidates:
            self._patch(task_id, "reference_analysis", lambda t: t.__setitem__("status", "planning"))
            self._event(task_id, "reference_analysis", "phase_done", "参考库暂无相关案例，直接进入规划")
            self._bot_message(task_id, "reference", "参考库里没有找到相关案例，这次将只依据审美档案与商品信息规划。", "reference_analysis")
            return
        pool = candidates[:12]
        selected: List[Dict[str, Any]] = []
        try:
            message = json.dumps({
                "任务目标": task["brief"]["goal"],
                "商品": task["brief"]["product"],
                "视觉方向": task["brief"].get("style_direction") or "",
                "候选参考案例": [
                    {key: entry[key] for key in ("id", "title", "category", "purpose", "expression",
                                                 "analysis_ready", "takeaways", "composition", "material", "lighting")}
                    for entry in pool
                ],
            }, ensure_ascii=False)
            system = REFERENCE_SYSTEM.replace("{max_select}", str(REFERENCE_SELECT_MAX))
            system += "\n\n" + commerce_bot_guidance({"id": "bot_reference"})
            data = await self._llm_json(task_id, task["models"]["chat"]["provider"],
                                        task["models"]["chat"]["model"], system, message,
                                        max_output_tokens=1200)
            valid_ids = {entry["id"] for entry in pool}
            for entry in (data.get("selected") or [])[:REFERENCE_SELECT_MAX]:
                if not isinstance(entry, dict) or entry.get("id") not in valid_ids:
                    continue
                selected.append({
                    "id": str(entry.get("id")), "title": next(item["title"] for item in pool if item["id"] == entry.get("id")),
                    "score": entry.get("score") if isinstance(entry.get("score"), (int, float)) else 0.5,
                    "reason": str(entry.get("reason") or "")[:300],
                    "takeaways": str(entry.get("takeaways") or "")[:400],
                    "thumb_url": next(item["thumb_url"] for item in pool if item["id"] == entry.get("id")),
                })
        except BotFlowError as exc:
            self._event(task_id, "reference_analysis", "phase_warn", f"参考重排失败，改用关键词排序：{exc}")
        if not selected:
            selected = [
                {"id": entry["id"], "title": entry["title"], "score": min(1.0, entry["score"] / 4),
                 "reason": "与商品品类/用途关键词匹配", "takeaways": entry["takeaways"] or entry["composition"],
                 "thumb_url": entry["thumb_url"]}
                for entry in pool[:3] if entry["score"] > 0
            ]
        summary_note = "、".join(entry["title"] for entry in selected[:3]) or "无"
        self._patch(task_id, "reference_analysis", lambda t: (
            t.__setitem__("references", selected),
            t.__setitem__("status", "planning"),
        ))
        self._event(task_id, "reference_analysis", "phase_done", f"选中 {len(selected)} 条参考：{summary_note}")
        self._bot_message(task_id, "reference",
                          f"从参考库选出 {len(selected)} 条相关案例：" + "；".join(
                              f"《{entry['title']}》{entry['takeaways'][:40]}" for entry in selected[:3]), "reference_analysis")

    # -- 设计规划 BOT --------------------------------------------------

    async def _phase_directions(self, task):
        task_id = task["id"]
        context = {"任务单": task["brief"], "产品图数量": len(task["product_images"]),
                   "参考分析": task["references"], "审美档案": self.profile_summary()}
        model = task["models"]["chat"]
        data = await self._llm_json(task_id, model["provider"], model["model"], DIRECTION_SYSTEM,
                                    json.dumps(context, ensure_ascii=False), images=task["product_images"], max_output_tokens=2500)
        directions = normalize_directions(data.get("directions"))
        if not distinct_directions(directions):
            raise BotFlowError("设计方向缺少不同的构图与阅读次序，请重试方向规划；尚未提交生图")
        def save(t):
            t["design"]["directions"] = directions
            t["design"]["confirmation"] = "direction"
            t["status"] = "awaiting_confirmation"
        self._patch(task_id, "planning", save)
        self._bot_message(task_id, "planner", "已整理不同的设计方向，请在方案中比较构图草图，选择后可补充想保留的部分。", "planning")

    async def _phase_planning(self, task: Dict[str, Any]) -> None:
        task_id = task["id"]
        self._guard_cancelled(task_id)
        self._event(task_id, "planning", "phase_started", "设计规划 BOT 制定方案")
        if task["design"]["version"] and needs_exploration(task["brief"]) and not task["design"]["selection"]["direction_id"]:
            await self._phase_directions(task)
            return
        if not task["brief"].get("visual_rules_applied"):
            self._patch(task_id, "planning", lambda t: t["brief"].update(visual_rules_applied=True))
            task = self._snapshot(task_id)
        if sku_series_mode(task["brief"]) and (task["execution"].get("sku_anchor_url") or task["execution"].get("visual_anchor_url")):
            # 重新规划整组模板时生成新底图；已有图片与历史文件继续保留。
            self._patch(task_id, "planning", lambda t: (t["execution"].update(sku_anchor_url="", visual_anchor_url="", shots=[], design_run_id=""),
                                                       t.__setitem__("reviews", [])))
        references = []
        for entry in self._snapshot(task_id)["references"]:
            references.append({
                "title": entry["title"], "可借鉴点": entry["takeaways"], "相关理由": entry["reason"],
            })
        try:
            providers = self.host.load_api_providers()
        except Exception:  # noqa: BLE001 - 模型清单仅作提示，失败不阻塞
            providers = []
        image_choices = []
        for provider in providers or []:
            if not provider.get("enabled", True) or str(provider.get("protocol") or "") in {"codex", "gemini-cli"}:
                continue
            for model in (provider.get("image_models") or [])[:8]:
                model_id = str(model.get("id") or model.get("name")) if isinstance(model, dict) else str(model)
                image_choices.append(f"{provider.get('id')}:{model_id}")
        brief = task["brief"]
        experiences = self._experience_candidates(brief)
        if experiences:
            self._patch(task_id, "planning", lambda t: (
                t["design"].__setitem__("experience_ids", [item["id"] for item in experiences]),
                t["design"].__setitem__("experience_context", [f"{item['title']}：" + "；".join(item.get("observations", [])[:3]) for item in experiences]),
            ))
            task = self._snapshot(task_id)
        skill = task.get("skill") or select_skill(self.host, json.dumps(brief, ensure_ascii=False))
        if skill and not task.get("skill"):
            self._patch(task_id, "planning", lambda t: t.__setitem__("skill", skill))
            self._bot_message(task_id, "planner", f"已关联 Skill：{skill['name']}（{skill['selection_reason']}）", "planning")
        message = json.dumps({
            "任务单": {
                "类型": brief["task_type"], "目标": brief["goal"], "商品": brief["product"],
                "交付物": [entry.get("text") for entry in brief["deliverables"]],
                "视觉方向": brief["style_direction"],
                "历次调整": brief.get("adjustments") or [],
                "用户原始需求": brief.get("source_text") or "",
                "张数与清晰度": brief_image_requirements(brief),
            },
            "商品图数量": len(task["product_images"]),
            "参考案例分析": references,
            "审美档案摘要": self.profile_summary(),
            "可用生图模型（provider:model）": image_choices[:20],
            "当前使用的 Skill": skill,
            "已发布个人经验（只作为参考，不是硬性指令）": task["design"].get("experience_context", []),
            "已确认设计方向": next((d for d in task["design"]["directions"] if d["id"] == task["design"]["selection"]["direction_id"]), {}),
            "用户选择与组合意见": task["design"]["selection"],
        }, ensure_ascii=False)
        async def request_plan(system, message, tokens):
            return await self._llm_json(task_id, task["models"]["chat"]["provider"],
                                        task["models"]["chat"]["model"], system, message,
                                        images=task["product_images"], max_output_tokens=tokens)
        def save_batch(plan, total):
            self._guard_cancelled(task_id)
            self._patch(task_id, "planning", lambda t: t.__setitem__("plan", plan))
            self._event(task_id, "planning", "batch_planned",
                        f"已规划 {len(plan['shots'])}/{total or len(plan['shots'])} 张")
        try:
            data = await compose_batched_plan(request_plan, brief, message, on_batch=save_batch,
                                              before_batch=lambda: self._guard_cancelled(task_id),
                                              initial_plan=task["plan"] if brief.get("append_from") else None)
            shots = self._apply_plan_requirements(self._snapshot(task_id)["brief"], data["shots"], task)
        except DesignBrainError as exc:
            raise BotFlowError(exc.message) from exc
        plan = {
            "sku_scene": data.get("sku_scene") or "",
            "sku_layout": data.get("sku_layout") or {},
            "visual_framework": data.get("visual_framework") or {},
            "test_schedule": data.get("test_schedule") or [],
            "direction": data.get("direction") or "",
            "rationale": data.get("rationale") or "",
            "constraints_locked": [str(value) for value in (data.get("constraints_locked") or []) if str(value).strip()],
            "flexible": [str(value) for value in (data.get("flexible") or []) if str(value).strip()],
            "acceptance": [str(value) for value in (data.get("acceptance") or []) if str(value).strip()],
            "adjustment_options": data.get("adjustment_options") or [],
            "shots": shots,
        }
        apply_ecommerce_plan(brief, plan)
        auto_confirm = bool(task["auto_confirm"])
        self._patch(task_id, "planning", lambda t: (
            t.__setitem__("plan", plan),
            t.__setitem__("status", "executing" if auto_confirm else "awaiting_confirmation"),
        ))
        if task["design"]["version"]:
            count = sum(s["count"] for s in shots)
            def set_budget(t):
                t["design"]["confirmation"] = "generate"
                t["design"]["budget"] = {"llm_limit": max(40, math.ceil(len(shots) / PLANNING_BATCH_SIZE) * 4 + len(shots) * 4 + 12),
                                           "image_limit": t["usage"]["image_calls"] + count + min(count, 3)}
                t["design"]["sample_mode"] = bool(not auto_confirm and len(shots) > 1
                                                   and not t["brief"].get("append_from")
                                                   and (t["brief"].get("direction_mode") == "explore" or t["design"]["selection"]["direction_id"]))
                t["design"]["batch_confirmed"] = bool(auto_confirm)
                if auto_confirm:
                    t["design"]["confirmed_revision"] = t["design"]["revision"]
            self._patch(task_id, "planning", set_budget)
        if auto_confirm:
            self._event(task_id, "planning", "phase_done", f"方案已生成（{len(shots)} 张），本任务设为自动执行")
        else:
            self._event(task_id, "planning", "phase_done", f"方案已生成（{len(shots)} 张），等待用户确认")
        self._bot_message(task_id, "planner",
                          f"设计方向：{plan['direction'][:80]}\n共规划 {len(shots)} 张："
                          + "；".join(f"{shot.get('purpose') or shot.get('kind')}" for shot in shots[:6]), "planning")

    # -- 生成执行 BOT --------------------------------------------------

    def _ensure_design_run(self, task_id: str) -> str:
        task = self._snapshot(task_id)
        execution = task["execution"]
        if execution.get("design_run_id"):
            return execution["design_run_id"]
        profile = self.profile_summary()
        run = self.runs.create({
            "title": task["title"],
            "brief": task["brief"]["goal"],
            "skill": task.get("skill") or {},
            "profile_revision": profile.get("revision") or 0,
            "profile_summary": {group: values for group, values in profile.items() if isinstance(values, list)},
            "case_ids": [{"id": entry["id"], "title": entry["title"], "score": entry["score"]}
                         for entry in task["references"]],
            "plan": {"summary": task["plan"]["direction"], "prompt": "\n---\n".join(
                shot["prompt"] for shot in task["plan"]["shots"])[:4000]},
        })
        try:
            self.runs.confirm(run["id"])
        except DesignBrainError:
            pass
        self._patch(task_id, "executing", lambda t: t["execution"].__setitem__("design_run_id", run["id"]))
        self._event(task_id, "executing", "run_created", f"执行记录 {run['id']} 已建立")
        return run["id"]

    async def _phase_execute(self, task: Dict[str, Any]) -> None:
        task_id = task["id"]
        self._guard_cancelled(task_id)
        apply_ecommerce_plan(task["brief"], task["plan"])
        apply_sku_plan(task["brief"], task["plan"])
        self._event(task_id, "executing", "phase_started", "生成执行 BOT 提交生图任务")
        design_run_id = self._ensure_design_run(task_id)

        def sync_shots(t: Dict[str, Any]) -> None:
            plan_ids = [shot["id"] for shot in t["plan"]["shots"]]
            known = {shot["id"] for shot in t["execution"]["shots"]}
            for shot_id in plan_ids:
                if shot_id not in known:
                    t["execution"]["shots"].append({
                        "id": shot_id, "status": "pending", "canvas_task_ids": [],
                        "outputs": [], "error": "", "prompt_used": "", "attempt": 0,
                    })
            t["execution"]["shots"] = [shot for shot in t["execution"]["shots"] if shot["id"] in plan_ids]
            # 阶段重入（恢复/重试）：中断的 running 重新入队；全部失败的重试需要新的
            # 幂等尝试号，否则会找回已失败的上游任务。
            requeued = 0
            has_success = any(shot["status"] == "succeeded" for shot in t["execution"]["shots"])
            for shot in t["execution"]["shots"]:
                if shot["status"] == "running":
                    shot.update(status="pending", canvas_task_ids=[], outputs=[])
                    requeued += 1
                elif shot["status"] == "failed" and not has_success:
                    shot.update(status="pending", canvas_task_ids=[], outputs=[], error="")
                    plan_shot = next((item for item in t["plan"]["shots"] if item["id"] == shot["id"]), None)
                    if plan_shot:
                        plan_shot["revised"] = min(9, plan_shot.get("revised", 0) + 1)
                    requeued += 1
            if requeued:
                t["events"].append({"at": now_ms(), "phase": "executing", "type": "requeued",
                                    "note": f"{requeued} 张分镜重新入队生成"})

        self._patch(task_id, "executing", sync_shots)
        semaphore = asyncio.Semaphore(GENERATION_CONCURRENCY)
        while True:
            self._guard_cancelled(task_id)
            current = self._snapshot(task_id)
            pending = [shot["id"] for shot in current["execution"]["shots"]
                       if shot["status"] in ("pending", "running")]
            if current["design"]["version"] and current["design"]["sample_mode"] and not current["design"]["batch_confirmed"]:
                pending = [ident for ident in pending if ident == current["plan"]["shots"][0]["id"]]
            if not pending:
                break
            if is_sku_brief(current["brief"]):
                apply_sku_plan(current["brief"], current["plan"])
                anchor_id = current["plan"]["shots"][0]["id"]
                anchor = next(shot for shot in current["execution"]["shots"] if shot["id"] == anchor_id)
                if anchor_id in pending:
                    # 先得到场景基准，后续所有 SKU 引用同一张图，避免逐张接力累积漂移。
                    await self._execute_shot(task_id, anchor_id, semaphore, design_run_id)
                    ready = next(shot for shot in self._snapshot(task_id)["execution"]["shots"] if shot["id"] == anchor_id)
                    if ready["status"] == "succeeded" and ready["outputs"] and not self._snapshot(task_id)["execution"].get("sku_anchor_url"):
                        self._patch(task_id, "executing", lambda t: t["execution"].__setitem__(
                            "sku_anchor_url", ready["outputs"][0]["url"]))
                    continue
                if anchor["status"] != "succeeded" or not anchor["outputs"]:
                    if current["execution"].get("sku_anchor_url"):
                        raise BotFlowError(f"SKU 首张模板排字失败：{anchor['error']}；其余款式尚未生成")
                    raise BotFlowError("SKU 场景基准图生成失败，请重试；其余款式尚未生成")
                if not current["execution"].get("sku_anchor_url"):
                    self._patch(task_id, "executing", lambda t: t["execution"].__setitem__(
                        "sku_anchor_url", anchor["outputs"][0]["url"]))
            elif task_kind(current["brief"]) in ("main_image", "detail_images", "sku_variants") and not current["execution"].get("visual_anchor_url"):
                anchor_id = current["plan"]["shots"][0]["id"]
                anchor = next(s for s in current["execution"]["shots"] if s["id"] == anchor_id)
                if anchor_id in pending:
                    await self._execute_shot(task_id, anchor_id, semaphore, design_run_id)
                    anchor = next(s for s in self._snapshot(task_id)["execution"]["shots"] if s["id"] == anchor_id)
                    if anchor["status"] == "succeeded" and anchor["outputs"]:
                        self._patch(task_id, "executing", lambda t: t["execution"].__setitem__("visual_anchor_url", anchor["outputs"][0]["url"]))
                    else:
                        raise BotFlowError(f"首张风格基准生成失败：{anchor['error']}，其余图片尚未生成")
                    continue
                if anchor["status"] != "succeeded" or not anchor["outputs"]:
                    raise BotFlowError("首张风格基准尚未就绪，请重试第一张图")
                self._patch(task_id, "executing", lambda t: t["execution"].__setitem__("visual_anchor_url", anchor["outputs"][0]["url"]))
            results = await asyncio.gather(
                *(self._execute_shot(task_id, shot_id, semaphore, design_run_id) for shot_id in pending),
                return_exceptions=True)
            for result in results:
                if isinstance(result, (BotCancelled, BotFlowError)):
                    raise result
        current = self._snapshot(task_id)
        succeeded = [shot for shot in current["execution"]["shots"] if shot["status"] == "succeeded"]
        if not succeeded:
            raise BotFlowError("全部生图任务失败，请检查生图平台与模型后重试")
        self._patch(task_id, "executing", lambda t: t.__setitem__("status", "quality_check"))
        self._event(task_id, "executing", "phase_done",
                    f"生成完成：{len(succeeded)}/{len(current['execution']['shots'])} 张成功")

    async def _execute_shot(self, task_id: str, shot_id: str,
                            semaphore: asyncio.Semaphore, design_run_id: str) -> None:
        async with semaphore:
            await self._execute_shot_locked(task_id, shot_id, design_run_id)

    async def _render_sku_output(self, task_id, shot_id, template_url, design_run_id):
        task = self._snapshot(task_id)
        shot = next(s for s in task["plan"]["shots"] if s["id"] == shot_id)
        self._guard_cancelled(task_id)
        try:
            path = self.host.output_file_from_url(template_url)
            if not path:
                raise VisualRuleError("SKU 底图不是可读取的本地图片，请重试模板生成")
            content = await asyncio.to_thread(render_sku_image, path, task["plan"]["sku_layout"], shot["sku_values"])
            self._guard_cancelled(task_id)
            url, _path = await asyncio.to_thread(self.host.save_generated_image_bytes, content, prefix="sku_")
            asset = self.host.asset_registry_register_media(
                url, source="design_brain", kind="image",
                derived_from={"url": template_url, "operation": "sku-template-text"}) or {}
            output = {"url": url, "asset_ref_id": asset.get("id") or ""}
            record = {"type": "online", "history_source": "design_brain", "timestamp": time.time(),
                      "prompt": shot["prompt"], "model": "sku-template", "images": [url], "image_items": [output],
                      "design_run_id": design_run_id, "params": {"size": shot["size"], "paid_api": False,
                          "sku_values": shot["sku_values"], "reference_images": [{"url": template_url}],
                          "derived_from": {"url": template_url, "operation": "sku-template-text"}}}
            await asyncio.to_thread(self.host.save_to_history, record)
            self.runs.note_task(design_run_id, {"task_id": f"{task_id}_{shot_id}_v{shot['revised'] + 1}",
                "status": "succeeded", "model": "sku-template", "history_timestamp": record["timestamp"],
                "asset_refs": [output]})
            self._patch(task_id, "executing", lambda t: next(s for s in t["execution"]["shots"] if s["id"] == shot_id).update(
                status="succeeded", outputs=[output], error="", prompt_used=shot["prompt"], attempt=shot["revised"] + 1))
            self._event(task_id, "executing", "shot_done", f"{shot_id} 已按共同模板排入参数、赠品与属性名称")
        except (BotCancelled, asyncio.CancelledError):
            raise
        except Exception as exc:
            self._patch(task_id, "executing", lambda t: next(s for s in t["execution"]["shots"] if s["id"] == shot_id).update(
                status="failed", error=self.safe_error(exc)))
            self._event(task_id, "executing", "shot_failed", f"{shot_id} 模板排字失败：{self.safe_error(exc)}")

    async def _execute_shot_locked(self, task_id: str, shot_id: str, design_run_id: str) -> None:
        task = self._snapshot(task_id)
        plan_shot = next((shot for shot in task["plan"]["shots"] if shot["id"] == shot_id), None)
        exec_shot = next((shot for shot in task["execution"]["shots"] if shot["id"] == shot_id), None)
        if not plan_shot or not exec_shot:
            return
        self._guard_cancelled(task_id)
        attempt = plan_shot.get("revised", 0) + 1
        client_request_id = f"dbot_{task_id}_{shot_id}_v{attempt}"
        prompt = plan_shot["prompt"]
        if plan_shot.get("negative"):
            prompt = f"{prompt}。避免出现：{plan_shot['negative']}"
        if task_kind(task["brief"]) in ("main_image", "detail_images", "sku_variants"):
            prompt += "\n电商视觉框架锁定：" + json.dumps(task["plan"]["visual_framework"], ensure_ascii=False)
            if plan_shot.get("copy"):
                prompt += "\n本屏文案以此为准：" + json.dumps(plan_shot["copy"], ensure_ascii=False)
        reference_images = [
            self.host.AIReference(url=url, role=f"image_{index + 1}", kind="image")
            for index, url in enumerate(task["product_images"])
        ]
        edit_sources = [url for url in exec_shot.get("edit_source_urls", []) if str(url).strip()]
        if edit_sources:
            for url in edit_sources:
                reference_images.append(self.host.AIReference(url=url, role=f"edit_source_{len(reference_images) + 1}", kind="image"))
            prompt += "\n局部修改模式：最后的编辑源图片是上一版成品。保留其产品结构、构图、文字与已经成立的视觉关系，只执行本次修改要求；不要重新设计整张图。"
        if task_kind(task["brief"]) in ("main_image", "detail_images", "sku_variants") and task["execution"].get("visual_anchor_url"):
            reference_images.append(self.host.AIReference(url=task["execution"]["visual_anchor_url"], role=f"image_{len(reference_images) + 1}", kind="image"))
            if task_kind(task["brief"]) == "sku_variants":
                prompt += (f"\n图{len(reference_images)}是全组场景基准，统一背景、装裱工艺、构图、光线、机位、比例与品牌；"
                           "本款框色和窗口内照片等外观按已确认提示词变化，不照抄基准图的照片内容，不添加模板文字位。")
            else:
                prompt += (f"\n图{len(reference_images)}是全组风格基准，统一配色、产品外观与机位、字体字级和品牌标识；"
                           "本图的内容分工、画幅与版式按已确认方案执行。")
        if is_sku_brief(task["brief"]):
            apply_sku_plan(task["brief"], task["plan"])
            anchor_url = task["execution"].get("sku_anchor_url") or ""
            if anchor_url:
                await self._render_sku_output(task_id, shot_id, anchor_url, design_run_id)
                return
            prompt = ("生成整组SKU共用的无可变文字底图，只生成一次。产品主体、Logo与所有固定设计放在文字信息位以外，"
                      "不要出现任何参数、赠品、属性名称或占位字，三个信息位留干净纯色。\n共同场景：" + task["plan"]["sku_scene"]
                      + "\n全组视觉框架：" + json.dumps(task["plan"]["visual_framework"], ensure_ascii=False)
                      + "\n固定文字信息位：" + json.dumps(task["plan"]["sku_layout"], ensure_ascii=False)
                      + "\n真实商品及约束：" + json.dumps(task["brief"]["product"], ensure_ascii=False))
        payload = self.host.OnlineImageRequest(
            prompt=prompt,
            provider_id=task["models"]["image"]["provider"],
            model=task["models"]["image"]["model"],
            size=plan_shot["size"],
            resolution=plan_shot.get("resolution") or task["brief"].get("resolution", "").lower(),
            aspect_ratio=plan_shot.get("aspect_ratio") or "",
            n=plan_shot["count"],
            client_request_id=client_request_id,
            history_source="design_brain",
            design_run_id=design_run_id,
            skill_id=(task.get("skill") or {}).get("skill_id", ""),
            skill_name=(task.get("skill") or {}).get("name", ""),
            skill_applied=bool((task.get("skill") or {}).get("skill_id")),
            reference_images=reference_images,
        )
        def reserve_image(t):
            if t["status"] != "executing":
                raise BotCancelled()
            if t["design"]["version"] and t["usage"]["image_calls"] + plan_shot["count"] > t["design"]["budget"]["image_limit"]:
                raise BotFlowError("本任务已达到确认的生图调用上限，请查看已有版本后决定下一步")
            t["usage"]["image_calls"] += plan_shot["count"]
            next(s for s in t["execution"]["shots"] if s["id"] == shot_id).update(
                status="running", canvas_task_ids=[], outputs=[], error="", prompt_used=prompt, attempt=attempt)
        self._patch(task_id, "executing", reserve_image)
        try:
            response = await self.host.create_canvas_image_task(payload)
            canvas_task_id = str(response.get("task_id") or "")
        except Exception as exc:  # noqa: BLE001 - 单张失败不拖垮整批
            self._patch(task_id, "executing", lambda t: next(
                shot for shot in t["execution"]["shots"] if shot["id"] == shot_id
            ).update(status="failed", error=self.safe_error(exc)))
            self._event(task_id, "executing", "shot_failed", f"{shot_id} 提交失败：{self.safe_error(exc)}")
            return
        if not canvas_task_id:
            self._patch(task_id, "executing", lambda t: next(
                shot for shot in t["execution"]["shots"] if shot["id"] == shot_id
            ).update(status="failed", error="生图服务未返回任务编号"))
            return
        self._patch(task_id, "executing", lambda t: next(
            shot for shot in t["execution"]["shots"] if shot["id"] == shot_id
        )["canvas_task_ids"].append(canvas_task_id))
        elapsed = 0.0
        while elapsed < CANVAS_TASK_TIMEOUT_SECONDS:
            self._guard_cancelled(task_id)
            await asyncio.sleep(CANVAS_TASK_POLL_INTERVAL)
            elapsed += CANVAS_TASK_POLL_INTERVAL
            try:
                remote = await self.host.get_canvas_image_task(canvas_task_id)
            except HTTPException as exc:
                if exc.status_code == 404:
                    remote = {"status": "failed", "error": "生图任务记录不存在"}
                else:
                    continue
            status = str(remote.get("status") or "")
            if status not in CANVAS_TASK_TERMINAL and status != "jimeng_pending":
                continue
            result = remote.get("result") if isinstance(remote.get("result"), dict) else {}
            outputs = []
            for item in (result.get("image_items") or []):
                if isinstance(item, dict) and item.get("url"):
                    output = {"url": item["url"], "asset_ref_id": item.get("asset_ref_id") or ""}
                    for key in ("product_fidelity", "fidelity_report", "width", "height", "mime_type"):
                        if key in item:
                            output[key] = item[key]
                    outputs.append(output)
            if status in {"succeeded", "completed", "success", "done"} and outputs:
                if is_sku_brief(task["brief"]):
                    template_url = outputs[0]["url"]
                    self._patch(task_id, "executing", lambda t: t["execution"].__setitem__("sku_anchor_url", template_url))
                    await self._render_sku_output(task_id, shot_id, template_url, design_run_id)
                    return
                self._patch(task_id, "executing", lambda t: next(
                    shot for shot in t["execution"]["shots"] if shot["id"] == shot_id
                ).update(status="succeeded", outputs=outputs, error=""))
                self._event(task_id, "executing", "shot_done", f"{shot_id} 生成成功（{len(outputs)} 张）")
            else:
                error = str(remote.get("error") or remote.get("message") or f"生图任务状态异常：{status or '未知'}")
                self._patch(task_id, "executing", lambda t: next(
                    shot for shot in t["execution"]["shots"] if shot["id"] == shot_id
                ).update(status="failed", error=error[:400]))
                self._event(task_id, "executing", "shot_failed", f"{shot_id} 生成失败：{error[:200]}")
            return
        try:
            await self.host.cancel_canvas_image_task(canvas_task_id)
        except Exception:  # noqa: BLE001 - 超时兜底，取消失败不影响状态标记
            pass
        self._patch(task_id, "executing", lambda t: next(
            shot for shot in t["execution"]["shots"] if shot["id"] == shot_id
        ).update(status="failed", error="生成超时（15 分钟），已停止等待"))
        self._event(task_id, "executing", "shot_failed", f"{shot_id} 生成超时")

    # -- 质量检查 BOT --------------------------------------------------

    @staticmethod
    def _shot_review_round(task: Dict[str, Any], shot_id: str) -> int:
        rounds = [review["round"] for review in task["reviews"] if review["shot_id"] == shot_id]
        return max(rounds) if rounds else 0

    def _review_references(self, task):
        import base64
        import io
        from PIL import Image
        try:
            profile = self.profile_store.read().get("profile") or {}
            privacy = profile.get("privacy") or {}
            if not privacy.get("allow_cloud_analysis") or not privacy.get("allow_reference_analysis"):
                return []
            refs = []
            for chosen in task["references"]:
                item = self.references.get(chosen["id"])
                relative = item.get("file", {}).get("media") or item.get("file", {}).get("thumb")
                path = (self.references.root / relative).resolve()
                if not path.is_relative_to(self.references.root.resolve()):
                    continue
                with Image.open(path) as original:
                    image = original.convert("RGB")
                    image.thumbnail((1536, 1536))
                    output = io.BytesIO()
                    image.save(output, format="JPEG", quality=90)
                refs.append({"url": "data:image/jpeg;base64," + base64.b64encode(output.getvalue()).decode("ascii")})
            return refs
        except (DesignBrainError, OSError, ValueError, TypeError):
            return []

    async def _phase_review(self, task: Dict[str, Any]) -> None:
        task_id = task["id"]
        self._guard_cancelled(task_id)
        self._event(task_id, "quality_check", "phase_started", "质量检查 BOT 对照产品原图与已确认方向检查产物")
        review_round = max([r["round"] for r in task["reviews"]], default=0) + 1
        vision = task["models"]["vision"]
        reference_images = self._review_references(task)
        for plan_shot in task["plan"]["shots"]:
            exec_shot = next((s for s in task["execution"]["shots"] if s["id"] == plan_shot["id"]), None)
            if not exec_shot or exec_shot["status"] != "succeeded" or not exec_shot["outputs"]:
                continue
            if self._shot_review_round(self._snapshot(task_id), plan_shot["id"]) >= exec_shot["attempt"]:
                continue
            self._guard_cancelled(task_id)
            contract, images = review_contract(task, plan_shot, exec_shot["outputs"],
                                               profile=self.profile_summary(), references=reference_images)
            local_checks = inspect_shot(task, plan_shot, exec_shot, getattr(self.host, "output_file_from_url", None))
            entry = {"round": review_round, "shot_id": plan_shot["id"], "verdict": "needs_human",
                     "checked_at": now_ms(), "model": vision["model"], "plan_revision": task["design"]["revision"],
                     "input_manifest": contract["图片顺序与比较要求"],
                     "local_checks": local_checks,
                     "issues": [{"severity": "minor", "area": "other", "description": "质检没有返回可靠结果，需要人工确认",
                                 "evidence": "", "suggestion": "请对照原图和已选方向检查"}]}
            system = REVIEWER_SYSTEM if task_kind(task["brief"]) else REVIEWER_SYSTEM.split("\n\n" + ECOMMERCE_RULES)[0]
            system += "\n独立审核：以产品原图、已确认方向和验收点为依据。逐项看结构、颜色、比例、文字、留白、层级、参考语言和AI痕迹。不要把系列基准自身的错误当成标准。没有原文不能认证文字准确，没有几何依据不能认证真实尺寸。每个问题补充cause、preserve、verification，说明原因线索、应保留项和复检方法。看不清必须needs_human；不提出无依据的换风格建议。"
            try:
                data = await self._llm_json(task_id, vision["provider"], vision["model"], system,
                                            json.dumps(contract, ensure_ascii=False), images=images,
                                            max_output_tokens=2400, isolated=True)
                verdict = data.get("verdict")
                issues = data.get("issues")
                if verdict not in ("pass", "issues", "needs_human") or not isinstance(issues, list):
                    raise BotFlowError("审核结果缺少判定或问题清单")
                if any(not isinstance(i, dict) or not str(i.get("description") or "").strip() for i in issues):
                    raise BotFlowError("审核问题缺少具体描述")
                if verdict == "issues" and not issues:
                    raise BotFlowError("审核未提供可定位的问题")
                if verdict == "pass" and issues:
                    verdict = "issues"
                if is_sku_brief(task["brief"]) and verdict == "issues":
                    verdict = "needs_human"
                entry.update(verdict=verdict, issues=issues[:8])
            except BotFlowError as exc:
                entry["issues"][0]["description"] = f"质检无法完成，需要人工确认：{exc}"
            if local_checks["status"] == "fail":
                entry["verdict"] = "issues"
                entry["issues"] = (entry.get("issues") or []) + [{
                    "severity": "major", "area": "composition", "description": "本地确定性检查发现输出画幅或文件问题",
                    "evidence": "; ".join(issue for check in local_checks["checks"] for issue in check.get("issues", []))[:400],
                    "suggestion": "保持已确认方向，修正该分镜的输出画幅后重新生成",
                    "cause": "model_limit", "preserve": "方向、文案与商品约束", "verification": "重新检查实际像素尺寸与画幅比例",
                }]
            self._patch(task_id, "quality_check", lambda t, e=entry: t["reviews"].append(e))

        await self._phase_group_review(task_id, review_round, task)

        current = self._snapshot(task_id)
        latest = {}
        for review in current["reviews"]:
            latest[review["shot_id"]] = review
        shot_ids = {shot["id"] for shot in current["plan"]["shots"]}
        repairable = [r for r in latest.values() if r["shot_id"] in shot_ids and r["verdict"] == "issues"
                      and any(i["severity"] in ("critical", "major") for i in r["issues"])]
        if repairable and not is_sku_brief(current["brief"]) and current["usage"]["auto_revisions"] < MAX_AUTO_REVISIONS:
            self._patch(task_id, "quality_check", lambda t: t.__setitem__("status", "revision"))
            self._event(task_id, "quality_check", "phase_done", "发现需修正的问题，先分析原因与处理方式")
            return
        quality = acceptance_status(current)
        sample_waiting = (current["design"]["version"] and current["design"]["sample_mode"]
                          and not current["design"]["batch_confirmed"]
                          and any(s["status"] == "pending" for s in current["execution"]["shots"]))
        if sample_waiting and quality == "passed":
            def await_batch(t):
                t["design"]["acceptance"] = {"status": "passed", "note": "代表性样图审核通过，其余分镜待确认"}
                t["design"]["confirmation"] = "batch"
                t["status"] = "awaiting_confirmation"
            self._patch(task_id, "quality_check", await_batch)
            self._bot_message(task_id, "director", "样图审核通过。请查看样图并确认后续批量生成，未确认的分镜仍在等待。", "awaiting_confirmation")
            return
        self._finish_review(task_id, quality)
        await self._phase_deliver(self._snapshot(task_id), review_round)

    async def _phase_group_review(self, task_id: str, review_round: int, task: Dict[str, Any]) -> None:
        """Review the set once after per-shot checks; only enabled for explicit design tasks."""
        brief = task["brief"]
        design = task["design"]
        if not design["version"] or not (brief.get("direction_mode") in ("fixed", "explore") or design["selection"].get("direction_id")):
            return
        current = self._snapshot(task_id)
        if any(review.get("round") == review_round and review.get("shot_id") == "__group__" for review in current["reviews"]):
            return
        outputs = []
        manifest = []
        for plan_shot in current["plan"]["shots"]:
            execution = next((item for item in current["execution"]["shots"] if item["id"] == plan_shot["id"]), None)
            if not execution or execution["status"] != "succeeded":
                continue
            for output in execution["outputs"][:1]:
                outputs.append(output["url"])
                manifest.append({"image": len(outputs), "shot_id": plan_shot["id"], "purpose": plan_shot["purpose"]})
        if len(outputs) < 2:
            return
        local_group = inspect_group(current, getattr(self.host, "output_file_from_url", None))
        entry = {"round": review_round, "shot_id": "__group__", "verdict": "needs_human",
                 "checked_at": now_ms(), "model": current["models"]["vision"]["model"],
                 "plan_revision": design["revision"], "input_manifest": manifest,
                 "local_checks": local_group, "issues": []}
        message = json.dumps({"任务目标": brief["goal"], "已确认方向": design["selection"],
                              "整组方案": [{"id": shot["id"], "purpose": shot["purpose"], "acceptance": shot["acceptance"]}
                                          for shot in current["plan"]["shots"]],
                              "整组本地检查": local_group}, ensure_ascii=False)
        try:
            data = await self._llm_json(task_id, current["models"]["vision"]["provider"], current["models"]["vision"]["model"],
                                        GROUP_REVIEW_SYSTEM, message, images=outputs, max_output_tokens=1800, isolated=True)
            verdict = data.get("verdict")
            issues = data.get("issues") if isinstance(data.get("issues"), list) else []
            if verdict not in ("pass", "issues", "needs_human"):
                raise BotFlowError("整组审核没有返回可靠判定")
            if verdict == "pass" and issues:
                verdict = "issues"
            entry.update(verdict=verdict, issues=issues[:8])
        except BotFlowError as exc:
            entry["verdict"] = "needs_human"
            entry["issues"] = [{"severity": "minor", "area": "consistency", "description": f"整组审核无法完成：{exc}",
                                 "evidence": "、".join(item["shot_id"] for item in manifest), "suggestion": "请人工并排检查整组色彩、机位与留白", "cause": "uncertain", "preserve": "已确认方向", "verification": "并排查看所有分镜"}]
        if local_group["status"] == "issues":
            entry["verdict"] = "issues"
            entry["issues"] = (entry.get("issues") or []) + local_group["issues"]
        self._patch(task_id, "quality_check", lambda t: t["reviews"].append(entry))

    def _finish_review(self, task_id, quality, note=""):
        task = self._snapshot(task_id)
        if task["execution"].get("design_run_id"):
            try:
                self.runs.complete(task["execution"]["design_run_id"], True, note="生成结束；质量结论见设计任务")
            except DesignBrainError:
                pass
        def finish(t):
            t["status"] = "delivered"
            t["design"]["acceptance"] = {"status": quality, "note": note}
        self._patch(task_id, "quality_check", finish)
        self._event(task_id, "quality_check", "phase_done", {"passed": "已审核通过", "needs_fix": "生成结束，仍有待修改项",
                    "needs_human": "生成结束，需要人工复核"}.get(quality, "生成结束"))

    async def _phase_revision(self, task: Dict[str, Any]) -> None:
        task_id = task["id"]
        self._guard_cancelled(task_id)
        current = self._snapshot(task_id)
        latest = {}
        for review in current["reviews"]:
            latest[review["shot_id"]] = review
        targets = {key: r for key, r in latest.items() if r["verdict"] == "issues"
                   and any(i["severity"] in ("critical", "major") for i in r["issues"])}
        model = current["models"]["chat"]
        try:
            data = await self._llm_json(task_id, model["provider"], model["model"], REPAIR_SYSTEM,
                json.dumps({"任务": current["brief"], "已确认方案": current["plan"],
                            "用户选择": current["design"]["selection"], "审核证据": list(targets.values())}, ensure_ascii=False),
                max_output_tokens=4000, isolated=True)
            revised = {str(s.get("id") or ""): s for s in data.get("shots", []) if isinstance(s, dict)}
            limit = current["design"]["budget"]["image_limit"]
            needed = sum(s["count"] for s in current["plan"]["shots"] if s["id"] in targets)
            valid = (data.get("strategy") == "regenerate" and data.get("cause") in ("reference", "planning", "prompt")
                     and set(revised) == set(targets) and targets
                     and (not current["design"]["version"] or current["usage"]["image_calls"] + needed <= limit)
                     and all(isinstance(s.get("prompt"), str) and s["prompt"].strip()
                             and len(s["prompt"]) <= 3500 for s in revised.values()))
            if not valid:
                # A malformed repair response must never cause an unbounded retry.
                # If the reviewer supplied concrete suggestions, one deterministic
                # bounded pass is still safe; otherwise stop for human choice.
                fallback = {shot_id: {"prompt": "修正要求：" + "\n".join(i["suggestion"] or i["description"] for i in review["issues"] if i.get("suggestion") or i.get("description"))}
                            for shot_id, review in targets.items()}
                if targets and all(item["prompt"] for item in fallback.values()) and (not current["design"]["version"] or current["usage"]["image_calls"] + needed <= limit):
                    revised, data = fallback, {"cause": "prompt", "reason": "审核已给出具体修改建议，按建议执行一轮", "preserve": []}
                else:
                    reason = str(data.get("reason") or "当前问题需要人工选择修改方式或补充资料")[:600]
                    self._patch(task_id, "revision", lambda t: t["design"]["repairs"].append({
                        "revision": t["design"]["revision"], "cause": str(data.get("cause") or "uncertain"),
                        "strategy": "needs_human", "reason": reason, "shot_ids": list(targets)}))
                    self._finish_review(task_id, "needs_human", reason)
                    return
        except BotFlowError as exc:
            self._finish_review(task_id, "needs_human", f"修改原因尚未确认：{exc}")
            return
        def apply_revision(t):
            snapshot_version(t)
            for shot in t["plan"]["shots"]:
                if shot["id"] not in targets:
                    continue
                patch = revised[shot["id"]]
                locks = "；".join(t["plan"]["constraints_locked"] + t["brief"]["product"]["constraints"])
                prompt = patch["prompt"].strip() + ("\n必须保留：" + locks if locks else "")
                if len(prompt) > 4000:
                    raise BotFlowError("修订提示词超出长度，请精简后再执行")
                shot["prompt"] = prompt
                shot["revised"] += 1
                entry = next(s for s in t["execution"]["shots"] if s["id"] == shot["id"])
                entry.update(status="pending", canvas_task_ids=[], outputs=[], error="", attempt=0)
            t["design"]["repairs"].append({"revision": t["design"]["revision"], "cause": data["cause"],
                "strategy": "regenerate", "reason": str(data.get("reason") or "")[:600],
                "preserve": [str(s)[:300] for s in data.get("preserve", [])[:8]], "shot_ids": list(targets)})
            t["usage"]["auto_revisions"] += 1
            t["status"] = "executing"
        self._patch(task_id, "revision", apply_revision)
        self._event(task_id, "revision", "phase_done", f"已定位原因并修订 {len(targets)} 张分镜，保留其他产物")

    async def _phase_deliver(self, task: Dict[str, Any], review_round: int) -> None:
        task_id = task["id"]
        current = self._snapshot(task_id)
        round_reviews = [review for review in current["reviews"] if review["round"] == review_round]
        summary_input = json.dumps({
            "任务": current["title"],
            "生成结果": [
                {"用途": next((shot["purpose"] for shot in current["plan"]["shots"] if shot["id"] == shot["id"]), ""),
                 "状态": shot["status"], "张数": len(shot["outputs"])}
                for shot in current["execution"]["shots"]
            ],
            "质检结论": [
                {"verdict": review["verdict"], "问题": [issue["description"] for issue in review["issues"]]}
                for review in round_reviews
            ],
        }, ensure_ascii=False)
        reply = ""
        try:
            data = await self._llm_json(task_id, current["models"]["chat"]["provider"],
                                        current["models"]["chat"]["model"],
                                        DIRECTOR_SUMMARY_SYSTEM, summary_input, max_output_tokens=800)
            reply = str(data.get("reply") or "")
        except (BotFlowError, DesignBrainError):
            reply = ""
        if not reply:
            ok = sum(1 for shot in current["execution"]["shots"] if shot["status"] == "succeeded")
            warn = len([review for review in round_reviews if review["verdict"] == "needs_human"])
            reply = f"任务完成：成功生成 {ok} 张；{warn} 张需要人工确认，请在右侧工作区查看。"
        self._bot_message(task_id, "director", reply, "delivered")
        self._event(task_id, "delivered", "phase_done", "任务已交付，可在工作区查看成果与质检结果")

    # ------------------------------------------------------------------
    # 对话入口（设计总监）
    # ------------------------------------------------------------------

    def _director_context(self, task: Optional[Dict[str, Any]]) -> str:
        context: Dict[str, Any] = {
            "审美档案摘要": self.profile_summary(),
            "参考库概况": self.reference_facets(),
            "当前任务": None,
        }
        if task:
            context["当前任务"] = {
                "id": task["id"], "标题": task["title"], "状态": task["status"],
                "视觉方向": (task["plan"] or {}).get("direction") or "",
                "分镜数": len((task["plan"] or {}).get("shots") or []),
                "最近事件": task["events"][-1]["note"] if task["events"] else "",
            }
        return json.dumps(context, ensure_ascii=False)

    async def chat(self, *, task_id: str, message: str, product_images: List[str],
                   models: Dict[str, Any], auto_confirm: Optional[bool], source_text: str = "",
                   skill_id: str = "") -> Dict[str, Any]:
        selected_skill = select_skill(self.host, source_text or message, skill_id)
        chat_provider = str((models.get("chat") or {}).get("provider") or "")
        chat_model = str((models.get("chat") or {}).get("model") or "")
        self.validate_model_choice(chat_provider, chat_model, "chat")
        image_provider = str((models.get("image") or {}).get("provider") or "")
        image_model = str((models.get("image") or {}).get("model") or "")
        self.validate_model_choice(image_provider, image_model, "image")
        vision = models.get("vision") or models.get("chat") or {}
        vision_provider = str(vision.get("provider") or chat_provider)
        vision_model = str(vision.get("model") or chat_model)
        self.validate_model_choice(vision_provider, vision_model, "chat")

        validated_images = []
        for url in product_images:
            url = str(url or "").strip()
            if not url:
                continue
            if not self.host.output_file_from_url(url):
                raise HTTPException(status_code=422, detail="商品图无法读取：请从图片空间选择或先上传")
            validated_images.append(url)

        task: Optional[Dict[str, Any]] = None
        if task_id:
            try:
                task = self.tasks.get(task_id)
            except DesignBrainError:
                task = None
        if task and task["status"] in AGENT_TASK_TERMINAL_STATUSES:
            task = None
        effective_task_id = task["id"] if task else ""

        def append_user() -> None:
            if effective_task_id:
                self.tasks.add_message(effective_task_id, "user", "director", message)

        if effective_task_id:
            append_user()
        system = DIRECTOR_SYSTEM + "\n\n" + commerce_bot_guidance({"id": "bot_director"})
        system += "\n\n上下文（JSON）：" + self._director_context(task)
        if validated_images:
            system += f"\n用户随消息附带了 {len(validated_images)} 张商品图。"
        data: Optional[Dict[str, Any]] = None
        raw_text = ""
        try:
            text, _ = await self._llm_text(effective_task_id,
                                           chat_provider, chat_model, system, message,
                                           images=validated_images,
                                           max_output_tokens=1600, skill_id=selected_skill.get("skill_id", ""))
            raw_text = text
            data = parse_model_json(text)
        except BotFlowError as exc:
            raise HTTPException(status_code=502, detail=str(exc)) from exc
        if data is None:
            # 有界重试一次；仍然失败时降级：有开放任务→纯回答；无任务且消息像需求→建最小任务。
            try:
                text, _ = await self._llm_text(effective_task_id, chat_provider, chat_model,
                                               system, message + "\n\n请严格只输出一个 JSON 对象。",
                                               images=validated_images,
                                               max_output_tokens=1600, skill_id=selected_skill.get("skill_id", ""))
                raw_text = text
                data = parse_model_json(text)
            except BotFlowError as exc:
                raise HTTPException(status_code=502, detail=str(exc)) from exc
        reply = str((data or {}).get("reply") or raw_text or "收到。")[:1200]
        intent = str((data or {}).get("intent") or "answer")
        if intent not in ("create_task", "answer", "revise_plan", "cancel_task"):
            intent = "answer"
        if data is None and not effective_task_id and len(message.strip()) >= 8:
            intent = "create_task"
            data = {"reply": reply, "brief": {}}
        if analysis_only(source_text or message):
            intent = "answer"

        if intent == "create_task":
            brief = self._normalize_brief(data.get("brief") or {}, source_text or message)
            created = self.tasks.create({
                "design": {"version": 1, "revision": 1},
                "title": (brief.get("goal") or message)[:60] or "设计任务",
                "status": "reference_analysis",
                "models": {"chat": {"provider": chat_provider, "model": chat_model},
                           "vision": {"provider": vision_provider, "model": vision_model},
                           "image": {"provider": image_provider, "model": image_model}},
                "auto_confirm": bool(auto_confirm) if auto_confirm is not None else not brief.get("need_confirmation", True),
                "brief": brief,
                "skill": selected_skill,
                "product_images": validated_images,
            })
            self.tasks.add_message(created["id"], "user", "director", message)
            self.tasks.add_message(created["id"], "bot", "director", reply, "intake")
            self._event(created["id"], "intake", "created", "设计总监创建任务，进入参考分析")
            self.start(created["id"])
            return {"reply": reply, "task_id": created["id"], "task": self.tasks.get(created["id"])}

        if intent == "revise_plan" and task and task["status"] == "awaiting_confirmation":
            if task["usage"]["replans"] >= MAX_REPLANS:
                raise HTTPException(status_code=409, detail="重规划次数已达上限，请新建任务")
            brief = self._normalize_brief({**task["brief"], **(data.get("brief") or {})}, source_text or message)
            brief.update({**brief_image_requirements(task["brief"]), **image_requirements(source_text or message)})
            brief.setdefault("adjustments", [])
            brief["adjustments"] = (task["brief"].get("adjustments") or []) + [message[:300]]

            def replan(t: Dict[str, Any]) -> None:
                invalidate_confirmation(t, archive=True)
                t["brief"] = brief
                t["status"] = "planning"
                t["usage"]["replans"] = min(999, t["usage"]["replans"] + 1)
                t["events"].append({"at": now_ms(), "phase": "awaiting_confirmation",
                                    "type": "replan", "note": f"按用户反馈重新规划：{message[:200]}"})

            self.tasks.patch(task["id"], replan)
            self.tasks.add_message(task["id"], "bot", "director", reply, "planning")
            self.start(task["id"])
            return {"reply": reply, "task_id": task["id"], "task": self.tasks.get(task["id"])}

        if intent == "cancel_task" and task:
            await self.cancel(task["id"], "用户在对话中取消")
            if effective_task_id:
                self.tasks.add_message(effective_task_id, "bot", "director", reply, "cancelled")
            return {"reply": reply, "task_id": task["id"], "task": self.tasks.get(task["id"])}

        if effective_task_id:
            self.tasks.add_message(effective_task_id, "bot", "director", reply)
            return {"reply": reply, "task_id": effective_task_id, "task": self.tasks.get(effective_task_id)}
        return {"reply": reply, "task_id": "", "task": None}

    def _normalize_brief(self, raw: Dict[str, Any], message: str) -> Dict[str, Any]:
        brief = raw if isinstance(raw, dict) else {}
        task_type = str(brief.get("task_type") or "")
        if task_type not in ("main_image", "detail_images", "creative", "other"):
            task_type = "other"
        task_type = infer_task_type(message, task_type)
        if task_type == "main_image" and image_requirements(message).get("image_count") == 1:
            task_type = "creative"
        product = brief.get("product") if isinstance(brief.get("product"), dict) else {}
        goal = str(brief.get("goal") or "").strip()
        if not goal:
            goal = message.strip()[:300]
        return {
            **brief_image_requirements(brief),
            **image_requirements(message),
            "series_mode": sku_series_mode({**brief, "source_text": str(brief.get("source_text") or "") + "\n" + message}),
            "source_text": str(brief.get("source_text") or message)[:8000],
            "visual_rules_applied": True,
            "aspect_ratio": image_requirements(message).get("aspect_ratio") or str(brief.get("aspect_ratio") or ""),
            "task_type": task_type,
            "goal": goal,
            "product": {
                "name": str(product.get("name") or "")[:120],
                "category": str(product.get("category") or "")[:60],
                "features": [str(value)[:80] for value in (product.get("features") or [])[:12] if str(value).strip()],
                "constraints": [str(value)[:160] for value in (product.get("constraints") or [])[:12] if str(value).strip()],
            },
            "deliverables": [{"text": str(entry.get("text") or "")[:300]}
                             for entry in (brief.get("deliverables") or [])
                             if isinstance(entry, dict) and str(entry.get("text") or "").strip()],
            "style_direction": str(brief.get("style_direction") or "")[:600],
            "direction_mode": brief.get("direction_mode", "auto"),
            "need_confirmation": bool(brief.get("need_confirmation", True)),
        }

    async def confirm_task(self, task_id, payload):
        if not payload.approved:
            await self.cancel(task_id, "用户拒绝了方案")
            return self.tasks.get(task_id)
        def confirm(t):
            if t["status"] != "awaiting_confirmation":
                raise DesignBrainError("invalid_transition", "只有等待确认的任务可以确认方案", 409)
            design = t["design"]
            if design["version"] and payload.expected_revision is not None and payload.expected_revision != design["revision"]:
                raise DesignBrainError("stale_plan", "方案已变化，请刷新并确认当前版本", 409)
            confirmation = payload.confirmation or design["confirmation"]
            if confirmation == "direction" and design["version"]:
                selected = next((d for d in design["directions"] if d["id"] == payload.direction_id), None)
                if not selected:
                    raise DesignBrainError("invalid_direction", "请选择当前方案中的一个设计方向", 422)
                design["selection"] = {"direction_id": selected["id"], "feedback": payload.feedback}
                design["revision"] += 1
                design["confirmation"] = "generate"
                t["brief"]["style_direction"] = selected["intent"] + "；" + selected["composition"]
                t["status"] = "planning"
            else:
                if design["confirmation"] == "batch" and payload.shot_edits:
                    raise DesignBrainError("changed_batch", "批量确认期间请保留已审核的方案；要修改请先提交调整意见", 422)
                edits = {str(e.get("id") or ""): e for e in payload.shot_edits if isinstance(e, dict)}
                known = {s["id"] for s in t["plan"]["shots"]}
                if set(edits) - known:
                    raise DesignBrainError("invalid_shot", "修改包含不存在的分镜，请刷新方案后重试", 422)
                guard_append_edits(t, edits)
                for shot in t["plan"]["shots"]:
                    edit = edits.get(shot["id"], {})
                    for key in ("prompt", "negative", "size", "sku_values"):
                        if key in edit:
                            shot[key] = edit[key]
                    if "count" in edit:
                        shot["count"] = max(1, min(2, int(edit["count"])))
                t["plan"]["shots"] = self._apply_plan_requirements(t["brief"], t["plan"]["shots"], t)
                if not t["plan"]["shots"]:
                    raise DesignBrainError("invalid_plan", "方案尚未完成，请先完成设计规划", 422)
                apply_ecommerce_plan(t["brief"], t["plan"])
                apply_sku_plan(t["brief"], t["plan"])
                if design["version"]:
                    design["confirmed_revision"] = design["revision"]
                    if design["confirmation"] == "batch":
                        design["batch_confirmed"] = True
                    else:
                        design["sample_mode"] = bool(len(t["plan"]["shots"]) > 1 and not t["brief"].get("append_from")
                                                      and (t["brief"].get("direction_mode") == "explore" or design["selection"]["direction_id"]))
                        design["batch_confirmed"] = False
                    pending = sum(s["count"] for s in t["plan"]["shots"] if not any(e["id"] == s["id"] and e["status"] == "succeeded" for e in t["execution"]["shots"]))
                    design["budget"]["image_limit"] = t["usage"]["image_calls"] + pending + min(pending, 3)
                t["status"] = "executing"
            t["events"].append({"at": now_ms(), "phase": "awaiting_confirmation", "type": "confirmed", "note": "用户确认当前设计版本"})
        task = self.tasks.patch(task_id, confirm)
        self.start(task_id)
        return task

    def update_requirements(self, task_id: str, text: str) -> Dict[str, Any]:
        task = self.tasks.get(task_id)
        requirements = image_requirements(text)
        if not requirements or task["status"] not in {"reference_analysis", "planning", "awaiting_confirmation"}:
            return task
        def update(t):
            invalidate_confirmation(t, archive=True)
            t["brief"].update(requirements)
            t["brief"]["adjustments"] = (t["brief"].get("adjustments") or []) + [text[:2000]]
            if t["status"] == "awaiting_confirmation" and "resolution" in requirements:
                # 数量不符的旧方案继续保留待调整，由确认门禁阻止生成。
                t["plan"]["shots"] = self._apply_plan_requirements(
                    {"resolution": t["brief"]["resolution"]},
                    t["plan"]["shots"], t)
        return self.tasks.patch(task_id, update)

    def append_detail_screens(self, task_id: str, count: int, feedback: str = "") -> Dict[str, Any]:
        task = self.tasks.get(task_id)
        if task["brief"]["task_type"] != "detail_images" or task["status"] != "delivered":
            raise DesignBrainError("invalid_transition", "只有已交付的详情页可以继续加屏", 409)
        if isinstance(count, bool) or not isinstance(count, int) or count < 1:
            raise DesignBrainError("invalid_plan", "请填写要追加的屏数（至少1屏）", 422)
        apply_ecommerce_plan(task["brief"], task["plan"])
        def append(t):
            invalidate_confirmation(t, archive=True)
            existing = len(t["plan"]["shots"])
            t["brief"].update(append_from=existing, image_count=existing + count)
            t["brief"]["adjustments"] = (t["brief"].get("adjustments") or []) + [f"在原详情页后追加{count}屏：{feedback}"]
            t["status"] = "planning"
            t["auto_confirm"] = False
            t["execution"]["design_run_id"] = ""
        self.tasks.patch(task_id, append)
        self.start(task_id)
        return self.tasks.get(task_id)

    async def delete(self, task_id: str) -> None:
        await self.cancel(task_id, "用户删除任务")
        runner = self.runners.get(task_id)
        if runner and runner is not asyncio.current_task() and not runner.done():
            runner.cancel()
            await asyncio.gather(runner, return_exceptions=True)
        self.tasks.delete(task_id)

    async def cancel(self, task_id: str, reason: str) -> Dict[str, Any]:
        task = self.tasks.get(task_id)
        if task["status"] in AGENT_TASK_TERMINAL_STATUSES:
            return task
        self._cancel_task(task_id, reason)
        runner = self.runners.get(task_id)
        if runner and runner is not asyncio.current_task() and not runner.done():
            runner.cancel()
            await asyncio.gather(runner, return_exceptions=True)
        for entry in task["execution"]["shots"]:
            for canvas_task_id in entry["canvas_task_ids"]:
                try:
                    remote = await self.host.get_canvas_image_task(canvas_task_id)
                except HTTPException:
                    continue
                if str(remote.get("status") or "") not in CANVAS_TASK_TERMINAL:
                    try:
                        await self.host.cancel_canvas_image_task(canvas_task_id)
                    except HTTPException:
                        pass
        run_id = task["execution"].get("design_run_id") or ""
        if run_id:
            try:
                self.runs.cancel(run_id)
            except DesignBrainError:
                pass

        def change(t: Dict[str, Any]) -> None:
            t["status"] = "cancelled"
            t["error"] = ""
            t["events"].append({"at": now_ms(), "phase": "", "type": "cancelled", "note": reason[:400]})

        return self.tasks.patch(task_id, change)


# ----------------------------------------------------------------------
# API 安装（仿 multi_agent_api：路由闭包持有 orchestrator 与 host）
# ----------------------------------------------------------------------

# FastAPI resolves postponed route annotations from module globals.
class BotChatRequest(BaseModel):
    task_id: str = Field(default="", max_length=60)
    message: str = Field(min_length=1, max_length=8000)
    product_images: List[str] = Field(default_factory=list)
    models: Dict[str, Any] = Field(default_factory=dict)
    auto_confirm: Optional[bool] = None
    skill_id: str = Field(default="", max_length=120)


class BotConfirmRequest(BaseModel):
    approved: bool = True
    shot_edits: List[Dict[str, Any]] = Field(default_factory=list)
    expected_revision: Optional[int] = Field(default=None, ge=0)
    confirmation: str = Field(default="", max_length=20)
    direction_id: str = Field(default="", max_length=32)
    feedback: str = Field(default="", max_length=2000)


class BotCancelRequest(BaseModel):
    reason: str = Field(default="", max_length=400)


class BotReplanRequest(BaseModel):
    feedback: str = Field(min_length=1, max_length=2000)
    expected_revision: Optional[int] = Field(default=None, ge=0)


class BotReviseRequest(BaseModel):
    shot_ids: List[str] = Field(default_factory=list)
    feedback: str = Field(default="", max_length=2000)
    expected_revision: Optional[int] = Field(default=None, ge=0)
    mode: str = Field(default="replace", max_length=20)


class BotAppendRequest(BaseModel):
    count: int = Field(ge=1, strict=True)
    feedback: str = Field(default="", max_length=2000)


class BotFeedbackRequest(BaseModel):
    rating: int = Field(ge=1, le=5)
    comment: str = Field(default="", max_length=400)


def install_design_brain_bots(app, host) -> DesignBotOrchestrator:
    orchestrator = DesignBotOrchestrator(host, AgentTaskStore(DATA_ROOT))
    prefix = "/api/design-brain/bot"

    def _local_only(request: Request) -> None:
        _local_only_dependency(request)

    @app.on_event("startup")
    async def design_bot_recovery() -> None:
        orchestrator.resume_open_tasks()

    @app.on_event("shutdown")
    async def design_bot_shutdown() -> None:
        await orchestrator.close()

    @app.get(prefix + "/config")
    async def bot_config(request: Request):
        _local_only(request)
        return {
            "bots": BOT_CATALOG,
            "limits": {
                "max_shots": None, "max_llm_calls": None,
                "max_image_calls": None, "planning_batch_size": PLANNING_BATCH_SIZE, "max_auto_revisions": MAX_AUTO_REVISIONS,
                "max_user_revisions": MAX_USER_REVISIONS, "max_replans": MAX_REPLANS,
                "generation_concurrency": GENERATION_CONCURRENCY,
            },
        }

    @app.post(prefix + "/chat")
    async def bot_chat(payload: BotChatRequest, request: Request):
        _local_only(request)
        _ensure_same_origin(request)
        result = await orchestrator.chat(
            task_id=payload.task_id, message=payload.message,
            product_images=payload.product_images, models=payload.models,
            auto_confirm=payload.auto_confirm, skill_id=payload.skill_id)
        return result

    @app.get(prefix + "/tasks")
    async def bot_tasks(request: Request, limit: int = 30):
        _local_only(request)
        return {"tasks": orchestrator.tasks.list(limit=max(1, min(100, limit)))}

    @app.get(prefix + "/tasks/{task_id}")
    async def bot_task(task_id: str, request: Request):
        _local_only(request)
        try:
            return {"task": orchestrator.tasks.get(task_id)}
        except DesignBrainError as error:
            raise HTTPException(status_code=error.status, detail=error.message) from error

    @app.delete(prefix + "/tasks/{task_id}")
    async def bot_delete_task(task_id: str, request: Request):
        _local_only(request)
        _ensure_same_origin(request)
        try:
            await orchestrator.delete(task_id)
        except DesignBrainError as error:
            raise HTTPException(status_code=error.status, detail=error.message) from error
        return {"ok": True}

    @app.post(prefix + "/tasks/{task_id}/confirm")
    async def bot_confirm(task_id: str, payload: BotConfirmRequest, request: Request):
        _local_only(request)
        _ensure_same_origin(request)
        try:
            task = await orchestrator.confirm_task(task_id, payload)
        except DesignBrainError as error:
            raise HTTPException(status_code=error.status, detail=error.message) from error
        return {"task": task}

    @app.post(prefix + "/tasks/{task_id}/cancel")
    async def bot_cancel(task_id: str, payload: BotCancelRequest, request: Request):
        _local_only(request)
        _ensure_same_origin(request)
        task = await orchestrator.cancel(task_id, payload.reason or "用户取消任务")
        return {"task": task}

    @app.post(prefix + "/tasks/{task_id}/replan")
    async def bot_replan(task_id: str, payload: BotReplanRequest, request: Request):
        _local_only(request)
        _ensure_same_origin(request)
        task = orchestrator.tasks.get(task_id)
        if task["status"] != "awaiting_confirmation":
            raise HTTPException(status_code=409, detail="只有等待确认的任务可以按反馈重新规划")
        if task["usage"]["replans"] >= MAX_REPLANS:
            raise HTTPException(status_code=409, detail="重规划次数已达上限，请新建任务")

        def replan(t: Dict[str, Any]) -> None:
            if t["design"]["version"] and payload.expected_revision is not None and payload.expected_revision != t["design"]["revision"]:
                raise DesignBrainError("stale_plan", "方案已变化，请刷新当前版本后提交调整", 409)
            invalidate_confirmation(t, archive=True)
            t["brief"].setdefault("adjustments", [])
            t["brief"]["adjustments"] = (t["brief"].get("adjustments") or []) + [payload.feedback]
            t["brief"].update(image_requirements(payload.feedback))
            t["status"] = "reference_analysis"
            t["usage"]["replans"] = min(999, t["usage"]["replans"] + 1)
            t["events"].append({"at": now_ms(), "phase": "awaiting_confirmation",
                                "type": "replan", "note": f"用户要求重新规划：{payload.feedback[:200]}"})

        try:
            orchestrator.tasks.patch(task_id, replan)
        except DesignBrainError as error:
            raise HTTPException(status_code=error.status, detail=error.message) from error
        orchestrator.start(task_id)
        return {"task": orchestrator.tasks.get(task_id)}

    @app.post(prefix + "/tasks/{task_id}/revise")
    async def bot_revise(task_id: str, payload: BotReviseRequest, request: Request):
        _local_only(request)
        _ensure_same_origin(request)
        task = orchestrator.tasks.get(task_id)
        if task["status"] != "delivered":
            raise HTTPException(status_code=409, detail="只有已交付的任务可以继续修改")
        try:
            apply_ecommerce_plan(task["brief"], task["plan"])
            apply_sku_plan(task["brief"], task["plan"])
        except DesignBrainError as error:
            raise HTTPException(status_code=error.status,
                                detail="这组旧 SKU 方案尚未锁定共同场景，请新建设计任务并重新规划，再生成整组图片") from error
        if task["usage"]["user_revisions"] >= MAX_USER_REVISIONS:
            raise HTTPException(status_code=409, detail="修改轮数已达上限，请新建任务")
        if payload.mode not in ("replace", "local_edit"):
            raise HTTPException(status_code=422, detail="修改模式只能是 replace 或 local_edit")
        shot_ids = {value for value in payload.shot_ids if value} or {
            shot["id"] for shot in task["plan"]["shots"]}

        def revise(t: Dict[str, Any]) -> None:
            if t["design"]["version"] and payload.expected_revision is not None and payload.expected_revision != t["design"]["revision"]:
                raise DesignBrainError("stale_plan", "方案已变化，请刷新当前版本后修改", 409)
            invalidate_confirmation(t, archive=True)
            for shot in t["plan"]["shots"]:
                if shot["id"] not in shot_ids:
                    continue
                if payload.feedback and not is_sku_brief(t["brief"]):
                    shot["prompt"] = f"{shot['prompt']}\n修改要求：{payload.feedback}"[:4000]
                shot["revised"] = min(9, shot.get("revised", 0) + 1)
                entry = next((item for item in t["execution"]["shots"] if item["id"] == shot["id"]), None)
                if entry:
                    if payload.mode == "local_edit":
                        entry["edit_source_urls"] = [output["url"] for output in entry.get("outputs", []) if output.get("url")][:4]
                    else:
                        entry["edit_source_urls"] = []
                    entry.update(status="pending", canvas_task_ids=[], outputs=[], error="", attempt=0)
            t["usage"]["user_revisions"] = min(999, t["usage"]["user_revisions"] + 1)
            t["design"]["repairs"].append({"revision": t["design"]["revision"], "strategy": payload.mode,
                                           "reason": payload.feedback[:600], "shot_ids": list(shot_ids)})
            t["status"] = "awaiting_confirmation" if is_sku_brief(t["brief"]) or t["design"]["version"] else "executing"
            if is_sku_brief(t["brief"]):
                t["brief"]["adjustments"] = (t["brief"].get("adjustments") or []) + [payload.feedback or "修改所选SKU的信息位"]
            t["events"].append({"at": now_ms(), "phase": "delivered",
                                "type": "user_revision", "note": f"用户要求修改：{payload.feedback[:200] or '全部重新生成'}"})

        try:
            orchestrator.tasks.patch(task_id, revise)
        except DesignBrainError as error:
            raise HTTPException(status_code=error.status, detail=error.message) from error
        run_id = task["execution"].get("design_run_id") or ""
        if run_id:
            try:
                RUNS.complete(run_id, True, note="用户发起继续修改，本轮交付结束")
            except DesignBrainError:
                pass
        # 继续修改需要一条新的执行记录，保持追溯链完整。
        orchestrator.tasks.patch(task_id, lambda t: t["execution"].__setitem__("design_run_id", ""))
        orchestrator.start(task_id)
        return {"task": orchestrator.tasks.get(task_id)}

    @app.post(prefix + "/tasks/{task_id}/append")
    async def bot_append(task_id: str, payload: BotAppendRequest, request: Request):
        _local_only(request)
        _ensure_same_origin(request)
        try:
            return {"task": orchestrator.append_detail_screens(task_id, payload.count, payload.feedback)}
        except DesignBrainError as error:
            raise HTTPException(status_code=error.status, detail=error.message) from error

    @app.post(prefix + "/tasks/{task_id}/feedback")
    async def bot_feedback(task_id: str, payload: BotFeedbackRequest, request: Request):
        _local_only(request)
        _ensure_same_origin(request)
        task = orchestrator.tasks.get(task_id)
        if task["status"] != "delivered":
            raise HTTPException(status_code=409, detail="只有已交付的任务可以提交反馈")
        if int((task.get("feedback") or {}).get("rating") or 0):
            raise HTTPException(status_code=409, detail="这个设计任务已经保存过反馈")
        experience = None
        try:
            review_notes = [review.get("issues", [])[0].get("description", "")
                            for review in task.get("reviews", []) if review.get("issues")]
            experience = EXPERIENCES.create({
                "title": f"任务反馈：{task['title']}"[:80],
                "project_id": task["brief"].get("product", {}).get("name", ""),
                "origin": {"type": "task_feedback", "note": f"设计任务 {task_id} 的用户反馈（评分 {payload.rating}/5）"},
                "observations": [
                    f"用户对「{task['title']}」的生成结果评分 {payload.rating}/5。",
                    *( [f"用户评语：{payload.comment}"] if payload.comment else [] ),
                    f"方案方向：{task['plan'].get('direction') or task['brief'].get('style_direction') or ''}"[:200],
                    f"使用模型：{task['models']['image']['model']}",
                    *(f"审核问题：{note}" for note in review_notes[:3]),
                ],
                "evidence": {
                    "asset_refs": [{"url": output["url"]} for shot in task["execution"]["shots"]
                                   for output in shot["outputs"]][:8],
                    "canvas_ids": [task["execution"].get("design_run_id", "")],
                },
                "proposals": {"profile_patch": []},
            })
            try:
                experience = EXPERIENCES.record_impact(experience["id"], task_id=task_id, rating=payload.rating)
            except DesignBrainError:
                pass
        except DesignBrainError:
            experience = None

        # Task feedback also enters the same QualityReview stream used by the
        # Skill statistics page, so a Skill version can be compared across runs.
        skill = task.get("skill") or {}
        if skill.get("skill_id"):
            for shot in task["execution"]["shots"]:
                for output in shot.get("outputs", [])[:1]:
                    try:
                        REVIEWS.create({
                            "target": {"url": output.get("url", ""), "asset_ref_id": output.get("asset_ref_id", ""),
                                       "run_id": task["execution"].get("design_run_id", "")},
                            "context": {"skill_id": skill.get("skill_id", ""), "skill_name": skill.get("name", ""),
                                        "skill_version": skill.get("version", ""), "model": task["models"]["image"].get("model", ""),
                                        "provider_id": task["models"]["image"].get("provider", ""), "size": next((s.get("size", "") for s in task["plan"]["shots"] if s["id"] == shot["id"]), ""),
                                        "reference_count": len(task.get("references", [])),
                                        "reference_digest": hashlib.sha256("|".join(item.get("id", "") for item in task.get("references", [])).encode()).hexdigest()[:16],
                                        "prompt_digest": hashlib.sha256(next((s.get("prompt", "") for s in task["plan"]["shots"] if s["id"] == shot["id"]), "").encode()).hexdigest()[:16]},
                            "user_feedback": {"rating": payload.rating, "comment": payload.comment, "selected_as_final": payload.rating >= 4},
                            "issue_tag": "other",
                        })
                    except DesignBrainError:
                        pass
        for experience_id in task.get("design", {}).get("experience_ids", []):
            try:
                EXPERIENCES.record_impact(experience_id, task_id=task_id, rating=payload.rating)
            except DesignBrainError:
                pass

        def apply_feedback(t: Dict[str, Any]) -> None:
            t["feedback"] = {
                "rating": payload.rating,
                "comment": payload.comment,
                "experience_id": (experience or {}).get("id", "") if experience else "",
            }
            t["events"].append({"at": now_ms(), "phase": "delivered", "type": "feedback",
                                "note": f"用户反馈 {payload.rating}/5{'：' + payload.comment if payload.comment else ''}"})

        orchestrator.tasks.patch(task_id, apply_feedback)
        return {"task": orchestrator.tasks.get(task_id),
                "experience": experience,
                "note": "反馈已保存；提炼的经验只是候选，需在「项目经验」里审核发布后才会影响档案。"}

    @app.post(prefix + "/tasks/{task_id}/resume")
    async def bot_resume(task_id: str, request: Request):
        _local_only(request)
        _ensure_same_origin(request)
        task = orchestrator.tasks.get(task_id)
        if task["status"] != "failed":
            raise HTTPException(status_code=409, detail="只有失败的任务可以重试")
        resume_phase = task.get("resume_phase") or "reference_analysis"
        if resume_phase in AGENT_TASK_TERMINAL_STATUSES:
            resume_phase = "reference_analysis"

        def resume(t: Dict[str, Any]) -> None:
            t["status"] = resume_phase
            t["error"] = ""
            t["events"].append({"at": now_ms(), "phase": resume_phase, "type": "resumed",
                                "note": "用户重试失败阶段"})

        orchestrator.tasks.patch(task_id, resume)
        orchestrator.start(task_id)
        return {"task": orchestrator.tasks.get(task_id)}

    return orchestrator
