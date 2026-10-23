"""Write and verify the machine readable capability declarations of Skills.

A Skill declares the host capabilities it needs in the ``capabilities`` key of
its ``SKILL.md`` front matter.  The identifiers come from the closed
vocabulary in ``skill_capabilities.py``.

Usage::

    python tools/skill-capabilities/apply.py --check     # verify only
    python tools/skill-capabilities/apply.py --apply     # write the declarations
    python tools/skill-capabilities/apply.py --apply --packages-dir <dir>

``--check`` fails when a Skill has no declaration, when the declaration does
not match the mapping below, or when an identifier is not registered.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO_ROOT))

from skill_capabilities import CAPABILITY_REGISTRY, unknown_capability_ids  # noqa: E402
from agent_skill_store import frontmatter_value  # noqa: E402

DEFAULT_PACKAGES_DIR = REPO_ROOT / "data" / "agent_skills" / "packages"

# The authoritative mapping.  Keep it in sync with the Skills it describes:
# ``--check`` compares it against what the front matter actually says.
SKILL_CAPABILITIES: dict[str, list[str]] = {
    # --- 1688 工具链 ---
    "1688-industrysearch": ["tool.1688.search", "data.market.1688"],
    "1688-product-find": ["tool.1688.search", "tool.1688.compare", "data.market.1688"],
    "1688-source-suppliers": ["tool.1688.supplier", "data.market.1688"],
    # --- 市场洞察与运营：对话产出 + 表格读写 ---
    "a1-cilu": ["io.sheet.read", "io.sheet.write"],
    "a2-wulei": ["io.sheet.read", "io.sheet.write"],
    "a3-sousuo": ["io.sheet.read", "io.sheet.write"],
    "a4-cilu": ["io.sheet.read", "io.sheet.write"],
    "b1-sanwei": ["io.sheet.read", "io.sheet.write"],
    "b2-jiaocha": ["io.sheet.read", "io.sheet.write"],
    "c1-pingjia": ["io.sheet.read", "io.sheet.write"],
    "c2-chuizhi": ["io.sheet.read", "io.sheet.write"],
    "d1-chanpin": ["io.sheet.read", "io.sheet.write"],
    "d2-lianjie": ["io.sheet.read", "io.sheet.write"],
    "d3-saima": ["io.sheet.read", "io.sheet.write"],
    "d4-saima": ["io.sheet.read", "io.sheet.write"],
    "e1-tuiguang": ["io.sheet.read", "io.sheet.write"],
    "e2-jingpin": ["io.image.read"],
    "e3-zhutu": ["io.image.read"],
    "e4-xiangqing": ["io.image.read", "io.sheet.read"],
    "f1-tuiguang": ["io.sheet.read", "io.sheet.write"],
    "f2-pingjia": ["io.sheet.read", "io.sheet.write"],
    "f3-shangjia": ["io.sheet.read", "io.sheet.write"],
    "f4-shangxin": ["io.sheet.read", "io.sheet.write"],
    "f5-liuliang": ["io.sheet.read", "io.sheet.write"],
    "g1-shuju": ["data.shop.self", "io.sheet.read", "io.sheet.write"],
    "g2-leimu": ["data.shop.self", "io.sheet.read", "io.sheet.write"],
    "g3-zhixing": ["data.shop.self", "io.sheet.read", "io.sheet.write"],
    "g4-lirun": ["data.shop.self", "io.sheet.read", "io.sheet.write"],
    "h1-dandian": ["data.shop.self", "io.sheet.read", "io.sheet.write"],
    "h2-biaoti": ["io.sheet.read", "io.sheet.write"],
    "h3-leimu": ["io.sheet.read", "io.sheet.write"],
    "resume-screener": ["io.office.read", "io.sheet.write"],
    # --- 视觉理解与生成 ---
    "ec-mainimage-analysis": ["io.image.read", "io.sheet.read"],
    "ec-mainimage-planning": ["io.image.read", "canvas.image.generate", "model.image"],
    "ec-detail-analysis": ["io.image.read", "io.web.read"],
    "ec-detail-planning": ["io.image.read", "canvas.image.generate", "model.image"],
    "ec-video-analysis": ["io.video.read", "io.video.frames", "io.audio.read"],
    "ec-video-planning": ["model.image", "model.video", "canvas.image.generate", "canvas.video.generate"],
    "mainimage-style-transfer": ["io.image.read", "canvas.image.generate", "model.image"],
    "mainimage-wash": ["io.image.read", "canvas.image.generate", "canvas.image.edit", "model.image"],
    "buyer-show-generation": ["canvas.image.generate", "model.image"],
    "ciwei-superi-guofeng-video": ["model.image", "model.video", "canvas.image.generate", "canvas.video.generate"],
    # --- 文案与营销 ---
    "ecommerce-copywriter": ["model.text"],
    "product-master": ["model.text"],
    "xhs-note-generation": ["model.text"],
    "营销心理学专家": ["model.text"],
    # --- 工具、平台与宿主 ---
    "amz-hot-keywords": ["tool.amz.keywords", "data.market.amazon", "io.sheet.write"],
    "browser-agent": ["tool.browser.collect", "io.web.read"],
    "taobao-launch": ["tool.browser.collect", "io.web.read"],
    "task-cron": ["host.schedule"],
    "skill-creator": ["host.skill"],
    # --- Office 文档 ---
    "docx": ["tool.office.render", "io.office.read", "io.doc.write"],
    "xlsx": ["tool.office.render", "io.sheet.read", "io.sheet.write"],
    "pptx": ["tool.office.render", "io.office.read", "io.doc.write"],
    "pdf": ["tool.office.render", "io.office.read"],
}

# Legacy single file Skills live next to the packages folder as
# ``data/agent_skills/<file>.md``.  They are keyed by the ``name`` declared in
# their front matter, not by the file name.
LEGACY_SKILL_CAPABILITIES: dict[str, list[str]] = {
    "gpt-image": ["model.image", "tool.cli.run"],
    "extract-visual-style-2": ["io.image.read", "io.video.read", "io.video.frames"],
}

FRONTMATTER = re.compile(r"^---\s*\r?\n(?P<meta>.*?)\r?\n---", re.DOTALL)
CAPABILITY_LINE = re.compile(r"^capabilities\s*:")
BLOCK_ITEM = re.compile(r"^\s+-\s*")


def read_text(path: Path) -> tuple[str, bool]:
    raw = path.read_bytes()
    has_bom = raw.startswith(b"\xef\xbb\xbf")
    text = raw.decode("utf-8-sig")
    return text, has_bom


def split_document(text: str) -> tuple[str, str, str]:
    """Return (front matter, body, newline) for a Skill document."""

    match = FRONTMATTER.match(text)
    if not match:
        return "", text, "\r\n" if "\r\n" in text else "\n"
    newline = "\r\n" if "\r\n" in text else "\n"
    return match.group("meta"), text[match.end():], newline


def declared_capabilities(meta: str) -> list[str]:
    """Read the declared identifiers from a front matter block."""

    from skill_capabilities import parse_capability_ids

    return parse_capability_ids(meta)


def render_frontmatter(meta: str, ids: list[str], newline: str) -> str:
    """Return the front matter with exactly one top level ``capabilities`` key."""

    lines = meta.splitlines()
    kept: list[str] = []
    index = 0
    while index < len(lines):
        line = lines[index]
        if CAPABILITY_LINE.match(line):
            # Drop the previous declaration together with its block items.
            index += 1
            while index < len(lines) and (not lines[index].strip() or BLOCK_ITEM.match(lines[index])):
                if lines[index].strip():
                    index += 1
                else:
                    break
            continue
        kept.append(line)
        index += 1
    while kept and not kept[-1].strip():
        kept.pop()
    kept.append("capabilities: [" + ", ".join(ids) + "]")
    return newline.join(kept)


def backup_file(path: Path, backup_dir: Path) -> None:
    backup_dir.mkdir(parents=True, exist_ok=True)
    target = backup_dir / f"{path.parent.name}.{path.name}.bak"
    target.write_bytes(path.read_bytes())


def main() -> int:
    parser = argparse.ArgumentParser(description="Apply or verify Skill capability declarations.")
    parser.add_argument("--packages-dir", default=str(DEFAULT_PACKAGES_DIR))
    parser.add_argument("--apply", action="store_true", help="write the declarations")
    parser.add_argument("--check", action="store_true", help="only verify (default)")
    parser.add_argument("--backup-dir", default="")
    parser.add_argument(
        "--skip-unmapped",
        action="store_true",
        help="tolerate skill directories that the mapping does not cover "
             "(for example a skill the user installed themselves)",
    )
    args = parser.parse_args()

    packages_dir = Path(args.packages_dir).expanduser().resolve()
    if not packages_dir.is_dir():
        print(f"技能包目录不存在：{packages_dir}")
        return 2
    backup_dir = Path(args.backup_dir) if args.backup_dir else packages_dir.parent / ".capability-backups"

    problems: list[str] = []
    changed: list[str] = []
    unmapped: list[str] = []
    checked = 0

    for capability_id in sorted({
        item
        for ids in list(SKILL_CAPABILITIES.values()) + list(LEGACY_SKILL_CAPABILITIES.values())
        for item in ids
    }):
        if capability_id not in CAPABILITY_REGISTRY:
            problems.append(f"映射表使用了未登记的能力标识：{capability_id}")

    skill_dirs = sorted(
        item for item in packages_dir.iterdir()
        if item.is_dir() and not item.name.startswith(".")
    )
    legacy_dir = packages_dir.parent

    # (label, document path, expected identifiers, mapping key)
    documents: list[tuple[str, Path, list[str] | None, str]] = []
    for skill_dir in skill_dirs:
        documents.append((
            skill_dir.name,
            skill_dir / "SKILL.md",
            SKILL_CAPABILITIES.get(skill_dir.name),
            skill_dir.name,
        ))
    for legacy_file in sorted(legacy_dir.glob("*.md")):
        legacy_text, _ = read_text(legacy_file)
        legacy_meta, _, _ = split_document(legacy_text)
        legacy_id = str(frontmatter_value(legacy_meta, "name") or "").strip() or legacy_file.stem
        documents.append((
            legacy_file.name,
            legacy_file,
            LEGACY_SKILL_CAPABILITIES.get(legacy_id),
            legacy_id,
        ))

    for label, skill_file, expected, _ in documents:
        if expected is None:
            if args.skip_unmapped:
                unmapped.append(label)
            else:
                problems.append(f"{label}：映射表缺少该技能")
            continue
        if not skill_file.is_file():
            problems.append(f"{label}：缺少 SKILL.md")
            continue
        checked += 1
        text, has_bom = read_text(skill_file)
        meta, body, newline = split_document(text)
        if not meta:
            problems.append(f"{label}：缺少 front matter")
            continue
        current = declared_capabilities(meta)
        unknown = unknown_capability_ids(current)
        if unknown:
            problems.append(f"{label}：未登记的能力标识 {'、'.join(unknown)}")
        if current == expected:
            continue
        if not args.apply:
            problems.append(
                f"{label}：声明与映射表不一致（当前 {current or '无'}，期望 {expected}）"
            )
            continue
        backup_file(skill_file, backup_dir)
        new_meta = render_frontmatter(meta, expected, newline)
        new_text = f"---{newline}{new_meta}{newline}---" + body
        payload = new_text.encode("utf-8")
        if has_bom:
            payload = b"\xef\xbb\xbf" + payload
        skill_file.write_bytes(payload)
        changed.append(label)

    present_keys = {key for _, _, _, key in documents}
    for name in sorted(set(SKILL_CAPABILITIES) - present_keys):
        problems.append(f"{name}：映射表中的技能在 {packages_dir} 下不存在")
    for name in sorted(set(LEGACY_SKILL_CAPABILITIES) - present_keys):
        problems.append(f"{name}：映射表中的旧版技能在 {legacy_dir} 下不存在")

    if args.apply:
        print(f"已检查 {checked} 个技能，更新 {len(changed)} 个：{'、'.join(changed) if changed else '无'}")
    else:
        print(f"已检查 {checked} 个技能")
    if unmapped:
        print(f"未登记的技能（已跳过）：{'、'.join(unmapped)}")
    for problem in problems:
        print(f"[问题] {problem}")
    if problems:
        return 1
    if not args.apply:
        print("能力声明与映射表一致。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
