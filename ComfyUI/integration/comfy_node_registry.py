"""Trusted and discoverable sources for ComfyUI workflow node packages.

The built-in registry is the first choice.  Nodes not present there may be
resolved from ComfyUI-Manager's public catalogs, but only when an exact node
name points to one HTTPS GitHub repository and that repository can be pinned
to a commit before installation.
"""
import json
import os
import re
import subprocess
import threading
import time
import uuid
from pathlib import Path
from urllib.parse import urlparse

import requests


MANAGER_NODE_MAP_URL = 'https://raw.githubusercontent.com/ltdrdata/ComfyUI-Manager/main/extension-node-map.json'
MANAGER_NODE_LIST_URL = 'https://raw.githubusercontent.com/ltdrdata/ComfyUI-Manager/main/custom-node-list.json'
MANAGER_CACHE_TTL = 24 * 60 * 60
MANAGER_CACHE_VERSION = 1
PACKAGE_NAME_PATTERN = re.compile(r'[A-Za-z0-9][A-Za-z0-9_.-]{0,159}')
REVISION_PATTERN = re.compile(r'[a-f0-9]{40}')

NODE_PACKAGES = {
    'RES4LYF': {
        'source': 'https://github.com/ClownsharkBatwing/RES4LYF.git',
        'revision': '7750bf7800b6ad9d670308a09989fc0c04c40cec',
        'nodes': ['LatentNoised'],
    },
    'cg-use-everywhere': {
        'source': 'https://github.com/chrisgoringe/cg-use-everywhere.git',
        'revision': '50ae9f8c5d8b9538589663c90a15d4067a02969c',
        'nodes': ['Anything Everywhere', 'Anything Everywhere3', 'Anything Everywhere?',
                  'Prompts Everywhere', 'Seed Everywhere', 'Simple String', 'Combo Clone'],
    },
    'ComfyUI-CacheDiT': {
        'source': 'https://github.com/Jasonzzt/ComfyUI-CacheDiT.git',
        'revision': '1d92bbd86ec59aa6223fe2368849b7413a1acb93',
        'nodes': ['CacheDiT_Model_Optimizer'],
    },
    'ComfyUI-Image-Saver': {
        'source': 'https://github.com/alexopus/ComfyUI-Image-Saver.git',
        'revision': 'b4b349e553d0f43713fa6914708b70b296392f73',
        'nodes': ['Civitai Hash Fetcher (Image Saver)', 'Image Saver',
                  'Workflow Input Value (Image Saver)'],
    },
    'ComfyUI-Detail-Daemon': {
        'source': 'https://github.com/Jonseed/ComfyUI-Detail-Daemon.git',
        'revision': '3394e44afea04ed0188fb37b21f0d9952469766b',
        'nodes': ['DetailDaemonGraphSigmasNode', 'DetailDaemonSamplerNode',
                  'LyingSigmaSampler', 'MultiplySigmas'],
    },
    'was-node-suite-comfyui': {
        'source': 'https://github.com/ltdrdata/was-node-suite-comfyui.git',
        'revision': '44de705818d4663fefefde57ffe0ea5a9ea39df4',
        'nodes': ['Get Image Size', 'Image Lucy Sharpen', 'Seed'],
    },
    'ComfyUI-LG_SamplingUtils': {
        'source': 'https://github.com/LAOGOU-666/ComfyUI-LG_SamplingUtils.git',
        'revision': '8a725e318201a03895f287a926d6f022902e5c31',
        'nodes': ['LGNoiseInjectionLatent', 'LGNoiseInjection'],
    },
    'ComfyUI_essentials': {
        'source': 'https://github.com/cubiq/ComfyUI_essentials.git',
        'revision': '9d9f4bedfc9f0321c19faf71855e228c93bd0dc9',
        'nodes': ['SimpleMath+'],
    },
    'ComfyUI-GGUF': {
        'source': 'https://github.com/city96/ComfyUI-GGUF.git',
        'revision': '6ea2651e7df66d7585f6ffee804b20e92fb38b8a',
        'nodes': ['CLIPLoaderGGUF', 'DualCLIPLoaderGGUF', 'QuadrupleCLIPLoaderGGUF',
                  'TripleCLIPLoaderGGUF', 'UnetLoaderGGUF', 'UnetLoaderGGUFAdvanced'],
    },
    'rgthree-comfy': {
        'source': 'https://github.com/rgthree/rgthree-comfy.git',
        'revision': '2c5342a8cb0eaecaabf61435a5f37dd594c510ba',
        'nodes': ['Fast Groups Bypasser (rgthree)', 'Bookmark (rgthree)', 'Label (rgthree)', 'Image Comparer (rgthree)', 'Seed (rgthree)'],
    },
    'ComfyUI_LayerStyle': {
        'source': 'https://github.com/chflame163/ComfyUI_LayerStyle.git',
        'revision': 'a3459a7638c4c2839878089c105c73af0eb2edd2',
        'nodes': ['LayerUtility: ImageScaleByAspectRatio V2', 'LayerUtility: ImageReel', 'LayerUtility: ImageReelComposit'],
    },
    'ComfyUI-KJNodes': {
        'source': 'https://github.com/kijai/ComfyUI-KJNodes.git',
        'revision': 'd3cfe21625e5170126ce06fbfcfe1d88108688c3',
        # SetNode/GetNode are virtual frontend nodes.  Keep them in the
        # package inventory so a workflow that activates them can still
        # request the KJNodes package, even though they never appear in
        # ComfyUI's backend object_info response.
        'nodes': ['INTConstant', 'GetNode', 'SetNode'],
    },
    'ComfyUI-SeedVR2_VideoUpscaler': {
        'source': 'https://github.com/numz/ComfyUI-SeedVR2_VideoUpscaler.git',
        'revision': '4490bd1f482e026674543386bb2a4d176da245b9',
        'nodes': ['SeedVR2LoadDiTModel', 'SeedVR2LoadVAEModel', 'SeedVR2VideoUpscaler'],
    },
    'ComfyUI-Custom-Scripts': {
        'source': 'https://github.com/pythongosssss/ComfyUI-Custom-Scripts.git',
        'revision': '609f3afaa74b2f88ef9ce8d939626065e3247469',
        'nodes': ['ShowText|pysssss'],
    },
    'ComfyUI-Easy-Use': {
        'source': 'https://github.com/yolain/ComfyUI-Easy-Use.git',
        'revision': '450b1ce4ce43b2280521c87f5fa388a898fb2ad2',
        'nodes': ['easy clearCacheAll'],
    },
    # These three packages are used by imported Z-Image/Qwen workflows.  Keep
    # them pinned here so the app can offer the same safe, explicit install
    # path as the other allow-listed custom nodes.
    'comfyui-impact-pack': {
        'source': 'https://github.com/ltdrdata/ComfyUI-Impact-Pack.git',
        'revision': '705698faf242851881abd7d1e1774baa3cf47136',
        'nodes': ['ImpactInt'],
    },
    'ComfyUI_Qwen3-VL-Instruct': {
        'source': 'https://github.com/IuvenisSapiens/ComfyUI_Qwen3-VL-Instruct.git',
        'revision': '70cc35edacfd5979cbe7a15caf56bd2f715bc3b5',
        'nodes': ['Qwen3_VQA'],
    },
    'comfyui-mixlab-nodes': {
        'source': 'https://github.com/shadowcz007/comfyui-mixlab-nodes.git',
        'revision': '32b22c39cbe13b46df29ef1b6ab088c2eb4389d2',
        'nodes': ['TextInput_'],
    },
    'ComfyUI-DLSS5': {
        'source': 'https://github.com/HECer/ComfyUI-DLSS5.git',
        'revision': 'f4f59cd1fe39e785a3b600ca20b5e09194a9e38d',
        'git_lfs': True,
        'post_install': ('实验性 Windows/NVIDIA 节点。节点加载后首次使用前，仍需在高级编辑中运行 '
                         '“DLSS Runtime Setup (One Click)”安装并检查插件自己的原生运行时。'),
        'nodes': [
            'DLSS5RuntimeSetup', 'DLSS5EasyPipeline', 'DLSSSuperResolution',
            'DLSS5FullPipeline', 'DLSS5NeuralRendering', 'DLSS5RuntimeStatus',
            'DLSS5OpticalFlow', 'DLSS5RAFTFlow', 'DLSS5DepthAnythingV2',
            'DLSS5VideoDepthAnything', 'DLSS5FlashDepth',
            'DLSS5TemporalDepthStabilize', 'DLSSFrameGeneration',
            'DLSSFrameGenerationStatus',
        ],
    },
}

