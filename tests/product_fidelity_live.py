"""Bounded live acceptance using configured channels and a synthetic product.

Run only on explicit authorization: --execute-paid-calls --output ABSOLUTE_PATH.
No credentials, prompts, private images or raw upstream responses are exported.
"""
import argparse
import asyncio
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
import time


def worker(root, output, selection):
    sys.path.insert(0,str(root))
    import main as app
    import contextvars
    import httpx
    from PIL import Image,ImageDraw
    image=Image.new('RGBA',(1024,1024),(0,0,0,0))
    draw=ImageDraw.Draw(image)
    draw.rectangle((212,282,811,741),fill='#687985',outline='#d0d5d9',width=18)
    draw.rectangle((237,307,786,716),fill='#dedbd0',outline='#303d48',width=5)
    draw.text((462,495),'XM 4:3',fill='#1a2530',stroke_width=1)
    for x,y in [(223,293),(800,293),(223,730),(800,730)]:draw.ellipse((x-3,y-3,x+3,y+3),fill='#1a2530')
    source=app.save_product_fidelity_asset(image,'fidelity_live_fixture.png')
    output.mkdir(parents=True,exist_ok=True);image.save(output/'测试商品原图.png')
    config=dict(enabled=True,version=1,mode='strict',productReferenceId='fixture-product',geometry='plane',
                structure=dict(lockRatio=True,lockOutline=True,lockLines=True),detail=dict(enabled=True,inputMode='combined',highPassRadiusPx=2,cropCount=1),
                rois=[dict(x=.43,y=.46,w=.17,h=.10)])
    previous=output/'真实调用验收.json'
    outcomes=json.loads(previous.read_text(encoding='utf-8')) if previous.is_file() else []
    current=contextvars.ContextVar('fidelity_live_item')
    async def request_hook(request):
        item=current.get(None)
        if item is not None and ('/images/edits' in request.url.path or ':generateContent' in request.url.path):
            item['actualGenerationSubmissions']=item.get('actualGenerationSubmissions',0)+1
            item['endpoint']=request.url.path
    original_client=httpx.AsyncClient
    def audited_client(*args,**kwargs):
        kwargs['event_hooks']={'request':[request_hook]}
        return original_client(*args,**kwargs)
    app.httpx.AsyncClient=audited_client
    async def execute(provider_id,model):
        name=provider_id+'_'+model
        started=time.monotonic()
        item=dict(channel=provider_id,modelId=model,requestedCalls=1,actualGenerationSubmissions=0,automaticRetries=False,costEstimate=None)
        token=current.set(item)
        try:
            provider=app.get_api_provider_exact(provider_id)
            request=app.OnlineImageRequest(prompt='将参考相框放在简洁的浅蓝色摄影背景中。产品保持原图同视角、同位置、同大小，底部添加柔和接触阴影。不要添加另一个产品。',
                provider_id=provider_id,model=model,size='1024x1024',quality='low',n=1,reference_images=[dict(url=source,name='synthetic frame',kind='image',reference_id='fixture-product')],product_fidelity=config)
            context=await app.preview_product_fidelity(request)
            item['transport']=context['modelCapabilities']['transport']
            item['submittedReferences']=[dict(order=i+1,id=r['reference_id'],role=r.get('role') or 'product') for i,r in enumerate(context['reference_images'])]
            item['channelAliasVersionVerified']=context['modelCapabilities']['aliasVersionVerified']
            result=await asyncio.wait_for(app.build_online_image_result(request),timeout=480)
            item.update(status='succeeded',validationStatus=result['product_fidelity']['validationStatus'],validations=result['product_fidelity']['validations'],warnings=result['product_fidelity']['warnings'])
            for index,meta in enumerate(result['image_items'],1):
                destination=output/(name+f'_{index}_严格合成.png')
                shutil.copyfile(app.output_file_from_url(meta['url']),destination)
                raw=meta.get('product_fidelity_model_output')
                if raw:shutil.copyfile(app.output_file_from_url(raw),output/(name+f'_{index}_模型原始输出.png'))
            item['outputCount']=len(result['images'])
            # Store token accounting only when provided by the actual channel.
            usage=result.get('raw_usage')
            if isinstance(usage,dict):item['usage']={k:v for k,v in usage.items() if isinstance(v,(int,float))}
        except Exception as exc:
            detail=str(getattr(exc,'detail',None) or exc)
            for provider_id_to_redact in ('api-6789','comfly'):
                secret=app.provider_env_key_value(provider_id_to_redact)
                if secret:detail=detail.replace(secret,'[redacted]')
            detail=re.sub(r'https?://[^\s；。]+','[upstream-url]',detail)
            item.update(status='failed',error=detail[:800])
        item['elapsedSeconds']=round(time.monotonic()-started,2)
        current.reset(token)
        outcomes.append(item)
        (output/'真实调用验收.json').write_text(json.dumps(outcomes,ensure_ascii=False,indent=2),encoding='utf-8')
        print(json.dumps(item,ensure_ascii=False),flush=True)
    async def scenario():
        # Parallel, independent single submissions; each uses its model/channel.
        await asyncio.gather(*(execute(p,m) for p,m in selection))
    asyncio.run(scenario())


