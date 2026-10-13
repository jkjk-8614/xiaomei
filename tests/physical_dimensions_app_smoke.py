"""Production adapters and task/history persistence in a fresh temporary application."""
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
import socket
import time


def worker(root):
    sys.path.insert(0,str(root))
    import main as app
    import httpx
    import numpy as np
    from PIL import Image,ImageDraw
    from physical_dimensions import dimension_defaults
    from fastapi.testclient import TestClient
    providers={
        'gpt':dict(id='gpt',name='GPT fixture',base_url='https://api.openai.com',protocol='openai',image_request_mode='openai',model_protocols={},image_models=['gpt-image-2']),
        'google':dict(id='google',name='Google fixture',base_url='https://generativelanguage.googleapis.com',protocol='gemini',image_request_mode='openai',model_protocols={},image_models=['gemini-3.1-flash-image'])}
    app.get_api_provider=lambda id:providers[id]
    app.get_api_provider_exact=lambda id:providers[id]
    app.api_headers=lambda **_:{}
    original=httpx.AsyncClient;calls=[]
    output=Image.new('RGB',(1536,864),'#739594');buf=io.BytesIO();output.save(buf,format='PNG')
    encoded=base64.b64encode(buf.getvalue()).decode()
    def handler(request):
        calls.append((str(request.url),request.content,request.headers.get('content-type','')))
        if 'generateContent' in str(request.url):
            return httpx.Response(200,json={'candidates':[{'content':{'parts':[{'inlineData':{'mimeType':'image/png','data':encoded}}]}}]})
        return httpx.Response(200,json={'data':[{'b64_json':encoded}]})
    def client(*args,**kwargs):
        kwargs['transport']=httpx.MockTransport(handler);return original(*args,**kwargs)
    app.httpx.AsyncClient=client
    product=Image.new('RGBA',(400,500),(0,0,0,0));ImageDraw.Draw(product).rectangle((50,50,349,449),fill='#527293')
    product_url=app.save_product_fidelity_asset(product,'product.png')
    other_url=app.save_product_fidelity_asset(Image.new('RGB',(300,300),'white'),'other.png')
    refs=[dict(url=other_url,kind='image',reference_id='other'),dict(url=product_url,kind='image',reference_id='product')]
    base=dict(version=1,enabled=True,mode='structure',productReferenceId='product',detail={'enabled':False},
              dimensions={**dimension_defaults(),'enabled':True,'width':300,'height':400,'depth':20,'constraintMode':'guide'})
    async def scenario():
        for provider,model in [('gpt','gpt-image-2'),('gpt','gpt-image-2.5-flare'),('gpt','gpt-image-2.5-sunburst'),('google','gemini-3.1-flash-image'),('google','nano-banana-2')]:
            for mode in ['prompt','guide']:
                config=copy.deepcopy(base);config['dimensions']['constraintMode']=mode
                request=app.OnlineImageRequest(prompt='用户提示词保持完整，输出宽画幅',provider_id=provider,model=model,size='1536x864',aspect_ratio='16:9',reference_images=refs,product_fidelity=config)
                before=len(calls);preview=await app.preview_product_fidelity(request)
                assert len(calls)==before and preview['paidApiCalled'] is False
                result=await app.build_online_image_result(request)
                assert len(calls)==before+1
                report=result['product_fidelity']
                assert report['usedReferenceIds'][:2]==['other','product']
                assert report['normalizedDimensions']['aspectRatio']['label']=='3:4'
                assert report['geometryGuideUsed']==(mode=='guide')
                assert result['prompt']==request.prompt
                assert result['params']['aspect_ratio']=='16:9'
                assert Image.open(app.output_file_from_url(result['images'][0])).size==(1536,864)
                assert report['validations'][0]['physicalGeometry']['status']=='unknown'
                url,body,content_type=calls[-1];expected=3 if mode=='guide' else 2
                if provider=='gpt':
                    assert '/images/edits' in url and 'multipart/form-data' in content_type
                    assert body.count(b'name="image[]"')==expected
                    assert b'name="size"\r\n\r\n1536x864' in body
                    for forbidden in [b'name="physical_dimensions"',b'name="dimensions"',b'input_fidelity',b'name="mask"',b'controlnet']:
                        assert forbidden not in body
                else:
                    data=json.loads(body);parts=data['contents'][0]['parts']
                    assert sum('inlineData' in p for p in parts)==expected
                    assert data['generationConfig']['imageConfig']['aspectRatio']=='16:9'
                    assert not {'dimensions','mask','input_fidelity','quality','size'}&data['generationConfig'].keys()
                    assert request.prompt in parts[0]['text']
                print('PASS physical data -> effective model request, 3:4 product / 16:9 canvas:',provider,model,mode)
        no_ref=copy.deepcopy(base);no_ref.pop('productReferenceId');no_ref['dimensions']['depth']=None
        for mode in ['prompt','guide']:
            no_ref['dimensions']['constraintMode']=mode
            request=app.OnlineImageRequest(prompt='产品软约束',provider_id='gpt',model='gpt-image-2',size='1536x864',aspect_ratio='16:9',product_fidelity=no_ref)
            result=await app.build_online_image_result(request)
            assert any('没有原产品参考图' in s for s in result['product_fidelity']['warnings'])
            assert result['product_fidelity']['normalizedDimensions']['depth'] is None
            assert result['product_fidelity']['validations'][0]['physicalGeometry']['status']=='unknown'
        print('PASS absent product reference and unknown thickness stay honest')
        protect=copy.deepcopy(base);protect['dimensions']['constraintMode']='protect'
        request=app.OnlineImageRequest(prompt='替换背景',provider_id='gpt',model='gpt-image-2',size='1536x864',aspect_ratio='16:9',reference_images=refs,product_fidelity=protect)
        result=await app.build_online_image_result(request)
        validation=result['product_fidelity']['validations'][0]
        assert validation['maxPixelError']==0 and validation['outputCanvasPreserved']
        saved=Image.open(app.output_file_from_url(result['images'][0])).convert('RGB');x,y=validation['productOffset']
        np.testing.assert_array_equal(np.asarray(saved)[y+50:y+450,x+50:x+350],np.asarray(product.convert('RGB'))[50:450,50:350])
        assert saved.size==(1536,864)
        print('PASS Protect reuses actual core pixel composite and retains 16:9 canvas')
        request.product_fidelity['dimensions']['depth']=0;before=len(calls)
        try:await app.build_online_image_result(request)
        except app.HTTPException as e:assert e.status_code==400 and '厚度' in str(e.detail)
        else:raise AssertionError('zero accepted as unknown')
        assert len(calls)==before
        print('PASS invalid dimensions rejected before model request')
        request.product_fidelity=copy.deepcopy(base)
        task=await app.create_canvas_image_task(request)
        while app.CANVAS_TASKS[task['task_id']]['status'] in {'queued','running'}:await asyncio.sleep(.02)
        record=app.CANVAS_TASKS[task['task_id']]
        assert record['status']=='succeeded',record.get('error')
        assert record['request']['product_fidelity']['dimensions']['width']==300
        assert record['result']['product_fidelity']['geometryGuideUsed']
        persisted=json.loads(Path(app.CANVAS_TASKS_FILE).read_text(encoding='utf-8'))
        assert persisted and Path(app.HISTORY_FILE).is_file()
        print('PASS asynchronous request/result and history preserve structured constraints')
    asyncio.run(scenario())
    with TestClient(app.app,base_url='http://127.0.0.1',client=('127.0.0.1',50000)) as client:
        for route in ['/','/api/app-info','/api/providers','/api/history']:
            assert client.get(route).status_code==200
        print('PASS startup routes in temporary data directory')


