"""Resolve workflow references and translate saved form values into node inputs."""

import math
import re

import media_paths


_COMPONENT = re.compile(r'[^/\\:*?"<>|\x00-\x1f]{1,180}')
_INTEGER = re.compile(r"[+-]?\d+")
_DROPDOWN_INTEGER = re.compile(r"-?\d+")
_FALSE = {"false", "no", "off", "0"}
_TRUE = {"true", "yes", "on", "1"}


def _valid_components(value):
    return all(part not in {".", ".."} and _COMPONENT.fullmatch(part) for part in value.split("/"))


def name(value):
    reference = str(value or "").strip().replace("\\", "/")
    leaf = reference.rsplit("/", 1)[-1].lower()
    if len(leaf) <= len(".json") or not leaf.endswith(".json") or leaf.endswith(".config.json"):
        return ""
    return reference if _valid_components(reference) else ""


def valid_folder(value):
    folder = str(value or "").strip().replace("\\", "/").strip("/")
    return not folder or _valid_components(folder)


def file_path(root, value):
    reference = name(value)
    return media_paths.path_under(root, reference) if reference else None


def _convert(field, value):
    if field.type == "boolean":
        if isinstance(value, str):
            flag = value.strip().lower()
            if flag in _FALSE or flag in _TRUE:
                return flag in _TRUE
        return bool(value)
    if field.type in ("number", "slider"):
        fractional = bool(field.step and field.step < 1)
        try:
            if not fractional and isinstance(value, int):
                return int(value)
            if not fractional and isinstance(value, str) and _INTEGER.fullmatch(value.strip()):
                return int(value)
            numeric = float(value)
            if math.isfinite(numeric):
                return numeric if fractional else int(numeric)
        except (ValueError, TypeError, OverflowError):
            pass
    if field.type == "dropdown" and isinstance(value, str):
        option = value.strip()
        try:
            if _DROPDOWN_INTEGER.fullmatch(option):
                return int(option)
            if "." in option or "e" in option.lower():
                numeric = float(option)
                if math.isfinite(numeric):
                    return numeric
        except (ValueError, OverflowError):
            pass
    return value


def node_inputs(fields, values):
    overrides = {}
    for field in fields:
        if field.node and field.input and field.id in values:
            overrides.setdefault(field.node, {})[field.input] = _convert(field, values[field.id])
    return overrides
