"""Resolve explicit model links to versioned, individually selected weight files."""
import copy
import re
from pathlib import PurePosixPath
from urllib.parse import parse_qs, parse_qsl, quote, unquote, urlencode, urlparse, urlunparse

import requests


WEIGHT_EXTENSIONS = {'.safetensors', '.gguf', '.sft', '.ckpt', '.pt', '.pth', '.bin', '.onnx'}
MODEL_CATEGORIES = ('checkpoints', 'diffusion_models', 'text_encoders', 'vae', 'loras',
                    'controlnet', 'clip_vision', 'upscale_models', 'embeddings', 'SEEDVR2')
CIVITAI_CATEGORIES = {'Checkpoint': 'checkpoints', 'LORA': 'loras', 'LoCon': 'loras',
                      'VAE': 'vae', 'Controlnet': 'controlnet', 'ControlNet': 'controlnet',
                      'Upscaler': 'upscale_models', 'TextualInversion': 'embeddings',
                      'Diffusion Model': 'diffusion_models'}


def safe_filename(value):
    name = str(value or '')
    if (not name or len(name) > 240 or name != name.strip() or name.endswith('.')
            or re.search(r'[<>:"/\\|?*\x00-\x1f]', name)
            or name in ('.', '..') or name.split('.')[0].upper() in
            {'CON', 'PRN', 'AUX', 'NUL', *(f'COM{i}' for i in range(1, 10)),
             *(f'LPT{i}' for i in range(1, 10))}):
        raise ValueError('模型文件名不能包含路径、控制字符或 Windows 保留名称')
    return name


def model_metadata(version):
    model = version.get('model') or {}
    words = version.get('trainedWords') or []
    images = version.get('images') or []
    cover = next((str(image.get('url') or '') for image in images
                  if isinstance(image, dict) and image.get('nsfwLevel', 1) == 1
                  and urlparse(str(image.get('url') or '')).hostname == 'image.civitai.com'), '')
    model_id, version_id = str(version.get('modelId') or model.get('id') or ''), str(version.get('id') or '')
    source = 'https://civitai.com/models/' + model_id if model_id.isdigit() else ''
    if source and version_id.isdigit():
        source += '?modelVersionId=' + version_id
    return {'display_name': str(model.get('name') or ''), 'version': str(version.get('name') or ''),
            'source_url': source, 'platform': 'civitai', 'base_model': str(version.get('baseModel') or ''),
            'trigger_words': [str(word)[:500] for word in words[:100] if isinstance(word, str)],
            'cover_source': cover, 'model_id': model_id, 'version_id': version_id}


