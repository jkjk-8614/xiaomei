"""Managed, isolated ComfyUI instance. Never installs into the existing venv."""
import hashlib
import json
import logging
import os
import re
from pathlib import Path
import shutil
import subprocess
import threading
import time
from urllib.parse import urlparse

import requests
from ComfyUI.integration.comfy_node_registry import (
    NODE_PACKAGES,
    canonical_github_source,
    frontend_node_available,
    validate_node_package,
)

SOURCE = 'https://github.com/jtydhr88/ComfyUI-See-through.git'
REVISION = '98d754bf04f668647919ab750eccb0e0640faa81'
MODELS = ('layerdifforg/seethroughv0.0.2_layerdiff3d', 'layerdifforg/seethroughv0.0.1_marigold')
RUNTIME_DIR_NAME = 'comfy_apps_runtime'


class ManagedRuntime:
    def __init__(self, root):
        self.project = Path(root)
        # Keep the managed runtime inside the project's ComfyUI workspace while
        # retaining its isolated Python environment and app-specific nodes.
        self.root = self.project / 'ComfyUI' / RUNTIME_DIR_NAME
        self.output = self.project / 'ComfyUI' / 'output'
        project_base = self.project / 'ComfyUI'
        default_base = project_base if project_base.is_dir() else Path.home() / 'Documents' / 'ComfyUI'
        self.base = Path(os.environ.get('XIAOMEI_COMFY_BASE', str(default_base)))
        self.address = '127.0.0.1:8190'
        self.cancel = threading.Event()
        self.process = None
        self.guard = threading.Lock()

    def _startup_inventory(self):
        """Include disabled branches and original graphs used by the native editor."""
        def node_types(value):
            if isinstance(value, dict):
                if isinstance(value.get('class_type'), str):
                    yield value['class_type']
                if isinstance(value.get('nodes'), list):
                    for node in value['nodes']:
                        if isinstance(node, dict) and isinstance(node.get('type'), str):
                            yield node['type']
                for child in value.values():
                    yield from node_types(child)
            elif isinstance(value, list):
                for child in value:
                    yield from node_types(child)

        paths = set((self.project / 'ComfyUI' / 'workflows').rglob('*.json'))
        paths.update((self.project / 'ComfyUI' / 'comfy_apps').glob('*/app.json'))
        for user in (self.root / 'user', self.base / 'user', self.base / 'core' / 'user'):
            paths.update(path for path in user.rglob('*.json')
                         if 'workflows' in path.relative_to(user).parts)
        workflows = {}
        for path in sorted(paths):
            if path.name.endswith('.config.json'):
                continue
            value = json.loads(path.read_text(encoding='utf-8-sig'))
            if not isinstance(value, dict):
                raise ValueError('工作流不是 JSON 对象：' + str(path))
            workflows[str(path.resolve())] = sorted(set(node_types(value)))
        custom = self.root / 'custom_nodes'
        packages = sorted(path.name for path in custom.iterdir()
                          if not path.name.startswith('.') and not path.name.endswith('.disabled')
                          and ((path.is_dir() and path.name != '__pycache__')
                               or path.suffix == '.py')) if custom.exists() else []
        return {'workflows': workflows, 'packages': packages}

    def audit_startup_nodes(self, info, candidates):
        """Audit explicit candidates against a full, unfiltered object_info snapshot.

        Returns a local startup profile; the caller saves it only after reviewing
        missing nodes and validating the selected packages on a test backend.
        """
        inventory = self._startup_inventory()
        used = {node for nodes in inventory['workflows'].values() for node in nodes}
        skipped = []
        referenced = {}
        provided_nodes = {}
        for name in candidates:
            if name not in inventory['packages'] or name == 'xiaomei_app_bridge':
                continue
            provided = {node for node, detail in info.items()
                        if detail.get('python_module') == 'custom_nodes.' + name}
            if not provided:
                raise ValueError('无法核验节点包的完整节点清单：' + name)
            provided.update(NODE_PACKAGES.get(name, {}).get('nodes', []))
            provided_nodes[name] = sorted(provided)
            referenced[name] = sorted(used & provided)
            if not referenced[name]:
                skipped.append(name)
        return {'version': 1, **inventory, 'skipped': sorted(skipped),
                'references': referenced, 'provided_nodes': provided_nodes,
                'unavailable_nodes': sorted(used - set(info))}

    def _packages_to_install(self, packages):
        """Re-enable audited installed nodes without downloading their code again."""
        packages = [validate_node_package(package) for package in packages]
        try:
            profile = json.loads((self.root / 'startup-nodes.json').read_text(encoding='utf-8'))
            skipped = profile['skipped'] if profile.get('version') == 1 else []
            provided = profile['provided_nodes']
            return [package for package in packages
                    if not (package['name'] in skipped
                            and (self.root / 'custom_nodes' / package['name']).is_dir()
                            and set(package['required_nodes']).issubset(provided.get(package['name'], [])))]
        except (OSError, ValueError, TypeError, KeyError, AttributeError):
            return packages

    def _startup_node_args(self):
        profile_path = self.root / 'startup-nodes.json'
        if not profile_path.exists():
            return []
        try:
            profile = json.loads(profile_path.read_text(encoding='utf-8'))
            inventory = self._startup_inventory()
            if (profile.get('version') != 1 or
                    any(profile.get(key) != value for key, value in inventory.items())):
                logging.info('ComfyUI 工作流或节点目录已变化，使用完整节点加载')
                return []
            skipped = profile['skipped']
            if (not isinstance(skipped, list) or not all(isinstance(name, str) for name in skipped)
                    or not set(skipped).issubset(inventory['packages'])
                    or 'xiaomei_app_bridge' in skipped):
                raise ValueError('启动节点清单无效')
            keep = [name for name in inventory['packages'] if name not in skipped]
            if skipped and keep:
                logging.info('ComfyUI 跳过未引用节点包：%s', ', '.join(skipped))
                return ['--disable-all-custom-nodes', '--whitelist-custom-nodes', *keep]
        except (OSError, ValueError, TypeError, KeyError, AttributeError) as exc:
            logging.warning('ComfyUI 启动清单无法核验，使用完整节点加载：%s', exc)
        return []

    def _wait_for_start(self, server_log):
        last_error = ''
        for _ in range(180):
            if self.cancel.is_set():
                self.process.terminate()
                raise RuntimeError('启动已取消')
            if self.process.poll() is not None:
                tail = server_log.read_text(encoding='utf-8', errors='replace')[-3500:]
                raise RuntimeError('独立 ComfyUI 启动失败：\n' + tail)
            try:
                return self.info()
            except requests.RequestException as exc:
                last_error = str(exc)
                time.sleep(0.5)
        raise RuntimeError('独立 ComfyUI 启动超时。' + (f' 最近错误：{last_error}' if last_error else ' 请查看 server.log。'))

    def _shared_model_config(self):
        """Return the model paths shared from the selected base ComfyUI."""
        return {'xiaomei': {
            'base_path': str(self.base),
            'checkpoints': 'models/checkpoints',
            'diffusion_models': 'models/diffusion_models',
            'text_encoders': 'models/text_encoders',
            'vae': 'models/vae',
            'upscale_models': 'models/upscale_models',
            'loras': 'models/loras',
            'controlnet': 'models/controlnet',
            'clip_vision': 'models/clip_vision',
            'LLM': 'models/LLM',
            'VQA': 'models/VQA',
            'SEEDVR2': 'models/SEEDVR2',
        }}

    def _write_shared_model_config(self):
        paths = self.root / 'shared-models.yaml'
        paths.parent.mkdir(parents=True, exist_ok=True)
        paths.write_text(json.dumps(self._shared_model_config()), encoding='utf-8')
        return paths

    def resources(self):
        resources = []
        for repo in MODELS:
            folder = self.root / 'models' / 'SeeThrough' / repo.split('/')[-1]
            files = [p for p in folder.rglob('*') if p.is_file() and '.cache' not in p.parts] if folder.exists() else []
            resources.append({'name': repo, 'source': 'https://huggingface.co/' + repo,
                              'installed': (folder / 'model_index.json').exists() and not self.missing_resources(),
                              'downloaded_bytes': sum(p.stat().st_size for p in files),
                              'size_note': '完整下载体积在准备日志中显示；无法核实的大小不作估算'})
        return resources

    def info(self):
        identity = requests.get('http://' + self.address + '/xiaomei/app-runtime', timeout=3)
        identity.raise_for_status()
        identity_data = identity.json() or {}
        if Path(identity_data.get('root', '')).resolve() != self.root.resolve():
            raise requests.RequestException('8190 不是小美画布管理的独立环境')
        if Path(identity_data.get('output', '')).resolve() != self.output.resolve():
            raise requests.RequestException('8190 的输出目录不是小美画布 ComfyUI 输出目录')
        response = requests.get('http://' + self.address + '/object_info', timeout=3)
        response.raise_for_status()
        return response.json()

    def start_existing(self):
        """Start the already-prepared isolated ComfyUI without reinstalling anything.

        The main application can be restarted while the managed child process is
        gone.  Reconnecting must be able to bring that environment back without
        running the expensive dependency/model preparation flow again.
        """
        if not self.guard.acquire(timeout=100):
            raise RuntimeError('本地 ComfyUI 正在准备或启动，请稍候再试')
        try:
            self.cancel.clear()
            existing_identity = None
            try:
                identity = requests.get('http://' + self.address + '/xiaomei/app-runtime', timeout=3)
                identity.raise_for_status()
                existing_identity = identity.json() or {}
                if Path(existing_identity.get('root', '')).resolve() != self.root.resolve():
                    raise RuntimeError('8190 端口已被其他服务占用，未覆盖。请在“画布设置”中换一个地址。')
                if Path(existing_identity.get('output', '')).resolve() == self.output.resolve():
                    try:
                        return self.info()
                    except requests.RequestException as exc:
                        raise RuntimeError('独立 ComfyUI 已启动，但暂时无法响应，请稍后重试；持续无响应时请检查 server.log。') from exc
            except requests.RequestException:
                existing_identity = None

            if existing_identity is None and self.process and self.process.poll() is None:
                return self._wait_for_start(self.root / 'server.log')

            base_python = self.base / '.venv' / 'Scripts' / 'python.exe'
            core = self.base / 'core' / 'main.py'
            python = self.root / '.venv' / 'Scripts' / 'python.exe'
            if not base_python.exists() or not core.exists():
                raise RuntimeError('没有找到本机 ComfyUI 环境。请在“画布设置”中确认地址，或设置 XIAOMEI_COMFY_BASE。')
            if not python.exists():
                raise RuntimeError('独立 ComfyUI 环境尚未准备完成，请先在应用详情中点击“准备运行环境”。')

            self.output.mkdir(parents=True, exist_ok=True)

            # If the managed service is still running with the old output
            # directory, stop only that verified process before relaunching it.
            # Never terminate an unrelated service on port 8190.
            if existing_identity is not None:
                queue = requests.get('http://' + self.address + '/queue', timeout=5).json()
                if queue.get('queue_running') or queue.get('queue_pending'):
                    raise RuntimeError('独立环境仍有运行任务，请完成后再切换输出目录')
                script = ('import psutil,sys; p=psutil.Process(int(sys.argv[1])); '
                          'assert sys.argv[2].lower() in " ".join(p.cmdline()).lower(), "Runtime identity mismatch"; '
                          'p.terminate(); p.wait(timeout=30)')
                server_log = self.root / 'server.log'
                server_log.parent.mkdir(parents=True, exist_ok=True)
                self.command([python, '-c', script, str(existing_identity.get('pid') or 0), self.root], server_log)

            # Never take over an unrelated service already listening on 8190.
            try:
                response = requests.get('http://' + self.address + '/system_stats', timeout=1.5)
                if response.status_code == 200:
                    raise RuntimeError('8190 端口已被其他服务占用，未覆盖。请在“画布设置”中换一个地址。')
            except requests.RequestException:
                pass

            paths = self._write_shared_model_config()
            env = {**os.environ, 'PYTHONUTF8': '1', 'PYTHONIOENCODING': 'utf-8',
                   'HF_HUB_OFFLINE': '1', 'TRANSFORMERS_OFFLINE': '1',
                   'TORCH_HOME': str(self.root / 'torch')}
            server_log = self.root / 'server.log'
            server_log.parent.mkdir(parents=True, exist_ok=True)
            with server_log.open('a', encoding='utf-8') as output:
                self.process = subprocess.Popen(
                    [str(python), str(core), '--base-directory', str(self.root),
                     '--extra-model-paths-config', str(paths), '--listen', '127.0.0.1',
                     '--port', '8190', '--output-directory', str(self.output),
                     '--disable-auto-launch', *self._startup_node_args()],
                    stdout=output, stderr=subprocess.STDOUT, env=env,
                    creationflags=subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0)

            return self._wait_for_start(server_log)
        finally:
            self.guard.release()

    def missing_resources(self):
        manifest = self.root / 'resource-manifest.json'
        if not manifest.exists():
            return ['需要重新准备环境以核验模型文件清单']
        expected = json.loads(manifest.read_text(encoding='utf-8'))
        return [name for name, size in expected.items()
                if not (self.root / name).is_file() or (self.root / name).stat().st_size != size]

    def command(self, args, log):
        env = {**os.environ, 'PYTHONUTF8': '1', 'PYTHONIOENCODING': 'utf-8', 'HF_XET_HIGH_PERFORMANCE': '1'}
        flags = subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0
        with log.open('a', encoding='utf-8') as output:
            child = subprocess.Popen([str(x) for x in args], stdout=output, stderr=subprocess.STDOUT,
                                     env=env, creationflags=flags)
            while child.poll() is None:
                if self.cancel.wait(0.5):
                    child.terminate()
                    child.wait(timeout=20)
                    raise RuntimeError('准备已取消；已下载文件保留，未标记为完成')
            if child.returncode:
                tail = log.read_text(encoding='utf-8', errors='replace')[-4000:]
                raise RuntimeError('环境准备失败：\n' + tail)

    def _download_model(self, plan, log, report_progress=None):
        for attempt in range(5):
            if self.cancel.is_set():
                raise RuntimeError('准备已取消；已下载文件保留')
            try:
                return self._download_model_attempt(plan, log, report_progress)
            except RuntimeError as exc:
                cause = exc.__cause__
                retryable = isinstance(cause, (requests.Timeout, requests.ConnectionError,
                                              requests.exceptions.ChunkedEncodingError))
                if isinstance(cause, requests.HTTPError) and cause.response is not None:
                    retryable = cause.response.status_code in (408, 429, 500, 502, 503, 504)
                if not retryable or attempt == 4:
                    raise
                delay = 2 ** (attempt + 1)
                detail = f'连接中断，{delay} 秒后断点续传（重试 {attempt + 1}/4）：{plan["name"]}'
                with log.open('a', encoding='utf-8') as output:
                    output.write(detail + '\n')
                if report_progress:
                    report_progress(None, detail)
                if self.cancel.wait(delay):
                    raise RuntimeError('准备已取消；已下载文件保留')

    def _download_model_attempt(self, plan, log, report_progress=None):
        """Download one allow-listed model into the shared ComfyUI tree.

        The caller supplies descriptors from the application library's trusted
        registry.  This method still validates the URL and destination again
        so a future caller cannot turn a workflow field into an arbitrary
        filesystem write or network request.
        """
        name = Path(str(plan.get('name') or '')).name
        category = str(plan.get('category') or '').strip().replace('\\', '/')
        url = str(plan.get('url') or '').strip()
        allowed_categories = {'checkpoints', 'diffusion_models', 'text_encoders', 'vae', 'loras',
                              'upscale_models', 'controlnet', 'clip_vision', 'SEEDVR2', 'models'}
        parsed = urlparse(url)
        if not name or name in ('.', '..') or '/' in name or '\\' in name:
            raise RuntimeError('自动下载失败：模型文件名不安全')
        if category not in allowed_categories or '/' in category or category in ('.', '..'):
            raise RuntimeError('自动下载失败：模型目录不安全')
        if (parsed.scheme != 'https' or parsed.hostname not in {'huggingface.co', 'www.huggingface.co', 'civitai.com'}
                or parsed.username or parsed.password or parsed.port not in (None, 443)):
            raise RuntimeError('自动下载失败：文件下载地址不属于支持的模型平台')
        if parsed.hostname == 'civitai.com' and (
                not re.fullmatch(r'/api/download/models/\d+', parsed.path)
                or not re.fullmatch('[a-fA-F0-9]{64}', str(plan.get('sha256') or ''))):
            raise RuntimeError('自动下载失败：Civitai 文件缺少可核验的下载地址或 SHA-256')
        destination = self.base / 'models' / category / name
        destination.parent.mkdir(parents=True, exist_ok=True)
        expected_size = plan.get('size_bytes')
        expected_hash = str(plan.get('sha256') or '').strip().lower()
        if destination.is_file():
            if expected_size and destination.stat().st_size != int(expected_size):
                raise RuntimeError(f'模型已存在但大小不符：{destination.name}；系统不会覆盖，请手动确认')
            if expected_hash:
                digest = self._file_sha256(destination)
                if digest != expected_hash:
                    raise RuntimeError(f'模型已存在但校验值不符：{destination.name}；系统不会覆盖')
            if report_progress:
                report_progress(100, f'已找到模型：{name}')
            return

        partial = destination.with_name(destination.name + '.xiaomei.download')
        offset = partial.stat().st_size if partial.is_file() else 0
        if expected_size and shutil.disk_usage(destination.parent).free < max(0, int(expected_size) - offset):
            raise RuntimeError(f'模型目录磁盘空间不足：{name}；清理空间后可继续下载')
        headers = {'Accept-Encoding': 'identity'}
        if offset:
            headers['Range'] = f'bytes={offset}-'
        try:
            response = requests.get(url, headers=headers, stream=True,
                                    allow_redirects=True, timeout=(20, 120))
            # Some mirrors ignore Range and return the whole file.  Restart
            # the partial file instead of corrupting it by appending twice.
            append = offset > 0 and response.status_code == 206
            if response.status_code == 416 and offset:
                partial.unlink(missing_ok=True)
                response.close()
                offset = 0
                response = requests.get(url, headers={'Accept-Encoding': 'identity'}, stream=True,
                                        allow_redirects=True, timeout=(20, 120))
                append = False
            response.raise_for_status()
            if append and not response.headers.get('Content-Range', '').startswith(f'bytes {offset}-'):
                raise RuntimeError(f'下载源返回了错误的续传位置：{name}；已保留临时文件，请重试')
            remaining = int(response.headers.get('Content-Length') or 0)
            total = offset + remaining if append and remaining else (remaining or int(expected_size or 0))
            received = offset if append else 0
            mode = 'ab' if append else 'wb'
            with partial.open(mode) as output:
                for chunk in response.iter_content(chunk_size=8 * 1024 * 1024):
                    if self.cancel.is_set():
                        raise RuntimeError('准备已取消；已下载文件保留，未标记为完成')
                    if not chunk:
                        continue
                    output.write(chunk)
                    received += len(chunk)
                    if report_progress:
                        percent = min(100, int(received * 100 / total)) if total else None
                        report_progress(percent, f'下载模型：{name}' + (f'（{percent}%）' if percent is not None else '（处理中）'))
                output.flush()
                os.fsync(output.fileno())
            response.close()
            if total and partial.stat().st_size != total:
                raise RuntimeError(f'模型下载未完成：{name}，已下载 {partial.stat().st_size} / {total} 字节，请重试')
            if expected_size and partial.stat().st_size != int(expected_size):
                raise RuntimeError(f'模型下载大小校验失败：{name}，请重试或手动导入')
            if expected_hash:
                digest = self._file_sha256(partial)
                if digest != expected_hash:
                    raise RuntimeError(f'模型校验失败：{name}，文件可能已损坏，请重试')
            partial.replace(destination)
            with log.open('a', encoding='utf-8') as output:
                output.write(f'自动下载完成：{destination} <- {url}\n')
        except requests.RequestException as exc:
            raise RuntimeError(f'模型下载失败：{name}；{exc}') from exc
        finally:
            try:
                response.close()
            except UnboundLocalError:
                pass

    def _file_sha256(self, path):
        digest = hashlib.sha256()
        with path.open('rb') as stream:
            for block in iter(lambda: stream.read(8 * 1024 * 1024), b''):
                if self.cancel.is_set():
                    raise RuntimeError('校验已取消；已下载文件保留')
                digest.update(block)
        return digest.hexdigest()

    def install_node_packages(self, packages, python, log, update):
        packages = [validate_node_package(package) for package in packages]
        unique = {}
        for package in packages:
            key = (package['source'].casefold(), package['revision'])
            if key in unique:
                unique[key]['required_nodes'] = list(dict.fromkeys(
                    unique[key]['required_nodes'] + package['required_nodes']))
                continue
            unique[key] = package
        for package in unique.values():
            name = package['name']
            destination = self.root / 'custom_nodes' / name
            update('安装节点包：' + package['display_name'])
            created = not destination.exists()
            if created:
                self.command(['git', 'clone', '--filter=blob:none', package['source'], destination], log)
            actual = subprocess.check_output(['git', '-C', str(destination), 'remote', 'get-url', 'origin'], text=True).strip()
            if canonical_github_source(actual) != package['source']:
                raise RuntimeError('节点目录来源不一致，未覆盖：' + str(destination))
            dirty = subprocess.check_output(['git', '-C', str(destination), 'diff', 'HEAD', '--name-only'], text=True).strip()
            if dirty and not created:
                raise RuntimeError('节点目录存在本地修改，未覆盖：' + str(destination))
            self.command(['git', '-C', destination, 'fetch', '--depth', '1', 'origin', package['revision']], log)
            self.command(['git', '-C', destination, 'checkout', '--detach', package['revision']], log)
            actual_revision = subprocess.check_output(
                ['git', '-C', str(destination), 'rev-parse', 'HEAD'], text=True).strip().lower()
            if actual_revision != package['revision']:
                raise RuntimeError('节点包提交校验失败：' + package['display_name'])
            if package.get('git_lfs'):
                self.command(['git', '-C', destination, 'lfs', 'pull'], log)
            requirements = destination / 'requirements.txt'
            if requirements.is_file():
                self.command([python, '-m', 'pip', 'install', '--dry-run', '-r', requirements], log)
                self.command([python, '-m', 'pip', 'install', '-r', requirements], log)
        return list(unique.values())

    def prepare(self, update, seethrough=False, report_progress=None, download_models=None, node_packages=None):
        if not self.guard.acquire(blocking=False):
            raise RuntimeError('另一个环境准备任务正在运行')
        try:
            def progress(value, detail, indeterminate=False):
                if report_progress:
                    report_progress({'value': value, 'max': 100, 'detail': detail,
                                     'indeterminate': bool(indeterminate)})

            if self.cancel.is_set():
                raise RuntimeError('准备已取消')
            self.root.mkdir(parents=True, exist_ok=True)
            log = self.root / 'prepare.log'
            base_python = self.base / '.venv' / 'Scripts' / 'python.exe'
            core = self.base / 'core' / 'main.py'
            if not base_python.exists() or not core.exists():
                raise RuntimeError('未找到本机 ComfyUI 安装。请设置 XIAOMEI_COMFY_BASE 为包含 core 和 .venv 的目录。')
            env_path = self.root / '.venv'
            python = env_path / 'Scripts' / 'python.exe'
            update('检查独立 Python 环境')
            progress(0, '检查本机 ComfyUI 和独立环境')
            if not python.exists():
                progress(8, '创建独立 Python 环境；完成后进入下一阶段', True)
                self.command([base_python, '-m', 'venv', env_path], log)
                # Dependencies inherited read-only; isolated site-packages take
                # precedence. pip cannot uninstall files outside this environment.
                site = env_path / 'Lib' / 'site-packages'
                (site / 'comfy_shared.pth').write_text(str(self.base / '.venv' / 'Lib' / 'site-packages') + '\n', encoding='utf-8')
            progress(22, '独立 Python 环境已就绪')
            custom = self.root / 'custom_nodes'
            custom.mkdir(exist_ok=True)
            bridge = self.project / 'ComfyUI' / 'tools' / 'comfy-app-bridge'
            bridge_target = custom / 'xiaomei_app_bridge'
            bridge_changed = any(
                not (bridge_target / path.relative_to(bridge)).is_file()
                or path.read_bytes() != (bridge_target / path.relative_to(bridge)).read_bytes()
                for path in bridge.rglob('*') if path.is_file() and '__pycache__' not in path.parts)
            shutil.copytree(bridge, bridge_target, dirs_exist_ok=True,
                            ignore=shutil.ignore_patterns('__pycache__', '*.pyc'))
            node_packages = [validate_node_package(package) for package in (node_packages or [])]
            self.install_node_packages(self._packages_to_install(node_packages), python, log, update)
            progress(32 if seethrough else 52, '本地转换桥接已准备')
            download_models = list(download_models or [])
            if download_models:
                update('下载已确认来源的模型')
                download_start = 84 if seethrough else 54
                download_end = 88
                span = max(1, download_end - download_start)
                total = len(download_models)
                for index, plan in enumerate(download_models):
                    item_start = download_start + (span * index / total)
                    item_span = span / total
                    name = str(plan.get('name') or '模型')
                    progress(round(item_start), f'准备下载模型 {index + 1}/{total}：{name}', True)
                    self._download_model(
                        plan, log,
                        lambda value, detail, start=item_start, width=item_span: progress(
                            round(start + width * (value / 100 if value is not None else 0)),
                            detail, value is None),
                    )
                progress(download_end, '已下载并校验可自动安装的模型')
            if seethrough:
                update('下载并检查 SeeThrough 节点来源')
                progress(35, '下载并固定 SeeThrough 节点版本；完成后进入下一阶段', True)
                source = custom / 'ComfyUI-See-through'
                if not source.exists():
                    self.command(['git', 'clone', SOURCE, source], log)
                self.command(['git', '-C', source, 'checkout', '--detach', REVISION], log)
                self.command(['git', '-C', source, 'diff', '--exit-code', REVISION, '--'], log)
                deps = ['diffusers==0.37.0', 'bitsandbytes>=0.49.2', 'peft>=0.18.0', 'accelerate>=0.20.0']
                update('检查依赖冲突（不修改原 ComfyUI）')
                progress(43, '检查独立环境依赖冲突；不会升级原 ComfyUI', True)
                self.command([python, '-m', 'pip', 'install', '--dry-run', *deps], log)
                update('安装独立环境依赖')
                progress(50, '安装独立环境依赖；下载进度见准备日志', True)
                self.command([python, '-m', 'pip', 'install', *deps], log)
                for index, repo in enumerate(MODELS):
                    update('下载模型：' + repo + '；进度见准备日志')
                    progress(55 + index * 14, f'下载模型 {index + 1}/{len(MODELS)}：{repo}；文件百分比由下载源提供', True)
                    destination = self.root / 'models' / 'SeeThrough' / repo.split('/')[-1]
                    script = 'from huggingface_hub import snapshot_download; import sys; snapshot_download(repo_id=sys.argv[1],local_dir=sys.argv[2])'
                    self.command([python, '-c', script, repo, destination], log)
                update('准备调度器配置和 LaMa 补全权重')
                progress(84, '下载调度器和 LaMa 补全权重；进度见准备日志', True)
                self.command([python, '-c', "from huggingface_hub import hf_hub_download; hf_hub_download('frankjoshua/juggernautXL_version6Rundiffusion','scheduler/scheduler_config.json')"], log)
                self.command([python, '-c', "from huggingface_hub import hf_hub_download; import sys; hf_hub_download('dreMaz/AnimeMangaInpainting','lama_large_512px.ckpt',local_dir=sys.argv[1])", self.root / 'torch' / 'hub' / 'checkpoints'], log)
                inventory = {}
                for folder in [self.root / 'models' / 'SeeThrough', self.root / 'torch' / 'hub' / 'checkpoints']:
                    for path in folder.rglob('*'):
                        if path.is_file() and '.cache' not in path.parts:
                            inventory[path.relative_to(self.root).as_posix()] = path.stat().st_size
                (self.root / 'resource-manifest.json').write_text(json.dumps(inventory, indent=2), encoding='utf-8')
            if self.cancel.is_set():
                raise RuntimeError('准备已取消')
            if not bridge_changed and not node_packages and not seethrough:
                try:
                    info = self.info()
                except requests.RequestException:
                    pass
                else:
                    if 'Float' in info:
                        update('复用已启动的独立 ComfyUI')
                        progress(100, '环境已就绪；仍需转换和检查应用工作流')
                        return info
            update('启动并验证独立 ComfyUI')
            progress(90, '启动并验证独立 ComfyUI；等待本地服务响应', True)
            if self.process and self.process.poll() is None:
                queue = requests.get('http://' + self.address + '/queue', timeout=5).json()
                if queue.get('queue_running') or queue.get('queue_pending'):
                    raise RuntimeError('独立环境仍有运行任务，请完成后再准备新节点')
                self.process.terminate()
                self.process.wait(timeout=30)
            # Share existing models without changing their directories.
            paths = self._write_shared_model_config()
            try:
                identity = requests.get('http://' + self.address + '/xiaomei/app-runtime', timeout=5)
                if identity.status_code != 200 or Path(identity.json()['root']).resolve() != self.root.resolve():
                    raise RuntimeError('8190 端口已有其他服务，未覆盖。请关闭占用服务后重试。')
                queue = requests.get('http://' + self.address + '/queue', timeout=5).json()
                if queue.get('queue_running') or queue.get('queue_pending'):
                    raise RuntimeError('独立环境仍有运行任务，请完成后重试')
                script = ('import psutil,sys; p=psutil.Process(int(sys.argv[1])); '
                          'assert sys.argv[2].lower() in " ".join(p.cmdline()).lower(), "Runtime identity mismatch"; '
                          'p.terminate(); p.wait(timeout=30)')
                self.command([python, '-c', script, str(identity.json()['pid']), self.root], log)
            except requests.RequestException:
                pass
            env = {**os.environ, 'PYTHONUTF8': '1', 'PYTHONIOENCODING': 'utf-8', 'HF_HUB_OFFLINE': '1', 'TRANSFORMERS_OFFLINE': '1', 'TORCH_HOME': str(self.root / 'torch')}
            with (self.root / 'server.log').open('a', encoding='utf-8') as output:
                self.process = subprocess.Popen([str(python), str(core), '--base-directory', str(self.root),
                    '--extra-model-paths-config', str(paths), '--listen', '127.0.0.1', '--port', '8190',
                    '--output-directory', str(self.output), '--disable-auto-launch'],
                    stdout=output, stderr=subprocess.STDOUT, env=env,
                    creationflags=subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0)
            for _ in range(180):
                if self.cancel.wait(1):
                    self.process.terminate()
                    raise RuntimeError('准备已取消')
                if self.process.poll() is not None:
                    raise RuntimeError('独立 ComfyUI 启动失败：' + (self.root / 'server.log').read_text(encoding='utf-8', errors='replace')[-3500:])
                try:
                    info = self.info()
                    if 'Float' not in info:
                        raise RuntimeError('本地兼容桥接未加载 Float 节点，请查看独立环境 server.log')
                    if seethrough and 'SeeThrough_GenerateLayers' not in info:
                        raise RuntimeError('SeeThrough 节点加载失败，请查看独立环境 server.log')
                    missing = [node for package in (node_packages or []) for node in package['required_nodes']
                               if node not in info and not frontend_node_available(node, info)]
                    if missing:
                        raise RuntimeError('节点包已下载，但以下节点加载失败：' + '、'.join(missing) + '。请查看独立环境 server.log')
                    update('环境已启动；仍需转换和检查应用工作流')
                    progress(100, '环境已启动；仍需转换和检查应用工作流')
                    return info
                except requests.RequestException:
                    pass
            raise RuntimeError('独立环境启动超时，请查看 server.log')
        finally:
            self.guard.release()