# Older WAS Node Suite exports used the display label as the executable node
# type.  Current ComfyUI exposes the same built-in node under this class name.
# Keep the alias here so inspection and API compilation agree on the upgrade.
NODE_TYPE_ALIASES = {
    'Get Image Size': 'GetImageSize',
}


def packages_for_nodes(nodes):
    missing = set(nodes)
    return [name for name, package in NODE_PACKAGES.items() if missing.intersection(package['nodes'])]


def canonical_github_source(value):
    """Return a clone-safe canonical GitHub repository URL, or ``None``.

    Keeping this deliberately narrow prevents catalog values from becoming
    arbitrary git transports, local paths, credential-bearing URLs, or URLs
    whose path means something other than one repository.
    """
    value = str(value or '').strip()
    if not value or '%' in value or '\\' in value:
        return None
    try:
        parsed = urlparse(value)
        if (parsed.scheme != 'https' or parsed.hostname != 'github.com'
                or parsed.username or parsed.password or parsed.port not in (None, 443)
                or parsed.query or parsed.fragment or parsed.params):
            return None
    except ValueError:
        return None
    parts = parsed.path.strip('/').split('/')
    if len(parts) != 2:
        return None
    owner, repository = parts
    if repository.endswith('.git'):
        repository = repository[:-4]
    if not re.fullmatch(r'[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})', owner):
        return None
    if not re.fullmatch(r'[A-Za-z0-9](?:[A-Za-z0-9_.-]{0,99})', repository):
        return None
    if repository in {'.', '..'} or '..' in repository:
        return None
    return f'https://github.com/{owner}/{repository}.git'


