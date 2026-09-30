"""Local application views over the existing ComfyUI workflow/task stores."""
import asyncio
import copy
import ctypes
import hashlib
import io
import json
import math
import os
import platform
import re
import shutil
import struct
import subprocess
import threading
import time
import uuid
from pathlib import Path, PurePosixPath
from urllib.parse import unquote, urlparse

import requests
import websockets
from websockets.exceptions import WebSocketException
from fastapi import APIRouter, HTTPException, Request, UploadFile, File, Form
from PIL import Image

from ComfyUI.integration.comfy_workflow_inspection import inspect_workflow
from ComfyUI.integration.comfy_node_registry import NODE_TYPE_ALIASES, NodeSourceResolver
from ComfyUI.integration.comfy_app_runtime import ManagedRuntime, SOURCE, MODELS
from ComfyUI.integration.comfy_model_sources import ModelSourceResolver


MODEL_INPUT_NAMES = {
    'ckpt_name', 'unet_name', 'clip_name', 'clip_name1', 'clip_name2', 'clip_name3',
    'vae_name', 'lora_name', 'model_name', 'upscale_model', 'checkpoint',
    'model_name1', 'model_name2', 'model_name3', 'diffusion_model', 'dit_name',
    'weights', 'weights_name', 'model_path', 'vae_ckpt', 'unet_ckpt',
}
DELETE_CONFIRMATION_TTL = 10 * 60
HARDWARE_CACHE_TTL = 8
MODEL_FILE_EXTENSIONS = {
    '.safetensors', '.ckpt', '.pt', '.pth', '.bin', '.onnx', '.gguf', '.ggml',
    '.sft', '.tflite', '.msgpack', '.pkl', '.npz',
}
DIRECTORY_MODEL_NODE_TYPES = {
    'AILab_QwenVL', 'AILab_QwenVL_Advanced', 'AILab_QwenVL_PromptEnhancer',
}
SWARM_INPUT_PREFIX = 'SwarmInput'
SWARM_META_NODES = {'SwarmWorkflowDescription', 'SwarmInputGroup'}
CUSTOM_WORKFLOW_FOLDER = 'custom'
SWARM_FIELD_TYPES = {
    'SwarmInputText': 'text',
    'SwarmInputInteger': 'number',
    'SwarmInputFloat': 'number',
    'SwarmInputBoolean': 'boolean',
    'SwarmInputDropdown': 'dropdown',
    'SwarmInputImage': 'image',
    'SwarmInputAudio': 'audio',
    'SwarmInputVideo': 'video',
    'SwarmInputModelName': 'dropdown',
    'SwarmInputCheckpoint': 'dropdown',
}

# Automatic downloads are deliberately allow-listed.  A workflow may mention
# arbitrary URLs or model names, but an import must never turn those values
# into an unchecked download command.  These files are published by the
# Comfy-Org model repositories (plus explicitly pinned public upstream files)
# and are placed in the standard shared ComfyUI model tree.  Entries without a
# verified public source remain in the manual-import list.
AUTO_MODEL_REGISTRY = {
    'qwen_3_4b.safetensors': {
        'name': 'qwen_3_4b.safetensors',
        'category': 'text_encoders',
        'url': 'https://huggingface.co/Comfy-Org/z_image_turbo/resolve/main/split_files/text_encoders/qwen_3_4b.safetensors',
        'source': 'https://huggingface.co/Comfy-Org/z_image_turbo',
        'size_bytes': 8044982048,
        'size_note': '约 7.49 GiB（8.04 GB）；安装器会校验完整大小',
    },
    'z_image_turbo_bf16.safetensors': {
        'name': 'z_image_turbo_bf16.safetensors',
        'category': 'diffusion_models',
        'url': 'https://huggingface.co/Comfy-Org/z_image_turbo/resolve/main/split_files/diffusion_models/z_image_turbo_bf16.safetensors',
        'source': 'https://huggingface.co/Comfy-Org/z_image_turbo',
        'size_note': '约 12 GB，实际大小以下载源为准',
    },
    'ae.safetensors': {
        'name': 'ae.safetensors',
        'category': 'vae',
        'url': 'https://huggingface.co/Comfy-Org/z_image_turbo/resolve/main/split_files/vae/ae.safetensors',
        'source': 'https://huggingface.co/Comfy-Org/z_image_turbo',
        'size_note': '约数百 MB，实际大小以下载源为准',
    },
    'qwen_image_vae.safetensors': {
        'name': 'qwen_image_vae.safetensors',
        'category': 'vae',
        'url': 'https://huggingface.co/Comfy-Org/Qwen-Image_ComfyUI/resolve/main/split_files/vae/qwen_image_vae.safetensors',
        'source': 'https://huggingface.co/Comfy-Org/Qwen-Image_ComfyUI',
        'size_note': '约 254 MB，实际大小以下载源为准',
    },
    # SeedVR2's 7B sharp model is a public upstream file, but it lives in a
    # custom ComfyUI model directory rather than one of the standard folders.
    'seedvr2_ema_7b_sharp_fp16.safetensors': {
        'name': 'seedvr2_ema_7b_sharp_fp16.safetensors',
        'category': 'SEEDVR2',
        'url': 'https://huggingface.co/numz/SeedVR2_comfyUI/resolve/main/seedvr2_ema_7b_sharp_fp16.safetensors',
        'source': 'https://huggingface.co/numz/SeedVR2_comfyUI',
        'sha256': '20a93e01ff24beaeebc5de4e4e5be924359606c356c9c51509fba245bd2d77dd',
        'size_bytes': 16479334424,
        'size_note': '约 15.35 GiB（16.48 GB）；安装器会校验完整大小和 SHA-256',
    },
}

MANUAL_MODEL_SOURCES = {
    'z-image-turbo-细节增强v2.safetensors': {
        'source': 'https://www.runninghub.cn/model/public/2063991571288256513',
        'sha256': '79e911a8bdffc681d46755367eb04c4ee9386400aea0a260ca6b06fa5cc78c79',
        'detail': '已找到 RunningHub 同名模型；公开页面未提供文件下载链接。取得原文件后可在此导入，系统会校验 SHA-256，防止误用其他同名模型。',
    },
    # The workflow's exact Flux weight is access-controlled and may require
    # accepting the publisher's terms.  It is intentionally not an automatic
    # download, but showing the official repository makes the next step clear.
    'flux-2-klein-9b-fp8.safetensors': {
        'source': 'https://huggingface.co/black-forest-labs/FLUX.2-klein-9B',
        'detail': '官方模型需要账号/条款授权；下载后使用“导入此模型”，不会在后台绕过授权。',
    },
}


def write_json(path, data):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_name(path.name + '.' + uuid.uuid4().hex + '.tmp')
    try:
        temp.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding='utf-8')
        temp.replace(path)
    finally:
        temp.unlink(missing_ok=True)


def workflow_groups(source, include_preset_groups=False):
    """Locate UI groups containing executable nodes, including bypassed groups."""
    if not isinstance(source, dict) or not isinstance(source.get('nodes'), list):
        return []
    result = []
    node_types = {str(node.get('id')): str(node.get('type') or '') for node in source['nodes']}
    for index, group in enumerate(source.get('groups') or []):
        bounds = group.get('bounding') or []
        if len(bounds) != 4:
            continue
        x, y, width, height = bounds
        members = []
        for node in source['nodes']:
            pos = node.get('pos') or []
            if isinstance(pos, dict):
                pos = [pos.get('0', 0), pos.get('1', 0)]
            kind = str(node.get('type') or '')
            if len(pos) >= 2 and x <= pos[0] <= x + width and y <= pos[1] <= y + height \
                    and kind not in ('MarkdownNote', 'Note') and 'Bypasser' not in kind:
                members.append(str(node['id']))
        if members and not include_preset_groups and str(group.get('title') or '').strip() in ('低', '中', '高') and all(
                node_types.get(node_id) == 'DLSS5Settings' for node_id in members):
            continue
        if members:
            result.append({'id': str(group.get('id', index)),
                           'title': str(group.get('title') or f'分组 {index + 1}'),
                           'nodes': members})
    incoming = _workflow_incoming(source)
    nodes = {str(node['id']): node for node in source['nodes']}
    attached = set()
    for comparison in result:
        if not any(nodes[key].get('type') == 'Image Comparer (rgthree)' for key in comparison['nodes']):
            continue
        members = set(comparison['nodes'])
        dependencies = _workflow_ancestors(members, incoming) - members
        if not dependencies:
            continue
        for owner in result:
            if owner is comparison or members.intersection(owner['nodes']):
                continue
            if dependencies <= _workflow_ancestors(owner['nodes'], incoming):
                owner['nodes'] = list(dict.fromkeys(owner['nodes'] + comparison['nodes']))
                attached.add(comparison['id'])
    return [group for group in result if group['id'] not in attached]


def dlss5_preset_field(item, info=None):
    """Expose grouped DLSS5 image settings that the API export left unconnected."""
    source, graph = item.get('source'), item.get('api')
    if not isinstance(source, dict) or not isinstance(source.get('nodes'), list) or not isinstance(graph, dict):
        return None
    targets = [key for key, node in graph.items()
               if node.get('class_type') == 'DLSS5EnhanceImages'
               and not node.get('inputs', {}).get('settings')]
    if len(targets) != 1:
        return None
    nodes = {str(node.get('id')): node for node in source.get('nodes', [])
             if isinstance(node, dict) and node.get('id') is not None}
    if nodes.get(targets[0], {}).get('type') != 'DLSS5EnhanceImages':
        return None
    choices = {}
    for group in workflow_groups(source, include_preset_groups=True):
        label = group['title'].strip()
        if label not in ('低', '中', '高'):
            continue
        members = [node_id for node_id in group['nodes']
                   if nodes.get(node_id, {}).get('type') == 'DLSS5Settings']
        if len(members) != 1 or label in choices:
            return None
        choices[label] = [members[0], 0]
    if set(choices) != {'低', '中', '高'}:
        return None
    preset_values = {}
    for label, (node_id, _) in choices.items():
        source_node = nodes[node_id]
        widgets, inputs = source_node.get('widgets_values'), source_node.get('inputs')
        if not isinstance(widgets, list) or not isinstance(inputs, list):
            return None
        widget_inputs = [entry for entry in inputs if isinstance(entry, dict) and entry.get('widget')]
        if len(widget_inputs) != len(widgets) or not all(entry.get('name') for entry in widget_inputs):
            return None
        preset_values[label] = dict(zip((entry['name'] for entry in widget_inputs), widgets))
    input_names = list(preset_values['高'])
    if any(set(values) != set(input_names) for values in preset_values.values()):
        return None
    schema = (info or {}).get('DLSS5Settings', {}).get('input', {})
    specs = {**schema.get('required', {}), **schema.get('optional', {})}
    controls = []
    for name in input_names:
        spec = specs.get(name) or []
        spec_type = spec[0] if spec else ''
        details = spec[1] if len(spec) > 1 and isinstance(spec[1], dict) else {}
        defaults = {label: copy.deepcopy(values[name]) for label, values in preset_values.items()}
        options = spec_type if isinstance(spec_type, list) else details.get('options')
        if spec_type == 'BOOLEAN' or isinstance(defaults['高'], bool):
            kind = 'boolean'
        elif options or spec_type == 'COMBO':
            kind = 'dropdown'
            if not options:
                options = list(dict.fromkeys(defaults.values()))
        elif spec_type in ('FLOAT', 'INT') or isinstance(defaults['高'], (int, float)):
            kind = 'number'
        else:
            kind = 'text'
        control = {'input': name, 'name': name, 'type': kind,
                   'defaults': defaults, 'advanced': bool(details.get('advanced'))}
        if options:
            control['options'] = list(options)
        for bound in ('min', 'max', 'step'):
            if bound in details:
                control[bound] = details[bound]
        if spec_type == 'INT':
            control['step'] = 1
        if details.get('tooltip'):
            control['tooltip'] = details['tooltip']
        controls.append(control)
    target = targets[0]
    return {'id': f'{target}:settings_preset', 'node': target, 'input': 'settings',
            'name': '增强档位', 'type': 'dropdown', 'default': '原工作流默认',
            'advanced': False, 'options': ['原工作流默认', '低', '中', '高'],
            'preset_links': choices, 'preset_controls': controls,
            'preset_schema_complete': bool(specs)}


def apply_dlss5_preset(graph, item, params):
    field = dlss5_preset_field(item)
    if not field:
        return graph
    target = field['node']
    supplied = (params.get(target) or {}).get('settings') if isinstance(params, dict) else None
    if supplied is None:
        return graph
    label = next((label for label, link in field['preset_links'].items()
                  if supplied == link), None)
    if label is None:
        raise ValueError('增强档位无效，请重新选择低、中或高')
    node_id = field['preset_links'][label][0]
    source_node = next(node for node in item['source']['nodes'] if str(node.get('id')) == node_id)
    widgets = source_node.get('widgets_values')
    inputs = source_node.get('inputs')
    if not isinstance(widgets, list) or not isinstance(inputs, list):
        raise ValueError('增强档位节点缺少参数，请重新转换工作流')
    names = [entry.get('name') for entry in inputs if isinstance(entry, dict) and entry.get('widget')]
    if len(names) != len(widgets) or not all(names):
        raise ValueError('增强档位节点参数已变化，请重新转换工作流')
    graph[node_id] = {'class_type': 'DLSS5Settings',
                      'inputs': dict(zip(names, copy.deepcopy(widgets))),
                      '_meta': {'title': label}}
    return graph


def _workflow_incoming(source):
    incoming = {}
    for link in source.get('links') or []:
        if isinstance(link, list) and len(link) >= 5:
            incoming.setdefault(str(link[3]), set()).add(str(link[1]))
        elif isinstance(link, dict):
            incoming.setdefault(str(link.get('target_id')), set()).add(str(link.get('origin_id')))
    return incoming


def _workflow_ancestors(members, incoming):
    keep = set(members)
    pending = list(keep)
    while pending:
        for upstream in incoming.get(pending.pop(), ()):
            if upstream not in keep:
                keep.add(upstream)
                pending.append(upstream)
    return keep


def workflow_for_group(source, group_id):
    groups = workflow_groups(source)
    group = next((g for g in groups if g['id'] == str(group_id)), None)
    if not group:
        raise ValueError('工作流分组不存在，请重新打开工作流')
    keep = _workflow_ancestors(group['nodes'], _workflow_incoming(source))
    selected = copy.deepcopy(source)
    for node in selected['nodes']:
        # Group bypass controls are frontend-only and must not override the
        # selected modes when the native editor configures the graph.
        node['mode'] = 0 if str(node['id']) in keep else 2
    selected['nodes'] = [n for n in selected['nodes'] if 'Bypasser' not in str(n.get('type', ''))]
    return selected, group


def active_graph(graph, info):
    """Keep only ancestors of output nodes, including output nodes themselves."""
    roots = [key for key, node in graph.items() if info.get(node['class_type'], {}).get('output_node')]
    if not roots:
        raise ValueError('没有找到可识别的输出节点。请先补齐节点，再在高级编辑中检查输出。')
    keep = set()
    def visit(key):
        if key in keep:
            return
        if key not in graph:
            raise ValueError('连线引用了不存在的节点：' + key)
        keep.add(key)
        for value in graph[key].get('inputs', {}).values():
            if isinstance(value, list) and len(value) == 2 and isinstance(value[1], int):
                visit(str(value[0]))
    for key in roots:
        visit(key)
    return {key: copy.deepcopy(node) for key, node in graph.items() if key in keep}


LEGACY_SCHEDULER_ALIASES = {
    # Some exported Z-Image workflows contain the Diffusers scheduler class
    # name in a KSampler combo field. ComfyUI's KSampler uses its own short
    # scheduler choices; the built-in Z-Image workflow uses ``simple``.
    'FlowMatchEulerDiscreteScheduler': 'simple',
}

# A few public Z-Image workflow exports predate the current ComfyUI model
# filename.  Treat the old reference as the same VAE only when the current
# backend exposes the replacement or the local model tree already contains
# it; never download an arbitrary same-name file as a substitute.
LEGACY_MODEL_ALIASES = {
    'ae.sft': 'ae.safetensors',
}


def normalize_legacy_scheduler_values(graph):
    """Repair known exported scheduler values before a local ComfyUI run."""
    if not isinstance(graph, dict):
        return graph
    for node in graph.values():
        if not isinstance(node, dict) or node.get('class_type') not in {'KSampler', 'KSamplerAdvanced'}:
            continue
        inputs = node.get('inputs')
        if not isinstance(inputs, dict):
            continue
        replacement = LEGACY_SCHEDULER_ALIASES.get(inputs.get('scheduler'))
        if replacement:
            inputs['scheduler'] = replacement
    return graph


def normalize_legacy_node_types(graph, info=None):
    """Map known exported display-label node types to current class names."""
    if not isinstance(graph, dict):
        return graph
    info = info if isinstance(info, dict) else {}
    for node in graph.values():
        if not isinstance(node, dict):
            continue
        kind = node.get('class_type')
        replacement = NODE_TYPE_ALIASES.get(kind)
        if replacement and (not info or replacement in info):
            node['class_type'] = replacement
    return graph


def _legacy_model_alias(value):
    if not isinstance(value, str):
        return None
    return LEGACY_MODEL_ALIASES.get(PurePosixPath(value.replace('\\', '/')).name.casefold())


def normalize_legacy_model_values(graph, info):
    """Use a known current model filename when a workflow uses its old alias."""
    if not isinstance(graph, dict) or not isinstance(info, dict):
        return graph
    graph = graph.get('prompt', graph) if isinstance(graph.get('prompt'), dict) else graph
    for node in graph.values():
        if not isinstance(node, dict) or not isinstance(node.get('inputs'), dict):
            continue
        kind = str(node.get('class_type') or '')
        specs = info.get(kind, {}).get('input', {}) if isinstance(info.get(kind), dict) else {}
        specs = {**(specs.get('required') or {}), **(specs.get('optional') or {})}
        for field, value in list(node['inputs'].items()):
            replacement = _legacy_model_alias(value)
            if not replacement or replacement == value:
                continue
            spec = specs.get(field) or []
            choices = spec[0] if spec and isinstance(spec[0], list) else (
                spec[1].get('options', []) if len(spec) > 1 and isinstance(spec[1], dict) else [])
            if replacement in choices:
                node['inputs'][field] = replacement
    return graph


