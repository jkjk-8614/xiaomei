"""Small, framework-free helpers shared by the Agent Skill adapters.

The application keeps package-aware Skill discovery in ``main.py``.  This
module owns the format-level operations that must behave the same for package
and legacy clients: ids, Markdown front matter, and UTF-8 file I/O.
"""

from __future__ import annotations

import json
import re
import uuid
from pathlib import Path


SKILL_ID_RE = re.compile(r"^[\w.-]{1,120}$", re.UNICODE)


def normalize_skill_id(value: object) -> str:
    """Validate and normalize an on-disk Skill id without touching the FS."""

    raw = str(value or "").strip()
    if raw.lower().endswith(".md"):
        raw = raw[:-3]
    if (
        not raw
        or raw in {".", ".."}
        or "/" in raw
        or "\\" in raw
        or not SKILL_ID_RE.fullmatch(raw)
    ):
        raise ValueError("无效的 Skill ID")
    return raw


def skill_slug(value: object) -> str:
    """Create the canonical, filesystem-safe id used for new Skills."""

    candidate = re.sub(r"[^\w-]+", "-", str(value or "").strip(), flags=re.UNICODE)
    candidate = candidate.strip("-_.")[:80]
    return candidate or f"skill-{uuid.uuid4().hex[:8]}"


def frontmatter_value(block: object, key: str) -> str:
    """Read a scalar or simple block-style YAML front matter value."""

    lines = str(block or "").splitlines()
    key_pattern = re.compile(rf"^\s*{re.escape(key)}\s*:\s*(.*?)\s*$", re.IGNORECASE)
    for index, line in enumerate(lines):
        match = key_pattern.match(line)
        if not match:
            continue
        value = match.group(1).strip()
        continuation = []
        if value in {"|", ">"} or not value:
            for next_line in lines[index + 1 :]:
                if next_line and not next_line[0].isspace() and re.match(r"^[\w-]+\s*:", next_line):
                    break
                if next_line.strip():
                    continuation.append(next_line.strip())
            if continuation:
                value = " ".join(continuation).strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in {"'", '"'}:
            if value[0] == '"':
                try:
                    return str(json.loads(value))
                except Exception:
                    pass
            return value[1:-1].replace("''", "'").strip()
        return value.strip()
    return ""


def split_skill_document(text: object) -> tuple[str, str, str]:
    """Return full text, front matter, and instruction body."""

    content = str(text or "").lstrip("\ufeff")
    metadata = ""
    body = content
    match = re.match(r"^\s*---\s*\r?\n(?P<meta>.*?)\r?\n---\s*(?:\r?\n|$)", content, re.DOTALL)
    if match:
        metadata = match.group("meta")
        body = content[match.end() :]
    return content, metadata, body


def parse_skill_document(text: object, fallback_id: object) -> dict:
    """Parse both package-style and old plain Markdown Skill files."""

    content, metadata, body = split_skill_document(text)
    skill_id = str(fallback_id or "").strip()
    name = frontmatter_value(metadata, "name") or skill_id or "未命名 Skill"
    description = frontmatter_value(metadata, "description")
    if not description:
        paragraphs = [
            line.strip()
            for line in body.splitlines()
            if line.strip() and not line.lstrip().startswith("#")
        ]
        description = (paragraphs[0] if paragraphs else "本地 Markdown Skill")[:500]
    return {
        "id": skill_id,
        "name": name[:120],
        "description": description[:2000],
        "instructions": body.strip() or content.strip(),
        "_frontmatter": metadata,
    }


def render_skill_document(
    name: object,
    description: object,
    instructions: object,
    *,
    frontmatter: bool = True,
) -> str:
    """Render a Skill while allowing legacy callers to retain plain Markdown."""

    safe_name = str(name or "").strip() or "未命名 Skill"
    safe_description = str(description or "").strip()
    if frontmatter:
        safe_description = safe_description.replace("\r", " ").replace("\n", " ")
    safe_instructions = str(instructions or "").strip()
    if frontmatter:
        return (
            "---\n"
            f"name: {json.dumps(safe_name, ensure_ascii=False)}\n"
            f"description: {json.dumps(safe_description, ensure_ascii=False)}\n"
            "---\n\n"
            f"{safe_instructions}\n"
        )
    return f"# {safe_name}\n\n{safe_description}\n\n{safe_instructions}\n"


def read_skill_text(path: str | Path, max_chars: int | None = None) -> tuple[str, bool]:
    """Read UTF-8 Skill text and optionally report truncation."""

    text = Path(path).read_text(encoding="utf-8-sig", errors="replace")
    if max_chars and len(text) > max_chars:
        return text[:max_chars], True
    return text, False


def write_skill_text(path: str | Path, text: object) -> None:
    """Write a Skill file with stable UTF-8/newline behavior."""

    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    with target.open("w", encoding="utf-8", newline="\n") as handle:
        handle.write(str(text or ""))