def _package_directory_name(source):
    canonical = canonical_github_source(source)
    if not canonical:
        raise ValueError('节点包来源必须是 HTTPS GitHub 仓库')
    owner, repository = urlparse(canonical).path.strip('/').split('/')
    repository = repository[:-4]
    value = f'manager--{owner}--{repository}'
    if len(value) > 150:
        import hashlib
        value = value[:108] + '--' + hashlib.sha256(canonical.casefold().encode()).hexdigest()[:24]
    return value


def validate_node_package(value):
    """Normalize an allow-listed name or a previously verified descriptor."""
    if isinstance(value, str):
        if value not in NODE_PACKAGES:
            raise ValueError('未登记的节点包：' + value)
        value = {'name': value, 'display_name': value, **NODE_PACKAGES[value]}
    if not isinstance(value, dict):
        raise ValueError('节点包描述无效')
    name = str(value.get('name') or '')
    if not PACKAGE_NAME_PATTERN.fullmatch(name):
        raise ValueError('节点包目录名无效：' + name)
    source = canonical_github_source(value.get('source'))
    if not source:
        raise ValueError('节点包来源必须是 HTTPS GitHub 仓库：' + name)
    revision = str(value.get('revision') or '').lower()
    if not REVISION_PATTERN.fullmatch(revision):
        raise ValueError('节点包没有固定到有效提交：' + name)
    nodes = list(dict.fromkeys(str(node) for node in (value.get('nodes') or [])
                              if isinstance(node, str) and node))
    if not nodes or len(nodes) > 5000:
        raise ValueError('节点包的节点清单无效：' + name)
    required = list(dict.fromkeys(str(node) for node in
                                 (value.get('required_nodes') or nodes)
                                 if isinstance(node, str) and node))
    if not required or not set(required).issubset(nodes):
        raise ValueError('节点包的复检清单无效：' + name)
    return {
        'name': name,
        'display_name': str(value.get('display_name') or name)[:160],
        'source': source,
        'revision': revision,
        'nodes': nodes,
        'required_nodes': required,
        'origin': str(value.get('origin') or 'built-in')[:80],
        'git_lfs': bool(value.get('git_lfs')),
        'post_install': str(value.get('post_install') or '')[:1000],
    }


