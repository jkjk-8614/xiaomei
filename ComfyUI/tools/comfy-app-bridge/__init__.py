"""Task-scoped artifacts and native frontend conversion for 小美画布.

The SwarmInput classes below are a small local compatibility layer, not a
copy of SwarmUI.  They let a workflow keep its original input nodes while the
小美画布 application form supplies their values in the isolated ComfyUI
runtime.  The node names and the important input/output contracts match the
open-source SwarmUI definitions; the rest of SwarmUI is deliberately not
installed.
"""
import base64
import io
import json
import os
from pathlib import Path
import zipfile

WEB_DIRECTORY = './web'
NODE_CLASS_MAPPINGS = {}


class AnyType(str):
    def __ne__(self, other):
        return False


class CleanGpu:
    @classmethod
    def INPUT_TYPES(cls):
        return {'required': {'anything': (AnyType('*'),)}}
    RETURN_TYPES = (AnyType('*'),)
    FUNCTION = 'run'
    CATEGORY = '小美画布'
    def run(self, anything):
        import gc
        import comfy.model_management as mm
        gc.collect()
        mm.unload_all_models()
        mm.soft_empty_cache()
        return (anything,)


NODE_CLASS_MAPPINGS['easy cleanGpuUsed'] = CleanGpu


class FloatValue:
    @classmethod
    def INPUT_TYPES(cls):
        return {'required': {'value': ('FLOAT', {'default': 0.0})}}

    RETURN_TYPES = ('FLOAT',)
    FUNCTION = 'run'
    CATEGORY = '小美画布'

    def run(self, value):
        return (float(value),)


NODE_CLASS_MAPPINGS['Float'] = FloatValue


def _standard_inputs():
    return {
        'description': ('STRING', {'default': '', 'multiline': True}),
        'order_priority': ('FLOAT', {'default': 0, 'min': -1024, 'max': 1024, 'step': 0.5}),
        'is_advanced': ('BOOLEAN', {'default': False}),
        'raw_id': ('STRING', {'default': ''}),
    }


def _with_group(required, optional=True):
    result = {'required': required}
    if optional:
        result['optional'] = {'group': ('GROUP',)}
    return result


class SwarmWorkflowDescription:
    @classmethod
    def INPUT_TYPES(cls):
        return _with_group({
            'description': ('STRING', {'default': '', 'multiline': True}),
            'enable_in_simple_tab': ('BOOLEAN', {'default': False}),
        }, optional=False)
    RETURN_TYPES = ()
    FUNCTION = 'do_input'
    CATEGORY = 'SwarmUI/inputs'
    def do_input(self, **kwargs):
        return ()


class SwarmInputGroup:
    @classmethod
    def INPUT_TYPES(cls):
        required = {
            'title': ('STRING', {'default': 'My Group'}),
            'open_by_default': ('BOOLEAN', {'default': True}),
            'description': ('STRING', {'default': '', 'multiline': True}),
            'order_priority': ('FLOAT', {'default': 0, 'min': -1024, 'max': 1024, 'step': 0.5}),
            'is_advanced': ('BOOLEAN', {'default': False}),
            'can_shrink': ('BOOLEAN', {'default': True}),
        }
        return _with_group(required, optional=False)
    RETURN_TYPES = ('GROUP',)
    FUNCTION = 'do_input'
    CATEGORY = 'SwarmUI/inputs'
    def do_input(self, **kwargs):
        return (None,)


class SwarmInputInteger:
    @classmethod
    def INPUT_TYPES(cls):
        required = {
            'title': ('STRING', {'default': 'My Integer'}),
            'value': ('INT', {'default': 0, 'min': -0xffffffffffffffff, 'max': 0xffffffffffffffff, 'step': 1}),
            'step': ('INT', {'default': 1, 'min': 1, 'max': 0xffffffffffffffff, 'step': 1}),
            'min': ('INT', {'default': 0, 'min': -0xffffffffffffffff, 'max': 0xffffffffffffffff, 'step': 1}),
            'max': ('INT', {'default': 100, 'min': -0xffffffffffffffff, 'max': 0xffffffffffffffff, 'step': 1}),
            'view_max': ('INT', {'default': 100}),
            'view_type': (['big', 'small', 'seed', 'slider', 'pot_slider'],),
        }
        required.update(_standard_inputs())
        return _with_group(required)
    RETURN_TYPES = ('INT',)
    FUNCTION = 'do_input'
    CATEGORY = 'SwarmUI/inputs'
    def do_input(self, value, **kwargs):
        return (int(value),)