def _input_value(inputs, name, default=None):
    value = inputs.get(name, default)
    return value if not isinstance(value, (list, dict)) else default


def _swarm_targets(graph, source_id):
    targets = []
    source_id = str(source_id)
    for target_id, node in graph.items():
        for input_name, value in (node.get('inputs') or {}).items():
            if isinstance(value, list) and len(value) == 2 and str(value[0]) == source_id:
                targets.append({'node': str(target_id), 'input': str(input_name)})
    return targets


def _swarm_options(inputs):
    raw = inputs.get('values', inputs.get('options', []))
    if isinstance(raw, str):
        return [item.strip() for item in raw.split(',') if item.strip()]
    if isinstance(raw, (list, tuple)):
        return [item for item in raw if isinstance(item, (str, int, float, bool))]
    return []


def _swarm_fields(graph):
    fields = []
    groups = {}
    for key, node in graph.items():
        kind = str(node.get('class_type') or '')
        inputs = node.get('inputs') or {}
        if kind == 'SwarmInputGroup':
            group_id = str(_input_value(inputs, 'group', key) or key)
            groups[group_id] = {
                'title': str(_input_value(inputs, 'title', group_id)),
                'description': str(_input_value(inputs, 'description', '') or ''),
                'open_by_default': bool(_input_value(inputs, 'open_by_default', True)),
                'order': _input_value(inputs, 'order_priority', 0),
            }
            continue
        field_type = SWARM_FIELD_TYPES.get(kind)
        if not field_type:
            continue
        targets = _swarm_targets(graph, key)
        if not targets:
            # An unconnected SwarmInput cannot affect an output.  Keeping it
            # out of the runtime form is safer than presenting a control that
            # appears to work but changes nothing.
            continue
        default = _input_value(inputs, 'value', '')
        title = str(_input_value(inputs, 'title', kind))
        description = str(_input_value(inputs, 'description', '') or '')
        raw_id = str(_input_value(inputs, 'raw_id', key) or key)
        group_link = inputs.get('group')
        if isinstance(group_link, list) and group_link:
            group = str(group_link[0])
        else:
            group = str(_input_value(inputs, 'group', '') or '')
        field = {
            'id': 'swarm:' + raw_id,
            'node': targets[0]['node'],
            'input': targets[0]['input'],
            'targets': targets,
            'source_node': str(key),
            'source_type': kind,
            'raw_id': raw_id,
            'name': title,
            'description': description,
            'type': field_type,
            'default': None if field_type in ('image', 'audio', 'video') else default,
            'advanced': bool(_input_value(inputs, 'is_advanced', False)),
            'group': group,
            'order': _input_value(inputs, 'order_priority', 0),
            'view_type': str(_input_value(inputs, 'view_type', '') or ''),
        }
        for bound in ('min', 'max', 'step'):
            value = _input_value(inputs, bound, None)
            if value is not None:
                field[bound] = value
        options = _swarm_options(inputs)
        if options:
            field['options'] = options
        if field_type == 'text' and field.get('view_type') == 'prompt':
            field['type'] = 'textarea'
        fields.append(field)
    for field in fields:
        group_id = field.get('group')
        if group_id and group_id in groups:
            field['group_config'] = groups[group_id]
    fields.sort(key=lambda item: (str(item.get('group') or ''), item.get('order', 0), item['id']))
    return fields


def extract_fields(graph, info):
    swarm_fields = _swarm_fields(graph)
    if swarm_fields:
        return swarm_fields
    fields = []
    labels = {
        'image': '上传原图', 'images': '图片', 'text': '提示词', 'prompt': '提示词',
        'positive': '正向提示词', 'negative': '反向提示词', 'seed': '随机种子',
        'noise_seed': '随机种子', 'steps': '步数', 'cfg': '提示词强度',
        'denoise': '重绘强度', 'width': '宽度', 'height': '高度',
    }
    dlss_easy_labels = {
        'scenario': '处理场景', 'operation': '处理方式', 'scale': '放大倍率',
        'quality': '画质', 'look': '渲染风格', 'effect_strength': '效果强度',
    }
    for key, node in graph.items():
        kind = node['class_type']
        specs = info.get(kind, {}).get('input', {})
        specs = {**specs.get('required', {}), **specs.get('optional', {})}
        for name, value in node.get('inputs', {}).items():
            label = labels.get(name) or (dlss_easy_labels.get(name) if kind == 'DLSS5EasyPipeline' else None)
            if not label or isinstance(value, (list, dict)):
                continue
            spec = specs.get(name, [])
            if not spec:
                continue
            image = kind == 'LoadImage' and name == 'image'
            if name in ('image', 'images') and not image:
                continue
            data = spec[1] if len(spec) > 1 and isinstance(spec[1], dict) else {}
            options = spec[0] if spec and isinstance(spec[0], list) else data.get('options', [])
            if isinstance(value, bool):
                field_type = 'boolean'
            elif image:
                field_type = 'image'
            elif options:
                field_type = 'dropdown'
            elif isinstance(value, str):
                field_type = 'textarea' if name in ('text', 'prompt', 'positive', 'negative') else 'text'
            else:
                field_type = 'number'
            field = {'id': f'{key}:{name}', 'node': key, 'input': name,
                     'name': label, 'type': field_type,
                     'default': None if image else value,
                     'advanced': name not in ('image', 'images', 'text', 'prompt', 'positive', 'negative')
                                 and kind != 'DLSS5EasyPipeline'}
            if name in ('text', 'prompt', 'positive', 'negative'):
                roles, pending, visited = set(), [str(key)], set()
                while pending:
                    source_id = pending.pop()
                    if source_id in visited:
                        continue
                    visited.add(source_id)
                    for consumer_id, consumer in graph.items():
                        for port, link in consumer.get('inputs', {}).items():
                            if isinstance(link, list) and len(link) == 2 and str(link[0]) == source_id:
                                if port in ('positive', 'negative'):
                                    roles.add(port)
                                else:
                                    pending.append(str(consumer_id))
                if roles == {'negative'} or name == 'negative':
                    field.update(name='反向提示词', advanced=True)
                elif roles == {'positive'}:
                    field['name'] = '提示词'
            if options:
                field['options'] = list(options)
            for bound in ('min', 'max', 'step'):
                if bound in data:
                    field[bound] = data[bound]
            if spec[0] == 'INT':
                field['step'] = 1
            fields.append(field)
    return fields


def validate_fields(fields, supplied, uploads):
    if not isinstance(supplied, dict):
        raise ValueError('参数必须是对象')
    allowed = {f['id'] for f in fields}
    extra = set(supplied) - allowed
    if extra:
        raise ValueError('未配置的参数：' + '、'.join(sorted(extra)))
    params = {}
    for field in fields:
        value = supplied.get(field['id'], field.get('default'))
        if field['type'] in ('image', 'audio', 'video'):
            if not isinstance(value, str) or value not in uploads:
                raise ValueError(field['name'] + '：请重新上传文件')
        elif field['type'] == 'number':
            if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
                raise ValueError(field['name'] + '：请输入有效数字')
            if field.get('step') == 1 and int(value) != value:
                raise ValueError(field['name'] + '：请输入整数')
            if field.get('min') is not None and value < field['min'] or field.get('max') is not None and value > field['max']:
                raise ValueError(field['name'] + '：数值超出允许范围')
        elif field['type'] == 'boolean':
            if not isinstance(value, bool):
                raise ValueError(field['name'] + '：开关值无效')
        elif field['type'] == 'dropdown':
            if not isinstance(value, (str, int, float, bool)):
                raise ValueError(field['name'] + '：选项值无效')
            options = field.get('options') or []
            if options and str(value) not in {str(option) for option in options}:
                raise ValueError(field['name'] + '：请选择有效选项')
            for option in options:
                if str(option) == str(value):
                    value = option
                    break
        elif not isinstance(value, str) or len(value) > 100000:
            raise ValueError(field['name'] + '：文字无效或过长')
        if field.get('preset_links'):
            if value == field.get('default'):
                continue
            value = field['preset_links'].get(value)
            if not isinstance(value, list) or len(value) != 2:
                raise ValueError(field['name'] + '：请选择有效档位')
        targets = field.get('targets') or [{'node': field.get('node'), 'input': field.get('input')}]
        source_node = field.get('source_node')
        if source_node and field.get('source_type', '').startswith(SWARM_INPUT_PREFIX):
            # The compatibility node is the runtime owner of SwarmInput
            # values.  Keep the original links intact: replacing an IMAGE or
            # MODEL link with the uploaded filename would turn a typed output
            # into a string and break the downstream node.
            params.setdefault(str(source_node), {})['value'] = value
            targets = []
        for target in targets:
            if not target.get('node') or not target.get('input'):
                continue
            params.setdefault(target['node'], {})[target['input']] = value
    return params


