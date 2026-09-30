"""Run the actual image-space routes with temporary storage, without app startup jobs."""
import ast
import copy
import json
import os
import pathlib
import re
import tempfile
import time
import uuid
import sys
from typing import Any, Dict, Optional, Literal, List

from fastapi import FastAPI, HTTPException
from fastapi.staticfiles import StaticFiles
from PIL import Image
from pydantic import BaseModel, Field
ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from image_space import merge_classification, replace_ai, matches_filters


def build_app(directory):
    app = FastAPI()
    root = pathlib.Path(directory)
    root.mkdir(parents=True, exist_ok=True)
    names = {
        'ImageSpaceFilters', 'ImageSpaceCollectionRequest', 'ImageSpaceClassificationRequest',
        'image_space_dimensions', 'image_space_read_generated_classification', 'image_space_collections',
        'get_image_space_collections', 'create_image_space_collection', 'update_image_space_collection',
        'delete_image_space_collection', 'edit_image_space_classification', 'list_storage_files',
        '_normalize_asset_classification_fields', 'normalize_asset_classification', '_safe_asset_tag',
        '_read_local_upload_classification', '_write_local_upload_classification',
        '_atomic_write_json_locked',
        'AssetLibraryClassifyRequest', 'classify_asset_library_items',
    }
    tree = ast.parse((ROOT / 'main.py').read_text(encoding='utf-8'))
    selected = [node for node in tree.body if isinstance(node, (ast.ClassDef, ast.FunctionDef, ast.AsyncFunctionDef)) and node.name in names]
    assert len(selected) == len(names)
    ns = dict(globals(), app=app, DATA_DIR=str(root), now_ms=lambda: int(time.time()*1000),
              _IMAGE_SPACE_DIMENSIONS={}, ASSET_CLASSIFICATION_DIMENSION_NAMES={'color':'色彩','materials':'材质','subject':'主体','style':'风格','use_case':'用途'},
              STORAGE_MEDIA_EXTS={'.png'}, STORAGE_VIDEO_EXTS={'.mp4'}, Request=Any)
    library = {'libraries':[{'id':'default','name':'默认资产库','categories':[{'id':'frames','name':'相框','type':'image','items':[]}]}]}
    ns['load_asset_library'] = lambda: copy.deepcopy(library)
    def save_library(value):
        library.clear()
        library.update(copy.deepcopy(value))
    ns['save_asset_library'] = save_library
    ns['find_asset_item_in_library'] = lambda lib, ident, library_id='': next((i for l in lib['libraries'] for c in l['categories'] for i in c['items'] if i['id']==ident), None)
    ns['asset_library_media_kind'] = lambda path: 'image'
    def safe_path(name):
        target = (root / name).resolve()
        if not target.is_relative_to(root.resolve()):
            raise HTTPException(400, '路径无效')
        return str(target)
    ns['_local_upload_safe_path'] = lambda name: (name, safe_path(name))
    ns['_local_upload_classification_path'] = lambda name: str(pathlib.Path(safe_path(name)).with_suffix('.classification.json'))
    ns['storage_kind_roots'] = lambda kind: [str(root)]
    ns['storage_file_path'] = lambda kind, rel: safe_path(rel)
    ns['output_file_from_url'] = lambda url: safe_path(url.removeprefix('/fixtures/'))
    def storage_item(kind, source_root, path, include_dimensions=False):
        rel = pathlib.Path(path).relative_to(root).as_posix()
        return {'id':f'{kind}:{rel}', 'name':pathlib.Path(path).name,'kind':kind,'rel':rel,'folder':str(pathlib.Path(rel).parent).replace('.',''),'url':f'/fixtures/{rel}','created_at':os.stat(path).st_mtime,'size':os.stat(path).st_size}
    ns['storage_file_item'] = storage_item
    exec(compile(ast.Module(body=selected, type_ignores=[]), str(ROOT/'main.py'), 'exec'), ns)
    for index in range(25):
        name = f'相框{index:02d}.png'
        Image.new('RGB', (300, 600) if index == 24 else (600, 300), '#dfd1bf').save(root/name)
        os.utime(root/name, (index+1,index+1))
        classification = ns['normalize_asset_classification']({'categories':{'color':['金色' if index == 24 else '白色'],'materials':['金属']},'tags':['参考图'],'summary':'相框产品图'})
        ns['_atomic_write_json_locked'](str(root/name)+'.classification.json',classification)
        if index < 3 or index == 24:
            library['libraries'][0]['categories'][0]['items'].append({'id':f'asset_{index}','name':name,'url':f'/fixtures/{name}','kind':'image','width':300 if index==24 else 600,'height':600 if index==24 else 300,'classification':classification,'created_at':1000})
    @app.get('/api/asset-library')
    async def assets(): return {'library':copy.deepcopy(library)}
    @app.get('/api/local-assets')
    async def locals_():
        items = [dict(item,id=item['name'],file=item['name']) for item in library['libraries'][0]['categories'][0]['items']]
        for item in items:
            item['classification'] = ns['_read_local_upload_classification'](item['name']) or item['classification']
        return {'items':items,'tree':{'path':'','name':'全部上传','count':len(items),'children':[]}}
    @app.get('/api/prompt-libraries')
    async def prompts(): return {'library':{'libraries':[]}}
    @app.get('/api/providers')
    async def providers(): return {'providers':[]}
    @app.get('/api/canvas-assets')
    async def canvases(): return {'items':[],'categories':[],'canvases':[]}
    @app.get('/api/shared-folders')
    async def shared(): return {'folders':[]}
    app.mount('/static',StaticFiles(directory=ROOT/'static'),name='static')
    app.mount('/fixtures',StaticFiles(directory=root),name='fixtures')
    return app, ns, library


if __name__ == '__main__':
    import uvicorn
    with tempfile.TemporaryDirectory(prefix='xiaomei-image-space-') as directory:
        app, _, _ = build_app(directory)
        uvicorn.run(app, host='127.0.0.1',port=3017)