class ModelLinkResolver:
    def __init__(self, settings=lambda: {}):
        self.settings = settings

    def request(self, method, url, **kwargs):
        config = self.settings()
        host = urlparse(url).hostname
        headers = dict(kwargs.pop('headers', {}))
        token = config.get('civitai_key') if host == 'civitai.com' else config.get('hf_token') if host == 'huggingface.co' else ''
        if token:
            headers['Authorization'] = 'Bearer ' + token
        headers.setdefault('User-Agent', 'XiaomeiCanvas/ModelDownloads')
        proxy = config.get('proxy_url')
        if proxy:
            kwargs['proxies'] = {'https': proxy, 'http': proxy}
        kwargs.setdefault('timeout', (8, 25))
        try:
            response = requests.request(method, url, headers=headers, **kwargs)
            response.raise_for_status()
            return response
        except requests.HTTPError as exc:
            status = exc.response.status_code if exc.response is not None else 0
            message = {401: '来源需要账号授权，请在下载设置中填写对应平台的 Key 或 Token 后重试',
                       403: '来源拒绝访问，请检查账号权限、模型授权及代理后重试',
                       404: '来源中没有找到这个模型或版本，请检查链接',
                       429: '来源查询过于频繁，请稍后重试'}.get(status, f'模型来源请求失败（HTTP {status}），请稍后重试')
            raise ValueError(message) from exc
        except requests.RequestException as exc:
            raise ValueError('连接模型来源失败，请检查网络或系统代理后重试，也可以打开来源页面下载') from exc

    def json(self, url, **kwargs):
        response = self.request('GET', url, **kwargs)
        try:
            value = response.json()
            if not isinstance(value, (dict, list)):
                raise ValueError('模型来源返回了无法识别的数据，请稍后重试')
            return value
        finally:
            response.close()

    def resolve(self, value, version=''):
        value = str(value or '').strip()
        if len(value) > 4000:
            raise ValueError('模型链接过长，请复制模型页面地址')
        try:
            parsed = urlparse(value)
            valid = (parsed.scheme == 'https' and not parsed.username and not parsed.password
                     and parsed.port in (None, 443))
        except ValueError:
            valid = False
        if not valid:
            raise ValueError('请使用 Civitai 或 Hugging Face 的 HTTPS 模型链接')
        if parsed.hostname in ('civitai.com', 'civitai.red', 'www.civitai.com', 'www.civitai.red'):
            return self.civitai(parsed, str(version or ''))
        if parsed.hostname == 'huggingface.co':
            return self.huggingface(parsed, str(version or ''))
        raise ValueError('暂支持 Civitai 与 Hugging Face 模型页面或文件链接')

    def civitai(self, parsed, chosen):
        query = parse_qs(parsed.query)
        model = re.fullmatch(r'/models/(\d+)(?:/[^/]*)?/?', parsed.path)
        direct = re.fullmatch(r'/(?:api/download/models|model-versions)/(\d+)/?', parsed.path)
        requested = next(iter(query.get('modelVersionId', [])), '')
        file_id = next(iter(query.get('fileId', [])), '')
        if not model and not direct:
            raise ValueError('请复制 Civitai 模型页、版本页或模型文件下载链接')
        if (chosen and not chosen.isdigit()) or (requested and not requested.isdigit()) or (file_id and not file_id.isdigit()):
            raise ValueError('Civitai 版本或文件标识无效，请重新复制链接')
        model_id = model[1] if model else ''
        if direct:
            original = self.json('https://civitai.com/api/v1/model-versions/' + direct[1])
            model_id = str(original.get('modelId') or '')
            requested = direct[1]
        data = self.json('https://civitai.com/api/v1/models/' + model_id)
        versions = data.get('modelVersions') or []
        selected = chosen or requested or (str(versions[0].get('id') or '') if versions else '')
        summary = next((entry for entry in versions if str(entry.get('id')) == selected), None)
        if not summary:
            raise ValueError('所选版本不属于这个模型或已不可用，请重新选择版本')
        version = self.json('https://civitai.com/api/v1/model-versions/' + selected)
        if str(version.get('modelId') or '') != model_id:
            raise ValueError('来源返回的模型与版本不一致，请重新解析链接')
        version['model'] = {**(version.get('model') or {}), 'name': data.get('name', ''), 'type': data.get('type', '')}
        metadata = model_metadata(version)
        category = CIVITAI_CATEGORIES.get(data.get('type'), 'diffusion_models')
        files = []
        for file in version.get('files') or []:
            name = str(file.get('name') or '')
            if PurePosixPath(name).suffix.lower() not in WEIGHT_EXTENSIONS:
                continue
            if file.get('type') in ('Training Data', 'Config', 'Archive', 'Image'):
                continue
            try:
                safe_filename(name)
            except ValueError:
                continue
            identity = str(file.get('id') or '')
            url = str(file.get('downloadUrl') or '')
            target = urlparse(url)
            if target.hostname in ('civitai.com', 'civitai.red') and target.scheme == 'https' and not target.username and not target.password and target.port in (None, 443) and target.path == '/api/download/models/' + selected:
                selectors = [(key, val) for key, val in parse_qsl(target.query)
                             if key in ('fileId', 'type', 'format', 'size', 'fp')]
                selectors = [(key, val) for key, val in selectors if key != 'fileId']
                if identity.isdigit():
                    selectors.append(('fileId', identity))
                url = 'https://civitai.com' + target.path + ('?' + urlencode(selectors) if selectors else '')
            elif identity.isdigit():
                url = 'https://civitai.com/api/download/models/' + selected + '?fileId=' + identity
            else:
                url = ''
            digest = str((file.get('hashes') or {}).get('SHA256') or '').lower()
            size = round(float(file.get('sizeKB') or 0) * 1024)
            label = ', '.join(str(value) for key, value in (file.get('metadata') or {}).items() if key in ('format', 'fp', 'size') and value)
            eligible = bool(url and re.fullmatch('[a-f0-9]{64}', digest) and size > 0)
            file_category = {'Diffusion Model': 'diffusion_models', 'VAE': 'vae', 'Text Encoder': 'text_encoders',
                             'Negative': 'embeddings'}.get(file.get('type'), category)
            files.append({'name': name, 'category': file_category, 'size_bytes': size, 'sha256': digest,
                          'url': url, 'source': metadata['source_url'], 'metadata': {**metadata, 'file_id': identity},
                          'variant': label, 'eligible': eligible, 'preferred': bool(file_id and identity == file_id),
                          'disabled_reason': '' if eligible else '来源缺少可核验的文件地址、大小或 SHA-256，请到来源页面下载后导入'})
        if file_id and not chosen and not any(file['preferred'] for file in files):
            raise ValueError('链接指定的文件不属于这个版本，已停止解析；请重新复制文件链接')
        return {'platform': 'civitai', 'title': str(data.get('name') or model_id), 'source_url': metadata['source_url'],
                'version': selected, 'versions': [{'id': str(entry['id']), 'name': str(entry.get('name') or entry['id'])}
                                                 for entry in versions if entry.get('id')], 'files': files}

    def huggingface(self, parsed, chosen):
        parts = parsed.path.strip('/').split('/')
        if len(parts) < 2 or any(not re.fullmatch(r'[A-Za-z0-9_.-]+', part) or part in ('.', '..') for part in parts[:2]):
            raise ValueError('请复制 Hugging Face 模型仓库或权重文件链接')
        repo = '/'.join(parts[:2])
        revision, path = 'main', ''
        if len(parts) > 2:
            if parts[2] not in ('blob', 'resolve', 'tree') or len(parts) < 4:
                raise ValueError('Hugging Face 链接需要指向模型仓库、版本目录或文件')
            revision = unquote(parts[3])
            if parts[2] in ('blob', 'resolve'):
                path = unquote('/'.join(parts[4:]))
        revision = chosen or revision
        if not revision or len(revision) > 200 or any(part in ('', '.', '..') for part in revision.split('/')):
            raise ValueError('Hugging Face 版本无效，请重新复制链接')
        endpoint = 'https://huggingface.co/api/models/' + repo
        data = self.json(endpoint + '/revision/' + quote(revision, safe=''), params={'blobs': 'true'})
        commit = str(data.get('sha') or '')
        if not re.fullmatch('[a-f0-9]{40}', commit):
            raise ValueError('无法确认 Hugging Face 仓库版本，请稍后重试')
        versions = [{'id': revision, 'name': revision}]
        try:
            refs = self.json(endpoint + '/refs')
            for ref in (refs.get('tags') or []) + (refs.get('branches') or []):
                name = str(ref.get('name') or '')
                if name and name != revision:
                    versions.append({'id': name, 'name': name})
        except ValueError:
            pass
        card = data.get('cardData') or {}
        cover = str(card.get('thumbnail') or '') if isinstance(card, dict) else ''
        if cover and not urlparse(cover).scheme:
            cover = f'https://huggingface.co/{repo}/resolve/{commit}/' + quote(cover.lstrip('/'), safe='/')
        if urlparse(cover).hostname != 'huggingface.co':
            cover = ''
        metadata = {'display_name': repo, 'version': revision + ' · ' + commit[:8], 'revision': commit,
                    'source_url': f'https://huggingface.co/{repo}/tree/{quote(revision, safe="")}',
                    'platform': 'huggingface', 'cover_source': cover, 'trigger_words': []}
        files = []
        for file in data.get('siblings') or []:
            relative = str(file.get('rfilename') or '')
            if path and relative != path:
                continue
            if PurePosixPath(relative).suffix.lower() not in WEIGHT_EXTENSIONS or '..' in PurePosixPath(relative).parts:
                continue
            name = PurePosixPath(relative).name
            try:
                safe_filename(name)
            except ValueError:
                continue
            lfs = file.get('lfs') or {}
            digest = str(lfs.get('sha256') or '').lower()
            size = int(file.get('size') or lfs.get('size') or 0)
            category = next((part for part in PurePosixPath(relative).parts[:-1] if part in MODEL_CATEGORIES), 'diffusion_models')
            eligible = bool(re.fullmatch('[a-f0-9]{64}', digest) and size > 0)
            files.append({'name': name, 'category': category, 'size_bytes': size, 'sha256': digest,
                          'url': f'https://huggingface.co/{repo}/resolve/{commit}/' + quote(relative, safe='/'),
                          'source': metadata['source_url'], 'metadata': copy.deepcopy(metadata), 'variant': relative,
                          'preferred': bool(path), 'eligible': eligible,
                          'disabled_reason': '' if eligible else '来源没有提供文件大小或 SHA-256，请到来源页面下载后导入'})
        return {'platform': 'huggingface', 'title': repo, 'source_url': metadata['source_url'],
                'version': revision, 'versions': versions[:100], 'files': files}