class AppLibrary:
    def __init__(self, host):
        self.host = host
        self.root = Path(host.BASE_DIR) / 'ComfyUI' / 'comfy_apps'
        self.lock = threading.RLock()
        self.serial = asyncio.Lock()
        self.workers = set()
        self.runtime = ManagedRuntime(host.BASE_DIR)
        self.node_sources = NodeSourceResolver(self.runtime.root / 'node-source-cache.json')
        self.delete_confirmations = {}
        self.deleting = set()
        self.hardware_cache = {'at': 0.0, 'value': None}

    def _build_model_reference_index(self):
        """Index local model files once for a dependency/reference scan.

        Deletion previews used to call ``rglob`` separately for every model
        reference in every app and workflow.  That made the UI wait several
        seconds on a normal model tree, even though the same directory was
        being walked repeatedly.  The index is deliberately request-scoped:
        callers that make a safety decision can build a fresh view and never
        rely on stale deletion data.
        """
        by_name = {}
        by_relative_path = {}
        seen = set()
        for root in self._model_roots():
            root = Path(root)
            if not root.exists() or not root.is_dir():
                continue
            try:
                root_resolved = root.resolve()
                for path in root.rglob('*'):
                    if not path.is_file() or path.is_symlink() or '.cache' in path.parts:
                        continue
                    try:
                        resolved = path.resolve()
                        resolved.relative_to(root_resolved)
                    except (OSError, ValueError):
                        continue
                    key = self._path_key(resolved)
                    if key in seen:
                        continue
                    seen.add(key)
                    by_name.setdefault(resolved.name.casefold(), []).append(resolved)
                    relative = resolved.relative_to(root_resolved).as_posix().casefold()
                    by_relative_path.setdefault(relative, []).append(resolved)
            except OSError:
                continue
        return {'by_name': by_name, 'by_relative_path': by_relative_path}

    @staticmethod
    def _memory_gb():
        """Return total physical memory without making psutil a hard dependency."""
        try:
            if os.name == 'nt':
                class MemoryStatus(ctypes.Structure):
                    _fields_ = [
                        ('dwLength', ctypes.c_ulong),
                        ('dwMemoryLoad', ctypes.c_ulong),
                        ('ullTotalPhys', ctypes.c_ulonglong),
                        ('ullAvailPhys', ctypes.c_ulonglong),
                        ('ullTotalPageFile', ctypes.c_ulonglong),
                        ('ullAvailPageFile', ctypes.c_ulonglong),
                        ('ullTotalVirtual', ctypes.c_ulonglong),
                        ('ullAvailVirtual', ctypes.c_ulonglong),
                        ('ullAvailExtendedVirtual', ctypes.c_ulonglong),
                    ]
                status = MemoryStatus()
                status.dwLength = ctypes.sizeof(MemoryStatus)
                if ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(status)):
                    return status.ullTotalPhys / 1024 ** 3
            if hasattr(os, 'sysconf'):
                return os.sysconf('SC_PHYS_PAGES') * os.sysconf('SC_PAGE_SIZE') / 1024 ** 3
        except (AttributeError, OSError, TypeError, ValueError):
            pass
        return None

    @staticmethod
    def _gb_from_memory_value(value, unit='bytes'):
        try:
            number = float(value)
        except (TypeError, ValueError):
            return None
        if number <= 0:
            return None
        if unit == 'mb':
            return number / 1024
        # ComfyUI and torch report bytes. Some lightweight adapters expose MB
        # or GB instead, so retain a conservative fallback for small values.
        if number >= 1024 ** 3:
            return number / 1024 ** 3
        if number >= 1024:
            return number / 1024
        return number

    @staticmethod
    def _address_candidates(host, item=None):
        addresses = []
        if item:
            for key in ('backend',):
                value = item.get(key)
                if isinstance(value, str):
                    addresses.append(value.removeprefix('http://').removeprefix('https://').rstrip('/'))
            if item.get('managed'):
                addresses.append('127.0.0.1:8190')
        for value in getattr(host, 'COMFYUI_INSTANCES', []) or []:
            if isinstance(value, str):
                addresses.append(value.removeprefix('http://').removeprefix('https://').rstrip('/'))
        return list(dict.fromkeys(addresses))

    def _hardware_info_uncached(self, item=None):
        ram_gb = self._memory_gb()
        gpus = []

        # Prefer the running ComfyUI system_stats endpoint: it already knows
        # which CUDA device the actual backend is using.
        for address in self._address_candidates(self.host, item):
            try:
                response = requests.get('http://' + address + '/system_stats', timeout=2)
                response.raise_for_status()
                payload = response.json()
                system = payload.get('system') if isinstance(payload, dict) else {}
                if isinstance(system, dict) and ram_gb is None:
                    ram_gb = self._gb_from_memory_value(system.get('ram_total'))
                devices = payload.get('devices', []) if isinstance(payload, dict) else []
                for device in devices if isinstance(devices, list) else []:
                    if not isinstance(device, dict):
                        continue
                    device_type = str(device.get('type') or '').lower()
                    name = str(device.get('name') or device.get('device') or '').strip()
                    if device_type == 'cpu' or name.lower() == 'cpu':
                        continue
                    vram = self._gb_from_memory_value(
                        device.get('vram_total', device.get('vram_total_bytes')))
                    if name or vram is not None:
                        gpus.append({'name': name or 'CUDA GPU', 'vram_gb': round(vram, 2) if vram is not None else None,
                                     'source': 'ComfyUI system_stats'})
                if gpus:
                    break
            except (OSError, requests.RequestException, ValueError, TypeError):
                continue

        if not gpus:
            try:
                import torch
                if torch.cuda.is_available():
                    for index in range(torch.cuda.device_count()):
                        props = torch.cuda.get_device_properties(index)
                        gpus.append({'name': str(props.name),
                                     'vram_gb': round(props.total_memory / 1024 ** 3, 2),
                                     'source': 'PyTorch CUDA'})
            except Exception:
                # Hardware inspection must never make importing an app fail.
                pass

        if not gpus:
            try:
                flags = subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0
                result = subprocess.run(
                    ['nvidia-smi', '--query-gpu=name,memory.total', '--format=csv,noheader,nounits'],
                    capture_output=True, text=True, timeout=3, creationflags=flags, check=False)
                for line in result.stdout.splitlines():
                    parts = [part.strip() for part in line.split(',', 1)]
                    if not parts or not parts[0]:
                        continue
                    vram = self._gb_from_memory_value(parts[1], unit='mb') if len(parts) > 1 else None
                    gpus.append({'name': parts[0], 'vram_gb': round(vram, 2) if vram is not None else None,
                                 'source': 'nvidia-smi'})
            except (FileNotFoundError, OSError, subprocess.SubprocessError, ValueError):
                pass

        try:
            disk = shutil.disk_usage(Path(self.host.BASE_DIR))
            disk_free_gb = disk.free / 1024 ** 3
        except (OSError, TypeError, ValueError):
            disk_free_gb = None
        cpu = platform.processor() or platform.machine() or '未知 CPU'
        return {
            'os': f'{platform.system()} {platform.release()}'.strip(),
            'cpu': cpu,
            'cpu_count': os.cpu_count(),
            'ram_gb': round(ram_gb, 1) if ram_gb is not None else None,
            'gpu': gpus,
            'disk_free_gb': round(disk_free_gb, 2) if disk_free_gb is not None else None,
            'base_comfyui_ready': self._base_comfyui_ready(),
        }

    def hardware_info(self, item=None):
        now = time.monotonic()
        cached = self.hardware_cache.get('value')
        if cached is not None and now - self.hardware_cache.get('at', 0) < HARDWARE_CACHE_TTL:
            return copy.deepcopy(cached)
        value = self._hardware_info_uncached(item)
        self.hardware_cache = {'at': now, 'value': value}
        return copy.deepcopy(value)

    def _base_comfyui_ready(self):
        base = Path(self.runtime.base)
        python = base / '.venv' / ('Scripts' if os.name == 'nt' else 'bin') / ('python.exe' if os.name == 'nt' else 'python')
        return bool(python.exists() and (base / 'core' / 'main.py').exists())

    @staticmethod
    def _workflow_text(item):
        try:
            return json.dumps(item.get('api') or item.get('source') or {}, ensure_ascii=False).lower()
        except (TypeError, ValueError):
            return ''

    def _refresh_static_report(self, item, model_index=None):
        """Refresh model references for apps created by an older build.

        Reports are persisted with the app, so adding a new loader heuristic
        must also work for already-imported applications.  This refresh does
        not claim that the backend is online and deliberately leaves live
        node/authorization results untouched.
        """
        source = item.get('api') or item.get('source')
        if not isinstance(source, dict):
            return item.get('report') or {}
        try:
            static = inspect_workflow(source, {})
        except (TypeError, ValueError):
            return item.get('report') or {}
        report = item.setdefault('report', {})
        # The current source is authoritative.  Reusing the old list here
        # would keep a model from a previous profile/workflow forever after a
        # user replaced the file.
        previous_names = {entry.get('name') for entry in report.get('model_requirements', [])}
        report['model_requirements'] = list(static.get('model_requirements') or [])
        current_names = {entry.get('name') for entry in report['model_requirements']}
        report['missing_models'] = [name for name in report.get('missing_models', [])
                                    if name in current_names or (name not in previous_names
                                    and str(name).casefold() not in {'none', 'null', 'cpu', 'cuda', 'mps'}
                                    and not str(name).casefold().startswith('cuda:'))]
        if item.get('api') and isinstance(item.get('source', {}).get('nodes'), list):
            originals = inspect_workflow(item['source'], {}).get('model_requirements', [])
            for requirement in report['model_requirements']:
                matches = [entry for entry in originals if entry.get('name') == requirement.get('name')
                           and entry.get('category') == requirement.get('category') and entry.get('source')]
                urls = {entry['source'] for entry in matches}
                if len(urls) == 1:
                    requirement['source'] = urls.pop()
                hashes = {entry['sha256'] for entry in originals if entry.get('name') == requirement.get('name')
                          and entry.get('category') == requirement.get('category') and entry.get('sha256')}
                if len(hashes) == 1:
                    requirement['sha256'] = hashes.pop()
        return self._apply_static_model_status(item, report, model_index)

    def _dependency_preflight(self, item):
        report = self._refresh_static_report(item)
        missing_nodes = list(report.get('missing_nodes') or [])
        missing_models = list(report.get('missing_models') or [])
        review_nodes = list(report.get('review_nodes') or [])
        unknown_nodes = list(report.get('unknown_nodes') or [])
        installed, automatic, manual = [], [], []

        if not report.get('backend_available'):
            automatic.append({
                'kind': '环境检查', 'name': '启动本地 ComfyUI 并扫描节点',
                'detail': '本地服务尚未连接；启动独立环境后检查工作流节点，并继续安装能确认来源的缺失节点。',
                'status': '待启动 / 检查',
            })

        bridge_files = self.runtime.root / 'custom_nodes' / 'xiaomei_app_bridge'
        if not item.get('api') and not ((bridge_files / '__init__.py').is_file()
                                      and (bridge_files / 'web' / 'bridge.js').is_file()):
            automatic.append({'kind': '转换桥接', 'name': '小美本地 ComfyUI 转换桥接',
                              'detail': '用于把普通节点图转换为 API 工作流；只安装本地桥接文件',
                              'status': '待准备'})
        has_swarm_inputs = bool(report.get('swarm_inputs') or any(
            str(node.get('class_type', node.get('type', '')) or '').startswith(SWARM_INPUT_PREFIX)
            for graph in self._graphs(item)
            for node in (graph.get('nodes', []) if isinstance(graph.get('nodes'), list) else graph.values())
            if isinstance(node, dict)))
        swarm_missing = any(str(name).startswith(SWARM_INPUT_PREFIX)
                            for name in missing_nodes)
        if has_swarm_inputs and (not item.get('managed') or swarm_missing):
            automatic.append({'kind': '兼容桥接', 'name': 'SwarmInput 本地兼容桥接',
                              'detail': ('更新并重启本地独立 ComfyUI；不安装完整 SwarmUI'
                                         if item.get('managed') else
                                         '让 SwarmUI 风格输入节点在本地独立 ComfyUI 中可执行；不安装完整 SwarmUI'),
                              'status': '待更新' if item.get('managed') else '待准备'})
        if item.get('description', '').startswith('SeeThrough'):
            node_path = self.runtime.root / 'custom_nodes' / 'ComfyUI-See-through'
            node = {'kind': '自定义节点', 'name': 'ComfyUI-See-through', 'source': SOURCE,
                    'detail': '固定版本，来源已登记，可由本地安装器准备',
                    'status': '已安装' if node_path.exists() else '待安装'}
            (installed if node_path.exists() else automatic).append(node)
            for resource in self.runtime.resources():
                entry = {'kind': '模型', 'name': resource['name'], 'source': resource.get('source'),
                         'detail': resource.get('size_note', '安装器登记的模型来源'),
                         'status': '已安装' if resource.get('installed') else '待安装'}
                (installed if resource.get('installed') else automatic).append(entry)

        node_resolution = self.node_sources.resolve(
            name for name in missing_nodes if name != 'Float')
        node_packages = node_resolution['packages']
        for package in node_packages:
            detail = ('精确匹配并固定到提交 ' + package['revision'][:12] + '；安装到独立环境并重启复检：'
                      + '、'.join(package['required_nodes']))
            if package.get('stale_revision'):
                detail += '。当前离线，使用上次已核验的固定提交'
            if package.get('post_install'):
                detail += '。' + package['post_install']
            automatic.append({'kind': '节点包', 'name': package['display_name'],
                              'source': package['source'], 'origin': package['origin'],
                              'revision': package['revision'], 'detail': detail,
                              'status': '待安装 / 重启后检查加载'})
        supported = set(node_resolution['resolved_nodes'])
        if 'Float' in missing_nodes:
            automatic.append({'kind': '兼容桥接', 'name': 'Float 数值输入节点',
                              'detail': '准备本地环境以更新桥接并重启，保留工作流原有数值', 'status': '待更新'})
            supported.add('Float')
        for name in missing_nodes:
            if name in supported:
                continue
            issue = node_resolution['issues'].get(name, {})
            detail = ('此工作流用该节点调用豆包视觉模型描述图片。请从工作流作者获取节点与配置说明，'
                      '或在高级编辑中改用本地图片描述节点并重新连接提示词。导入模型文件不会补齐此节点。'
                      if name == 'LibLibVisionV2Seed' else
                      (issue.get('detail') or '工作流未提供可核验的安装来源。')
                      + ' 请向作者获取准确节点仓库；系统不会按相似名称猜测或改写工作流。')
            entry = {'kind': '节点', 'name': name, 'detail': detail,
                     'reason': issue.get('status', 'not_found')}
            if issue.get('sources'):
                entry['sources'] = issue['sources']
            manual.append(entry)
        requirements = report.get('model_requirements') or []
        requirements_by_name = {str(entry.get('name')): entry for entry in requirements}
        listed_models = set()
        for requirement in requirements:
            name = str(requirement.get('name') or '').strip()
            display_name = str(requirement.get('resolved_name') or name).strip()
            model_key = (requirement.get('category'), display_name)
            if name and name not in missing_models and model_key not in listed_models:
                listed_models.add(model_key)
                installed_entry = {'kind': '模型', 'name': display_name,
                                  'category': requirement.get('category', 'models'),
                                  'status': '已安装', 'detail': '已在本机模型目录中找到'}
                if display_name != name:
                    installed_entry['requested_name'] = name
                installed.append(installed_entry)
        for name in missing_models:
            requirement = requirements_by_name.get(name, {})
            source = self._model_source(item, name, requirement)
            if source:
                automatic.append({'kind': '模型', 'name': name,
                                  'category': source['category'],
                                  'download_id': source['name'],
                                  'source': source['source'],
                                  'detail': source['size_note'],
                                  'status': '待下载'})
            else:
                manual_source = MANUAL_MODEL_SOURCES.get(
                    PurePosixPath(str(name).replace('\\', '/')).name.casefold(), {})
                search = (item.get('model_search') or {}).get(name, {})
                manual.append({'kind': '模型', 'name': name,
                               'category': requirement.get('category', 'models'),
                               'node': requirement.get('node'),
                               'input': requirement.get('input'),
                               'source': requirement.get('source') or manual_source.get('source', ''),
                               'search': search,
                               'detail': search.get('detail') or manual_source.get(
                                   'detail',
                                   '可自动搜索公开来源；找到匹配文件后下载并校验，未找到时会列出原因。')})
        for name in review_nodes:
            manual.append({'kind': '云端/授权节点', 'name': name,
                           'detail': '可能需要账号、云端服务或作者授权，不能标记为本地免费可运行'})
        for name in unknown_nodes:
            if name not in review_nodes and not any(entry['name'] == name for entry in manual):
                manual.append({'kind': '自定义代码', 'name': name,
                               'detail': '尚未完成离线审查，不能自动执行或安装'})
        if item.get('conversion_error'):
            manual.append({'kind': '工作流转换', 'name': '普通节点图转换失败',
                           'detail': item['conversion_error']})
        if not automatic and not manual and item.get('api'):
            installed.append({'kind': '工作流依赖', 'name': '当前本地 ComfyUI 检查通过',
                              'detail': '未发现缺失节点或模型'})
        return {'installed': installed, 'auto_installable': automatic, 'manual': manual,
                'node_catalog': node_resolution['catalog']}

    def preflight(self, item):
        hardware = self.hardware_info(item)
        dependencies = self._dependency_preflight(item)
        known, unknown, hard_failures, hardware_warnings, warnings = [], [], [], [], []
        is_seethrough = item.get('description', '').startswith('SeeThrough')
        is_zimage = 'z_image_turbo' in self._workflow_text(item)
        is_dlss5 = 'dlss5' in self._workflow_text(item)
        guidance = []
        gpus = hardware.get('gpu') or []
        vram_values = [gpu.get('vram_gb') for gpu in gpus if gpu.get('vram_gb') is not None]
        if is_seethrough:
            minimum = 8
            actual = max(vram_values) if vram_values else None
            requirement = {'label': 'GPU 显存（省显存配置）', 'minimum_gb': minimum,
                           'actual_gb': actual, 'reason': '分层 1024 / 深度 720 / 30 步的默认配置'}
            known.append(requirement)
            if actual is None:
                hardware_warnings.append('未检测到可确认的 CUDA 显卡显存；可以继续尝试，但不能提前保证能运行。')
            elif actual < minimum:
                hard_failures.append(f'检测到最高显存约 {actual:.1f} GB，低于本应用省显存配置所需的 {minimum} GB。')
            manifest = self.runtime.root / 'resource-manifest.json'
            missing_bytes = 0
            if manifest.exists():
                try:
                    expected = json.loads(manifest.read_text(encoding='utf-8'))
                    for relative, size in expected.items():
                        path = self.runtime.root / PurePosixPath(str(relative))
                        if not path.is_file() or path.stat().st_size != int(size):
                            missing_bytes += int(size)
                except (OSError, TypeError, ValueError, json.JSONDecodeError):
                    unknown.append({'label': '模型磁盘空间', 'reason': '模型清单无法读取，完整下载体积待安装器核验。'})
            else:
                unknown.append({'label': '模型磁盘空间', 'reason': '首次下载体积由模型仓库决定，当前没有可核验的本地清单。'})
            if missing_bytes:
                needed_gb = missing_bytes / 1024 ** 3
                disk_free = hardware.get('disk_free_gb')
                known.append({'label': '可用磁盘空间', 'minimum_gb': round(needed_gb, 2),
                              'actual_gb': disk_free, 'reason': '本地模型清单中仍缺少的文件总量'})
                if disk_free is not None and disk_free < needed_gb:
                    hard_failures.append(f'工作区磁盘剩余约 {disk_free:.2f} GB，低于待下载模型至少需要的 {needed_gb:.2f} GB。')
        elif is_zimage:
            actual = max(vram_values) if vram_values else None
            guidance.append({'label': 'Z-Image-Turbo 硬件参考',
                'detail': '官方介绍以 16GB 显存消费级显卡为参考，并提供 CPU 卸载方式；16GB 不是本工作流的硬性最低要求。',
                'source': 'https://huggingface.co/Tongyi-MAI/Z-Image-Turbo'})
            if actual is not None and actual < 16:
                guidance.append({'label': '本机运行建议',
                    'detail': f'本机显存 {actual:g}GB，建议先用 512×512、单张生成验证；由 ComfyUI 将部分权重卸载到系统内存。首次加载可能较慢，成功后再提高尺寸。'})
            else:
                guidance.append({'label': '本机运行建议', 'detail': '先用单张生成验证，再逐步提高尺寸和批量；实际显存随分辨率及 LoRA 改变。'})
            guidance.append({'label': '运行验证', 'detail': '依赖齐全后才能实测峰值显存；硬件信息已识别不代表已经成功出图。'})
        elif any(token in self._workflow_text(item) for token in ('seedvr', 'z-image', 'upscal', 'diffusion', 'flux', 'sdxl')):
            unknown.append({'label': 'GPU/显存', 'reason': '该工作流包含大模型或超分节点，JSON 无法可靠推断最低显存。'})
            hardware_warnings.append('工作流的 GPU/显存需求无法从 JSON 可靠估算，请以实际节点和模型说明为准。')
        else:
            unknown.append({'label': 'GPU/显存', 'reason': '工作流没有登记明确的硬件最低要求。'})

        if not hardware.get('base_comfyui_ready'):
            hard_failures.append('未找到可复用的本机 ComfyUI 环境（需要包含 core 和 .venv）。请先启动/配置本机 ComfyUI，或设置 XIAOMEI_COMFY_BASE。')
        if hardware.get('ram_gb') is None:
            hardware_warnings.append('无法读取系统内存，安装器不会据此虚报“硬件满足”。')
        if hardware.get('disk_free_gb') is None:
            hardware_warnings.append('无法读取工作区磁盘剩余空间，下载过程中仍会再次检查。')
        if not gpus:
            hardware_warnings.append('未检测到 NVIDIA/CUDA GPU；CPU 运行大模型通常会非常慢或无法完成。')
        if is_dlss5:
            guidance.append({
                'label': 'DLSS5 首次运行还需确认原生运行时',
                'detail': ('节点包会自动安装并复检；首次出图前仍需在高级编辑中运行插件的 '
                           '“DLSS Runtime Setup (One Click)”，按插件界面确认安装并运行状态检查。'),
                'source': ('https://github.com/HECer/ComfyUI-DLSS5/blob/'
                           'f4f59cd1fe39e785a3b600ca20b5e09194a9e38d/README.md'),
            })
            if not str(hardware.get('os') or '').lower().startswith('windows'):
                hard_failures.append('DLSS5 节点仅支持 64 位 Windows 与 NVIDIA CUDA/RTX 显卡。')

        if dependencies['manual']:
            warnings.append('待补齐：' + '、'.join(entry['name'] for entry in dependencies['manual']))
        if dependencies.get('node_catalog', {}).get('error'):
            warnings.append(dependencies['node_catalog']['error'])
        if unknown:
            warnings.append('部分硬件需求无法从工作流准确判断，安装前仅作风险提示。')
        if hard_failures:
            status = 'blocked'
            summary = '当前环境不满足已知安装条件'
        elif warnings or hardware_warnings:
            status = 'warning'
            summary = '可以安装已登记依赖，但仍有风险或手动项目'
        else:
            status = 'pass'
            summary = '硬件和已登记依赖检查通过'
        hardware_status = 'blocked' if any('显存' in reason or 'CUDA' in reason for reason in hard_failures) else ('warning' if hardware_warnings else 'pass')
        return {
            'status': status, 'summary': summary, 'hardware_status': hardware_status,
            'hardware': hardware, 'requirements': {'known': known, 'unknown': unknown},
            'guidance': guidance,
            'dependencies': dependencies, 'hard_failures': hard_failures,
            'warnings': hardware_warnings + warnings,
        }

    def path(self, app_id):
        if not re.fullmatch(r'[a-f0-9]{32}', app_id):
            raise HTTPException(404, '应用不存在')
        return self.root / app_id / 'app.json'

    def read(self, app_id, model_index=None):
        path = self.path(app_id)
        if not path.exists():
            raise HTTPException(404, '应用不存在')
        item = json.loads(path.read_text(encoding='utf-8'))
        workflow_path = Path(self.host.workflow_path_from_name(item['workflow']))
        if item.get('api') and workflow_path.exists():
            item['api'] = json.loads(workflow_path.read_text(encoding='utf-8'))
        config_path = Path(self.host.workflow_config_path(item['workflow']))
        if item.get('api') and config_path.exists():
            config = json.loads(config_path.read_text(encoding='utf-8'))
            item['fields'] = config.get('fields', item.get('fields', []))
            item['title'] = config.get('title') or item['title']
        preset = dlss5_preset_field(item)
        if preset:
            fields = item.setdefault('fields', [])
            existing = next((field for field in fields if field.get('id') == preset['id']), None)
            if existing:
                existing.update({key: value for key, value in preset.items() if key != 'name'})
            else:
                fields.append(preset)
        self._refresh_static_report(item, model_index)
        item['entry_type'] = 'app'
        return self._decorate(item)

    def save(self, item):
        write_json(self.path(item['id']), item)

    def replacement_requirement(self, item, dependency, category):
        with self.host.CANVAS_TASK_LOCK:
            if any(t.get('app_id') == item['id'] and t.get('status') in ('queued', 'running')
                   for t in self.host.CANVAS_TASKS.values()):
                raise HTTPException(409, '工作流正在运行或准备，请完成或取消后再替换模型')
        matches = [r for r in self._refresh_static_report(item).get('model_requirements', [])
                   if r['name'] == dependency and r['category'] == category]
        if not matches:
            raise HTTPException(400, '该模型引用已变化，请重新打开工作流后选择替换项')
        if category not in {'checkpoints', 'diffusion_models', 'text_encoders', 'vae', 'loras',
                            'upscale_models', 'controlnet', 'clip_vision', 'SEEDVR2'}:
            raise HTTPException(400, '无法确定模型目录，请先在高级编辑中确认加载器')
        return matches

    def replacement_files(self, category):
        found = {}
        for root in (self.runtime.base / 'models', self.runtime.root / 'models'):
            folder = root / category
            if not folder.is_dir():
                continue
            for path in folder.rglob('*'):
                if path.is_file() and path.suffix.lower() in MODEL_FILE_EXTENSIONS and path.resolve().is_relative_to(folder.resolve()):
                    found.setdefault(path.relative_to(folder).as_posix(), []).append(path)
        return found

    @staticmethod
    def check_replacement_file(path, category, filename=None):
        if Path(filename or path.name).suffix.lower() != '.safetensors':
            return '文件类别一致；模型架构兼容性需实际运行验证'
        try:
            with path.open('rb') as stream:
                size = struct.unpack('<Q', stream.read(8))[0]
                if not 2 <= size <= 32 * 1024 * 1024:
                    raise ValueError('无效头部长度')
                header = json.loads(stream.read(size))
            if not isinstance(header, dict) or not isinstance(header.get('__metadata__', {}), dict):
                raise ValueError('无效模型头部')
            tensors = {k: v for k, v in header.items() if k != '__metadata__'}
            if not tensors:
                raise ValueError('没有模型张量')
            data_size = path.stat().st_size - 8 - size
            for tensor in tensors.values():
                start, end = tensor['data_offsets']
                if not 0 <= start <= end <= data_size:
                    raise ValueError('模型文件不完整')
            has_lora = any(any(marker in k.lower() for marker in ('lora_', 'lora.', 'hada_', 'lokr_')) for k in tensors)
            if category == 'loras' and not has_lora:
                raise ValueError('未检测到 LoRA 权重，请选择 LoRA 文件')
            if category != 'loras' and has_lora:
                raise ValueError('这是 LoRA 权重，不能用来替换基础模型')
            family = str((header.get('__metadata__') or {}).get('ss_base_model_version') or '')
            return ('文件标注的基础模型：' + family + '；兼容性需实际运行验证') if family else '文件结构检查通过；模型架构兼容性需实际运行验证'
        except (ValueError, TypeError, KeyError, struct.error, OSError) as exc:
            raise HTTPException(400, '替换文件检查失败：' + str(exc)) from exc

    def replace_model_reference(self, app_id, dependency, category, replacement):
        with self.lock:
            item = self.read(app_id)
            targets = self.replacement_requirement(item, dependency, category)
            candidates = self.replacement_files(category).get(replacement, [])
            if not candidates:
                raise HTTPException(400, '替换模型不在对应目录中，请重新选择或上传')
            if len({str(p.resolve()) for p in candidates}) > 1:
                raise HTTPException(409, '多个模型目录存在同名文件，请先整理文件名以免引用错误')
            compatibility = self.check_replacement_file(candidates[0], category)
            item.setdefault('model_replacement_original', {k: copy.deepcopy(item.get(k))
                for k in ('source', 'api', 'fields', 'original_api')})
            for key in ('api', 'source', 'original_api'):
                graph = item.get(key)
                if not isinstance(graph, dict):
                    continue
                refs = [r for r in inspect_workflow(graph, {}).get('model_requirements', [])
                        if r['name'] == dependency and r['category'] == category]
                if isinstance(graph.get('nodes'), list):
                    ids = {str(r['node']) for r in refs}
                    for node in graph['nodes']:
                        matched_api = any(str(t['node']) == str(node.get('id')) and t['class_type'] == node.get('type') for t in targets)
                        if str(node.get('id')) not in ids and not matched_api:
                            continue
                        widgets = node.get('widgets_values', [])
                        if not isinstance(widgets, list):
                            raise HTTPException(400, '该节点的参数格式暂不支持自动替换，请在高级编辑中修改')
                        node['widgets_values'] = [replacement if v == dependency else v for v in widgets]
                        props = node.get('properties') or {}
                        if isinstance(props.get('models'), list):
                            props['models'] = [m for m in props['models'] if not isinstance(m, dict) or m.get('name') != dependency]
                else:
                    nodes = graph.get('prompt', graph)
                    for ref in refs:
                        nodes[str(ref['node'])]['inputs'][ref['input']] = replacement
            for field in item.get('fields', []):
                if any(str(field.get('node')) == str(t['node']) and field.get('input') == t['input'] for t in targets):
                    if field.get('default') == dependency:
                        field['default'] = replacement
                    if isinstance(field.get('options'), list):
                        field['options'] = [replacement if v == dependency else v for v in field['options']]
            item.setdefault('model_replacements', []).append({'from': dependency, 'to': replacement,
                'category': category, 'at': time.time(), 'compatibility': compatibility})
            item.get('model_search', {}).pop(dependency, None)
            item['verified'] = False
            for key in ('runtime_error', 'prepare_error', 'rescan_error'):
                item.pop(key, None)
            if item.get('api'):
                write_json(self.host.workflow_path_from_name(item['workflow']), item['api'])
                config = self._workflow_config(item['workflow'])
                config['fields'] = item.get('fields', [])
                write_json(self.host.workflow_config_path(item['workflow']), config)
            try:
                backend, info = self.backend(item)
                item['backend'] = backend
                self.analyze(item, info)
            except HTTPException as exc:
                item['state'] = 'blocked'
                item['rescan_error'] = exc.detail
            self.save(item)
            return {'ok': True, 'item': self.read(app_id), 'compatibility': compatibility,
                    'message': f'已将 {dependency} 替换为 {replacement}。{compatibility}'}

    def sync_deleted_workflow(self, name):
        """Hide application copies whose workflow source was deleted elsewhere.

        The legacy canvas settings page owns ``/api/workflows``. When it
        deletes a workflow file, the app manifest must not remain visible in
        the separate AI application catalog. This covers both an app's own
        executable copy and an app linked to that source workflow. Move only
        application files to the existing local recovery area; model files,
        shared workflows, tasks and protected models are never touched here.
        """
        deleted = []
        target = str(name or '').replace('\\', '/')
        if not target:
            return deleted
        with self.lock:
            for manifest in sorted(self.root.glob('*/app.json')):
                try:
                    item = json.loads(manifest.read_text(encoding='utf-8'))
                except (OSError, ValueError, TypeError):
                    continue
                workflow = str(item.get('workflow') or '').replace('\\', '/')
                source = str(item.get('workflow_source') or '').replace('\\', '/')
                if workflow != target and source != target:
                    continue
                try:
                    archive_root, archived = self._archive_app(item)
                except (OSError, ValueError, HTTPException):
                    # The workflow deletion itself has already succeeded. Do
                    # not make that operation fail because a stale app
                    # manifest is locked; the next catalog scan can still
                    # report the remaining manifest for manual recovery.
                    continue
                deleted.append({
                    'id': item.get('id', ''),
                    'title': item.get('title', ''),
                    'archive': archive_root.name,
                    'files': archived,
                })
        return deleted

    @staticmethod
    def _workflow_status(item):
        if (item.get('report') or {}).get('missing_nodes'):
            return 'missing_nodes'
        if item.get('conversion_error'):
            return 'conversion_failed'
        if not item.get('api'):
            return 'needs_conversion'
        report = item.get('report') or {}
        if report.get('swarm_inputs') and not item.get('managed'):
            return 'needs_bridge'
        if report.get('missing_models'):
            return 'missing_models'
        if report.get('missing_nodes'):
            return 'missing_nodes'
        if report.get('review_nodes'):
            return 'cloud_review'
        if report.get('unknown_nodes'):
            return 'manual_review'
        if report.get('reasons'):
            return 'needs_configuration'
        if report.get('backend_available') is False:
            return 'needs_check'
        return 'ready'

    def _environment_status(self, item):
        task_id = item.get('prepare_task')
        tasks = getattr(self.host, 'CANVAS_TASKS', {}) or {}
        task = tasks.get(task_id) if task_id else None
        task_status = task.get('status') if isinstance(task, dict) else None
        if task_status in ('queued', 'running') or item.get('state') == 'preparing':
            return 'running'
        if task_status == 'cancelled':
            return 'cancelled'
        if task_status == 'failed' or item.get('prepare_error'):
            return 'failed'
        if item.get('managed'):
            return 'ready'
        if item.get('api'):
            return 'available'
        return 'needs_preparation'

    def readiness(self, item):
        environment = self._environment_status(item)
        workflow = self._workflow_status(item)
        if environment in ('running',):
            summary = '正在准备本地运行环境'
        elif environment in ('failed', 'cancelled'):
            summary = '本地运行环境未准备完成，请查看安装日志'
        elif workflow == 'ready':
            summary = '工作流检查通过，可以运行'
        elif workflow == 'missing_models':
            count = len((item.get('report') or {}).get('missing_models') or [])
            summary = f'工作流仍缺少 {count} 个模型，暂不能运行'
        elif workflow == 'missing_nodes':
            count = len((item.get('report') or {}).get('missing_nodes') or [])
            summary = f'工作流仍缺少 {count} 个节点，暂不能运行'
        elif workflow == 'needs_conversion':
            summary = '需要通过本地 ComfyUI 转换工作流后才能运行'
        elif workflow == 'needs_bridge':
            summary = '需要准备 SwarmInput 本地兼容桥接后才能运行'
        elif workflow == 'cloud_review':
            summary = '包含未确认的云端或授权节点，暂不能离线运行'
        elif workflow == 'manual_review':
            summary = '包含尚未完成离线审查的自定义代码'
        elif workflow == 'conversion_failed':
            summary = '工作流转换失败，原文件已保留'
        else:
            summary = '工作流还需要补充配置'
        return {
            'environment': environment,
            'workflow': workflow,
            'can_run': environment in ('available', 'ready') and workflow == 'ready',
            'summary': summary,
        }

    def _decorate(self, item):
        item['workflow_groups'] = workflow_groups(item.get('source'))
        item['environment_status'] = self._environment_status(item)
        item['workflow_status'] = self._workflow_status(item)
        item['readiness'] = self.readiness(item)
        return item

    def _workflow_store_root(self):
        return Path(self.host.BASE_DIR) / 'ComfyUI' / 'workflows'

    def _workflow_names(self):
        root = self._workflow_store_root()
        if not root.exists():
            return []
        names = []
        is_builtin = getattr(self.host, 'is_builtin_workflow', None)
        for path in root.rglob('*.json'):
            if path.name.endswith('.config.json'):
                continue
            try:
                name = path.relative_to(root).as_posix()
            except ValueError:
                continue
            if callable(is_builtin) and is_builtin(name):
                continue
            names.append(name)
        return sorted(set(names), key=str.casefold)

    def _workflow_config(self, name):
        try:
            path = Path(self.host.workflow_config_path(name))
        except Exception:
            path = self._workflow_store_root() / (name + '.config.json')
        if not path.exists():
            return {}
        try:
            data = json.loads(path.read_text(encoding='utf-8'))
            return data if isinstance(data, dict) else {}
        except (OSError, ValueError, TypeError):
            return {}

    def _load_workflow(self, name):
        name = unquote(name) if isinstance(name, str) else name
        if not isinstance(name, str) or not name or '\\' in name or '..' in Path(name).parts:
            raise HTTPException(400, '工作流名称不合法')
        try:
            path = Path(self.host.workflow_path_from_name(name))
        except Exception as exc:
            raise HTTPException(400, '工作流名称不合法') from exc
        root = self._workflow_store_root().resolve()
        try:
            if path.resolve().parent != root and root not in path.resolve().parents:
                raise HTTPException(400, '工作流路径不在本地工作流目录内')
        except OSError as exc:
            raise HTTPException(400, '工作流路径无法读取') from exc
        if not path.exists() or not path.is_file():
            raise HTTPException(404, '工作流不存在：' + name)
        try:
            return json.loads(path.read_text(encoding='utf-8'))
        except (OSError, ValueError) as exc:
            raise HTTPException(400, '工作流 JSON 无法读取：' + name) from exc

    def _catalog_info(self):
        try:
            _, info = self.backend()
            return info
        except Exception:
            return {}

    def _app_for_workflow(self, apps, name):
        return next((item for item in apps
                     if item.get('workflow') == name or item.get('workflow_source') == name), None)

    def _virtual_workflow(self, name, info=None):
        source = self._load_workflow(name)
        info = info if info is not None else self._catalog_info()
        initial = inspect_workflow(source, info)
        api = source.get('prompt', source) if initial['format'] == 'API' else None
        config = self._workflow_config(name)
        identity = hashlib.sha256(('workflow:' + name).encode('utf-8')).hexdigest()[:32]
        is_builtin = getattr(self.host, 'is_builtin_workflow', None)
        item = {
            'id': identity,
            'title': config.get('title') or Path(name).stem,
            'description': config.get('description') or '本地 ComfyUI 工作流',
            'source': source,
            'api': api,
            'fields': config.get('fields') or (extract_fields(api, info) if api and info else []),
            'workflow': name,
            'uploads': [],
            'created_at': 0,
            'source_kind': 'workflow',
            'entry_type': 'workflow',
            'simple_enabled': bool(config.get('simple_enabled', bool(config.get('fields')))),
            'verified': False,
            'tasks': [],
            'builtin': bool(is_builtin(name)) if callable(is_builtin) else False,
        }
        if api and info:
            self.analyze(item, info)
        else:
            item['report'] = self._apply_static_model_status(item, initial)
            item['state'] = 'blocked'
        item['format'] = initial['format']
        item['workflow_ref'] = name
        return self._decorate(item)

    def _invalid_workflow(self, name, detail):
        identity = hashlib.sha256(('invalid-workflow:' + name).encode('utf-8')).hexdigest()[:32]
        message = str(detail or '工作流 JSON 无法读取')
        return {
            'id': identity,
            'title': Path(name).stem,
            'description': '工作流文件无法读取，请修复 JSON 后重新扫描或重新导入。',
            'source': None,
            'api': None,
            'fields': [],
            'workflow': name,
            'workflow_ref': name,
            'source_kind': 'workflow',
            'entry_type': 'workflow',
            'simple_enabled': False,
            'verified': False,
            'tasks': [],
            'workflow_error': message,
            'workflow_status': 'conversion_failed',
            'environment_status': 'unknown',
            'readiness': {'environment': 'unknown', 'workflow': 'conversion_failed',
                          'can_run': False, 'summary': '工作流文件无法读取：' + message},
            'format': 'unknown',
        }

    def catalog(self, include_library=True):
        apps = [self.read(path.parent.name) for path in self.root.glob('*/app.json')]
        entries = []
        known = set()
        for item in apps:
            item['entry_type'] = 'app'
            item['source_kind'] = item.get('source_kind', 'app')
            item['workflow_ref'] = item.get('workflow_source') or item.get('workflow')
            item['simple_enabled'] = item.get('simple_enabled', True)
            if include_library or item['source_kind'] != 'workflow':
                entries.append(item)
            if item.get('workflow'):
                known.add(item['workflow'])
            if item.get('workflow_source'):
                known.add(item['workflow_source'])
        info = self._catalog_info() if include_library else {}
        for name in self._workflow_names() if include_library else []:
            if name in known:
                continue
            try:
                entries.append(self._virtual_workflow(name, info))
            except HTTPException as exc:
                entries.append(self._invalid_workflow(name, exc.detail))
        entries.sort(key=lambda item: (str(item.get('title') or '').casefold(), str(item.get('workflow_ref') or '').casefold()))
        return {'entries': entries, 'apps': apps, 'generated_at': time.time()}

    def enable_workflow(self, name):
        existing = self._app_for_workflow(self.catalog()['apps'], name)
        if existing:
            return existing
        info = self._catalog_info()
        virtual = self._virtual_workflow(name, info)
        identity = uuid.uuid4().hex
        item = {key: copy.deepcopy(value) for key, value in virtual.items()
                if key not in {'id', 'entry_type', 'workflow_ref', 'tasks', 'format'}}
        # Keep the user's original workflow as the source/UI graph.  The API
        # graph used by the simple form gets its own generated app file, so a
        # later conversion/profile change can never overwrite the library
        # workflow the user imported or downloaded.
        item['workflow_source'] = name
        item['workflow'] = f'{CUSTOM_WORKFLOW_FOLDER}/app_{identity}.json'
        item.update({'id': identity, 'source_kind': 'workflow', 'simple_enabled': True,
                     'created_at': time.time(), 'verified': False, 'tasks': []})
        if item.get('api') and info:
            try:
                item['backend'], info = self.backend()
                self.compile(item, item['api'], info)
            except (ValueError, HTTPException) as exc:
                item['conversion_error'] = str(exc)
            self.analyze(item, info)
        if item.get('api'):
            # API JSON has no UI layout to convert in the browser.  Keep an
            # executable copy immediately, then let the managed backend
            # recompile it after preparation so SeeThrough/Swarm defaults and
            # its actual node versions are checked there.
            item['needs_runtime_compile'] = True
            write_json(self.host.workflow_path_from_name(item['workflow']), item['api'])
            write_json(self.host.workflow_config_path(item['workflow']), {
                'title': item['title'], 'fields': item.get('fields', []), 'mini_cards': {}})
        item['workflow_ref'] = name
        self.save(item)
        return self.read(identity)

    def enable_group(self, app_id, group_id):
        parent = self.read(app_id)
        parent_id = parent.get('group_parent') or app_id
        parent = self.read(parent_id)
        source, group = workflow_for_group(parent['source'], group_id)
        identity = hashlib.sha256(('group:' + parent_id + ':' + group['id']).encode()).hexdigest()[:32]
        if self.path(identity).exists():
            existing = self.read(identity)
            if existing.get('source') == source:
                return existing
            existing.update(source=source, api=None, fields=[])
            existing.pop('original_api', None)
            self.save(existing)
            return self.read(identity)
        item = {'id': identity, 'title': parent['title'] + ' · ' + group['title'],
                'description': group['title'], 'source': source, 'api': None, 'fields': [],
                'workflow': f'{CUSTOM_WORKFLOW_FOLDER}/app_{identity}.json',
                'uploads': [], 'created_at': time.time(), 'group_parent': parent_id,
                'selected_group': group['id'], 'simple_enabled': True}
        for key in ('backend', 'managed'):
            if key in parent:
                item[key] = parent[key]
        try:
            item['backend'], info = self.backend(item)
            self.analyze(item, info)
        except HTTPException as exc:
            item['state'] = 'blocked'
            item['report'] = inspect_workflow(source, {})
            item['report']['reasons'] = [str(exc.detail)]
        self.save(item)
        return self.read(identity)

    def backend(self, item=None, *, start=False):
        if item and item.get('managed'):
            try:
                return self.runtime.address, self.runtime.info()
            except requests.RequestException as exc:
                if start:
                    try:
                        return self.runtime.address, self.runtime.start_existing()
                    except (RuntimeError, OSError, requests.RequestException) as start_error:
                        raise HTTPException(503, str(start_error)) from start_error
                raise HTTPException(503, '应用独立环境未启动，请点击“准备运行环境”') from exc
        for address in self.host.COMFYUI_INSTANCES:
            if re.fullmatch(r'(127\.0\.0\.1|localhost):\d+', address):
                try:
                    response = requests.get(f'http://{address}/object_info', timeout=8)
                    response.raise_for_status()
                    return address, response.json()
                except requests.RequestException:
                    continue
        try:
            return self.runtime.address, self.runtime.info()
        except requests.RequestException:
            pass
        raise HTTPException(503, '本地 ComfyUI 未连接。请启动本机服务后重新检查。')

    def _graphs(self, item):
        graphs = []
        seen = set()

        def add(graph):
            if not isinstance(graph, dict):
                return
            graph = graph.get('prompt', graph) if isinstance(graph.get('prompt'), dict) else graph
            if not isinstance(graph, dict) or id(graph) in seen:
                return
            seen.add(id(graph))
            graphs.append(graph)

        for key in ('api', 'original_api', 'source'):
            add(item.get(key))
        return graphs

    @staticmethod
    def _is_model_input(node_kind, input_name):
        name = str(input_name or '').strip().lower()
        kind = str(node_kind or '').strip().lower()
        if name == 'model_name' and 'civitai hash fetcher' in kind and 'image saver' in kind:
            return False
        if name in MODEL_INPUT_NAMES:
            return True
        if name == 'model':
            return ('load' in kind or 'model' in kind or 'seedvr' in kind
                    or 'upscale' in kind or 'dit' in kind or kind.startswith('seethrough_'))
        return name in {'name', 'model_patch', 'patch_model'} and 'modelpatch' in kind

    def _model_references(self, item):
        refs = []

        def add(kind, name, value):
            if not self._is_model_input(kind, name) or not isinstance(value, str) or not value.strip():
                return
            refs.append({'node': str(kind or ''), 'input': str(name), 'value': value.strip()})

        for graph in self._graphs(item):
            if isinstance(graph.get('nodes'), list):
                for node in graph['nodes']:
                    if not isinstance(node, dict):
                        continue
                    kind = node.get('type', '')
                    values = node.get('widgets_values') or []
                    widget_inputs = [
                        spec for spec in (node.get('inputs') or [])
                        if isinstance(spec, dict) and isinstance(spec.get('widget'), dict)
                    ]
                    for index, spec in enumerate(widget_inputs):
                        name = spec.get('widget', {}).get('name') or spec.get('name')
                        if index < len(values):
                            add(kind, name, values[index])
                continue
            for node in graph.values():
                if not isinstance(node, dict):
                    continue
                kind = node.get('class_type', '')
                for name, value in (node.get('inputs') or {}).items():
                    if not isinstance(value, (list, dict)):
                        add(kind, name, value)
        unique = {}
        for ref in refs:
            unique.setdefault((ref['node'], ref['input'], ref['value'].casefold()), ref)
        return list(unique.values())

    def _directory_model_reference_paths(self, reference):
        """Resolve supported loader values that name a Hugging Face model directory."""
        node_kind = str(reference.get('node') or reference.get('class_type') or '')
        input_name = str(reference.get('input') or '')
        if node_kind not in DIRECTORY_MODEL_NODE_TYPES or input_name != 'model_name':
            return []
        value = str(reference.get('value') or reference.get('name') or '').replace('\\', '/').strip('/')
        model_ref = PurePosixPath(value)
        model_name = model_ref.name
        if not model_name or model_name in {'.', '..'}:
            return []
        author = model_ref.parts[0] if len(model_ref.parts) > 1 else ''
        paths = []
        seen = set()
        for models_root in (self.runtime.root / 'models', self.runtime.base / 'models'):
            for llm_name in ('LLM', 'llm'):
                llm_root = models_root / llm_name
                candidates = [llm_root / model_name, llm_root / 'Qwen' / model_name,
                              llm_root / 'Qwen-VL' / model_name]
                if author:
                    candidates.extend((llm_root / author / model_name,
                                       llm_root / 'hf' / author / model_name))
                for candidate in candidates:
                    safe = self._inside_model_root(candidate)
                    if not safe or not safe.is_dir():
                        continue
                    key = self._path_key(safe)
                    if key not in seen:
                        seen.add(key)
                        paths.append(safe)
        return paths

    def _directory_model_usage_keys(self, reference, catalog):
        """Map a directory-model reference to each catalogued weight inside it."""
        folders = self._directory_model_reference_paths(reference)
        if not folders:
            return set()
        matches = set()
        for key, candidate in catalog.items():
            try:
                candidate_path = Path(candidate.get('path') or '').resolve()
            except (OSError, TypeError, ValueError):
                continue
            for folder in folders:
                try:
                    candidate_path.relative_to(folder)
                except ValueError:
                    continue
                matches.add(key)
                break
        return matches

    def _model_reference_present(self, requirement, model_index=None):
        """Check a model reference against the local ComfyUI model roots."""
        value = str(requirement.get('name') or '').strip()
        if not value:
            return True
        # Qwen-VL uses a Hugging Face directory (config + sharded weights),
        # while the generic inspector sees its model_name as a single file.
        # Check the directory layout used by ComfyUI-QwenVL before falling
        # back to the standard single-file model lookup.
        directory_reference = {
            'class_type': requirement.get('class_type'),
            'input': requirement.get('input'),
            'name': value,
        }
        if (str(requirement.get('class_type') or '') in DIRECTORY_MODEL_NODE_TYPES
                and str(requirement.get('input') or '') == 'model_name'):
            for candidate in self._directory_model_reference_paths(directory_reference):
                if ((candidate / 'config.json').is_file()
                        and (any(candidate.glob('*.safetensors')) or any(candidate.glob('*.bin')))):
                    return True
            return False
        # SeeThrough stores a repository id rather than a model file name;
        # its own resource manifest is checked by the application analyzer.
        if value.replace('\\', '/').strip('/') in MODELS:
            folder = self.runtime.root / 'models' / 'SeeThrough' / value.replace('\\', '/').split('/')[-1]
            return (folder / 'model_index.json').is_file() and not self.runtime.missing_resources()
        ref = {'value': value}
        candidate, _ = self._resolve_model_reference(ref, model_index)
        if not candidate:
            legacy_name = _legacy_model_alias(value)
            if legacy_name:
                candidate, _ = self._resolve_model_reference({'value': legacy_name}, model_index)
        if not candidate:
            return False
        resolved_name = str(candidate.get('name') or '').strip()
        if resolved_name and resolved_name.casefold() != value.casefold():
            requirement['resolved_name'] = resolved_name
        return True

    def _apply_static_model_status(self, item, report, model_index=None):
        """Merge static loader references with live object_info checks.

        ``object_info`` is unavailable while ComfyUI is offline, but the JSON
        still contains enough information to tell the user which model files
        are needed.  Conversely, a model may be present locally even when a
        stopped backend could not report its combo choices, so existence in
        the model tree is the final local check.
        """
        if model_index is None:
            model_index = self._build_model_reference_index()
        requirements = report.get('model_requirements') or []
        missing = set(report.get('missing_models') or [])
        requirement_names = set()
        for requirement in requirements:
            name = str(requirement.get('name') or '').strip()
            if not name:
                continue
            requirement_names.add(name)
            if self._model_reference_present(requirement, model_index):
                missing.discard(name)
            else:
                missing.add(name)
        # Keep a backend-reported missing value when no static requirement was
        # available (for example a newer custom loader schema).
        report['missing_models'] = sorted(missing)
        # ``read()`` refreshes the static file inventory as well as the live
        # ComfyUI report.  When a model was copied into place after an earlier
        # scan, the old reason must not keep the app blocked after the file has
        # been found locally.
        if isinstance(report.get('reasons'), list):
            reasons = [reason for reason in report['reasons']
                       if not (isinstance(reason, str) and reason.startswith('需要下载模型：'))]
            if report['missing_models']:
                reasons.append('需要下载模型：' + '、'.join(report['missing_models']))
            report['reasons'] = reasons
        return report

    @staticmethod
    def _auto_model_entry(name, requirement=None):
        basename = PurePosixPath(str(name).replace('\\', '/')).name.casefold()
        basename = _legacy_model_alias(basename) or basename
        entry = AUTO_MODEL_REGISTRY.get(basename)
        requirement = requirement or {}
        if not entry:
            url = str(requirement.get('source') or '')
            try:
                parsed = urlparse(url)
                port = parsed.port
            except ValueError:
                return None
            parts = unquote(parsed.path).split('/')
            category = str(requirement.get('category') or '')
            categories = {'checkpoints', 'diffusion_models', 'text_encoders', 'vae', 'loras', 'controlnet', 'clip_vision', 'upscale_models', 'SEEDVR2'}
            if (parsed.scheme != 'https' or parsed.hostname != 'huggingface.co'
                    or parsed.username or parsed.password or port not in (None, 443)
                    or parsed.query or parsed.fragment or len(parts) < 6
                    or parts[1] != 'Comfy-Org' or parts[3] != 'resolve'
                    or any(part in ('', '.', '..') for part in parts[1:])
                    or parts[-1].casefold() != basename or not basename.endswith('.safetensors')
                    or category not in categories):
                return None
            entry = {'name': parts[-1], 'category': category, 'url': url,
                     'source': 'https://huggingface.co/Comfy-Org/' + parts[2],
                     'size_note': '以下载源返回的完整文件大小为准'}
        expected_category = str(requirement.get('category') or '').strip()
        if expected_category and expected_category != entry['category']:
            return None
        entry = copy.deepcopy(entry)
        expected_hash = str(requirement.get('sha256') or '').lower()
        if re.fullmatch('[a-f0-9]{64}', expected_hash):
            if entry.get('sha256') and entry['sha256'].lower() != expected_hash:
                return None
            entry['sha256'] = expected_hash
        return entry

    def _model_source(self, item, name, requirement=None):
        source = self._auto_model_entry(name, requirement)
        if source:
            return source
        result = (item.get('model_search') or {}).get(name, {})
        source = result.get('download') if result.get('status') == 'resolved' else None
        if source and source.get('category') == (requirement or {}).get('category'):
            return copy.deepcopy(source)
        return None

    def find_missing_models(self, app_id, progress):
        resolver = ModelSourceResolver(self.runtime.cancel, progress)
        item = self.read(app_id)
        report = self._refresh_static_report(item)
        requirements = {entry['name']: entry for entry in report.get('model_requirements', [])}
        for name in report.get('missing_models', []):
            requirement = requirements.get(name, {'name': name})
            if self._auto_model_entry(name, requirement):
                continue
            result = resolver.resolve(requirement, MANUAL_MODEL_SOURCES.get(PurePosixPath(name.replace('\\', '/')).name.casefold()))
            with self.lock:
                latest = self.read(app_id)
                latest.setdefault('model_search', {})[name] = result
                self.save(latest)
        return self.read(app_id)

    def _auto_model_downloads(self, item, preflight=None):
        """Return trusted download descriptors for this app only."""
        preflight = preflight or self.preflight(item)
        requirements = {str(entry.get('name')): entry
                        for entry in (item.get('report') or {}).get('model_requirements', [])}
        downloads = []
        seen = set()
        for entry in (preflight.get('dependencies') or {}).get('auto_installable', []):
            if entry.get('kind') != '模型' or not entry.get('download_id'):
                continue
            key = str(entry['download_id']).casefold()
            if key in seen:
                continue
            source = self._model_source(item, entry.get('name'), requirements.get(entry.get('name'), {}))
            if source:
                downloads.append(source)
                seen.add(key)
        return downloads

    def _model_catalog_roots(self):
        """Return the local model roots we own or manage, with user-facing labels."""
        return [
            ('主 ComfyUI 模型', self.runtime.base / 'models'),
            ('应用独立环境模型', self.runtime.root / 'models'),
            ('应用补全权重', self.runtime.root / 'torch' / 'hub' / 'checkpoints'),
        ]

    def model_catalog(self):
        """Scan local model files and annotate them with workflow usage."""
        roots = []
        candidates = []
        seen_paths = set()
        warnings = []
        for label, root in self._model_catalog_roots():
            root = Path(root)
            root_entry = {'label': label, 'exists': root.exists(), 'file_count': 0, 'size': 0}
            roots.append(root_entry)
            if not root.exists():
                continue
            try:
                files = root.rglob('*')
                for path in files:
                    if not path.is_file() or path.is_symlink() or '.cache' in path.parts:
                        continue
                    if path.suffix.casefold() not in MODEL_FILE_EXTENSIONS:
                        continue
                    try:
                        resolved = path.resolve()
                        stat = resolved.stat()
                    except OSError:
                        continue
                    key = self._path_key(resolved)
                    if key in seen_paths:
                        continue
                    if not self._inside_model_root(resolved):
                        continue
                    seen_paths.add(key)
                    relative = resolved.relative_to(root.resolve()).as_posix()
                    candidate = self._path_candidate(resolved, resolved.name, 'file')
                    if not candidate:
                        continue
                    candidate.update({'root_label': label, 'relative_path': relative,
                                      'category': relative.split('/')[0] if '/' in relative else label,
                                      'modified_at': stat.st_mtime})
                    candidates.append(candidate)
                    root_entry['file_count'] += 1
                    root_entry['size'] += stat.st_size
            except OSError as exc:
                warnings.append(f'{label} 扫描不完整：{exc}')

        usage = self._all_model_usage('', '', candidates)
        preferences = self._read_model_preferences()
        models = []
        for candidate in candidates:
            users = sorted(set(str(value) for value in usage.get(candidate['key'], {}).values() if value))
            user_protected = self._user_protected(candidate, preferences)
            delete_reason = ''
            if users:
                delete_reason = (f"不能删除模型“{candidate['name']}”：它正被以下内容使用：" + '、'.join(users)
                                 + '。请先在对应工作流中更换模型或移除引用。')
            elif user_protected:
                delete_reason = (f"不能删除模型“{candidate['name']}”：它已被手动保留。"
                                 '请先取消“手动保留”后再删除。')
            models.append({
                'id': self._model_id(candidate['path']),
                'name': candidate['name'], 'category': candidate['category'],
                'root_label': candidate['root_label'], 'relative_path': candidate['relative_path'],
                'size': candidate['size'], 'file_count': candidate['file_count'],
                'modified_at': candidate['modified_at'], 'users': users,
                'status': '手动保留' if user_protected else ('共用' if users else '暂未发现引用'),
                'user_protected': user_protected,
                'protected': bool(users) or user_protected,
                'can_delete': not users and not user_protected,
                'delete_reason': delete_reason,
            })
        models.sort(key=lambda item: (not item['protected'], item['category'].casefold(), item['name'].casefold()))
        return {
            'generated_at': time.time(), 'roots': roots, 'models': models,
            'total_size': sum(item['size'] for item in models),
            'total_files': sum(item['file_count'] for item in models),
            'warnings': warnings,
        }

    def _model_catalog_candidate(self, model_id, catalog=None):
        """Resolve a scanned model ID back to a server-owned local path."""
        catalog = catalog or self.model_catalog()
        model = next((item for item in catalog.get('models', []) if item.get('id') == model_id), None)
        if not model:
            return None, None
        roots = {label: Path(root) for label, root in self._model_catalog_roots()}
        root = roots.get(model.get('root_label'))
        relative = PurePosixPath(str(model.get('relative_path') or ''))
        if not root or relative.is_absolute() or '..' in relative.parts:
            return None, model
        candidate = self._path_candidate(root.joinpath(*relative.parts), model.get('name', ''), 'file')
        if not candidate or self._model_id(candidate['path']) != model_id:
            return None, model
        candidate.update({
            'root_label': model.get('root_label', ''),
            'relative_path': model.get('relative_path', ''),
            'category': model.get('category', ''),
        })
        return candidate, model

    def delete_model(self, model_id):
        """Delete one explicitly selected, unreferenced model file."""
        catalog = self.model_catalog()
        candidate, model = self._model_catalog_candidate(model_id, catalog)
        if not model:
            raise HTTPException(404, '模型不存在或已移动，请刷新本地模型列表')
        users = list(model.get('users') or [])
        if users:
            raise HTTPException(409, f"不能删除模型“{model['name']}”：它正被以下内容使用：" + '、'.join(users)
                                + '。请先在对应工作流中更换模型或移除引用。')
        if model.get('user_protected'):
            raise HTTPException(409, '模型已手动保留，请先取消“手动保留”后再删除')
        if not candidate:
            raise HTTPException(404, '模型文件已移动或删除，请刷新本地模型列表')

        usage = self._all_model_usage('', '', [candidate])
        live_users = sorted(set(str(value) for value in usage.get(candidate['key'], {}).values() if value))
        if live_users:
            raise HTTPException(409, f"不能删除模型“{model['name']}”：它刚刚被以下内容引用：" + '、'.join(live_users)
                                + '。请先在对应工作流中更换模型或移除引用。')
        if self._user_protected(candidate):
            raise HTTPException(409, '模型已手动保留，请先取消“手动保留”后再删除')

        deleted, errors = self._delete_candidate_files(candidate)
        if errors:
            detail = '；'.join(f"{entry.get('name', candidate['name'])}：{entry.get('reason', '未知错误')}" for entry in errors)
            raise HTTPException(409, '删除模型失败：' + detail)
        if not deleted:
            raise HTTPException(404, '模型文件已移动或删除，请刷新本地模型列表')
        preferences = self._read_model_preferences()
        preferences.get('models', {}).pop(model_id, None)
        self._write_model_preferences(preferences)
        return {
            'model_id': model_id,
            'name': model['name'],
            'deleted_files': deleted,
            'size': model.get('size', 0),
            'message': f"已删除模型“{model['name']}”。",
        }

    def _model_roots(self):
        roots = [
            self.runtime.root / 'models',
            self.runtime.base / 'models',
            self.runtime.root / 'torch' / 'hub' / 'checkpoints',
        ]
        result, seen = [], set()
        for root in roots:
            try:
                key = str(root.resolve()).casefold()
            except OSError:
                continue
            if key not in seen:
                seen.add(key)
                result.append(root)
        return result

    @staticmethod
    def _path_key(path):
        return str(Path(path).resolve()).casefold()

    @classmethod
    def _model_id(cls, path):
        return hashlib.sha256(cls._path_key(path).encode('utf-8')).hexdigest()[:32]

    def _model_preferences_path(self):
        return self.root.parent / 'comfy_model_preferences.json'

    def _read_model_preferences(self):
        path = self._model_preferences_path()
        try:
            data = json.loads(path.read_text(encoding='utf-8')) if path.exists() else {}
        except (OSError, UnicodeError, ValueError, TypeError):
            return {'models': {}}
        models = data.get('models') if isinstance(data, dict) else {}
        return {'models': models if isinstance(models, dict) else {}}

    def _write_model_preferences(self, data):
        write_json(self._model_preferences_path(), data)

    def _user_protected(self, candidate, preferences=None):
        preferences = preferences or self._read_model_preferences()
        entries = preferences.get('models', {})
        paths = [candidate.get('path'), *(candidate.get('files') or [])]
        for path in paths:
            if not path:
                continue
            entry = entries.get(self._model_id(path), {})
            if (isinstance(entry, dict) and bool(entry.get('protected'))) or entry is True:
                return True
        return False

    def _inside_model_root(self, path):
        path = Path(path)
        if path.is_symlink():
            return None
        try:
            resolved = path.resolve()
        except OSError:
            return None
        for root in self._model_roots():
            try:
                resolved.relative_to(root.resolve())
                return resolved
            except ValueError:
                continue
            except OSError:
                continue
        return None

    def _path_candidate(self, path, name='', kind='file', source=''):
        path = Path(path)
        if not path.exists() or path.is_symlink():
            return None
        try:
            resolved = path.resolve()
        except OSError:
            return None
        if kind == 'file':
            files = [resolved] if resolved.is_file() else []
        else:
            files = [
                p.resolve() for p in resolved.rglob('*')
                if p.is_file() and not p.is_symlink() and '.cache' not in p.parts
            ]
        if not files:
            return None
        size = 0
        safe_files = []
        for file_path in files:
            if not self._inside_model_root(file_path) or not file_path.is_file():
                continue
            try:
                size += file_path.stat().st_size
            except OSError:
                continue
            safe_files.append(str(file_path))
        if not safe_files:
            return None
        return {
            'key': self._path_key(resolved),
            'path': str(resolved),
            'name': name or resolved.name,
            'kind': kind,
            'source': source,
            'files': safe_files,
            'size': size,
            'file_count': len(safe_files),
        }

    def _resolve_model_reference(self, ref, model_index=None):
        value = ref['value'].replace('\\', '/').strip()
        basename = PurePosixPath(value).name
        known = {repo.split('/')[-1]: repo for repo in MODELS}
        if basename in known:
            folder = self.runtime.root / 'models' / 'SeeThrough' / basename
            candidate = self._path_candidate(folder, basename, 'folder', 'https://huggingface.co/' + known[basename])
            if candidate:
                return candidate, ''
            return None, '模型目录尚未完整下载，未自动删除'
        if not basename or '://' in value:
            return None, '工作流引用了外部路径，未自动删除'

        matches = []
        absolute = Path(value)
        if absolute.is_absolute():
            safe = self._inside_model_root(absolute)
            if safe and safe.is_file():
                matches.append(safe)
        else:
            if model_index is None:
                model_index = self._build_model_reference_index()
            relative_key = value.strip('/').casefold()
            matches.extend((model_index.get('by_relative_path') or {}).get(relative_key, []))
            matches.extend((model_index.get('by_name') or {}).get(basename.casefold(), []))
        unique = {self._path_key(path): path for path in matches}
        if len(unique) == 1:
            path = next(iter(unique.values()))
            return self._path_candidate(path, basename, 'file'), ''
        if len(unique) > 1:
            return None, '找到多个同名模型，未自动删除，请在高级编辑中确认'
        return None, '本机未找到该模型文件，未自动删除'

    def _app_model_candidates(self, item, model_index=None):
        candidates = {}
        unresolved = []
        for ref in self._model_references(item):
            candidate, reason = self._resolve_model_reference(ref, model_index)
            if candidate:
                current = candidates.setdefault(candidate['key'], candidate)
                current.setdefault('references', []).append(ref)
            else:
                unresolved.append({**ref, 'reason': reason})

        use_lama = any(
            str(node.get('class_type', '')).startswith('SeeThrough_PostProcess')
            and bool((node.get('inputs') or {}).get('use_lama'))
            for graph in self._graphs(item) if not isinstance(graph.get('nodes'), list)
            for node in graph.values() if isinstance(node, dict)
        )
        if use_lama:
            lama = self.runtime.root / 'torch' / 'hub' / 'checkpoints' / 'lama_large_512px.ckpt'
            candidate = self._path_candidate(lama, lama.name, 'file', 'https://huggingface.co/dreMaz/AnimeMangaInpainting')
            if candidate:
                candidates.setdefault(candidate['key'], candidate)
            else:
                unresolved.append({'value': lama.name, 'node': 'SeeThrough_PostProcess', 'input': 'use_lama',
                                   'reason': 'LaMa 补全权重尚未下载，未自动删除'})
        return list(candidates.values()), unresolved

    def _all_model_usage(self, exclude_id, exclude_workflow='', candidates=None, exclude_source='', model_index=None):
        model_index = model_index if model_index is not None else self._build_model_reference_index()
        usage = {}
        catalog = {candidate['key']: candidate for candidate in (candidates or [])}
        for path in self.root.glob('*/app.json'):
            try:
                raw = json.loads(path.read_text(encoding='utf-8'))
                app_id = str(raw.get('id') or path.parent.name)
                if app_id == exclude_id:
                    continue
                item = self.read(app_id, model_index=model_index)
                candidate_list, _ = self._app_model_candidates(item, model_index)
            except Exception:
                continue
            for candidate in candidate_list:
                catalog.setdefault(candidate['key'], candidate)
                apps = usage.setdefault(candidate['key'], {})
                apps[app_id] = str(item.get('title') or app_id)
            for ref in self._model_references(item):
                for key in self._directory_model_usage_keys(ref, catalog):
                    usage.setdefault(key, {})[app_id] = str(item.get('title') or app_id)

        workflow_dir = Path(self.host.BASE_DIR) / 'ComfyUI' / 'workflows'
        excluded_path = None
        if exclude_workflow:
            try:
                excluded_path = Path(self.host.workflow_path_from_name(exclude_workflow)).resolve()
            except Exception:
                pass
        for path in workflow_dir.rglob('*.json') if workflow_dir.exists() else []:
            if path.name.endswith('.config.json'):
                continue
            try:
                if excluded_path and path.resolve() == excluded_path:
                    continue
                if exclude_source and path.resolve() == Path(self.host.workflow_path_from_name(exclude_source)).resolve():
                    continue
                graph = json.loads(path.read_text(encoding='utf-8'))
                candidate_list, _ = self._app_model_candidates({'api': graph, 'source': graph}, model_index)
            except Exception:
                continue
            label = '工作流：' + path.stem
            for candidate in candidate_list:
                catalog.setdefault(candidate['key'], candidate)
                users = usage.setdefault(candidate['key'], {})
                users['workflow:' + str(path.resolve()).casefold()] = label
            for ref in self._model_references({'api': graph, 'source': graph}):
                for key in self._directory_model_usage_keys(ref, catalog):
                    usage.setdefault(key, {})['workflow:' + str(path.resolve()).casefold()] = label

        canvas_dir = Path(self.host.BASE_DIR) / 'data' / 'canvases'
        canvas_files = list(canvas_dir.glob('*.json')) if canvas_dir.exists() else []
        for path in canvas_files:
            try:
                text = path.read_text(encoding='utf-8').casefold()
            except (OSError, UnicodeError):
                continue
            for key, candidate in catalog.items():
                names = {str(candidate.get('name') or '').casefold()}
                if any(name and name in text for name in names):
                    usage.setdefault(key, {})['canvas:' + path.stem] = '画布：' + path.stem
        return usage

    def _active_app_tasks(self):
        lock = getattr(self.host, 'CANVAS_TASK_LOCK', None)
        tasks = getattr(self.host, 'CANVAS_TASKS', {})
        if lock:
            with lock:
                values = list(tasks.values())
        else:
            values = list(tasks.values())
        return [copy.deepcopy(task) for task in values
                if task.get('type') in ('comfy-app', 'comfy-app-prepare')
                and task.get('status') in ('queued', 'running')]

    def _workflow_paths(self, item):
        paths = []
        workflow = item.get('workflow')
        if not workflow:
            return paths
        for label, getter in (('工作流配置', self.host.workflow_path_from_name),
                              ('应用字段配置', self.host.workflow_config_path)):
            try:
                path = Path(getter(workflow))
            except Exception:
                continue
            if path.exists() and path.is_file() and path not in paths:
                paths.append((label, path))
        return paths

    def _workflow_is_shared(self, item):
        workflow = item.get('workflow')
        if not workflow:
            return False
        # Files discovered from the existing workflow library are user-owned
        # library entries, not disposable copies created by an application.
        # Only the app_<id>.json files created by the application importer may
        # be moved to the app recovery area.
        owned_name = f'{CUSTOM_WORKFLOW_FOLDER}/app_{item.get("id")}.json'
        if workflow != owned_name:
            return True
        for path in self.root.glob('*/app.json'):
            try:
                other = json.loads(path.read_text(encoding='utf-8'))
            except Exception:
                continue
            if other.get('id') != item.get('id') and other.get('workflow') == workflow:
                return True
        return False

    def _public_model(self, candidate, users=None, preferences=None):
        users = list(users or [])
        user_protected = self._user_protected(candidate, preferences)
        return {
            'model_id': self._model_id(candidate['path']),
            'name': candidate['name'],
            'kind': candidate['kind'],
            'size': candidate['size'],
            'file_count': candidate['file_count'],
            'users': users,
            'user_protected': user_protected,
        }

    def _deletable_source(self, item):
        name = item.get('workflow_source')
        if not name:
            return ''
        self._load_workflow(name)
        path = Path(self.host.workflow_path_from_name(name))
        if path.is_symlink():
            return ''
        for manifest in self.root.glob('*/app.json'):
            other = json.loads(manifest.read_text(encoding='utf-8'))
            if other.get('id') != item['id'] and name in (other.get('workflow'), other.get('workflow_source')):
                return ''
        return name

    def delete_plan(self, app_id, remove_source=False):
        model_index = self._build_model_reference_index()
        item = self.read(app_id, model_index=model_index)
        active = self._active_app_tasks()
        candidates, unresolved = self._app_model_candidates(item, model_index)
        source = self._deletable_source(item) if remove_source else ''
        usage = self._all_model_usage(app_id, item.get('workflow', ''), candidates, source, model_index)
        preferences = self._read_model_preferences()
        exclusive, shared, protected = [], [], []
        for candidate in candidates:
            users = usage.get(candidate['key'], {})
            public = self._public_model(candidate, users.values(), preferences)
            if users:
                shared.append(public)
            elif public['user_protected']:
                protected.append(public)
            else:
                exclusive.append(public)
        files = [{'label': label, 'name': path.name, 'size': path.stat().st_size}
                 for label, path in self._workflow_paths(item)]
        notes = [
            '应用配置会移入本地回收区，生成结果和历史记录保留。',
            '只删除已确认属于本应用且未被其他应用使用的模型文件。',
            'ComfyUI 运行环境和自定义节点保留，避免影响其他应用。',
        ]
        if shared:
            notes.append('共用模型会保留；删除本应用不会影响仍在使用它的应用。')
        if protected:
            notes.append('你手动勾选保留的模型会保留；删除本应用只会处理未受保护的独占模型。')
        if unresolved:
            notes.append('未能安全确认的模型不会自动删除，请查看“未自动删除”列表。')
        if active:
            notes.insert(0, '本地还有任务正在运行，请等待任务结束后再删除。')
        return {
            'app_id': app_id,
            'title': item.get('title') or app_id,
            'can_delete': not active,
            'active_tasks': [{'stage': task.get('stage') or task.get('status'), 'app_id': task.get('app_id')}
                             for task in active],
            'workflow_files': files,
            'workflow_shared': self._workflow_is_shared(item),
            'source_to_archive': source,
            'source_kept': bool(remove_source and item.get('workflow_source') and not source),
            'models': {'exclusive': exclusive, 'shared': shared, 'protected': protected},
            'unresolved': [{'name': ref['value'], 'reason': ref['reason']} for ref in unresolved],
            'notes': notes,
        }

    def _archive_app(self, item, source=''):
        archive_root = self.root.parent / 'comfy_apps_deleted' / (str(int(time.time())) + '_' + item['id'])
        archive_root.mkdir(parents=True, exist_ok=False)
        moved = []
        sources = [(self.path(item['id']), 'app.json')]
        if not self._workflow_is_shared(item):
            sources.extend((path, path.name) for _, path in self._workflow_paths(item))
        if source:
            for getter in (self.host.workflow_path_from_name, self.host.workflow_config_path):
                path = Path(getter(source))
                if path.exists():
                    sources.append((path, 'source_' + path.name))
        seen = set()
        for source, name in sources:
            source = Path(source)
            key = str(source.resolve()).casefold()
            if key in seen or not source.exists() or not source.is_file():
                continue
            seen.add(key)
            destination = archive_root / name
            source.replace(destination)
            moved.append({'from': str(source), 'to': name})
        write_json(archive_root / 'deletion.json', {'app_id': item['id'], 'title': item.get('title', ''), 'files': moved})
        try:
            self.path(item['id']).parent.rmdir()
        except OSError:
            pass
        return archive_root, moved

    def _delete_candidate_files(self, candidate):
        deleted, errors = [], []
        for raw_path in candidate.get('files', []):
            path = Path(raw_path)
            safe = self._inside_model_root(path)
            if not safe or safe != path.resolve() or path.is_symlink():
                errors.append({'name': path.name, 'reason': '文件不在受保护的模型目录内'})
                continue
            if not path.exists():
                continue
            if not path.is_file():
                errors.append({'name': path.name, 'reason': '模型路径已不是文件'})
                continue
            try:
                path.unlink()
                deleted.append(path.name)
            except OSError as exc:
                errors.append({'name': path.name, 'reason': '文件正在使用或没有删除权限：' + str(exc)})
        return deleted, errors

    def analyze(self, item, info):
        source = item.get('api') or item['source']
        if item.get('api'):
            normalize_legacy_node_types(item['api'], info)
            normalize_legacy_model_values(item['api'], info)
            source = item['api']
        report = inspect_workflow(source, info)
        if not item.get('api') and report['format'] == 'UI' and item.get('conversion_error') == '节点缺少 type 或 class_type，无法识别工作流':
            item.pop('conversion_error', None)
        report = self._apply_static_model_status(item, report)
        unknown = []
        nodes = source.get('nodes') if 'nodes' in source else source.values()
        for node in nodes:
            kind = node.get('class_type', node.get('type'))
            module = info.get(kind, {}).get('python_module', '')
            # Installed nodes come from the connected local ComfyUI schema;
            # importing a graph never installs arbitrary custom Python code.
            trusted = item.get('managed') and (
                (kind in {'SeeThrough_LoadLayerDiffModel', 'SeeThrough_LoadDepthModel', 'SeeThrough_GenerateLayers',
                          'SeeThrough_GenerateDepth', 'SeeThrough_PostProcess', 'SeeThrough_SavePSD', 'SeeThrough_PartsToLayers'}
                 and module == 'custom_nodes.ComfyUI-See-through')
                or ((str(kind).startswith(SWARM_INPUT_PREFIX) or kind == 'SwarmWorkflowDescription')
                    and module in ('', 'custom_nodes.xiaomei_app_bridge'))
                or (kind == 'easy cleanGpuUsed' and module in ('', 'custom_nodes.xiaomei_app_bridge')))
            if kind in info and not trusted and module != 'nodes' and not module.startswith(('comfy_extras.', 'custom_nodes.')):
                unknown.append(kind)
        reasons = []
        if item.get('runtime_error'):
            reasons.append('上次运行失败：' + item['runtime_error'] + '。修复后请重新准备环境。')
        if report['missing_nodes']:
            reasons.append('需要安装节点：' + '、'.join(report['missing_nodes']))
        if report['missing_models']:
            reasons.append('需要下载模型：' + '、'.join(report['missing_models']))
        if report['review_nodes']:
            reasons.append('包含可能调用云端的节点，已禁止本地应用执行：' + '、'.join(report['review_nodes']))
        if unknown:
            reasons.append('自定义代码尚未完成离线审查：' + '、'.join(sorted(set(unknown))))
        if report.get('swarm_inputs') and not item.get('managed'):
            reasons.append('需要准备小美的 SwarmInput 本地兼容桥接；不会安装完整 SwarmUI')
        if not item.get('api'):
            reasons.append('尚未生成操作表单；补齐节点后，点击“生成操作表单”即可在当前页面完成')
        if item.get('api'):
            if any(n['class_type'].startswith('SeeThrough_') for n in item['api'].values()):
                missing_files = self.runtime.missing_resources()
                if missing_files:
                    reasons.append('模型文件清单未通过：' + '、'.join(missing_files[:8]))
            for node in item['api'].values():
                kind = node['class_type']
                if kind.startswith(('LoadImage', 'LoadAudio', 'LoadVideo')) and kind != 'LoadImage':
                    reasons.append(kind + ' 的上传参数需要配置，暂不支持自动生成表单')
                if kind in {'SwarmInputAudio', 'SwarmInputVideo'}:
                    reasons.append(kind + ' 的本地上传桥接尚未启用，请在高级编辑器中配置输入')
                if node['class_type'].startswith('SeeThrough_Load'):
                    inputs = node.get('inputs', {})
                    model = inputs.get('model', '')
                    known = {repo.split('/')[-1] for repo in MODELS}
                    if model not in known or inputs.get('auto_download') is not False or inputs.get('vae_ckpt') or inputs.get('unet_ckpt'):
                        reasons.append('SeeThrough 模型必须使用准备环境中的本地文件，禁止运行时下载和外部权重路径')
                    elif not (self.runtime.root / 'models' / 'SeeThrough' / model / 'model_index.json').exists():
                        reasons.append('SeeThrough 模型文件缺失，请重新准备环境')
        report['unknown_nodes'] = sorted(set(unknown))
        report['reasons'] = reasons
        item['report'] = report
        item['state'] = 'blocked' if reasons else 'ready'
        item['workflow_status'] = self._workflow_status(item)
        return item

    def compile(self, item, graph, info):
        normalize_legacy_model_values(graph, info)
        report = inspect_workflow(graph, info)
        if report['format'] != 'API':
            raise ValueError('转换结果不是 API 工作流')
        graph = active_graph(graph.get('prompt', graph), info)
        normalize_legacy_node_types(graph, info)
        normalize_legacy_scheduler_values(graph)
        if any(n['class_type'].startswith('SeeThrough_') for n in graph.values()):
            item.setdefault('original_api', copy.deepcopy(graph))
            for node in graph.values():
                kind, inputs = node['class_type'], node['inputs']
                changes = {}
                if kind in ('SeeThrough_LoadLayerDiffModel', 'SeeThrough_LoadDepthModel'):
                    changes = {'cache_tag_embeds': True, 'group_offload': True, 'auto_download': False,
                               'model': MODELS[0 if kind == 'SeeThrough_LoadLayerDiffModel' else 1].split('/')[-1]}
                elif kind == 'SeeThrough_GenerateLayers':
                    changes = {'resolution': 1024, 'num_inference_steps': 30}
                elif kind == 'SeeThrough_GenerateDepth':
                    changes = {'resolution_depth': 720}
                elif kind == 'SeeThrough_SavePSD':
                    inputs.pop('Download PSD', None)
                    inputs.pop('Download Depth PSD', None)
                specs = info[kind].get('input', {})
                names = {**specs.get('required', {}), **specs.get('optional', {})}
                absent = set(changes) - set(names)
                if absent:
                    raise ValueError(kind + ' 不支持省显存设置：' + ', '.join(sorted(absent)))
                inputs.update(changes)
            item['profile'] = 'RTX 4060 8GB 省显存：分层 1024 / 深度 720 / 30 步 / 缓存文本嵌入 / 分组卸载'
        item['api'] = graph
        item.pop('conversion_error', None)
        item['fields'] = extract_fields(graph, info)
        item['outputs'] = [k for k, n in graph.items() if info.get(n['class_type'], {}).get('output_node')]
        self.analyze(item, info)
        # Older app manifests may still point directly at a discovered
        # workflow. Migrate those manifests before writing the executable API
        # graph, preserving the original file and its UI layout.
        owned_name = f'{CUSTOM_WORKFLOW_FOLDER}/app_{item.get("id")}.json'
        if item.get('source_kind') == 'workflow' and item.get('workflow') != owned_name:
            item['workflow_source'] = item.get('workflow_source') or item.get('workflow')
            item['workflow'] = owned_name
        name = item['workflow']
        write_json(self.host.workflow_path_from_name(name), graph)
        write_json(self.host.workflow_config_path(name), {'title': item['title'], 'fields': item['fields'], 'mini_cards': {}})
        self.save(item)
        return item

    def tasks(self, app_id):
        with self.host.CANVAS_TASK_LOCK:
            return sorted([copy.deepcopy(t) for t in self.host.CANVAS_TASKS.values()
                           if t.get('type') == 'comfy-app' and t.get('app_id') == app_id],
                          key=lambda t: t.get('created_at', 0), reverse=True)

    async def watch_stage(self, task_id):
        log = self.runtime.root / 'server.log'
        offset = log.stat().st_size if log.exists() else 0
        stages = [('Loading LayerDiff model', '加载分层模型'), ('Loading Marigold', '加载深度模型'),
                  ('GenerateLayers:', '正在生成透明图层'), ('Depth inference at', '正在估计图层深度'),
                  ('PostProcess complete', '正在整理图层与下载文件')]
        while True:
            await asyncio.sleep(2)
            if not log.exists():
                continue
            with log.open('rb') as stream:
                stream.seek(offset)
                text = stream.read().decode('utf-8', errors='replace')
                offset = stream.tell()
            matches = [(text.rfind(token), stage) for token, stage in stages if token in text]
            if matches:
                self.host.update_canvas_task(task_id, {'stage': max(matches)[1]})

    async def watch_progress(self, task_id, backend, graph):
        labels = {'SeeThrough_GenerateLayers': '生成透明图层', 'SeeThrough_GenerateDepth': '估计图层深度',
                  'SeeThrough_PostProcess': '整理图层', 'SeeThrough_SavePSD': '保存图层文件', 'SaveImage': '保存预览'}
        while True:
            try:
                async with websockets.connect(f'ws://{backend}/ws?clientId={task_id}', max_size=2**20) as socket:
                    async for raw in socket:
                        if not isinstance(raw, str):
                            continue
                        message = json.loads(raw)
                        data = message.get('data', {})
                        if message.get('type') == 'executing' and data.get('node'):
                            kind = graph.get(str(data['node']), {}).get('class_type', '')
                            stage = labels.get(kind, '运行节点：' + kind)
                            self.host.update_canvas_task(task_id, {'stage': stage, 'prompt_id': data.get('prompt_id')})
                        elif message.get('type') == 'progress':
                            self.host.update_canvas_task(task_id, {'progress': {'value': data.get('value'), 'max': data.get('max')}})
            except (OSError, WebSocketException, ValueError):
                await asyncio.sleep(3)

    async def execute(self, task_id, item, values, backend):
        async with self.serial:
            self.host.update_canvas_task(task_id, {'status': 'running', 'stage': '本地 ComfyUI 运行中'})
            monitor = asyncio.create_task(self.watch_stage(task_id)) if item.get('managed') else None
            progress = None
            try:
                graph = normalize_legacy_scheduler_values(copy.deepcopy(item['api']))
                apply_dlss5_preset(graph, item, values)
                progress = asyncio.create_task(self.watch_progress(task_id, backend, graph))
                # Use a full input copy so legacy numeric-node defaults cannot
                # change an imported graph's dimensions or seed.
                params = {key: copy.deepcopy(n.get('inputs', {})) for key, n in graph.items()}
                for key, fields in values.items():
                    params[key].update(fields)
                for key, node in graph.items():
                    if 'filename_prefix' in params[key]:
                        params[key]['filename_prefix'] = 'xiaomei_app_' + task_id
                request = self.host.GenerateRequest(workflow_json=item['workflow'], params=params,
                    preferred_backend=backend, local_only=True, preserve_workflow=True,
                    workflow_snapshot=graph,
                    client_id=task_id, type='comfy-app', history_source='comfy-app')
                result = await asyncio.to_thread(self.host.generate, request)
                if result.get('error'):
                    raise RuntimeError(result['error'])
                if not any(result.get(k) for k in ('images', 'videos', 'files', 'texts', 'audios')):
                    raise RuntimeError('工作流没有返回可下载的结果。请在高级编辑中检查输出节点。')
                for output in result.get('items', []):
                    if output['name'].endswith('_layers.json') and output['class_type'] == 'SeeThrough_SavePSD':
                        path = self.host.local_media_path_from_url(output['url'])
                        if not path:
                            raise RuntimeError('图层清单下载失败，请检查本地 ComfyUI 输出目录')
                        manifest = json.loads(Path(path).read_text(encoding='utf-8'))
                        if manifest.get('prefix') != 'xiaomei_app_' + task_id:
                            raise RuntimeError('图层清单与本次任务不匹配，已停止下载')
                        urls = {o['name']: o['url'] for o in result['items']}
                        for layer in manifest['layers']:
                            layer['url'] = urls.get(layer['filename'])
                            if not layer['url'] or not self.host.local_media_path_from_url(layer['url']):
                                raise RuntimeError('图层下载不完整：' + layer['filename'])
                        result['layers'] = manifest
                with self.lock:
                    latest = self.read(item['id'])
                    latest['verified'] = True
                    latest['cover'] = next((o['url'] for o in result.get('items', []) if o['class_type'] == 'SaveImage' and o['kind'] == 'image'), '')
                    self.save(latest)
                self.host.update_canvas_task(task_id, {'status': 'succeeded', 'stage': '完成', 'result': result})
            except Exception as exc:
                self.host.update_canvas_task(task_id, {'status': 'failed', 'stage': '运行失败', 'error': str(exc)})
                with self.lock:
                    latest = self.read(item['id'])
                    latest['runtime_error'] = str(exc)
                    latest['verified'] = False
                    latest['state'] = 'blocked'
                    self.save(latest)
            finally:
                if monitor:
                    monitor.cancel()
                if progress:
                    progress.cancel()


