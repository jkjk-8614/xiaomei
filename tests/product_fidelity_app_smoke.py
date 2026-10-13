"""Exercise production serializers, tasks, local storage and history in isolation.

No user settings, user images or paid models are used by this test.
"""
import asyncio
import base64
import copy
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile


def worker(root):
    sys.path.insert(0,str(root))
    import main as app
    import httpx
    import numpy as np
    from PIL import Image,ImageDraw
    from fastapi.testclient import TestClient
    provider=dict(id='fixture',name='Fixture',base_url='https://fixture.test',protocol='openai',image_request_mode='openai',model_protocols={},image_models=['gpt-image-2'])
    app.get_api_provider=lambda _='':provider
    app.get_api_provider_exact=lambda _:provider
    app.api_headers=lambda **_:{}
    image=Image.new('RGBA',(512,512),(0,0,0,0))
    draw=ImageDraw.Draw(image)
    draw.rectangle((110,125,401,386),fill='#74818a',outline='white',width=8)
    draw.text((185,250),'XM 4:3',fill='black')
    source=app.save_product_fidelity_asset(image,'fixture_product.png')
    other=app.save_product_fidelity_asset(Image.new('RGB',(512,512),'white'),'fixture_other.png')
    buffer=io.BytesIO();Image.new('RGB',(512,512),'#164578').save(buffer,format='PNG')
    generated=base64.b64encode(buffer.getvalue()).decode()
    thought=base64.b64encode(b'not-a-real-image').decode()
    calls=[]
    def handler(request):
        raw=request.content
        calls.append((str(request.url),raw,request.headers.get('content-type','')))
        if 'generateContent' in str(request.url):
            return httpx.Response(200,json={'candidates':[{'content':{'parts':[
                {'thought':True,'inlineData':{'mimeType':'image/png','data':thought}},
                {'text':'Final image'}, {'inlineData':{'mimeType':'image/png','data':generated}}]}}]})
        return httpx.Response(200,json={'data':[{'b64_json':generated}]})
    original=httpx.AsyncClient
    def mock_client(*args,**kwargs):
        kwargs['transport']=httpx.MockTransport(handler)
        return original(*args,**kwargs)
    app.httpx.AsyncClient=mock_client
    refs=[dict(url=other,kind='image',reference_id='other'),dict(url=source,kind='image',reference_id='product')]
    config=dict(version=1,enabled=True,mode='strict',productReferenceId='product',detail=dict(inputMode='combined'),rois=[dict(x=.3,y=.3,w=.2,h=.2)])
    async def scenario():
        for model in ['gpt-image-2','gpt-image-2.5-flare','gpt-image-2.5-sunburst','gemini-2.5-flash-image','gemini-3-pro-image-preview','gemini-3.1-flash-image','gemini-nano-banana-2.1','gemini-3.1-flash-lite-image','nano-banana-2','nano-banana-2.1']:
            before=len(calls)
            request=app.OnlineImageRequest(prompt='换成蓝色背景，保留产品',provider_id='fixture',model=model,size='512x512',quality='max',reference_images=refs,product_fidelity=config)
            preview=await app.preview_product_fidelity(request)
            assert preview['paidApiCalled'] is False
            assert len(calls)==before
            result=await app.build_online_image_result(request)
            assert len(calls)==before+1,(model,len(calls)-before)
            assert result['product_fidelity']['validationStatus']=='passed'
            assert result['product_fidelity']['usedReferenceIds'][:2]==['other','product']
            output=Image.open(app.output_file_from_url(result['images'][0])).convert('RGB')
            core=np.asarray(image.getchannel('A'))==255
            np.testing.assert_array_equal(np.asarray(output)[core],np.asarray(image.convert('RGB'))[core])
            url,body,content_type=calls[-1]
            if model.startswith('gpt-'):
                assert '/images/edits' in url
                assert 'multipart/form-data' in content_type
                assert body.count(b'name="image[]"')==4
                assert b'name="mask"' not in body
                assert b'input_fidelity' not in body and b'controlnet' not in body
                assert b'name="quality"\r\n\r\nmax' in body if '2.5' in model else b'name="quality"\r\n\r\nmax' not in body
            else:
                assert model+':generateContent' in url
                body=json.loads(body)
                parts=body['contents'][0]['parts']
                count=sum('inlineData' in p for p in parts)
                assert count==(3 if model.startswith('nano-') or model=='gemini-2.5-flash-image' else 4),(model,count)
                assert '图片 2：产品真实' in parts[0]['text']
                assert not {'quality','size','mask','input_fidelity'} & body.keys()
                image_config=body['generationConfig']['imageConfig']
                if model=='gemini-2.5-flash-image':assert 'imageSize' not in image_config
                else:assert image_config['imageSize']=='1K'
                assert 'quality' not in body['generationConfig']
            print('PASS serializer + final parser + strict pixels:',model)
        # Automatic texture crops go through the same serializers; local gain
        # and restoration controls must never become native provider fields.
        for model in ('gpt-image-2.5-flare','gemini-3.1-flash-image'):
            auto_config={**config,'rois':[],'detail':dict(inputMode='combined',autoCrops=True,cropCount=2,highPassGain=3)}
            request=app.OnlineImageRequest(prompt='auto detail',provider_id='fixture',model=model,reference_images=refs,product_fidelity=auto_config)
            preview=await app.preview_product_fidelity(request)
            assert preview['detectedRois'],preview['warnings']
            assert preview['usedReferenceIds'][:2]==['other','product']
            result=await app.build_online_image_result(request)
            assert result['product_fidelity']['validationStatus']=='passed'
            url,body,content_type=calls[-1]
            if model.startswith('gpt-'):
                assert body.count(b'name="image[]"')==len(preview['reference_images'])
                assert b'autoCrops' not in body and b'highPassGain' not in body
            else:
                payload=json.loads(body)
                assert sum('inlineData' in p for p in payload['contents'][0]['parts'])==len(preview['reference_images'])
                assert not {'autoCrops','highPassGain','restoreStrength','controlnet_weight'} & payload['generationConfig'].keys()
            print('PASS automatic ROI + local-only parameters:',model)
        # The disabled path has identical transmitted multipart fields, including
        # ordered user image bytes; request IDs/boundaries naturally differ.
        def normalized_multipart(body):
            import re
            boundary=body.split(b'\r\n',1)[0]
            return re.sub(rb'xiaomei-edit-[a-f0-9]+',b'ID',body.replace(boundary,b'BOUNDARY'))
        request=app.OnlineImageRequest(prompt='ordinary',provider_id='fixture',model='gpt-image-2',reference_images=refs)
        await app.build_online_image_result(request);old=normalized_multipart(calls[-1][1])
        request.product_fidelity={'enabled':False,'mode':'bad'}
        await app.build_online_image_result(request);new=normalized_multipart(calls[-1][1])
        assert old==new,'disabled fidelity changed model payload'
        print('PASS disabled path payload equality')
        rejected=app.OnlineImageRequest(prompt='invalid',provider_id='fixture',model='gpt-image-2',reference_images=refs,product_fidelity={**config,'view':{'mode':'target','yaw':45}})
        before=len(calls)
        try:await app.build_online_image_result(rejected)
        except app.HTTPException as e:assert e.status_code==400
        else:raise AssertionError('strict angle conflict accepted')
        assert len(calls)==before
        print('PASS invalid settings rejected before paid submission')
        # Queued task uses the same production code and persists only URLs/IDs.
        request=app.OnlineImageRequest(prompt='task',provider_id='fixture',model='gpt-image-2',reference_images=refs,product_fidelity=config)
        task=await app.create_canvas_image_task(request)
        while app.CANVAS_TASKS[task['task_id']]['status'] in {'queued','running'}:await asyncio.sleep(.02)
        stored=app.CANVAS_TASKS[task['task_id']]
        assert stored['status']=='succeeded',stored.get('error')
        assert stored['request']['product_fidelity']['enabled']
        assert 'base64' not in json.dumps(stored['request'])
        assert stored['result']['product_fidelity']['validationStatus']=='passed'
        print('PASS background task persistence + history')
        # A recovery must reapply protection, even after a process restart.
        stored['upstream_task_id']='upstream-fixture'
        raw_url=app.save_product_fidelity_asset(Image.new('RGB',(512,512),'red'),'raw_recovered.png')
        recovered=await app.protect_recovered_product_result(dict(provider_id='fixture',task_id='upstream-fixture',images=[raw_url],image_items=[],params={}))
        assert recovered['product_fidelity']['validationStatus']=='passed'
        assert recovered['images'][0]!=raw_url
        print('PASS already-paid task recovery retains local protection')
        assert app.extract_images({'candidates':[{'content':{'parts':[{'thought':True,'inlineData':{'data':thought}},{'inlineData':{'data':generated}}]}}]})[0]['value']==generated
        try:app.extract_image({'candidates':[{'content':{'parts':[{'thought':True,'inlineData':{'data':thought}}]}}]})
        except app.HTTPException:pass
        else:raise AssertionError('thought-only response accepted')
        print('PASS thought-only output rejected by fallback parser')
    asyncio.run(scenario())
    with TestClient(app.app, base_url='http://127.0.0.1', client=('127.0.0.1',50000)) as client:
        # A processing node can preview before any paid model/provider is chosen.
        original_lookup=app.get_api_provider_exact
        app.get_api_provider_exact=lambda _: (_ for _ in ()).throw(AssertionError('local preview selected a provider'))
        before=len(calls)
        response=client.post('/api/product-fidelity/preview',json=dict(
            prompt='本地图片处理',local_only=True,product_fidelity=config,reference_images=refs))
        assert response.status_code==200,response.text[:300]
        local=response.json()
        assert local['paidApiCalled'] is False and len(calls)==before
        assert local['usedReferenceIds'][:2]==['other','product']
        assert len(local['reference_images'])==4
        app.get_api_provider_exact=original_lookup
        print('PASS provider-free local processing HTTP endpoint')
        for route in ['/', '/api/app-info','/api/providers','/api/history','/api/product-fidelity/capabilities?provider_id=fixture&model=gpt-image-2']:
            response=client.get(route);assert response.status_code==200,(route,response.text[:200]);print('200',route)


def isolated_run():
    source=Path(__file__).resolve().parents[1]
    with tempfile.TemporaryDirectory(prefix='xiaomei-fidelity-app-') as temporary:
        root=Path(temporary)
        for file in source.glob('*.py'):shutil.copyfile(file,root/file.name)
        (root/'static').mkdir();shutil.copyfile(source/'static/index.html',root/'static/index.html')
        shutil.copytree(source/'ComfyUI/integration',root/'ComfyUI/integration',ignore=shutil.ignore_patterns('__pycache__'))
        (root/'ComfyUI/web').mkdir()
        env={k:v for k,v in os.environ.items() if not any(word in k.upper() for word in ('API_KEY','TOKEN','SECRET','XIAOMEI','COMFY','PROVIDER'))}
        env['PYTHONIOENCODING']='utf-8'
        result=subprocess.run([sys.executable,str(Path(__file__).resolve()),'--worker',str(root)],cwd=root,env=env)
        if result.returncode:raise SystemExit(result.returncode)


if __name__=='__main__':
    if len(sys.argv)>1 and sys.argv[1]=='--worker':worker(Path(sys.argv[2]))
    else:isolated_run()
