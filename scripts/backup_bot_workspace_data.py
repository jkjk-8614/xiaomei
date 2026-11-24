"""非破坏性备份小美画布 Agent / 设计大脑 / 多代理本地运行数据。

可在迁移前由程序自动调用，也可手动执行：
    python/python.exe scripts/backup_bot_workspace_data.py
"""
from __future__ import annotations

import hashlib
import json
import os
import shutil
import sys
import time
from pathlib import Path
from typing import Any, Dict, List

REPO_ROOT = Path(__file__).resolve().parents[1]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from bot_workspace_config import backup_root_dir, normalize_data_dir

BACKUP_TARGETS = (
    "design_brain",
    "multi_agent",
    "project_agent",
)

# 避免拷贝临时锁文件或正在写入的碎片文件
_SKIP_SUFFIXES = (".tmp", ".migrating", ".lock")
_SKIP_DIR_NAMES = {"media_previews", "__pycache__"}


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        while True:
            chunk = handle.read(65536)
            if not chunk:
                break
            digest.update(chunk)
    return digest.hexdigest()


def backup_user_data(
    data_dir: str | Path | None = None,
    *,
    label: str = "pre_migration",
    targets: tuple[str, ...] = BACKUP_TARGETS,
) -> Dict[str, Any]:
    """将指定子目录安全复制到 data/backups/ 下，绝不修改源目录。"""
    source_root = normalize_data_dir(data_dir)
    backups_root = backup_root_dir(source_root)
    safe_label = "".join(ch if ch.isalnum() or ch in ("-", "_") else "_" for ch in str(label or "backup"))[:40] or "backup"
    stamp = time.strftime("%Y%m%d_%H%M%S")
    dest_dir = backups_root / f"bot_workspace_{safe_label}_{stamp}"
    suffix = 1
    while dest_dir.exists():
        dest_dir = backups_root / f"bot_workspace_{safe_label}_{stamp}_{suffix}"
        suffix += 1
    dest_dir.mkdir(parents=True, exist_ok=True)

    copied_files: List[Dict[str, Any]] = []
    skipped_targets: List[str] = []

    for rel_target in targets:
        src_path = source_root / rel_target
        if not src_path.exists():
            skipped_targets.append(rel_target)
            continue
        dst_path = dest_dir / rel_target
        if src_path.is_file():
            dst_path.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(src_path, dst_path)
            copied_files.append({
                "relative_path": rel_target,
                "size": dst_path.stat().st_size,
                "sha256": _sha256_file(dst_path),
            })
            continue
        for current, dirnames, filenames in os.walk(src_path):
            dirnames[:] = [
                name for name in dirnames
                if name not in _SKIP_DIR_NAMES and not (Path(current) / name).is_symlink()
            ]
            current_path = Path(current)
            relative_dir = current_path.relative_to(source_root)
            target_dir = dest_dir / relative_dir
            target_dir.mkdir(parents=True, exist_ok=True)
            for filename in filenames:
                if filename.endswith(_SKIP_SUFFIXES):
                    continue
                src_file = current_path / filename
                if src_file.is_symlink() or not src_file.is_file():
                    continue
                dst_file = target_dir / filename
                shutil.copy2(src_file, dst_file)
                rel_file = str(src_file.relative_to(source_root)).replace("\\", "/")
                copied_files.append({
                    "relative_path": rel_file,
                    "size": dst_file.stat().st_size,
                    "sha256": _sha256_file(dst_file),
                })

    manifest = {
        "version": 1,
        "created_at": int(time.time() * 1000),
        "label": safe_label,
        "source_data_dir": str(source_root),
        "backup_dir": str(dest_dir),
        "targets": list(targets),
        "skipped_targets": skipped_targets,
        "file_count": len(copied_files),
        "total_bytes": sum(item["size"] for item in copied_files),
        "files": copied_files,
    }
    manifest_path = dest_dir / "backup_manifest.json"
    manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return manifest


def main() -> int:
    data_dir = sys.argv[1] if len(sys.argv) > 1 else None
    label = sys.argv[2] if len(sys.argv) > 2 else "p0_baseline"
    manifest = backup_user_data(data_dir, label=label)
    print(json.dumps({
        "backup_dir": manifest["backup_dir"],
        "file_count": manifest["file_count"],
        "total_bytes": manifest["total_bytes"],
        "skipped_targets": manifest["skipped_targets"],
    }, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
