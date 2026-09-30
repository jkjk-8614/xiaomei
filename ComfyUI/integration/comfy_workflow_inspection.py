"""Read-only dependency inspection for ComfyUI UI and API workflows.

The inspector deliberately stays independent from the application library.  It
is used while importing a workflow, before an execution backend is selected,
so the result must remain useful when a custom node is not installed yet.
"""


from ComfyUI.integration.comfy_node_registry import frontend_node_available

SWARM_INPUT_TYPES = {
    "SwarmWorkflowDescription",
    "SwarmInputGroup",
    "SwarmInputInteger",
    "SwarmInputFloat",
    "SwarmInputText",
    "SwarmInputModelName",
    "SwarmInputCheckpoint",
    "SwarmInputDropdown",
    "SwarmInputBoolean",
    "SwarmInputImage",
    "SwarmInputAudio",
    "SwarmInputVideo",
}

MODEL_INPUT_CATEGORIES = {
    "ckpt_name": "checkpoints",
    "checkpoint": "checkpoints",
    "unet_name": "diffusion_models",
    "clip_name": "text_encoders",
    "clip_name1": "text_encoders",
    "clip_name2": "text_encoders",
    "clip_name3": "text_encoders",
    "vae_name": "vae",
    "lora_name": "loras",
    "model_name": "upscale_models",
    "upscale_model": "upscale_models",
    "control_net_name": "controlnet",
    "clip_vision": "clip_vision",
    "vae_ckpt": "vae",
    "unet_ckpt": "diffusion_models",
    "model_name1": "text_encoders",
    "model_name2": "text_encoders",
    "model_name3": "text_encoders",
    "diffusion_model": "diffusion_models",
    "dit_name": "diffusion_models",
}


def _model_category(node_kind, input_name):
    """Return the ComfyUI model directory for a scalar loader input.

    A number of custom nodes use names that are not present in ComfyUI's
    standard loader list (for example ``model_name1`` in Inspire nodes and
    ``model`` in SeedVR2).  This is deliberately a conservative heuristic:
    it only treats a value as a model when the node/input combination clearly
    describes a loader.  It is used for inspection only; downloads are gated
    by the application library's explicit trusted registry.
    """
    name = str(input_name or "").strip().lower()
    kind = str(node_kind or "").strip().lower()
    # Image Saver's Civitai metadata helper calls this field ``model_name``,
    # but it stores a human-readable model title rather than a ComfyUI model
    # file.  Treating it as an upscale model creates a false download block.
    if name == "model_name" and "civitai hash fetcher" in kind and "image saver" in kind:
        return None
    if "seedvr" in kind and name in {"model", "model_name", "dit_name", "vae_name"}:
        return "SEEDVR2"
    if name in {"model_name", "model_name1", "model_name2", "model_name3"}:
        if "textencoder" in kind or "text_encoder" in kind:
            return "text_encoders"
        if "diffusion" in kind or "dit" in kind:
            return "diffusion_models"
    if name in MODEL_INPUT_CATEGORIES:
        return MODEL_INPUT_CATEGORIES[name]
    if name == "model":
        if "seedvr" in kind or "upscale" in kind or "dit" in kind:
            return "diffusion_models"
        if "load" in kind or "diffusion" in kind:
            return "diffusion_models"
    if name in {"name", "model_patch", "patch_model"} and "modelpatch" in kind:
        return "controlnet"
    return None


def _widget_model_fields(node, kind):
    """Yield model-valued UI widget names without relying on object_info."""
    names = []
    for entry in node.get("inputs") or []:
        if not isinstance(entry, dict):
            continue
        widget = entry.get("widget")
        if not widget and ("link" in entry or entry.get("type") not in {"INT", "FLOAT", "STRING", "BOOLEAN", "COMBO"}):
            continue
        name = widget.get("name") if isinstance(widget, dict) else None
        name = name or entry.get("name")
        if name and _model_category(kind, name):
            names.append(str(name))
    if names:
        return names
    # Standard loader nodes exported by older ComfyUI versions may omit the
    # per-widget metadata.  The known loader mapping is still safe to use.
    known = {
        "UNETLoader": "unet_name",
        "CLIPLoader": "clip_name",
        "VAELoader": "vae_name",
        "LoraLoaderModelOnly": "lora_name",
        "LoraLoader": "lora_name",
        "CheckpointLoaderSimple": "ckpt_name",
        "UpscaleModelLoader": "model_name",
        "SeedVR2LoadDiTModel": "model",
        "SeedVR2LoadVAEModel": "model",
    }
    field = known.get(kind)
    return [field] if field and _model_category(kind, field) else []


