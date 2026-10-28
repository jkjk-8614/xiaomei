"""Load pure production image parameter helpers without reading runtime data."""
import ast
import math
import re
from pathlib import Path
from fastapi import HTTPException


def image_params_namespace():
    source = Path(__file__).resolve().parents[1] / 'main.py'
    functions = {'parse_size_pair', 'apimart_size_resolution', 'apimart_nearest_aspect',
                 'apimart_model_supports_official_fallback',
                 'normalize_gemini_aspect_ratio',
                 'gemini_image_config', 'normalize_gpt_image_2_size', 'is_gpt_image_2_model',
                 'gpt_image_2_auto_size_for_ratio', 'resolve_image_generation_params',
                 'comfly_gemini_size_model'}
    constants = {'COMFLY_GEMINI_STANDARD_SIZES', 'GPT_IMAGE2_AUTO_RATIO_SIZES',
                 'GEMINI_ASPECT_RATIO_CHOICES', 'GPT_IMAGE2_MAX_EDGE',
                 'GPT_IMAGE2_MIN_PIXELS', 'GPT_IMAGE2_MAX_PIXELS', 'APIMART_ASPECT_RATIOS'}
    tree = ast.parse(source.read_text(encoding='utf-8'))
    nodes = [node for node in tree.body if getattr(node, 'name', None) in functions
             or isinstance(node, ast.Assign) and any(getattr(target, 'id', '') in constants for target in node.targets)]
    assert len(nodes) == len(functions) + len(constants)
    namespace = dict(re=re, math=math, HTTPException=HTTPException)
    exec(compile(ast.Module(body=nodes, type_ignores=[]), str(source), 'exec'), namespace)
    return namespace
