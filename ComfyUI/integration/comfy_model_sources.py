"""Resolve missing weights from public catalogs; never execute page/workflow instructions."""
import re
import time
import xml.etree.ElementTree as ET
from pathlib import PurePosixPath
from urllib.parse import quote, unquote, urlparse
import requests

CATEGORIES = {'checkpoints', 'diffusion_models', 'text_encoders', 'vae', 'loras', 'controlnet', 'clip_vision', 'upscale_models', 'SEEDVR2'}
CATALOG_URL = 'https://raw.githubusercontent.com/Comfy-Org/ComfyUI-Manager/main/model-list.json'
GENERIC_NAMES = {'model.safetensors', 'lora.safetensors', 'diffusion_pytorch_model.safetensors', 'pytorch_model.bin', 'model.gguf'}


def basename(name):
    return PurePosixPath(str(name).replace('\\', '/')).name


def public_url(url, hosts):
    try:
        p = urlparse(str(url))
        return p.scheme == 'https' and p.hostname in hosts and not p.username and not p.password and p.port in (None, 443)
    except ValueError:
        return False


class ModelSourceResolver:
    def __init__(self, cancel, progress=lambda message: None):
        self.cancel = cancel
        self.progress = progress
        self.catalog = None

    def check(self):
        if self.cancel.is_set():
            raise RuntimeError('模型搜索已取消，已下载文件保留')
        if time.monotonic() >= self.deadline:
            raise TimeoutError('本次模型搜索达到时间上限，可点击重试')

    def request(self, method, url, **kwargs):
        self.check()
        remaining = max(1, min(12, self.deadline - time.monotonic()))
        response = requests.request(method, url, timeout=(min(5, remaining), remaining), **kwargs)
        response.raise_for_status()
        return response

    def attempt(self, label, callback):
        self.progress(f'寻找模型：{self.name} · {label}')
        self.searched.append(label)
        try:
            return callback()
        except (requests.RequestException, ValueError, KeyError, TypeError, TimeoutError, ET.ParseError) as exc:
            status = getattr(getattr(exc, 'response', None), 'status_code', None)
            reason = {401: '需要登录后才能查询或下载', 403: '来源拒绝访问或需要授权',
                      429: '查询限流，请稍后重试', 404: '未找到对应记录'}.get(status)
            reason = reason or ('连接超时，请稍后重试' if isinstance(exc, (requests.Timeout, TimeoutError))
                                else f'HTTP {status}' if status else '查询失败，请稍后重试')
            self.errors.append({'source': label, 'reason': reason})
            return None

    def link(self, url, label):
        if public_url(url, {'huggingface.co', 'civitai.com', 'www.runninghub.cn', 'www.runninghub.ai', 'github.com', 'modelscope.cn', 'www.liblib.art'}):
            if not any(x['url'] == url for x in self.links):
                self.links.append({'url': url, 'label': label})

    def add(self, url, sha256, size, source, file_name, category=None, explicit=False):
        if PurePosixPath(str(file_name)).suffix.lower() != PurePosixPath(self.name).suffix.lower():
            return
        digest = str(sha256 or '').lower()
        if not re.fullmatch(r'[a-f0-9]{64}', digest):
            return
        if self.expected_hash and digest != self.expected_hash:
            return
        if basename(file_name).casefold() != self.name.casefold() and not self.expected_hash:
            return
        if category and category != self.category:
            return
        if not self.expected_hash and not explicit and self.name.casefold() in GENERIC_NAMES:
            return
        if not public_url(url, {'huggingface.co', 'civitai.com'}):
            return
        size = int(size or 0)
        if size <= 0:
            return
        self.candidates.append({'name': self.name, 'category': self.category, 'url': url,
            'sha256': digest, 'size_bytes': size, 'source': source,
            'size_note': f'{size / 1024**3:.2f} GiB；下载后校验 SHA-256', 'discovered': True})

    def huggingface(self, url, explicit=False):
        if not public_url(url, {'huggingface.co'}):
            return
        parts = unquote(urlparse(url).path).strip('/').split('/')
        if len(parts) < 2 or any(x in ('', '.', '..') for x in parts):
            return
        repo = '/'.join(parts[:2])
        if repo in self.hf_seen or len(self.hf_seen) >= 8:
            return
        self.hf_seen.add(repo)
        revision = parts[3] if len(parts) > 4 and parts[2] in ('resolve', 'blob') else None
        endpoint = 'https://huggingface.co/api/models/' + quote(repo, safe='/')
        if revision:
            endpoint += '/revision/' + quote(revision, safe='')
        data = self.request('GET', endpoint, params={'blobs': 'true'}).json()
        source = 'https://huggingface.co/' + repo
        self.link(source, 'Hugging Face：' + repo)
        if data.get('gated') or data.get('private'):
            self.errors.append({'source': source, 'reason': '需要登录或接受模型条款'})
            return
        commit = data.get('sha', '')
        if not re.fullmatch('[a-f0-9]{40}', commit):
            return
        target_path = '/'.join(parts[4:]) if revision else None
        for file in data.get('siblings', []):
            filename = str(file.get('rfilename', ''))
            if target_path and filename != target_path:
                continue
            if basename(filename).casefold() != self.name.casefold() and not self.expected_hash:
                continue
            lfs = file.get('lfs') or {}
            category = next((c for c in CATEGORIES if c in filename.split('/')[:-1]), None)
            download = f'https://huggingface.co/{repo}/resolve/{commit}/' + quote(filename, safe='/')
            self.add(download, lfs.get('sha256'), file.get('size') or lfs.get('size'), source, filename, category, explicit)

    def civitai_version(self, data):
        model = data.get('model') or {}
        model_type = model.get('type', '')
        category = {'LORA': 'loras', 'LoCon': 'loras', 'Checkpoint': 'checkpoints', 'VAE': 'vae', 'Controlnet': 'controlnet', 'Upscaler': 'upscale_models'}.get(model_type)
        source = 'https://civitai.com/models/' + str(data.get('modelId', ''))
        self.link(source, 'Civitai：' + str(data.get('name', self.name)))
        if data.get('earlyAccessEndsAt') and not data.get('availability') == 'Public':
            return
        for file in data.get('files', []):
            if file.get('type') != 'Model' or not str(file.get('name', '')).lower().endswith(('.safetensors', '.gguf')):
                continue
            self.add(file.get('downloadUrl', ''), (file.get('hashes') or {}).get('SHA256'), round(float(file.get('sizeKB') or 0)*1024), source, file.get('name'), category)

    def runninghub(self):
        data = self.request('POST', 'https://www.runninghub.cn/api/portal/model/list', json={
            'size': 50, 'current': 1, 'search': self.name.rsplit('.', 1)[0], 'tags': None,
            'sort': 'RECOMMEND', 'resourceType': '', 'baseModels': [], 'systemResource': None}).json()
        if data.get('code') != 0:
            raise ValueError('RunningHub 查询未成功')
        for record in (data.get('data') or {}).get('records', []):
            matches = [v for v in record.get('versions', []) if basename(v.get('resourceStorageName')).casefold() == self.name.casefold()]
            if not matches:
                continue
            identity = str(record.get('id', ''))
            if not identity.isdigit():
                continue
            source = 'https://www.runninghub.cn/model/public/' + identity
            self.link(source, 'RunningHub：' + self.name)
            if not self.expected_hash:
                detail = self.request('POST', 'https://www.runninghub.cn/api/portal/model/detail', json={'resourceId': identity}).json()
                if detail.get('code') != 0:
                    raise ValueError('RunningHub 模型详情查询未成功')
                hashes = {v.get('sha256') for v in (detail.get('data') or {}).get('versions', [])
                          if basename(v.get('resourceStorageName')).casefold() == self.name.casefold() and re.fullmatch('[a-fA-F0-9]{64}', str(v.get('sha256') or ''))}
                if len(hashes) == 1:
                    self.expected_hash = hashes.pop().lower()
            break

    def manager(self):
        if self.catalog is None:
            self.catalog = self.request('GET', CATALOG_URL).json().get('models', [])
        for model in self.catalog:
            if basename(model.get('filename')).casefold() != self.name.casefold():
                continue
            path = str(model.get('save_path') or '')
            if path in CATEGORIES and path != self.category:
                continue
            url = model.get('url', '')
            self.link(model.get('reference', ''), 'ComfyUI 模型目录：' + self.name)
            if public_url(url, {'huggingface.co'}):
                self.huggingface(url, explicit=True)
            elif public_url(url, {'civitai.com'}):
                match = re.fullmatch(r'/api/download/models/(\d+)', urlparse(url).path)
                if match:
                    self.civitai_version(self.request('GET', 'https://civitai.com/api/v1/model-versions/' + match[1]).json())

    def web_search(self):
        response = self.request('GET', 'https://www.bing.com/search', params={'format': 'rss', 'q': '"' + self.name + '"'})
        root = ET.fromstring(response.content)
        for item in root.findall('./channel/item')[:10]:
            url = item.findtext('link', '')
            title = item.findtext('title', '')
            self.link(url, title[:150])
            if public_url(url, {'huggingface.co'}):
                self.attempt('网页中的 Hugging Face 来源', lambda: self.huggingface(url))

    def hf_search(self):
        term = self.name.rsplit('.', 1)[0]
        terms = list(dict.fromkeys([term, re.split(r'[_\-]', term)[0]]))
        for term in terms:
            if len(term) < 3:
                continue
            repos = self.request('GET', 'https://huggingface.co/api/models', params={'search': term, 'limit': 5}).json()
            for repo in repos if isinstance(repos, list) else []:
                self.attempt('Hugging Face 文件核验', lambda: self.huggingface('https://huggingface.co/' + repo['id']))
            if self.candidates:
                break

    def civitai_search(self):
        if self.expected_hash:
            try:
                data = self.request('GET', 'https://civitai.com/api/v1/model-versions/by-hash/' + self.expected_hash).json()
            except requests.HTTPError as exc:
                if exc.response is not None and exc.response.status_code == 404:
                    return
                raise
            self.civitai_version(data)
        else:
            data = self.request('GET', 'https://civitai.com/api/v1/models', params={'query': self.name.rsplit('.', 1)[0], 'limit': 5, 'nsfw': 'false'}).json()
            for model in data.get('items', []):
                for version in model.get('modelVersions', []):
                    self.civitai_version({**version, 'modelId': model.get('id'), 'model': {'type': model.get('type')}})

    def resolve(self, requirement, known=None):
        self.name = basename(requirement.get('name', ''))
        self.category = requirement.get('category')
        self.deadline = time.monotonic() + 90
        self.expected_hash = str((known or {}).get('sha256') or requirement.get('sha256') or '').lower()
        if not re.fullmatch('[a-f0-9]{64}', self.expected_hash):
            self.expected_hash = ''
        self.candidates, self.links, self.errors, self.searched, self.hf_seen = [], [], [], [], set()
        if self.category not in CATEGORIES or not self.name.lower().endswith(('.safetensors', '.gguf')):
            return {'status': 'manual', 'detail': '该目录或文件格式暂不支持自动寻找下载，需从原作者取得后导入。', 'links': []}
        source = str(requirement.get('source') or (known or {}).get('source') or '')
        if source:
            self.link(source, '工作流模型来源')
            self.attempt('工作流自带来源', lambda: self.huggingface(source, explicit=True))
        if not self.candidates:
            self.attempt('ComfyUI 模型目录', self.manager)
        if not self.candidates:
            self.attempt('RunningHub 同名模型', self.runninghub)
            self.attempt('Civitai 校验与搜索', self.civitai_search)
            self.attempt('公开网页搜索', self.web_search)
            self.attempt('Hugging Face 模型搜索', self.hf_search)
        self.check_cancel_only()
        candidates = [x for x in self.candidates if not self.expected_hash or x['sha256'] == self.expected_hash]
        hashes = {x['sha256'] for x in candidates}
        result = {'checked_at': time.time(), 'searched': self.searched, 'links': self.links,
                  'errors': self.errors, 'sha256': self.expected_hash, 'candidates': candidates}
        if len(hashes) == 1:
            result.update(status='resolved', detail='已找到匹配文件，下载后会校验 SHA-256。', download=candidates[0])
        elif hashes:
            result.update(status='ambiguous', detail='找到多个同名但内容不同的模型；请确认原作者版本后导入，未自动替换。')
        else:
            detail = '找到来源页面，但尚未取得可核验的公开下载文件。' if self.links else '本次未找到可核验的下载文件。'
            if self.errors:
                detail += '部分来源查询失败，可重试或打开来源页面。'
            result.update(status='not_found', detail=detail)
        return result

    def check_cancel_only(self):
        if self.cancel.is_set():
            raise RuntimeError('模型搜索已取消，已下载文件保留')