def _ui_model_metadata(node, value):
    """Read source metadata embedded by the ComfyUI model picker, if any."""
    properties = node.get("properties") if isinstance(node, dict) else None
    models = properties.get("models") if isinstance(properties, dict) else None
    if not isinstance(models, list):
        return {}
    for model in models:
        if not isinstance(model, dict) or str(model.get("name") or "") != str(value):
            continue
        result = {}
        if model.get("directory"):
            result["category"] = str(model["directory"])
        if model.get("url"):
            result["source"] = str(model["url"])
        if model.get("sha256"):
            result["sha256"] = str(model["sha256"])
        return result
    return {}


def _widget_names(node, info):
    """Return UI widget names in the same order as ``widgets_values``.

    ComfyUI exports widget metadata in slightly different shapes across
    frontend versions.  Prefer the explicit UI input metadata and fall back to
    the object-info schema instead of assuming the first widget is the model.
    """
    names = []
    for entry in node.get("inputs") or []:
        if not isinstance(entry, dict):
            continue
        widget = entry.get("widget")
        if not widget and ("link" in entry or entry.get("type") not in {"INT", "FLOAT", "STRING", "BOOLEAN", "COMBO"}):
            continue
        name = widget.get("name") if isinstance(widget, dict) else None
        name = name or entry.get("name")
        if name:
            names.append(str(name))
    if names:
        return names
    schema = info.get("input", {}) if isinstance(info, dict) else {}
    for section in ("required", "optional"):
        for name, spec in (schema.get(section) or {}).items():
            if spec and (isinstance(spec[0], list) or spec[0] in {"INT", "FLOAT", "STRING", "BOOLEAN", "COMBO"}):
                names.append(str(name))
    if not names:
        names = _widget_model_fields({"inputs": []}, node.get("type", ""))
    return names


def _ui_widget_value(node, name, info):
    values = node.get("widgets_values") or []
    names = _widget_names(node, info)
    if name in names:
        index = names.index(name)
        return values[index] if index < len(values) else None
    return None


def _is_inactive_ui_node(node):
    """Whether a UI workflow node is disabled or bypassed in ComfyUI.

    Modes 2 (never) and 4 (bypass) are retained in the saved canvas so the
    user can turn an optional branch back on later, but they are not part of
    the executable graph now.  Inspecting them as active dependencies makes
    optional nodes and their model files block the current workflow.
    """
    if not isinstance(node, dict):
        return False
    try:
        return int(node.get('mode', 0) or 0) in {2, 4}
    except (TypeError, ValueError):
        return False