class SwarmInputFloat:
    @classmethod
    def INPUT_TYPES(cls):
        required = {
            'title': ('STRING', {'default': 'My Floating-Point Number'}),
            'value': ('FLOAT', {'default': 0, 'min': -0xffffffffffffffff, 'max': 0xffffffffffffffff, 'step': 0.01}),
            'step': ('FLOAT', {'default': 0.1, 'min': 0.0000001, 'max': 0xffffffffffffffff, 'step': 0.01}),
            'min': ('FLOAT', {'default': 0, 'min': -0xffffffffffffffff, 'max': 0xffffffffffffffff, 'step': 0.01}),
            'max': ('FLOAT', {'default': 100, 'min': -0xffffffffffffffff, 'max': 0xffffffffffffffff, 'step': 0.01}),
            'view_max': ('FLOAT', {'default': 100}),
            'view_type': (['big', 'small', 'slider', 'pot_slider'],),
        }
        required.update(_standard_inputs())
        return _with_group(required)
    RETURN_TYPES = ('FLOAT',)
    FUNCTION = 'do_input'
    CATEGORY = 'SwarmUI/inputs'
    def do_input(self, value, **kwargs):
        return (float(value),)


class SwarmInputText:
    @classmethod
    def INPUT_TYPES(cls):
        required = {
            'title': ('STRING', {'default': 'My Text'}),
            'value': ('STRING', {'default': '', 'multiline': True}),
            'view_type': (['normal', 'prompt', 'big'],),
        }
        required.update(_standard_inputs())
        return _with_group(required)
    RETURN_TYPES = ('STRING',)
    FUNCTION = 'do_input'
    CATEGORY = 'SwarmUI/inputs'
    def do_input(self, value, **kwargs):
        return (str(value),)


class SwarmInputModelName:
    @classmethod
    def INPUT_TYPES(cls):
        required = {
            'title': ('STRING', {'default': 'My Model Name Input'}),
            'value': ('STRING', {'default': ''}),
            'subtype': (['Stable-Diffusion', 'VAE', 'LoRA', 'Embedding', 'ControlNet', 'ClipVision'],),
        }
        required.update(_standard_inputs())
        return _with_group(required)
    RETURN_TYPES = ('STRING',)
    FUNCTION = 'do_input'
    CATEGORY = 'SwarmUI/inputs'
    def do_input(self, value, **kwargs):
        return (str(value),)


class SwarmInputCheckpoint:
    @classmethod
    def INPUT_TYPES(cls):
        try:
            import folder_paths
            choices = folder_paths.get_filename_list('checkpoints')
        except Exception:
            choices = []
        required = {'title': ('STRING', {'default': 'My Checkpoint Model Name Input'}),
                    'value': (choices,)}
        required.update(_standard_inputs())
        return _with_group(required)
    RETURN_TYPES = ('MODEL', 'CLIP', 'VAE')
    FUNCTION = 'do_input'
    CATEGORY = 'SwarmUI/inputs'
    def do_input(self, value, **kwargs):
        try:
            from nodes import CheckpointLoaderSimple
            return CheckpointLoaderSimple().load_checkpoint(value)
        except Exception as exc:
            raise RuntimeError('SwarmInputCheckpoint 无法加载本地检查点：' + str(exc)) from exc


class SwarmInputDropdown:
    @classmethod
    def INPUT_TYPES(cls):
        required = {'title': ('STRING', {'default': 'My Dropdown'}),
                    'value': ('STRING', {'default': ''}),
                    'values': ('STRING', {'default': 'one, two, three', 'multiline': True})}
        required.update(_standard_inputs())
        return _with_group(required)
    RETURN_TYPES = ('STRING', '')
    FUNCTION = 'do_input'
    CATEGORY = 'SwarmUI/inputs'
    def do_input(self, value, **kwargs):
        return (str(value), str(value))


class SwarmInputBoolean:
    @classmethod
    def INPUT_TYPES(cls):
        required = {'title': ('STRING', {'default': 'My Boolean'}),
                    'value': ('BOOLEAN', {'default': False})}
        required.update(_standard_inputs())
        return _with_group(required)
    RETURN_TYPES = ('BOOLEAN',)
    FUNCTION = 'do_input'
    CATEGORY = 'SwarmUI/inputs'
    def do_input(self, value, **kwargs):
        return (bool(value),)


def _input_files(content_type):
    try:
        import folder_paths
        root = folder_paths.get_input_directory()
        files = [name for name in os.listdir(root) if os.path.isfile(os.path.join(root, name))]
        return sorted(folder_paths.filter_files_content_types(files, [content_type]))
    except Exception:
        return []


