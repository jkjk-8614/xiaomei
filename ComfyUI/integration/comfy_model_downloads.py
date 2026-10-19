"""Persistent ComfyUI model transfers and local source metadata."""
import copy
import hashlib
import io
import json
import os
from pathlib import Path
import re
import threading
import time
import uuid
from urllib.parse import parse_qs, urlparse

from PIL import Image

from ComfyUI.integration.comfy_model_links import ModelLinkResolver, MODEL_CATEGORIES, safe_filename, model_metadata


ACTIVE = {'queued', 'downloading', 'verifying', 'retrying', 'pausing', 'cancelling'}
FINISHED = {'succeeded', 'failed', 'cancelled'}


def atomic_json(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_name(path.name + '.' + uuid.uuid4().hex + '.tmp')
    try:
        temp.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding='utf-8')
        if os.name != 'nt':
            temp.chmod(0o600)
        temp.replace(path)
    finally:
        temp.unlink(missing_ok=True)


class TransferStopped(RuntimeError):
    pass


class ModelDownloads:
    def __init__(self, runtime):
        self.runtime = runtime
        self.root = runtime.project / 'ComfyUI' / 'model_downloads'
        self.lock = threading.RLock()
        self.tasks = {}
        self.workers = {}
        self.selections = {}
        self.changed_at = 0
        self.load_error = ''
        self.remote = ModelLinkResolver(self.effective_settings)
        try:
            path = self.root / 'queue.json'
            if path.exists():
                data = json.loads(path.read_text(encoding='utf-8'))
                for task in data['tasks']:
                    if not re.fullmatch('[a-f0-9]{32}', str(task.get('id') or '')):
                        continue
                    self.validate_plan(task['plan'])
                    if task.get('status') in ACTIVE:
                        task.update(status='paused', detail='上次下载已中断，点击继续以断点续传', speed=0)
                    self.tasks[task['id']] = task
        except (OSError, ValueError, KeyError, TypeError):
            self.load_error = '下载记录无法读取，原文件已保留；请检查 model_downloads/queue.json 后重启'

    def stored_settings(self):
        path = self.root / 'settings.json'
        if not path.exists():
            return {}
        try:
            data = json.loads(path.read_text(encoding='utf-8'))
            if not isinstance(data, dict):
                raise ValueError()
            return data
        except (OSError, ValueError):
            raise ValueError('下载设置无法读取，请检查 model_downloads/settings.json；原设置已保留')

    def effective_settings(self):
        data = self.stored_settings()
        return {**data,
                'concurrency': int(data.get('concurrency') or 2),
                'civitai_key': os.environ.get('XIAOMEI_CIVITAI_API_KEY') or os.environ.get('CIVITAI_API_KEY') or data.get('civitai_key', ''),
                'hf_token': os.environ.get('HF_TOKEN') or os.environ.get('HUGGING_FACE_HUB_TOKEN') or data.get('hf_token', ''),
                'proxy_url': data.get('proxy_url', '')}

    def public_settings(self):
        data = self.effective_settings()
        return {'concurrency': data['concurrency'], 'has_civitai_key': bool(data.get('civitai_key')),
                'has_hf_token': bool(data.get('hf_token')), 'has_proxy': bool(data.get('proxy_url')),
                'civitai_from_env': bool(os.environ.get('XIAOMEI_CIVITAI_API_KEY') or os.environ.get('CIVITAI_API_KEY')),
                'hf_from_env': bool(os.environ.get('HF_TOKEN') or os.environ.get('HUGGING_FACE_HUB_TOKEN'))}

    def save_settings(self, payload):
        with self.lock:
            data = self.stored_settings()
            concurrency = payload.get('concurrency', data.get('concurrency', 2))
            if not isinstance(concurrency, int) or isinstance(concurrency, bool) or not 1 <= concurrency <= 4:
                raise ValueError('同时下载数量需为 1–4')
            data['concurrency'] = concurrency
            for key in ('civitai_key', 'hf_token', 'proxy_url'):
                if key not in payload:
                    continue
                value = payload[key]
                if not isinstance(value, str) or len(value) > 4000 or re.search(r'[\r\n\x00]', value):
                    raise ValueError('下载账号或代理设置无效，请重新填写')
                data[key] = value.strip()
            if data.get('proxy_url'):
                try:
                    proxy = urlparse(data['proxy_url'])
                    valid = proxy.scheme in ('http', 'https') and proxy.hostname and proxy.port and not proxy.query and not proxy.fragment
                except ValueError:
                    valid = False
                if not valid:
                    raise ValueError('代理地址需为 http://地址:端口 或 https://地址:端口')
            atomic_json(self.root / 'settings.json', data)
            self._dispatch()
            return self.public_settings()

    def validate_plan(self, plan):
        safe_filename(plan.get('name'))
        if plan.get('category') not in (*MODEL_CATEGORIES, 'models'):
            raise ValueError('模型目录无效，请选择对应的 ComfyUI 模型目录')
        target = urlparse(str(plan.get('url') or ''))
        if (target.scheme != 'https' or target.hostname not in ('huggingface.co', 'www.huggingface.co', 'civitai.com')
                or target.username or target.password or target.port not in (None, 443)):
            raise ValueError('模型下载地址无效，请重新解析来源链接')
        root = (self.runtime.base / 'models').resolve()
        path = root / plan['category'] / plan['name']
        try:
            path.resolve().relative_to(root)
        except ValueError:
            raise ValueError('模型目录指向了配置范围以外的位置，请检查目录链接')
        return path

    def resolve(self, url, version=''):
        result = self.remote.resolve(url, version)
        with self.lock:
            now = time.time()
            self.selections = {key: value for key, value in self.selections.items() if now - value['at'] < 3600}
            for file in result['files']:
                identity = uuid.uuid4().hex
                if file['eligible']:
                    self.selections[identity] = {'at': now, 'plan': copy.deepcopy(file)}
                file['selection_id'] = identity
                file.pop('url', None)
                file.pop('metadata', None)
            return result

    def enqueue_selected(self, selections):
        if not isinstance(selections, list) or not 1 <= len(selections) <= 100:
            raise ValueError('请选择 1–100 个模型文件')
        plans = []
        destinations = {}
        with self.lock:
            for selection in selections:
                if not isinstance(selection, dict):
                    raise ValueError('文件选择无效，请重新解析链接')
                record = self.selections.get(selection.get('selection_id'))
                if not record or time.time() - record['at'] >= 3600:
                    raise ValueError('文件选择已过期，请重新解析链接')
                category = selection.get('category')
                if category not in MODEL_CATEGORIES:
                    raise ValueError('请选择有效的 ComfyUI 模型目录')
                plan = {**copy.deepcopy(record['plan']), 'category': category}
                destination = self.validate_plan(plan)
                key = str(destination).casefold()
                previous = destinations.get(key)
                if previous and previous.get('sha256') != plan.get('sha256'):
                    raise ValueError('所选文件包含同名的不同版本，请分别选择目录或一次只下载其中一个')
                for task in self.tasks.values():
                    if (str(task.get('destination') or '').casefold() == key and task['status'] not in FINISHED
                            and task['plan'].get('sha256') != plan.get('sha256') and task['plan']['url'] != plan['url']):
                        raise ValueError('同一模型文件已有其他版本的下载任务，请先处理该任务后重新选择')
                destinations[key] = plan
                plans.append(plan)
            result = [self.enqueue(plan)[0] for plan in plans]
            return {'tasks': result}

    def _save(self):
        if self.load_error:
            raise ValueError(self.load_error)
        atomic_json(self.root / 'queue.json', {'version': 1, 'tasks': list(self.tasks.values())})
        self.changed_at = time.monotonic()

    def enqueue(self, plan, origin='链接下载'):
        plan = copy.deepcopy(plan)
        destination = self.validate_plan(plan)
        with self.lock:
            if self.load_error:
                raise ValueError(self.load_error)
            for task in self.tasks.values():
                other = task['plan']
                same_path = (str(task.get('destination') or '').casefold() == str(destination).casefold())
                same_content = (other.get('sha256') and other.get('sha256') == plan.get('sha256')) or other['url'] == plan['url']
                if same_path and task['status'] not in FINISHED:
                    if not same_content:
                        raise ValueError('同一模型文件已有其他版本的下载任务，请先取消该任务后重新选择')
                    return self.public_task(task), False
                if same_path and same_content and task['status'] == 'succeeded' and destination.is_file():
                    return self.public_task(task), False
            identity = uuid.uuid4().hex
            task = {'id': identity, 'plan': plan, 'destination': str(destination), 'origin': origin,
                    'created_at': time.time(), 'updated_at': time.time(), 'status': 'queued',
                    'downloaded': 0, 'total': int(plan.get('size_bytes') or 0), 'speed': 0,
                    'progress': 0, 'detail': '等待下载', 'error': '', 'verification': ''}
            self.tasks[identity] = task
            self._save()
            self._dispatch()
            return self.public_task(task), True

    def public_task(self, task):
        plan = task['plan']
        return {**{key: task.get(key) for key in ('id', 'status', 'downloaded', 'total', 'speed', 'progress',
                                                'detail', 'error', 'origin', 'created_at', 'updated_at', 'verification')},
                'name': plan['name'], 'category': plan['category'], 'destination': task.get('destination', ''),
                'source_url': (plan.get('metadata') or {}).get('source_url') or plan.get('source', ''),
                'version': (plan.get('metadata') or {}).get('version', '')}

    def snapshot(self):
        with self.lock:
            return {'tasks': [self.public_task(task) for task in reversed(list(self.tasks.values()))],
                    'warning': self.load_error, 'concurrency': self.effective_settings()['concurrency']}

    def _update(self, identity, **values):
        with self.lock:
            task = self.tasks[identity]
            # A progress callback cannot undo a pause/cancel already requested by the user.
            if task['status'] in ('pausing', 'cancelling') and values.get('status') in ACTIVE:
                values.pop('status', None)
            task.update(values, updated_at=time.time())
            if time.monotonic() - self.changed_at >= 1 or values.get('status') in FINISHED | {'paused'}:
                self._save()

    def _dispatch(self):
        limit = self.effective_settings()['concurrency']
        destinations = {str(self.tasks[identity].get('destination') or '').casefold() for identity in self.workers}
        for identity, task in self.tasks.items():
            if len(self.workers) >= limit:
                break
            destination = str(task.get('destination') or '').casefold()
            if task['status'] != 'queued' or identity in self.workers or destination in destinations:
                continue
            worker = {'stop': threading.Event(), 'action': ''}
            self.workers[identity] = worker
            destinations.add(destination)
            threading.Thread(target=self._run, args=(identity, worker), daemon=True,
                             name='comfy-model-' + identity[:8]).start()

    def action(self, identity, action, restart=False):
        with self.lock:
            task = self.tasks.get(identity)
            if not task:
                raise ValueError('下载任务不存在，请刷新列表')
            worker = self.workers.get(identity)
            status = task['status']
            if action == 'pause' and status in ACTIVE:
                if worker:
                    worker.update(action='pause')
                    worker['stop'].set()
                    task.update(status='pausing', detail='正在暂停并保存下载位置', speed=0)
                else:
                    task.update(status='paused', detail='已暂停，点击继续可断点续传', speed=0)
            elif action == 'cancel' and status not in ('succeeded', 'cancelled'):
                if worker:
                    worker.update(action='cancel')
                    worker['stop'].set()
                    task.update(status='cancelling', detail='正在取消下载', speed=0)
                else:
                    task.update(status='cancelled', detail='已取消，模型文件和断点保留', speed=0)
            elif action in ('resume', 'retry') and status in ('paused', 'failed', 'cancelled') and not worker:
                destination = self.validate_plan(task['plan'])
                if any(other['id'] != identity
                       and str(other.get('destination') or '').casefold() == str(destination).casefold()
                       and (other['status'] not in FINISHED or other['id'] in self.workers)
                       for other in self.tasks.values()):
                    raise ValueError('同一模型文件已有其他下载任务，请先处理该任务后重试')
                if restart:
                    self.runtime.model_download_partial(task['plan']).unlink(missing_ok=True)
                task.update(status='queued', error='', detail='等待继续下载', speed=0)
                if restart:
                    task.update(downloaded=0, progress=0)
            else:
                raise ValueError('当前状态不能执行此操作，请刷新下载列表')
            task['updated_at'] = time.time()
            self._save()
            self._dispatch()
            return self.public_task(task)

    def _run(self, identity, worker):
        task = self.tasks[identity]
        plan = task['plan']
        def check():
            if worker['stop'].is_set():
                raise TransferStopped('下载已暂停' if worker['action'] == 'pause' else '下载已取消')
        def progress(value, detail):
            self._update(identity, progress=value, detail=detail)
        def transfer(values):
            self._update(identity, **values)
        try:
            self._update(identity, status='downloading', error='', detail='正在连接下载来源')
            options = self.remote.settings()
            headers = {}
            host = urlparse(plan['url']).hostname
            token = options.get('civitai_key') if host == 'civitai.com' else options.get('hf_token')
            if token:
                headers['Authorization'] = 'Bearer ' + token
            request_options = {'headers': headers}
            if options.get('proxy_url'):
                request_options['proxies'] = {'http': options['proxy_url'], 'https': options['proxy_url']}
            self.root.mkdir(parents=True, exist_ok=True)
            self.runtime._download_model_direct(plan, self.root / 'transfers.log', progress,
                                                control=check, transfer_progress=transfer, request_options=request_options)
            check()
            destination = self.validate_plan(plan)
            metadata = {**(plan.get('metadata') or {}), 'source_url': (plan.get('metadata') or {}).get('source_url') or plan.get('source', ''),
                        'sha256': plan.get('sha256', ''), 'filename': plan['name']}
            self.save_metadata(destination, metadata)
            try:
                self.cache_cover(destination, metadata)
            except (OSError, ValueError):
                pass
            self._update(identity, status='succeeded', progress=100, downloaded=destination.stat().st_size,
                         speed=0, detail='下载完成，模型已写入对应目录', error='',
                         verification='sha256' if plan.get('sha256') else 'size' if self.tasks[identity]['total'] else 'none')
        except TransferStopped:
            paused = worker['action'] == 'pause'
            self._update(identity, status='paused' if paused else 'cancelled', speed=0,
                         detail='已暂停，点击继续可断点续传' if paused else '已取消，已下载文件与断点保留')
        except Exception as exc:
            message = str(exc)
            for secret in ('civitai_key', 'hf_token', 'proxy_url'):
                value = self.effective_settings().get(secret)
                if value:
                    message = message.replace(value, '[已隐藏]')
            self._update(identity, status='failed', speed=0, detail='下载失败，可重试或打开来源页面', error=message[:1000])
        finally:
            with self.lock:
                self.workers.pop(identity, None)
                self._dispatch()

    def wait_for_download(self, plan, log, report_progress, cancel):
        task, created = self.enqueue(plan, '工作流自动补齐')
        last = None
        while True:
            if cancel.wait(.2):
                if created and task['id'] in self.tasks and self.tasks[task['id']]['status'] not in FINISHED:
                    self.action(task['id'], 'cancel')
                raise RuntimeError('准备已取消；已下载文件和断点保留')
            with self.lock:
                current = self.public_task(self.tasks[task['id']])
            state = (current['status'], current['progress'], current['detail'])
            if state != last and report_progress:
                report_progress(current['progress'], current['detail'] + '：' + current['name'])
                last = state
            if current['status'] == 'succeeded':
                return
            if current['status'] in ('failed', 'cancelled'):
                raise RuntimeError(current['error'] or current['detail'])

    @staticmethod
    def metadata_key(path):
        return hashlib.sha256(str(Path(path).resolve()).casefold().encode('utf-8')).hexdigest()

    def _metadata_records(self):
        path = self.root / 'metadata.json'
        if not path.exists():
            return {}
        try:
            data = json.loads(path.read_text(encoding='utf-8'))
            if not isinstance(data, dict):
                raise ValueError()
            return data
        except (OSError, ValueError):
            raise ValueError('模型资料文件无法读取，原文件已保留，请检查 model_downloads/metadata.json')

    def read_metadata(self, path, records=None):
        path = Path(path)
        with self.lock:
            records = records if records is not None else self._metadata_records()
            result = copy.deepcopy(records.get(self.metadata_key(path), {}))
        if result:
            return result
        for sidecar in (path.with_suffix('.civitai.info'), path.with_suffix('.info.json')):
            if sidecar.is_file() and not sidecar.is_symlink() and sidecar.stat().st_size < 2 * 1024 * 1024:
                try:
                    data = json.loads(sidecar.read_text(encoding='utf-8'))
                    result = model_metadata(data)
                    if result.get('source_url'):
                        return result
                except (OSError, ValueError, TypeError, AttributeError):
                    continue
        return {}

    def save_metadata(self, path, metadata):
        with self.lock:
            records = self._metadata_records()
            key = self.metadata_key(path)
            records[key] = {**records.get(key, {}), **metadata, 'updated_at': time.time()}
            atomic_json(self.root / 'metadata.json', records)
            return records[key]

    def edit_metadata(self, path, payload):
        result = {}
        for key in ('display_name', 'version', 'source_url'):
            if key in payload:
                value = payload[key]
                if not isinstance(value, str) or len(value) > (4000 if key == 'source_url' else 240):
                    raise ValueError('模型名称、版本或来源地址过长，请缩短后保存')
                if key == 'source_url' and value:
                    source = urlparse(value)
                    if source.scheme != 'https' or source.hostname not in ('civitai.com', 'civitai.red', 'huggingface.co') or source.username or source.password:
                        raise ValueError('来源需为 Civitai 或 Hugging Face HTTPS 页面地址')
                    if any(key.lower() in ('token', 'key', 'apikey', 'api_key') for key in parse_qs(source.query)):
                        raise ValueError('来源页面地址不能包含账号密钥，请移除后再保存')
                result[key] = value.strip()
        if 'trigger_words' in payload:
            words = payload['trigger_words']
            if not isinstance(words, list) or len(words) > 100 or any(not isinstance(word, str) or len(word) > 500 for word in words):
                raise ValueError('触发词需为文字列表，最多保存 100 条')
            result['trigger_words'] = list(dict.fromkeys(word.strip() for word in words if word.strip()))
        return self.save_metadata(path, result)

    def cover_path(self, path):
        return self.root / 'covers' / (self.metadata_key(path) + '.jpg')

    def cache_cover(self, path, metadata):
        url = str(metadata.get('cover_source') or '')
        parsed = urlparse(url)
        if parsed.scheme != 'https' or parsed.hostname not in ('image.civitai.com', 'huggingface.co') or parsed.username or parsed.password or parsed.port not in (None, 443):
            return
        response = self.remote.request('GET', url, stream=True)
        try:
            data = bytearray()
            for block in response.iter_content(64 * 1024):
                data.extend(block)
                if len(data) > 12 * 1024 * 1024:
                    raise ValueError('封面文件过大，已跳过保存')
            with Image.open(io.BytesIO(data)) as image:
                image.thumbnail((480, 480))
                destination = self.cover_path(path)
                destination.parent.mkdir(parents=True, exist_ok=True)
                temp = destination.with_suffix('.tmp')
                image.convert('RGB').save(temp, format='JPEG', quality=86)
                temp.replace(destination)
        finally:
            response.close()

    def identify(self, path):
        path = Path(path)
        initial = path.stat()
        digest = hashlib.sha256()
        with path.open('rb') as source:
            for block in iter(lambda: source.read(8 * 1024 * 1024), b''):
                digest.update(block)
        if path.stat().st_size != initial.st_size or path.stat().st_mtime_ns != initial.st_mtime_ns:
            raise ValueError('识别期间模型文件发生变化，请刷新后重试')
        version = self.remote.json('https://civitai.com/api/v1/model-versions/by-hash/' + digest.hexdigest())
        matching = [file for file in version.get('files') or []
                    if str((file.get('hashes') or {}).get('SHA256') or '').lower() == digest.hexdigest()]
        if not matching:
            raise ValueError('来源未返回与当前文件校验值一致的记录，未关联模型资料')
        metadata = model_metadata(version)
        if not metadata.get('display_name') and version.get('modelId'):
            model = self.remote.json('https://civitai.com/api/v1/models/' + str(version['modelId']))
            metadata['display_name'] = str(model.get('name') or '')
        result = self.save_metadata(path, {**metadata, 'sha256': digest.hexdigest(), 'filename': path.name})
        try:
            self.cache_cover(path, result)
        except (OSError, ValueError):
            pass
        return result
