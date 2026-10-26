"""Bounded, local quality checks for the design-brain output set.

These checks are evidence only. They never claim semantic product fidelity when
the original image or a reliable geometry configuration is unavailable.
"""
from __future__ import annotations

from pathlib import Path
from typing import Any, Callable, Dict, List


def _ratio(size: str):
    try:
        width, height = [int(value) for value in str(size or "").lower().split("x", 1)]
        if width > 0 and height > 0:
            return width / height
    except (TypeError, ValueError):
        pass
    return 0.0


def inspect_image(url: str, expected_size: str, resolve: Callable[[str], Any]) -> Dict[str, Any]:
    """Read dimensions without modifying the output; unknown is a valid result."""
    result = {"status": "unknown", "url": str(url or ""), "width": 0, "height": 0,
              "expected_size": str(expected_size or ""), "issues": []}
    path = resolve(url) if callable(resolve) else None
    if not path or not Path(path).is_file():
        result["issues"].append("本机没有可读取的原图，跳过像素与画幅检查")
        return result
    try:
        from PIL import Image
        with Image.open(path) as image:
            image.verify()
        with Image.open(path) as image:
            width, height = image.size
    except Exception as exc:  # noqa: BLE001 - a check must not break delivery
        result["status"] = "fail"
        result["issues"].append(f"图片无法解码：{str(exc)[:120]}")
        return result
    result.update(width=int(width), height=int(height))
    expected = _ratio(expected_size)
    actual = width / height if height else 0
    if min(width, height) < 512:
        result["issues"].append(f"最短边 {min(width, height)}px，小于 512px")
    if expected and actual and abs(actual / expected - 1) > 0.03:
        result["issues"].append(f"实际画幅 {width}×{height} 与方案 {expected_size} 的比例偏差超过 3%")
    result["status"] = "fail" if result["issues"] else "pass"
    return result


def inspect_shot(task: Dict[str, Any], plan_shot: Dict[str, Any], execution_shot: Dict[str, Any], resolve) -> Dict[str, Any]:
    checks = [inspect_image(output.get("url", ""), plan_shot.get("size", ""), resolve)
              for output in execution_shot.get("outputs", []) if isinstance(output, dict)]
    statuses = {item["status"] for item in checks}
    fidelity = [output.get("product_fidelity") or output.get("fidelity_report")
                for output in execution_shot.get("outputs", [])
                if isinstance(output, dict) and (output.get("product_fidelity") or output.get("fidelity_report"))]
    fidelity_statuses = {str(item.get("validationStatus") or item.get("status") or "").lower()
                         for item in fidelity if isinstance(item, dict)}
    status = "fail" if "fail" in statuses or "failed" in fidelity_statuses else "unknown" if "unknown" in statuses else "pass"
    return {"status": status, "checks": checks, "product_fidelity": fidelity,
            "fidelity_statuses": sorted(fidelity_statuses)}


def inspect_group(task: Dict[str, Any], resolve) -> Dict[str, Any]:
    shots = []
    urls = set()
    duplicate_urls = []
    for plan_shot in task.get("plan", {}).get("shots", []):
        execution = next((item for item in task.get("execution", {}).get("shots", []) if item.get("id") == plan_shot.get("id")), None)
        if not execution or execution.get("status") != "succeeded":
            continue
        local = inspect_shot(task, plan_shot, execution, resolve)
        for output in execution.get("outputs", []):
            url = str(output.get("url") or "") if isinstance(output, dict) else ""
            if url in urls:
                duplicate_urls.append(url)
            if url:
                urls.add(url)
        shots.append({"id": plan_shot.get("id", ""), "size": plan_shot.get("size", ""), "local": local})
    issues = []
    if duplicate_urls:
        issues.append({"severity": "major", "area": "consistency", "description": "整组中有重复的产物地址，无法作为独立分镜交付", "evidence": "、".join(duplicate_urls[:3]), "suggestion": "保留最符合分镜用途的一张，重新生成重复分镜", "cause": "execution", "preserve": "其余非重复分镜", "verification": "逐张核对产物地址与分镜编号"})
    failed = [shot for shot in shots if shot["local"]["status"] == "fail"]
    for shot in failed[:6]:
        for check in shot["local"]["checks"]:
            for issue in check.get("issues", [])[:2]:
                issues.append({"severity": "major", "area": "composition", "description": f"{shot['id']}：{issue}", "evidence": check.get("url", ""), "suggestion": "保持已确认设计方向，按方案画幅重新生成该分镜", "cause": "model_limit", "preserve": "已确认的方向与文案", "verification": "复核实际像素尺寸与画幅比例"})
    return {"status": "issues" if issues else "pass", "shot_count": len(shots), "issues": issues[:8], "shots": shots}
