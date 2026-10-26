"""Design choices, revision snapshots and review evidence for the existing BOT task."""
from __future__ import annotations

from copy import deepcopy
import re


DIRECTION_SYSTEM = """你是小美画布的设计方向探索助手。先理解目的和产品，再制定2至3个有实质区别的设计方向。
只输出JSON：{"directions":[{"id":"a","title":"方向名","intent":"一句指导取舍的设计意图","composition":"具体构图与留白","hierarchy":"标题、主体与辅助信息的阅读次序","focus":"视觉重点","palette":["#F5F1E8","#303030"],"typography":"字体性格与字级关系","layout":"center|split|diagonal|editorial","reason":"适合本任务的理由","avoid":"主动放弃的做法"}]}。
候选共用真实产品信息和核心内容，任意两个候选的构图、阅读次序、视觉重点至少两项不同；只换色不算新方向。
用户已锁定的品牌、商品、文案与参考语言必须保留，不虚构产品事实。layout用于展示构图草图，必须与composition一致。
不生成图片，不安排多套完整分镜，不使用网页控件或动效标准。"""

REPAIR_SYSTEM = """你是小美画布的设计修正负责人。根据原始需求、已确认方向和独立审核证据判断失败原因。
只输出JSON：{"cause":"reference|planning|prompt|model_limit|uncertain","reason":"具体原因与证据","strategy":"regenerate|needs_human","preserve":["必须保留的有效选择"],"shots":[{"id":"分镜ID","prompt":"修订后的完整提示词","acceptance":["复检目标"]}]}。
只修改点名的分镜，保留真实产品、已锁定约束、已确认文字和方向；修改要落成具体可检查的变化。
只有无需改变已确认方向且通过重新生成可解决的问题才用regenerate。需要局部编辑、精确排字、换模型、换方向、资料不足或能力限制时用needs_human，说明下一步；不要声称工具已经执行。
不凭空添加卖点、部件、文案；不重复追加模糊形容词。"""

GROUP_REVIEW_SYSTEM = """你是小美画布的整组视觉审核 BOT。你会看到同一任务的多张最终产物，以及每张图的用途和已确认视觉方向。
只输出 JSON：{"verdict":"pass|issues|needs_human","issues":[{"severity":"major|minor","area":"consistency|composition|text|other","description":"整组中具体可定位的问题","evidence":"涉及的图号或画面证据","suggestion":"可执行的整组修正建议","preserve":"必须保持的统一关系","verification":"复检方法"}]}。
检查色彩、主体比例、机位、光线、背景、字体与文字层级、品牌位置、留白和画面完成度是否统一；不同分镜的用途差异不算问题。
不要因为看不清商品事实而猜测；无法可靠判断时用 needs_human。不要提出换方向，除非整组明显偏离已确认方向。"""


def text(value, limit=600):
    return str(value or "").strip()[:limit]


def integer(value, default=0):
    try:
        return max(0, int(value)) if not isinstance(value, bool) else default
    except (TypeError, ValueError, OverflowError):
        return default


def normalize_directions(raw):
    result = []
    for item in raw[:3] if isinstance(raw, list) else []:
        if not isinstance(item, dict):
            continue
        entry = {key: text(item.get(key), 600 if key in ("composition", "hierarchy") else 300)
                 for key in ("id", "title", "intent", "composition", "hierarchy", "focus", "typography", "reason", "avoid")}
        if not re.fullmatch(r"[a-zA-Z0-9_-]{1,32}", entry["id"]) or any(e["id"] == entry["id"] for e in result):
            continue
        if not all(entry[k] for k in ("title", "intent", "composition", "hierarchy", "focus")):
            continue
        entry["layout"] = item.get("layout") if item.get("layout") in ("center", "split", "diagonal", "editorial") else "center"
        entry["palette"] = [c for c in item.get("palette", [])[:3] if isinstance(c, str) and re.fullmatch(r"#[0-9a-fA-F]{6}", c)] if isinstance(item.get("palette"), list) else []
        result.append(entry)
    return result


def distinct_directions(directions):
    if len(directions) < 2:
        return False
    for i, left in enumerate(directions):
        for right in directions[i + 1:]:
            # Require different visible skeletons as well as different verbal descriptions.
            if left["layout"] == right["layout"] or sum(left[k] != right[k] for k in ("composition", "hierarchy", "focus")) < 2:
                return False
    return True


