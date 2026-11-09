"""Image-space filtering and classification overrides."""
import copy
import os
import re

import asset_kernel


def merge_classification(raw, normalize):
    raw = raw if isinstance(raw, dict) else {}
    ai = normalize(raw.get("ai", raw))
    manual = copy.deepcopy(raw.get("manual") or {})
    effective = copy.deepcopy(ai)
    if "summary" in manual:
        effective["summary"] = manual["summary"]
    if "tags" in manual:
        effective["tags"] = manual["tags"]
    effective["categories"].update(manual.get("categories") or {})
    result = normalize(effective)
    result.update(ai=ai, manual=manual)
    return result


def replace_ai(previous, new, normalize):
    return merge_classification({"ai": new, "manual": (previous or {}).get("manual", {})}, normalize)


def matches_filters(item, filters):
    return asset_kernel.matches(item, filters)