def run(output, remaining=False):
    source=Path(__file__).resolve().parents[1]
    providers=json.loads((source/'data/api_providers.json').read_text(encoding='utf-8'))
    desired=([('api-6789','gemini-3-pro-image-preview'),('api-6789','gemini-3.1-flash-image'),('comfly','nano-banana-2')]
             if remaining else [('api-6789','gpt-image-2'),('api-6789','gpt-image-2.5-flare'),('api-6789','gpt-image-2.5-sunburst'),('api-6789','nano-banana-2.1'),('comfly','gemini-3.1-flash-image-preview')])
    selection=[(p,m) for p,m in desired if any(x['id']==p and x.get('enabled',True) and m in x.get('image_models',[]) for x in providers)]
    with tempfile.TemporaryDirectory(prefix='xiaomei-fidelity-live-') as temporary:
        root=Path(temporary)
        for file in source.glob('*.py'):shutil.copyfile(file,root/file.name)
        (root/'static').mkdir();shutil.copyfile(source/'static/index.html',root/'static/index.html')
        shutil.copytree(source/'ComfyUI/integration',root/'ComfyUI/integration',ignore=shutil.ignore_patterns('__pycache__'))
        (root/'ComfyUI/web').mkdir();(root/'data').mkdir()
        (root/'data/api_providers.json').write_text(json.dumps(providers,ensure_ascii=False),encoding='utf-8')
        env={k:v for k,v in os.environ.items() if not any(word in k.upper() for word in ('API_KEY','TOKEN','SECRET','XIAOMEI','COMFY','PROVIDER'))}
        allowed={'COMFLY_API_KEY','API_PROVIDER_API_6789_KEY'}
        # Keys stay in process environment and are never written into the copy.
        for line in (source/'API/.env').read_text(encoding='utf-8-sig').splitlines():
            if '=' not in line or line.strip().startswith('#'):continue
            k,v=line.split('=',1);k=k.strip()
            if k in allowed:env[k]=v.strip().strip('"').strip("'")
        env.update(PYTHONIOENCODING='utf-8',CANVAS_LLM_RETRIES='0',GPT_IMAGE2_EDIT_TRANSPORT_RETRIES='0',GPT_IMAGE2_EDIT_IDEMPOTENCY_SUPPORTED='0')
        env['NO_PROXY']=env['no_proxy']='127.0.0.1,localhost'
        result=subprocess.run([sys.executable,str(Path(__file__).resolve()),'--worker',str(root),str(output),json.dumps(selection)],cwd=root,env=env)
        if result.returncode:raise SystemExit(result.returncode)


if __name__=='__main__':
    if len(sys.argv)>1 and sys.argv[1]=='--worker':worker(Path(sys.argv[2]),Path(sys.argv[3]),json.loads(sys.argv[4]))
    else:
        parser=argparse.ArgumentParser();parser.add_argument('--execute-paid-calls',action='store_true');parser.add_argument('--remaining-configured-models',action='store_true');parser.add_argument('--output',type=Path,required=True)
        args=parser.parse_args()
        if not args.execute_paid_calls:parser.error('Live model calls require --execute-paid-calls')
        run(args.output.resolve(),args.remaining_configured_models)