def normalize_design(raw):
    value = raw if isinstance(raw, dict) else {}
    selection = value.get("selection") if isinstance(value.get("selection"), dict) else {}
    budget = value.get("budget") if isinstance(value.get("budget"), dict) else {}
    acceptance = value.get("acceptance") if isinstance(value.get("acceptance"), dict) else {}
    status = acceptance.get("status")
    return {
        "version": min(1, integer(value.get("version"))),
        "revision": integer(value.get("revision")),
        "confirmed_revision": integer(value.get("confirmed_revision")),
        "confirmation": value.get("confirmation") if value.get("confirmation") in ("direction", "generate", "batch") else "generate",
        "directions": normalize_directions(value.get("directions")),
        "selection": {"direction_id": text(selection.get("direction_id"), 32), "feedback": text(selection.get("feedback"), 2000)},
        "experience_ids": [text(value, 60) for value in (value.get("experience_ids") if isinstance(value.get("experience_ids"), list) else [])[:8] if text(value, 60)],
        "experience_context": [text(value, 400) for value in (value.get("experience_context") if isinstance(value.get("experience_context"), list) else [])[:8] if text(value, 400)],
        "sample_mode": bool(value.get("sample_mode")),
        "batch_confirmed": bool(value.get("batch_confirmed")),
        "budget": {"llm_limit": integer(budget.get("llm_limit"), 40), "image_limit": integer(budget.get("image_limit"))},
        "acceptance": {"status": status if status in ("unreviewed", "passed", "needs_fix", "needs_human", "user_accepted") else "unreviewed",
                       "note": text(acceptance.get("note"), 1000)},
        "repairs": deepcopy(value.get("repairs", [])[-8:]) if isinstance(value.get("repairs"), list) else [],
        "versions": deepcopy(value.get("versions", [])[-12:]) if isinstance(value.get("versions"), list) else [],
    }


def snapshot_version(task):
    design = task["design"]
    revision = design["revision"]
    if any(v.get("revision") == revision for v in design["versions"]):
        return
    design["versions"].append({"revision": revision, "selection": deepcopy(design["selection"]),
        "plan": deepcopy(task["plan"]), "execution": deepcopy(task["execution"]),
        "reviews": deepcopy(task["reviews"]), "acceptance": deepcopy(design["acceptance"])})
    design["versions"] = design["versions"][-12:]


def invalidate_confirmation(task, *, archive=False):
    design = task["design"]
    if not design["version"]:
        return
    if archive:
        snapshot_version(task)
    design["revision"] += 1
    design["confirmed_revision"] = 0
    design["confirmation"] = "generate"
    design["acceptance"] = {"status": "unreviewed", "note": ""}


def needs_exploration(brief):
    mode = brief.get("direction_mode")
    source = brief.get("source_text") or ""
    if brief.get("series_mode") or mode == "fixed" or re.search(r"只要一个方向|不(?:用|要)多方案|只改|仅改|只换|仅换", source):
        return False
    return mode == "explore" or bool(re.search(r"探索|不同(?:方案|风格|方向)|(?:两|三|2|3|几)(?:个|种|套)(?:方案|方向|风格)|没想好|方向不确定", source)) or not brief.get("style_direction")


def analysis_only(message):
    return bool(re.search(r"只(?:需|要)?(?:分析|讨论|写提示词|给提示词)|(?:不要|不需要|先不|暂不)(?:生成|生图|出图)|仅(?:分析|讨论)|先分析[^。\n]*(?:再说|别生成)", message))


def review_contract(task, shot, outputs, *, profile=None, references=None):
    images = []
    manifest = []
    def add(url, role):
        if url and url not in images:
            images.append(url)
            manifest.append({"image": len(images), "role": role})
    for output in outputs[:2]:
        add(output.get("url"), "待审核产物")
    # Product/reference pixels leave the machine only after the existing privacy
    # gates have produced a non-empty profile summary.
    if profile:
        for url in task["product_images"]:
            add(url, "原始产品图，产品事实依据")
    for ref in references or []:
        add(ref.get("url"), "已选设计参考，仅借鉴视觉关系")
    anchor = task["execution"].get("sku_anchor_url") or task["execution"].get("visual_anchor_url")
    add(anchor, "最后一张是全组固定场景基准；先核对其产品结构，不能继承错误" if task["brief"].get("series_mode") == "sku" else "系列视觉基准；先核对其产品结构，不能继承错误")
    selection = task.get("design", {}).get("selection", {})
    selected = next((d for d in task.get("design", {}).get("directions", []) if d["id"] == selection.get("direction_id")), {})
    contract = {"任务目标": task["brief"]["goal"], "产品事实": task["brief"]["product"],
        "本图用途": shot["purpose"] or shot["kind"], "原文文案": shot.get("copy") or {},
        "本图验收点": shot["acceptance"], "整体验收": task["plan"]["acceptance"],
        "锁定约束": task["plan"]["constraints_locked"], "已确认方向": selected or task["plan"].get("direction", ""),
        "用户选择与反馈": selection, "个人审美基线": profile or {}, "图片顺序与比较要求": manifest,
        "SKU制作方式": task["brief"].get("series_mode", ""), "SKU共同场景": task["plan"].get("sku_scene", ""),
        "SKU本款外观": shot.get("sku_variant", ""), "SKU允许变化的信息位": shot.get("sku_values", {}),
        "全组视觉框架": task["plan"].get("visual_framework", {})}
    return contract, images


def acceptance_status(task):
    latest = {}
    for review in task["reviews"]:
        latest[review["shot_id"]] = review
    outputs = [s for s in task["execution"]["shots"] if s["status"] == "succeeded" and s["outputs"]]
    group = latest.get("__group__")
    if group and group.get("verdict") == "issues":
        return "needs_fix"
    if group and group.get("verdict") == "needs_human":
        return "needs_human"
    if any(s["status"] in ("failed", "skipped") for s in task["execution"]["shots"]):
        return "needs_fix"
    if any(latest.get(s["id"], {}).get("verdict") == "issues" for s in outputs):
        return "needs_fix"
    if not outputs or any(latest.get(s["id"], {}).get("verdict") != "pass" for s in outputs):
        return "needs_human"
    return "passed"