def static_package_plan(nodes):
    """Return pinned descriptors for exact matches in the built-in registry."""
    requested = list(dict.fromkeys(str(node) for node in nodes if isinstance(node, str) and node))
    result = []
    for name in packages_for_nodes(requested):
        package = NODE_PACKAGES[name]
        required = [node for node in requested if node in package['nodes']]
        result.append(validate_node_package({
            'name': name,
            'display_name': name,
            **package,
            'required_nodes': required,
            'origin': '小美画布固定可信清单',
        }))
    return result


def _catalog_index(extension_map, custom_node_list):
    """Build an exact node-to-repository index from the two Manager catalogs."""
    allowed = {}
    records = custom_node_list.get('custom_nodes', []) if isinstance(custom_node_list, dict) else []
    for record in records:
        if not isinstance(record, dict) or record.get('install_type') != 'git-clone':
            continue
        files = record.get('files') or []
        if isinstance(files, str):
            files = [files]
        elif not isinstance(files, list):
            files = []
        values = files + [record.get('reference')]
        for value in values:
            source = canonical_github_source(value)
            if source:
                allowed[source.casefold()] = source
    index, rejected = {}, {}
    for raw_source, record in extension_map.items() if isinstance(extension_map, dict) else []:
        raw_nodes = record[0] if isinstance(record, list) and record and isinstance(record[0], list) else []
        nodes = list(dict.fromkeys(node for node in raw_nodes if isinstance(node, str) and node))
        if not nodes:
            continue
        source = canonical_github_source(raw_source)
        if not source:
            for node in nodes:
                rejected.setdefault(node, set()).add('来源不是安全的 HTTPS GitHub 仓库')
            continue
        source = allowed.get(source.casefold())
        if not source:
            for node in nodes:
                rejected.setdefault(node, set()).add('仓库未同时登记在 ComfyUI-Manager 节点清单')
            continue
        for node in nodes:
            index.setdefault(node, {})[source.casefold()] = source
    return ({node: sorted(sources.values(), key=str.casefold) for node, sources in index.items()},
            {node: sorted(reasons) for node, reasons in rejected.items()})