def inspect_workflow(workflow, object_info):
    if not isinstance(workflow, dict):
        raise ValueError("请选择 ComfyUI 导出的 JSON 工作流")
    if isinstance(workflow.get("nodes"), list):
        nodes = [node for node in workflow["nodes"] if not _is_inactive_ui_node(node)]
        ui_format = True
        records = []
    else:
        prompt = workflow.get("prompt", workflow)
        if not isinstance(prompt, dict):
            raise ValueError("工作流 prompt 必须是对象")
        records = [(str(key), node) for key, node in prompt.items()]
        nodes = [node for _, node in records]
        ui_format = False
    if not nodes or any(not isinstance(n, dict) for n in nodes):
        raise ValueError("工作流没有有效节点")
    invalid = [str(n.get('id', i) if ui_format else records[i][0]) for i, n in enumerate(nodes) if not n.get('type' if ui_format else 'class_type')]
    if invalid:
        raise ValueError('节点 ' + '、'.join(invalid) + ' 缺少 ' + ('type' if ui_format else 'class_type') + '；请检查原工作流及缺失的自定义节点')
    if ui_format:
        records = [(str(node.get("id", index)), node) for index, node in enumerate(nodes)]
        subgraphs = {str(graph['id']): graph for graph in
                     (workflow.get('definitions') or {}).get('subgraphs', [])
                     if isinstance(graph, dict) and graph.get('id')}
        expanded, visited = [], set()
        pending = [(node_id, node) for node_id, node in records
                   if not _is_inactive_ui_node(node)]
        while pending:
            node_id, node = pending.pop(0)
            kind = str(node.get('type', ''))
            if kind not in subgraphs:
                expanded.append((node_id, node))
                continue
            if kind in visited:
                continue
            visited.add(kind)
            for index, child in enumerate(subgraphs[kind].get('nodes', [])):
                if not isinstance(child, dict) or not child.get('type'):
                    raise ValueError('子图 ' + kind + ' 包含无效节点')
                if _is_inactive_ui_node(child):
                    continue
                pending.append((node_id + '/' + str(child.get('id', index)), child))
        records = expanded
    object_info = object_info if isinstance(object_info, dict) else {}
    # An empty object_info means that the local ComfyUI endpoint is offline or
    # still starting.  It must not turn every node into a false "missing node"
    # error; static model references below remain useful in that situation.
    backend_available = bool(object_info)
    missing_nodes, missing_models, review_nodes = set(), set(), set()
    model_requirements = []
    model_requirement_keys = set()
    swarm_inputs = []
    workflow_description = None
    loaders = {"UNETLoader": "unet_name", "CLIPLoader": "clip_name",
               "VAELoader": "vae_name", "LoraLoaderModelOnly": "lora_name",
               "LoraLoader": "lora_name", "CheckpointLoaderSimple": "ckpt_name",
               "UpscaleModelLoader": "model_name"}
    def add_model_requirement(node_id, kind, field, value, metadata=None):
        if not isinstance(value, str) or not value.strip():
            return None
        value = value.strip()
        if value.casefold() in {"none", "null", "none.safetensors", "cpu", "cuda", "mps"} or value.casefold().startswith("cuda:"):
            return None
        metadata = metadata or {}
        category = str(metadata.get("category") or _model_category(kind, field) or "")
        if not category:
            return None
        key = (str(node_id), str(field), value.casefold())
        if key not in model_requirement_keys:
            model_requirement_keys.add(key)
            requirement = {
                "name": value,
                "category": category,
                "node": node_id,
                "class_type": kind,
                "input": field,
            }
            if metadata.get("source"):
                requirement["source"] = metadata["source"]
            if metadata.get("sha256"):
                requirement["sha256"] = metadata["sha256"]
            model_requirements.append(requirement)
        return category

    for node_id, node in records:
        kind = node.get("type" if ui_format else "class_type")
        if kind in SWARM_INPUT_TYPES:
            swarm_inputs_title = ((node.get("inputs") or {}).get("title") if not ui_format
                                  else _ui_widget_value(node, "title", {}))
            swarm_inputs.append({
                "id": node_id,
                "type": kind,
                "title": swarm_inputs_title,
            })
            if kind == "SwarmWorkflowDescription":
                workflow_description = {
                    "description": ((node.get("inputs") or {}).get("description") if not ui_format
                                    else _ui_widget_value(node, "description", {})),
                    "enable_in_simple_tab": ((node.get("inputs") or {}).get("enable_in_simple_tab") if not ui_format
                                              else _ui_widget_value(node, "enable_in_simple_tab", {})),
                }
            continue
        if backend_available and kind not in object_info and kind not in {"Note", "MarkdownNote", "PrimitiveNode", "Reroute"} and not frontend_node_available(kind, object_info, node):
            missing_nodes.add(kind)
        info = object_info.get(kind, {})
        if info.get("api_node") or any(x in kind.lower() for x in
                ("runninghub", "openai", "gemini", "http", "api", "kling", "gpt")):
            review_nodes.add(kind)
        fields = _widget_model_fields(node, kind) if ui_format else list((node.get("inputs") or {}).keys())
        for field in fields:
            category = _model_category(kind, field)
            if not category:
                continue
            value = _ui_widget_value(node, field, info) if ui_format else (node.get("inputs") or {}).get(field)
            # API links are not file names.  UI widgets may also contain a
            # serialized link in unusual exports; only inspect scalar values.
            if isinstance(value, (list, dict)):
                continue
            if not add_model_requirement(node_id, kind, field, value,
                                         _ui_model_metadata(node, value) if ui_format else None):
                continue
            if not backend_available or not info:
                continue
            spec = info.get("input", {}).get("required", {}).get(field, [])
            choices = spec[0] if spec and isinstance(spec[0], list) else (spec[1].get("options", []) if len(spec) > 1 and isinstance(spec[1], dict) else [])
            if isinstance(value, str) and value not in choices:
                missing_models.add(value)
    return {"format": "UI" if ui_format else "API", "node_count": len(nodes),
            "missing_nodes": sorted(missing_nodes), "missing_models": sorted(missing_models),
            "review_nodes": sorted(review_nodes),
            "model_requirements": model_requirements,
            "swarm_inputs": swarm_inputs,
            "workflow_description": workflow_description,
            "backend_available": backend_available,
            "note": "检查覆盖已知加载器；自定义节点内部的模型下载、网络调用和许可证需另行确认。"}