def install_comfy_apps(app, host):
    service = AppLibrary(host)
    router = APIRouter(prefix='/api/comfy-apps')

    @router.get('')
    def listing():
        return {'apps': [service.read(p.parent.name) for p in service.root.glob('*/app.json')]}

    @router.get('/catalog')
    def catalog():
        # 简化工作台需要同时展示已启用应用和工作流目录中尚未启用的用户工作流。
        # catalog() 会按 workflow/workflow_source 去重，避免同一工作流出现两张卡。
        return service.catalog(include_library=True)

    @router.get('/models')
    def models():
        return service.model_catalog()

    @router.post('/models/protection')
    async def model_protection(request: Request):
        try:
            payload = await request.json()
        except ValueError as exc:
            raise HTTPException(400, '保存模型保留设置失败：请求无效') from exc
        model_id = str(payload.get('model_id') or '') if isinstance(payload, dict) else ''
        protected = payload.get('protected') if isinstance(payload, dict) else None
        if not re.fullmatch(r'[a-f0-9]{32}', model_id):
            raise HTTPException(400, '保存模型保留设置失败：模型标识无效')
        if not isinstance(protected, bool):
            raise HTTPException(400, '保存模型保留设置失败：保留状态无效')
        model = next((item for item in service.model_catalog()['models'] if item.get('id') == model_id), None)
        if not model:
            raise HTTPException(404, '模型不存在或已移动，请刷新本地模型列表')
        with service.lock:
            preferences = service._read_model_preferences()
            if protected:
                preferences['models'][model_id] = {
                    'protected': True,
                    'name': model['name'],
                    'root_label': model['root_label'],
                    'relative_path': model['relative_path'],
                    'updated_at': time.time(),
                }
            else:
                preferences['models'].pop(model_id, None)
            service._write_model_preferences(preferences)
        return {
            'model_id': model_id,
            'protected': protected,
            'message': '已标记为手动保留' if protected else '已取消手动保留',
        }

    @router.post('/models/delete')
    async def delete_model(request: Request):
        try:
            payload = await request.json()
        except ValueError as exc:
            raise HTTPException(400, '删除模型失败：请求无效') from exc
        if not isinstance(payload, dict):
            raise HTTPException(400, '删除模型失败：请求无效')
        model_id = str(payload.get('model_id') or '')
        if not re.fullmatch(r'[a-f0-9]{32}', model_id):
            raise HTTPException(400, '删除模型失败：模型标识无效')
        if payload.get('confirmed') is not True:
            raise HTTPException(400, '请确认删除后再执行')
        with service.lock:
            return service.delete_model(model_id)

    @router.post('/import')
    async def importing(request: Request):
        raw = await request.body()
        if len(raw) > 20 * 1024 * 1024:
            raise HTTPException(413, '工作流超过 20MB，请移除内嵌图片后重试')
        try:
            payload = json.loads(raw)
            graph = payload['workflow']
            initial = inspect_workflow(graph, {})
            identity = uuid.uuid4().hex
            item = {'id': identity, 'title': str(payload.get('name') or '未命名应用')[:120],
                    'description': '本地工作流应用', 'source': graph, 'api': None, 'fields': [],
                    'workflow': 'custom/app_' + identity + '.json', 'uploads': [], 'created_at': time.time()}
            if any(n.get('type', n.get('class_type', '')).startswith('SeeThrough_')
                   for n in (graph.get('nodes') if initial['format'] == 'UI' else graph.get('prompt', graph).values())):
                item['description'] = 'SeeThrough 图像分层：主要面向动漫角色，真人和商品效果需实测，不保证还原原始设计文件。'
            service.save(item)
            try:
                backend, info = await asyncio.to_thread(service.backend)
                item['backend'] = backend
                if initial['format'] == 'API':
                    try:
                        service.compile(item, graph, info)
                    except ValueError as exc:
                        item['conversion_error'] = str(exc)
                service.analyze(item, info)
            except HTTPException as exc:
                item['state'] = 'blocked'
                item['report'] = service._apply_static_model_status(item, initial)
                item['report']['reasons'] = [exc.detail]
            service.save(item)
            return item
        except (ValueError, KeyError, TypeError) as exc:
            raise HTTPException(400, '导入失败：' + str(exc)) from exc

    @router.post('/workflows/{name:path}/enable')
    def enable_workflow(name: str):
        return service.enable_workflow(unquote(name))

    @router.get('/workflows/{name:path}')
    def workflow_detail(name: str):
        name = unquote(name)
        existing = service._app_for_workflow(service.catalog()['apps'], name)
        if existing:
            return {**existing, 'workflow_ref': name, 'entry_type': 'app'}
        try:
            return service._virtual_workflow(name)
        except HTTPException as exc:
            return service._invalid_workflow(name, exc.detail)

    @router.get('/{app_id}')
    def detail(app_id: str):
        return {**service.read(app_id), 'tasks': service.tasks(app_id)}

    @router.get('/{app_id}/delete-preview')
    def delete_preview(app_id: str, remove_source: bool = False):
        with service.lock:
            plan = service.delete_plan(app_id, remove_source)
            token = ''
            if plan['can_delete']:
                token = uuid.uuid4().hex
                service.delete_confirmations[token] = {
                    'app_id': app_id,
                    'expires_at': time.time() + DELETE_CONFIRMATION_TTL,
                    'remove_source': remove_source,
                }
                for key, value in list(service.delete_confirmations.items()):
                    if value.get('expires_at', 0) < time.time():
                        service.delete_confirmations.pop(key, None)
            plan['token'] = token
            plan['token_expires_in'] = DELETE_CONFIRMATION_TTL if token else 0
            return plan

    @router.post('/{app_id}/delete')
    async def delete_app(app_id: str, request: Request):
        try:
            payload = await request.json()
        except ValueError as exc:
            raise HTTPException(400, '删除请求无效，请重新打开删除预览') from exc
        token = str(payload.get('token') or '')
        if payload.get('confirmed') is not True:
            raise HTTPException(400, '请在删除预览中确认后再执行')
        delete_models = payload.get('delete_models', True)
        if not isinstance(delete_models, bool):
            raise HTTPException(400, 'delete_models 必须是布尔值')

        with service.lock:
            confirmation = service.delete_confirmations.get(token)
            if (not confirmation or confirmation.get('app_id') != app_id
                    or confirmation.get('expires_at', 0) < time.time()):
                service.delete_confirmations.pop(token, None)
                raise HTTPException(409, '删除预览已过期，请重新打开删除预览')
            service.delete_confirmations.pop(token, None)
            if app_id in service.deleting:
                raise HTTPException(409, '该应用正在删除，请稍候')
            plan = service.delete_plan(app_id, confirmation.get('remove_source', False))
            if not plan['can_delete']:
                raise HTTPException(409, plan['notes'][0])
            model_index = service._build_model_reference_index()
            item = service.read(app_id, model_index=model_index)
            candidates, _ = service._app_model_candidates(item, model_index)
            usage = service._all_model_usage(app_id, item.get('workflow', ''), candidates,
                                              plan['source_to_archive'], model_index)
            preferences = service._read_model_preferences()
            exclusive = [candidate for candidate in candidates
                          if not usage.get(candidate['key'])
                          and not service._user_protected(candidate, preferences)]
            service.deleting.add(app_id)
            try:
                archive_root, archived = service._archive_app(item, plan['source_to_archive'])
                deleted_models, model_errors = [], []
                if delete_models:
                    for candidate in exclusive:
                        deleted, errors = service._delete_candidate_files(candidate)
                        entry = {'name': candidate['name'], 'deleted_files': len(deleted),
                                 'file_count': candidate['file_count'], 'size': candidate['size']}
                        if errors:
                            entry['errors'] = errors
                        if deleted:
                            deleted_models.append(entry)
                        if errors:
                            model_errors.append({'name': candidate['name'], 'errors': errors})
                recovery = ('本应用配置和字段配置已移入本地回收区；生成结果和历史记录保留。'
                            if not plan['workflow_shared'] else
                            '本应用配置已移入本地回收区，共用工作流文件保留；生成结果和历史记录保留。')
                return {
                    'message': '应用已删除',
                    'app_id': app_id,
                    'archived_workflow': bool(archived),
                    'deleted_models': deleted_models,
                    'shared_models_kept': plan['models']['shared'],
                    'protected_models_kept': plan['models']['protected'],
                    'unresolved_models_kept': plan['unresolved'],
                    'model_errors': model_errors,
                    'recovery': recovery,
                    'archive_name': archive_root.name,
                }
            finally:
                service.deleting.discard(app_id)

    @router.get('/{app_id}/preparation')
    def preparation(app_id: str):
        item = service.read(app_id)
        task_id = item.get('prepare_task')
        with host.CANVAS_TASK_LOCK:
            task = copy.deepcopy(host.CANVAS_TASKS.get(task_id))
        log = service.runtime.root / 'prepare.log'
        preflight = service.preflight(item)
        return {'task': task, 'readiness': service.readiness(item),
                'environment_status': service._environment_status(item),
                'workflow_status': service._workflow_status(item),
                'log': log.read_text(encoding='utf-8', errors='replace')[-6000:] if log.exists() else '',
                'source': SOURCE, 'models': service.runtime.resources() if item['description'].startswith('SeeThrough') else [],
                'downloads': service._auto_model_downloads(item, preflight),
                'preflight': preflight}

    @router.post('/{app_id}/install-nodes')
    @router.post('/{app_id}/prepare')
    async def prepare(app_id: str, request: Request):
        nodes_only = request.url.path.endswith('/install-nodes')
        with service.lock:
            item = service.read(app_id)
            with host.CANVAS_TASK_LOCK:
                busy = next((copy.deepcopy(t) for t in host.CANVAS_TASKS.values()
                    if t.get('type') == 'comfy-app-prepare' and t.get('status') in ('queued', 'running')), None)
            if busy:
                if busy.get('app_id') == app_id:
                    return busy
                raise HTTPException(409, '另一个应用正在准备环境，请等待它完成或取消后再试')
            preflight = service.preflight(item)
            if preflight['hard_failures']:
                reason = '；'.join(preflight['hard_failures'])
                item['state'] = 'blocked'
                item['prepare_error'] = '无法开始安装：' + reason
                service.save(item)
                raise HTTPException(409, item['prepare_error'])
            identity = uuid.uuid4().hex
            service.runtime.cancel.clear()
            item['prepare_task'] = identity
            item['state'] = 'preparing'
            service.save(item)
            task = {'task_id': identity, 'app_id': app_id, 'type': 'comfy-app-prepare', 'status': 'queued',
                    'stage': '等待准备独立环境', 'progress': {'value': 0, 'max': 100,
                    'detail': '等待安装器开始', 'indeterminate': False}, 'created_at': time.time()}
            host.add_canvas_task(identity, task)
        async def work():
            try:
                host.update_canvas_task(identity, {'status': 'running', 'progress': {'value': 0, 'max': 100,
                    'detail': '安装器已启动', 'indeterminate': False}})
                seethrough = not nodes_only and item['description'].startswith('SeeThrough')
                async with service.serial:
                    searched = item if nodes_only else await asyncio.to_thread(service.find_missing_models, app_id,
                        lambda detail: host.update_canvas_task(identity, {'stage': '寻找缺失模型与 LoRA',
                            'progress': {'value': 0, 'max': 100, 'detail': detail, 'indeterminate': True}}))
                    download_models = [] if nodes_only else service._auto_model_downloads(searched)
                    node_packages = service.node_sources.resolve(
                        name for name in (searched.get('report') or {}).get('missing_nodes', [])
                        if name != 'Float')['packages']
                    managed_info = await asyncio.to_thread(service.runtime.prepare,
                        lambda stage: host.update_canvas_task(identity, {'stage': stage}), seethrough,
                        lambda progress: host.update_canvas_task(identity, {'progress': progress}),
                        download_models, node_packages)
                    # An offline import has no object_info, so its initial
                    # report cannot know which custom node types are missing.
                    # Scan the original graph against the freshly started
                    # backend, then install any newly discovered packages.
                    source = searched.get('api') or searched.get('source') or {}
                    discovered = inspect_workflow(source, managed_info).get('missing_nodes', [])
                    already_planned = {node for package in node_packages
                                       for node in package['required_nodes']}
                    newly_missing = [node for node in discovered
                                     if node not in already_planned and node != 'Float']
                    if newly_missing:
                        additional = service.node_sources.resolve(newly_missing)['packages']
                        if additional:
                            host.update_canvas_task(identity, {
                                'stage': '本地扫描发现缺失节点，继续安装',
                                'progress': {'value': 0, 'max': 100,
                                             'detail': '安装启动后识别出的节点包',
                                             'indeterminate': True},
                            })
                            managed_info = await asyncio.to_thread(service.runtime.prepare,
                                lambda stage: host.update_canvas_task(identity, {'stage': stage}),
                                False,
                                lambda progress: host.update_canvas_task(identity, {'progress': progress}),
                                [], additional)
                if service.runtime.cancel.is_set():
                    raise RuntimeError('准备已取消')
                with service.lock:
                    latest = service.read(app_id)
                    latest['managed'] = True
                    latest['backend'] = service.runtime.address
                    latest.pop('runtime_error', None)
                    latest.pop('prepare_error', None)
                    # API JSON already has executable node inputs and does
                    # not need the browser conversion bridge.  Compile it
                    # directly after the managed backend is ready; UI JSON is
                    # intentionally left for the native editor bridge.
                    source = latest.get('source') or {}
                    if (latest.get('needs_runtime_compile') or not latest.get('api')) \
                            and isinstance(source, dict) and not isinstance(source.get('nodes'), list):
                        try:
                            service.compile(latest, source, managed_info)
                            latest.pop('conversion_error', None)
                            latest.pop('needs_runtime_compile', None)
                        except (ValueError, KeyError, TypeError) as exc:
                            latest['conversion_error'] = str(exc)
                    service.analyze(latest, managed_info)
                    service.save(latest)
                remaining_nodes = (latest.get('report') or {}).get('missing_nodes') or []
                if remaining_nodes:
                    raise RuntimeError('节点准备未完成，仍缺少：' + '、'.join(remaining_nodes)
                                       + '。请查看依赖清单中的安装来源或独立环境 server.log。')
                host.update_canvas_task(identity, {'status': 'succeeded', 'stage': service.readiness(latest)['summary'],
                    'progress': {'value': 100, 'max': 100, 'detail': service.readiness(latest)['summary'], 'indeterminate': False}})
            except Exception as exc:
                cancelled = service.runtime.cancel.is_set()
                with service.lock:
                    latest = service.read(app_id)
                    latest['state'] = 'blocked'
                    latest['prepare_error'] = str(exc)
                    service.save(latest)
                host.update_canvas_task(identity, {'status': 'cancelled' if cancelled else 'failed', 'stage': '准备已取消' if cancelled else '准备未完成', 'error': str(exc)})
        worker = asyncio.create_task(work())
        service.workers.add(worker)
        worker.add_done_callback(service.workers.discard)
        return task

    @router.post('/{app_id}/prepare/cancel')
    def cancel_prepare(app_id: str):
        item = service.read(app_id)
        with host.CANVAS_TASK_LOCK:
            task = host.CANVAS_TASKS.get(item.get('prepare_task'), {})
            if task.get('status') not in ('queued', 'running'):
                raise HTTPException(409, '没有正在准备的任务')
        service.runtime.cancel.set()
        return {'message': '正在取消，已下载文件会保留'}

    @router.post('/{app_id}/analyze')
    def analyze(app_id: str):
        with service.lock:
            item = service.read(app_id)
            backend, info = service.backend(item)
            item['backend'] = backend
            service.analyze(item, info)
            service.save(item)
            return item

    @router.post('/{app_id}/rescan')
    def rescan(app_id: str):
        with service.lock:
            item = service.read(app_id)
            backend, info = service.backend(item)
            item['backend'] = backend
            item.pop('prepare_error', None)
            service.analyze(item, info)
            service.save(item)
            return service.read(app_id)

    @router.post('/{app_id}/convert')
    async def convert(app_id: str, request: Request):
        payload = await request.json()
        with service.lock:
            item = service.read(app_id)
            backend, info = service.backend(item)
            item['backend'] = backend
            service.analyze(item, info)
            if item['report']['missing_nodes']:
                item.pop('conversion_error', None)
                service.save(item)
                raise HTTPException(409, '请先安装缺失节点，再生成操作表单：' + '、'.join(item['report']['missing_nodes']))
            try:
                return service.compile(item, payload['prompt'], info)
            except (ValueError, KeyError, TypeError) as exc:
                item['conversion_error'] = str(exc)
                service.save(item)
                raise HTTPException(400, '转换失败，原文件已保留：' + str(exc)) from exc

    @router.post('/{app_id}/groups/{group_id}/enable')
    def enable_group(app_id: str, group_id: str):
        with service.lock:
            try:
                return service.enable_group(app_id, group_id)
            except ValueError as exc:
                raise HTTPException(400, str(exc)) from exc

    @router.patch('/{app_id}')
    async def edit(app_id: str, request: Request):
        payload = await request.json()
        with service.lock:
            item = service.read(app_id)
            if 'title' in payload:
                title = str(payload['title']).strip()
                if not title or len(title) > 120:
                    raise HTTPException(400, '应用名称需为 1–120 个字')
                item['title'] = title
            if 'fields' in payload:
                original = {f['id']: f for f in item['fields']}
                incoming = payload['fields']
                if not isinstance(incoming, list) or len(incoming) != len(original) or {f.get('id') for f in incoming} != set(original):
                    raise HTTPException(400, '只能修改现有字段名称和顺序')
                item['fields'] = [{**original[f['id']], 'name': str(f.get('name') or original[f['id']]['name'])[:80]} for f in incoming]
            service.save(item)
            if item.get('api'):
                write_json(host.workflow_config_path(item['workflow']), {'title': item['title'], 'fields': item['fields'], 'mini_cards': {}})
            return item

    @router.post('/{app_id}/profile')
    async def profile(app_id: str, request: Request):
        payload = await request.json()
        with service.lock:
            item = service.read(app_id)
            if not item.get('original_api'):
                raise HTTPException(400, '该应用没有 SeeThrough 参数备份')
            if any(t.get('status') in ('queued', 'running') for t in service.tasks(app_id)):
                raise HTTPException(409, '请等待本应用的运行任务结束后再切换参数')
            _, info = service.backend(item)
            if payload.get('profile') == 'low-vram':
                return service.compile(item, item['original_api'], info)
            if payload.get('profile') != 'original':
                raise HTTPException(400, '请选择省显存或原工作流参数')
            graph = copy.deepcopy(item['api'])
            for key, node in graph.items():
                original = item['original_api'].get(key, {}).get('inputs', {})
                for name in ('resolution', 'resolution_depth', 'num_inference_steps', 'seed', 'cache_tag_embeds', 'group_offload'):
                    if name in original:
                        node['inputs'][name] = original[name]
            item['api'] = graph
            item['profile'] = '原工作流参数（显存需求可能更高）；模型仍使用本地文件'
            item['verified'] = False
            item['fields'] = extract_fields(graph, info)
            service.analyze(item, info)
            write_json(host.workflow_path_from_name(item['workflow']), graph)
            write_json(host.workflow_config_path(item['workflow']), {'title': item['title'], 'fields': item['fields'], 'mini_cards': {}})
            service.save(item)
            return item

    @router.post('/{app_id}/upload')
    async def upload(app_id: str, image: UploadFile = File(...)):
        item = service.read(app_id)
        data = await image.read(30 * 1024 * 1024 + 1)
        if len(data) > 30 * 1024 * 1024:
            raise HTTPException(413, '图片超过 30MB，请缩小后重试')
        try:
            pic = Image.open(io.BytesIO(data))
            if pic.format not in ('PNG', 'JPEG', 'WEBP') or pic.width * pic.height > 80_000_000:
                raise ValueError('Unsupported image format or size')
            pic.verify()
            suffix = Image.registered_extensions()
            ext = next((k for k, v in suffix.items() if v == pic.format), '.png')
        except Exception as exc:
            raise HTTPException(400, '图片无法读取，请上传 PNG、JPG 或 WebP') from exc
        address, _ = await asyncio.to_thread(service.backend, item, start=True)
        name = 'xiaomei_' + uuid.uuid4().hex + ext
        response = await asyncio.to_thread(requests.post, f'http://{address}/upload/image',
            files={'image': (name, data, image.content_type)}, data={'overwrite': 'false'}, timeout=60)
        response.raise_for_status()
        result = response.json()
        name = '/'.join(filter(None, [result.get('subfolder'), result['name']]))
        with service.lock:
            item = service.read(app_id)
            item['uploads'].append(name)
            item['backend'] = address
            service.save(item)
        return {'name': name}

    @router.get('/{app_id}/models/replacements')
    def replacement_options(app_id: str, dependency: str, category: str):
        item = service.read(app_id)
        service.replacement_requirement(item, dependency, category)
        return {'models': [name for name, paths in service.replacement_files(category).items()
                           if name != dependency and len({str(p.resolve()) for p in paths}) == 1]}

    @router.post('/{app_id}/models/replace')
    async def replace_model(app_id: str, request: Request):
        payload = await request.json()
        return await asyncio.to_thread(service.replace_model_reference, app_id,
            str(payload.get('dependency') or ''), str(payload.get('category') or ''),
            str(payload.get('replacement') or ''))

    @router.post('/{app_id}/models/import')
    async def import_model(app_id: str, file: UploadFile = File(...),
                           dependency: str = Form(''), category: str = Form(''), replace: bool = Form(False)):
        """Copy one user-provided model into the shared local ComfyUI model tree.

        The destination is derived from the workflow's loader category and is
        never accepted as an arbitrary filesystem path.
        """
        item = service.read(app_id)
        expected = str(dependency or '').strip()
        if replace:
            service.replacement_requirement(item, expected, category)
        missing = set((item.get('report') or {}).get('missing_models') or [])
        uploaded_name = Path(str(file.filename or '')).name
        if not uploaded_name or uploaded_name in ('.', '..'):
            raise HTTPException(400, '上传文件名无效')
        expected_name = Path(expected).name if expected and not replace else uploaded_name
        if expected and uploaded_name != expected_name and not replace:
            raise HTTPException(400, f'文件名需为 {expected_name}，当前为 {uploaded_name}')
        requirement = next((entry for entry in (item.get('report') or {}).get('model_requirements', [])
                            if entry.get('name') == expected_name or entry.get('name') == expected), {})
        trusted_source = service._model_source(item, expected or expected_name, requirement)
        expected_size = int(trusted_source['size_bytes']) if trusted_source and trusted_source.get('size_bytes') else None
        expected_hash = (trusted_source or MANUAL_MODEL_SOURCES.get(expected_name.casefold(), {})).get('sha256')
        expected_hash = expected_hash or (item.get('model_search', {}).get(expected or expected_name, {})).get('sha256')
        if replace:
            expected_size, expected_hash = None, None
        allowed_categories = {'checkpoints', 'diffusion_models', 'text_encoders', 'vae', 'loras',
                              'upscale_models', 'controlnet', 'clip_vision', 'SEEDVR2', 'models'}
        target_category = str(category or requirement.get('category') or 'models').strip().replace('\\', '/')
        if target_category not in allowed_categories or '/' in target_category or target_category in ('.', '..'):
            raise HTTPException(400, '模型目录类别无效，请选择 ComfyUI 模型目录')
        if not uploaded_name.lower().endswith(tuple(MODEL_FILE_EXTENSIONS)):
            raise HTTPException(400, '该文件不是支持的本地模型格式')
        destination_root = Path(service.runtime.base) / 'models'
        if target_category != 'models':
            destination_root /= target_category
        destination_root.mkdir(parents=True, exist_ok=True)
        destination = destination_root / expected_name
        if destination.exists():
            # A user may have copied the file into ComfyUI manually, or a
            # previous import may have completed before the UI refreshed.  Do
            # not overwrite that file, but reconcile the stale dependency
            # state instead of asking the user to import the same model again.
            if not replace and expected and destination.is_file() and not destination.is_symlink():
                try:
                    service.check_replacement_file(destination, target_category, expected_name)
                except HTTPException as exc:
                    raise HTTPException(409, '目标文件已存在，但文件检查未通过：' + str(exc.detail)) from exc
                try:
                    backend, info = service.backend(item)
                    item['backend'] = backend
                except HTTPException:
                    # The local file check still resolves the dependency while
                    # ComfyUI is restarting; a later rescan will restore live
                    # node information.
                    info = {}
                service.analyze(item, info)
                service.save(item)
                result = service.read(app_id)
                return {'ok': True, 'already_present': True, 'name': destination.name,
                        'category': target_category, 'bytes': destination.stat().st_size,
                        'item': result, 'message': '模型已在目标目录，已重新检查，无需重复导入'}
            raise HTTPException(409, f'目标文件已存在：{destination.name}。请先确认文件内容，系统不会覆盖已有模型。')
        if not replace and expected and expected not in missing:
            raise HTTPException(400, '该模型不是当前工作流已识别的缺失依赖，请先重新扫描')
        temporary = destination.with_name(destination.name + '.' + uuid.uuid4().hex + '.upload')
        total = 0
        digest = hashlib.sha256()
        try:
            with temporary.open('wb') as output:
                while True:
                    chunk = await file.read(1024 * 1024)
                    if not chunk:
                        break
                    total += len(chunk)
                    digest.update(chunk)
                    if total > 20 * 1024 ** 3:
                        raise HTTPException(413, '模型文件超过 20GB，无法通过本地导入上传')
                    output.write(chunk)
            if total == 0:
                raise HTTPException(400, '模型文件为空')
            if expected_size and total != expected_size:
                raise HTTPException(400,
                                    f'模型文件不完整：当前 {total / 1024 ** 3:.2f} GiB，'
                                    f'应为 {expected_size / 1024 ** 3:.2f} GiB；文件未移动')
            if expected_hash and digest.hexdigest() != expected_hash:
                raise HTTPException(400, '模型 SHA-256 与已核实的原文件不符，未导入；请从模型来源页取得正确版本。')
            if replace:
                service.check_replacement_file(temporary, target_category, uploaded_name)
            temporary.replace(destination)
        finally:
            temporary.unlink(missing_ok=True)
        if replace:
            return await asyncio.to_thread(service.replace_model_reference, app_id, expected, target_category, uploaded_name)
        with service.lock:
            latest = service.read(app_id)
            try:
                backend, info = service.backend(latest)
                latest['backend'] = backend
                service.analyze(latest, info)
            except HTTPException as exc:
                latest['rescan_error'] = exc.detail
                latest['state'] = 'blocked'
            service.save(latest)
        result = service.read(app_id)
        return {'ok': True, 'name': destination.name, 'category': target_category,
                'bytes': total, 'item': result,
                'message': '模型已导入并完成复查' if result.get('workflow_status') == 'ready'
                           else '模型已导入，但工作流仍有其他项目需要处理'}

    @router.post('/{app_id}/run')
    async def run(app_id: str, request: Request):
        payload = await request.json()
        request_id = host._normalize_canvas_client_request_id(payload.get('request_id'))
        if not request_id:
            raise HTTPException(400, '缺少请求编号，请刷新页面后重试')
        existing = next((t for t in service.tasks(app_id) if t.get('client_request_id') == request_id), None)
        if existing:
            return existing
        backend, info = await asyncio.to_thread(service.backend, service.read(app_id), start=True)
        # No await between duplicate lookup and registration.
        with service.lock:
            existing = next((t for t in service.tasks(app_id) if t.get('client_request_id') == request_id), None)
            if existing:
                return existing
            item = service.read(app_id)
            service.analyze(item, info)
            service.save(item)
            if item['state'] != 'ready':
                raise HTTPException(409, '；'.join(item['report']['reasons']))
            if item.get('backend') != backend:
                raise HTTPException(409, '本地后端已改变，请重新上传图片')
            try:
                schema = {(f['node'], f['input'], f['type']) for f in extract_fields(item['api'], info)}
                preset = dlss5_preset_field(item)
                if preset:
                    schema.add((preset['node'], preset['input'], preset['type']))
                if any((f['node'], f['input'], f['type']) not in schema for f in item['fields']):
                    raise ValueError('表单包含未经识别的参数映射，请重新转换工作流后配置')
                values = validate_fields(item['fields'], payload.get('fields', {}), item['uploads'])
            except ValueError as exc:
                raise HTTPException(400, str(exc)) from exc
            identity = uuid.uuid4().hex
            task = {'task_id': identity, 'app_id': app_id, 'type': 'comfy-app', 'status': 'queued',
                    'stage': '等待本地任务', 'created_at': time.time(), 'client_request_id': request_id}
            host.add_canvas_task(identity, task)
            worker = asyncio.create_task(service.execute(identity, copy.deepcopy(item), values, backend))
            service.workers.add(worker)
            worker.add_done_callback(service.workers.discard)
            return task

    @router.post('/{app_id}/tasks/{task_id}/psd')
    async def save_psd(app_id: str, task_id: str, request: Request):
        task = next((t for t in service.tasks(app_id) if t.get('task_id') == task_id), None)
        if not task or task.get('status') != 'succeeded' or not task.get('result', {}).get('layers'):
            raise HTTPException(404, '本次任务没有可合成的图层')
        data = bytearray()
        async for chunk in request.stream():
            data.extend(chunk)
            if len(data) > 128 * 1024 * 1024:
                raise HTTPException(413, 'PSD 超过 128MB')
        if len(data) < 26 or data[:6] != b'8BPS\x00\x01':
            raise HTTPException(400, 'PSD 文件头无效')
        manifest = task['result']['layers']
        if int.from_bytes(data[14:18], 'big') != manifest['height'] or int.from_bytes(data[18:22], 'big') != manifest['width']:
            raise HTTPException(400, 'PSD 尺寸与本次任务的图层清单不一致')
        filename = 'comfy_app_' + task_id + '.psd'
        path = host.output_path_for(filename, 'output')
        Path(path).write_bytes(data)
        url = host.output_url_for(filename, 'output')
        result = task['result']
        result['psd'] = url
        host.update_canvas_task(task_id, {'result': result})
        return {'url': url}

    app.include_router(router)
    return service