class NodeSourceResolver:
    """Resolve exact missing node types to commit-pinned Manager repositories."""
    def __init__(self, cache_path, http_get=None, revision_lookup=None, clock=None):
        self.cache_path = Path(cache_path)
        self.http_get = http_get or requests.get
        self.revision_lookup = revision_lookup or self._git_head
        self.clock = clock or time.time
        self.lock = threading.RLock()
        self.cache = None

    def _read_cache(self):
        if self.cache is not None:
            return self.cache
        try:
            value = json.loads(self.cache_path.read_text(encoding='utf-8'))
            if not isinstance(value, dict) or value.get('version') != MANAGER_CACHE_VERSION:
                raise ValueError('cache version')
        except (OSError, ValueError, TypeError, json.JSONDecodeError):
            value = {'version': MANAGER_CACHE_VERSION, 'fetched_at': 0,
                     'nodes': {}, 'rejected': {}, 'revisions': {}}
        self.cache = value
        return value

    def _write_cache(self):
        self.cache_path.parent.mkdir(parents=True, exist_ok=True)
        temporary = self.cache_path.with_name(self.cache_path.name + '.' + uuid.uuid4().hex + '.tmp')
        try:
            temporary.write_text(json.dumps(self.cache, ensure_ascii=False, separators=(',', ':')),
                                 encoding='utf-8')
            temporary.replace(self.cache_path)
        finally:
            temporary.unlink(missing_ok=True)

    def _json(self, url):
        response = self.http_get(url, timeout=(5, 20), headers={'User-Agent': 'Xiaomei-Canvas/ComfyUI-node-resolver'})
        response.raise_for_status()
        return response.json()

    def _catalog(self):
        cache = self._read_cache()
        now = self.clock()
        nodes = cache.get('nodes') if isinstance(cache.get('nodes'), dict) else {}
        try:
            fetched_at = float(cache.get('fetched_at') or 0)
        except (TypeError, ValueError):
            fetched_at = 0
        fresh = bool(nodes) and now - fetched_at < MANAGER_CACHE_TTL
        if fresh:
            return nodes, cache.get('rejected') or {}, {'stale': False, 'error': ''}
        try:
            extension_map = self._json(MANAGER_NODE_MAP_URL)
            custom_node_list = self._json(MANAGER_NODE_LIST_URL)
            nodes, rejected = _catalog_index(extension_map, custom_node_list)
            cache.update({'fetched_at': now, 'nodes': nodes, 'rejected': rejected})
            cache.setdefault('revisions', {})
            self._write_cache()
            return nodes, rejected, {'stale': False, 'error': ''}
        except (OSError, ValueError, TypeError, requests.RequestException) as exc:
            if nodes:
                return nodes, cache.get('rejected') or {}, {
                    'stale': True,
                    'error': '公共节点目录暂时无法更新，已使用本机缓存：' + str(exc),
                }
            return {}, {}, {
                'stale': False,
                'error': '无法读取 ComfyUI-Manager 公共节点目录：' + str(exc),
            }

    @staticmethod
    def _git_head(source):
        flags = subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0
        result = subprocess.run(['git', 'ls-remote', source, 'HEAD'], capture_output=True,
                                text=True, timeout=25, creationflags=flags, check=False)
        if result.returncode:
            raise RuntimeError((result.stderr or result.stdout or 'git ls-remote 失败').strip())
        match = re.search(r'(?m)^([a-fA-F0-9]{40})\s+HEAD\s*$', result.stdout)
        if not match:
            raise RuntimeError('仓库没有返回可固定的 HEAD 提交')
        return match.group(1).lower()

    def _revision(self, source):
        source = canonical_github_source(source)
        if not source:
            raise RuntimeError('公共节点缓存中的仓库地址未通过安全校验')
        cache = self._read_cache()
        revisions = cache.get('revisions')
        if not isinstance(revisions, dict):
            revisions = {}
            cache['revisions'] = revisions
        identity = source.casefold()
        saved = revisions.get(identity) if isinstance(revisions.get(identity), dict) else {}
        old_revision = str(saved.get('revision') or '').lower()
        old_valid = bool(REVISION_PATTERN.fullmatch(old_revision))
        try:
            checked_at = float(saved.get('checked_at') or 0)
        except (TypeError, ValueError):
            checked_at = 0
        fresh = old_valid and self.clock() - checked_at < MANAGER_CACHE_TTL
        if fresh:
            return old_revision, False
        try:
            revision = str(self.revision_lookup(source) or '').lower()
            if not REVISION_PATTERN.fullmatch(revision):
                raise RuntimeError('仓库没有返回有效的 40 位提交')
            revisions[identity] = {'source': source, 'revision': revision, 'checked_at': self.clock()}
            self._write_cache()
            return revision, False
        except (OSError, ValueError, TypeError, RuntimeError, subprocess.SubprocessError) as exc:
            if old_valid:
                return old_revision, True
            raise RuntimeError('无法把仓库固定到提交：' + str(exc)) from exc

    def resolve(self, nodes):
        """Return package descriptors plus an explicit issue for every miss."""
        requested = list(dict.fromkeys(str(node) for node in nodes if isinstance(node, str) and node))
        packages = static_package_plan(requested)
        resolved = {node for package in packages for node in package['required_nodes']}
        remaining = [node for node in requested if node not in resolved]
        result = {'packages': packages, 'resolved_nodes': sorted(resolved), 'issues': {},
                  'catalog': {'stale': False, 'error': ''}}
        if not remaining:
            return result
        with self.lock:
            index, rejected, catalog = self._catalog()
            result['catalog'] = catalog
            by_source = {}
            for node in remaining:
                raw_candidates = index.get(node) if isinstance(index.get(node), list) else []
                candidates = []
                unsafe_cache_value = False
                for candidate in raw_candidates:
                    source = canonical_github_source(candidate)
                    if not source:
                        unsafe_cache_value = True
                        continue
                    if source.casefold() not in {value.casefold() for value in candidates}:
                        candidates.append(source)
                if len(candidates) > 1:
                    result['issues'][node] = {
                        'status': 'ambiguous',
                        'detail': '公共节点目录中有多个精确匹配仓库，未自动选择。',
                        'sources': candidates,
                    }
                elif not candidates:
                    rejected_reasons = rejected.get(node) if isinstance(rejected.get(node), list) else []
                    if unsafe_cache_value:
                        rejected_reasons = list(rejected_reasons) + ['本机缓存中的仓库地址无效']
                    if rejected_reasons:
                        detail = '公共节点目录中的匹配来源未通过安全校验：' + '；'.join(rejected_reasons)
                        status = 'unsafe_source'
                    elif catalog.get('error') and not index:
                        detail = catalog['error']
                        status = 'catalog_unavailable'
                    else:
                        detail = 'ComfyUI-Manager 公共节点目录中没有找到该节点类型的精确来源。'
                        status = 'not_found'
                    result['issues'][node] = {'status': status, 'detail': detail, 'sources': []}
                else:
                    by_source.setdefault(candidates[0], []).append(node)
            for source, matched_nodes in by_source.items():
                try:
                    revision, stale_revision = self._revision(source)
                    descriptor = validate_node_package({
                        'name': _package_directory_name(source),
                        'display_name': urlparse(source).path.strip('/').split('/')[-1][:-4],
                        'source': source,
                        'revision': revision,
                        'nodes': matched_nodes,
                        'required_nodes': matched_nodes,
                        'origin': 'ComfyUI-Manager 公共节点目录',
                    })
                    descriptor['stale_revision'] = stale_revision
                    packages.append(descriptor)
                    resolved.update(matched_nodes)
                except (ValueError, RuntimeError) as exc:
                    for node in matched_nodes:
                        result['issues'][node] = {
                            'status': 'revision_unavailable',
                            'detail': str(exc),
                            'sources': [source],
                        }
            result['resolved_nodes'] = sorted(resolved)
        return result