def isolated_run():
    source=Path(__file__).resolve().parents[1]
    with tempfile.TemporaryDirectory(prefix='xiaomei-physical-app-') as temporary:
        root=Path(temporary)
        for file in source.glob('*.py'):shutil.copyfile(file,root/file.name)
        (root/'static').mkdir();shutil.copyfile(source/'static/index.html',root/'static/index.html')
        shutil.copytree(source/'ComfyUI/integration',root/'ComfyUI/integration',ignore=shutil.ignore_patterns('__pycache__'))
        (root/'ComfyUI/web').mkdir()
        env={k:v for k,v in os.environ.items() if not any(word in k.upper() for word in ('API_KEY','TOKEN','SECRET','XIAOMEI','COMFY','PROVIDER'))}
        env['PYTHONIOENCODING']='utf-8'
        subprocess.run([sys.executable,str(Path(__file__).resolve()),'--worker',str(root)],cwd=root,env=env,check=True)
        # Run the actual launch entry after serializer tests, still using only
        # the temporary application's configuration and assets.
        with socket.socket() as probe:
            probe.bind(('127.0.0.1',0));port=probe.getsockname()[1]
        env['XIAOMEI_CANVAS_PORT']=str(port)
        process=subprocess.Popen([sys.executable,str(root/'main.py')],cwd=root,env=env,
                                 stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,
                                 creationflags=getattr(subprocess,'CREATE_NO_WINDOW',0))
        try:
            import requests
            session=requests.Session();session.trust_env=False
            deadline=time.monotonic()+30
            while True:
                try:
                    response=session.get(f'http://127.0.0.1:{port}/',timeout=1)
                    if response.status_code==200:break
                except requests.RequestException:pass
                if process.poll() is not None:raise AssertionError('temporary main.py exited during startup')
                if time.monotonic()>deadline:raise AssertionError('temporary main.py startup timeout')
                time.sleep(.1)
            for route in ['/api/app-info','/api/providers','/api/history']:
                response=session.get(f'http://127.0.0.1:{port}{route}',timeout=5)
                assert response.status_code==200,(route,response.status_code)
            print('PASS python main.py launch and four HTTP routes in isolated temporary app')
        finally:
            process.terminate()
            try:process.wait(timeout=10)
            except subprocess.TimeoutExpired:process.kill();process.wait()

if __name__=='__main__':
    if len(sys.argv)>1 and sys.argv[1]=='--worker':worker(Path(sys.argv[2]))
    else:isolated_run()