class SwarmInputImage:
    @classmethod
    def INPUT_TYPES(cls):
        required = {'title': ('STRING', {'default': 'My Image'}),
                    'value': ('STRING', {'default': '(Do Not Set Me)', 'multiline': True}),
                    'auto_resize': ('BOOLEAN', {'default': True})}
        required.update(_standard_inputs())
        result = _with_group(required)
        result['optional'] = {'image': (_input_files('image'), {'image_upload': True}), 'group': ('GROUP',)}
        return result
    RETURN_TYPES = ('IMAGE', 'MASK')
    FUNCTION = 'do_input'
    CATEGORY = 'SwarmUI/inputs'
    def do_input(self, value=None, image=None, **kwargs):
        filename = image or (value if value and value != '(Do Not Set Me)' else None)
        if not filename:
            raise RuntimeError('SwarmInputImage 没有收到上传图片')
        try:
            from nodes import LoadImage
            return LoadImage().load_image(filename)
        except Exception as exc:
            raise RuntimeError('SwarmInputImage 无法读取本地图片：' + str(exc)) from exc


class SwarmInputAudio:
    @classmethod
    def INPUT_TYPES(cls):
        required = {'title': ('STRING', {'default': 'My Audio'}),
                    'value': ('STRING', {'default': '(Do Not Set Me)', 'multiline': True})}
        required.update(_standard_inputs())
        return _with_group(required)
    RETURN_TYPES = ('AUDIO',)
    FUNCTION = 'do_input'
    CATEGORY = 'SwarmUI/inputs'
    def do_input(self, value=None, **kwargs):
        raise RuntimeError('本地桥接暂不支持 SwarmInputAudio，请在高级编辑器中配置音频输入')


class SwarmInputVideo:
    @classmethod
    def INPUT_TYPES(cls):
        required = {'title': ('STRING', {'default': 'My Video'}),
                    'value': ('STRING', {'default': '(Do Not Set Me)', 'multiline': True})}
        required.update(_standard_inputs())
        return _with_group(required)
    RETURN_TYPES = ('VIDEO',)
    FUNCTION = 'do_input'
    CATEGORY = 'SwarmUI/inputs'
    def do_input(self, value=None, **kwargs):
        raise RuntimeError('本地桥接暂不支持 SwarmInputVideo，请在高级编辑器中配置视频输入')


NODE_CLASS_MAPPINGS.update({
    'SwarmWorkflowDescription': SwarmWorkflowDescription,
    'SwarmInputGroup': SwarmInputGroup,
    'SwarmInputInteger': SwarmInputInteger,
    'SwarmInputFloat': SwarmInputFloat,
    'SwarmInputText': SwarmInputText,
    'SwarmInputModelName': SwarmInputModelName,
    'SwarmInputCheckpoint': SwarmInputCheckpoint,
    'SwarmInputDropdown': SwarmInputDropdown,
    'SwarmInputBoolean': SwarmInputBoolean,
    'SwarmInputImage': SwarmInputImage,
    'SwarmInputAudio': SwarmInputAudio,
    'SwarmInputVideo': SwarmInputVideo,
})


def wrap_seethrough():
    import nodes
    base = nodes.NODE_CLASS_MAPPINGS.get('SeeThrough_SavePSD')
    if not base or getattr(base, '_xiaomei_artifacts', False):
        return
    original = base.save
    def save(self, parts, filename_prefix='seethrough'):
        result = original(self, parts, filename_prefix)
        manifest = Path(result[0])
        data = json.loads(manifest.read_text(encoding='utf-8'))
        files = [{'filename': manifest.name, 'subfolder': '', 'type': 'output'}]
        archive = manifest.with_suffix('.zip')
        with zipfile.ZipFile(archive, 'w', zipfile.ZIP_DEFLATED) as bundle:
            bundle.write(manifest, manifest.name)
            for layer in data['layers']:
                name = layer['filename']
                path = manifest.parent / name
                if path.resolve().parent != manifest.parent.resolve():
                    raise ValueError('Layer path must stay inside the task output directory')
                bundle.write(path, name)
                files.append({'filename': name, 'subfolder': '', 'type': 'output'})
        files.append({'filename': archive.name, 'subfolder': '', 'type': 'output'})
        return {'ui': {'files': files}, 'result': result}
    base.save = save
    base._xiaomei_artifacts = True


# ComfyUI imports custom nodes before its aiohttp startup hooks run.
from server import PromptServer
from aiohttp import web
import os
@PromptServer.instance.routes.get('/xiaomei/app-runtime')
async def runtime_identity(request):
    import folder_paths
    return web.json_response({
        'root': str(Path(folder_paths.base_path).resolve()),
        'output': str(Path(folder_paths.get_output_directory()).resolve()),
        'pid': os.getpid(),
    })

async def on_startup(app):
    wrap_seethrough()
PromptServer.instance.app.on_startup.append(on_startup)