def frontend_node_available(kind, info, node=None):
    """Return whether a known frontend-only node belongs to a loaded package.

    ComfyUI's ``object_info`` only describes executable Python nodes.  Some
    extensions add virtual canvas nodes in JavaScript instead, so treating
    every absent type as a missing Python package blocks otherwise valid
    workflows.  The package marker check keeps this from hiding a genuinely
    uninstalled extension.
    """
    if NODE_TYPE_ALIASES.get(kind) in info:
        return True
    if kind in {'Fast Groups Bypasser (rgthree)', 'Bookmark (rgthree)', 'Label (rgthree)'}:
        # rgthree's virtual controls are registered by its JS, not object_info.
        return 'Image Comparer (rgthree)' in info
    if kind in {'GetNode', 'SetNode'}:
        properties = node.get('properties') if isinstance(node, dict) else {}
        source = str((properties or {}).get('aux_id') or (properties or {}).get('cnr_id') or '').lower()
        if source and 'kjnodes' not in source:
            return False
        # KJNodes exposes these backend markers while Set/Get themselves stay
        # frontend-only.  If the marker is absent, the package may not have
        # loaded and the workflow should remain blocked for re-check/install.
        return any(marker in info for marker in ('INTConstant', 'ImageTransformKJ', 'SimpleCalculatorKJ'))
    return False
