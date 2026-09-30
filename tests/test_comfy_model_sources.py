import hashlib
import json
import tempfile
import threading
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import MagicMock, patch
import requests
from ComfyUI.integration.comfy_model_sources import ModelSourceResolver
from ComfyUI.integration.comfy_app_runtime import ManagedRuntime
from ComfyUI.integration.comfy_apps import AppLibrary

SHA = 'a'*64
COMMIT = 'b'*40
NAME = 'example-style-v2.safetensors'
REQ = {'name': NAME, 'category': 'loras'}

def response(data):
    r = MagicMock();r.json.return_value = data;return r

def hf_data(name=NAME, digest=SHA):
    return {'sha': COMMIT, 'gated': False, 'siblings': [
        {'rfilename': 'loras/'+name, 'size': 123, 'lfs': {'sha256': digest}}]}

class ModelSourceTests(unittest.TestCase):
    def resolver(self):
        return ModelSourceResolver(threading.Event())

    def test_workflow_source_is_verified_and_pinned_to_commit(self):
        resolver = self.resolver()
        with patch.object(resolver, 'request', return_value=response(hf_data())) as request:
            result = resolver.resolve({**REQ, 'source':'https://huggingface.co/author/style/resolve/main/loras/'+NAME})
        self.assertEqual(result['status'], 'resolved')
        self.assertIn('/resolve/'+COMMIT+'/', result['download']['url'])
        self.assertEqual(result['download']['sha256'], SHA)
        self.assertEqual(request.call_count, 1)

    def test_multiple_different_hashes_are_not_auto_selected(self):
        resolver = self.resolver()
        data = hf_data();data['siblings'].append({'rfilename':'v2/loras/'+NAME,'size':321,'lfs':{'sha256':'c'*64}})
        with patch.object(resolver,'request',return_value=response(data)):
            result=resolver.resolve({**REQ,'source':'https://huggingface.co/author/style'})
        self.assertEqual(result['status'],'ambiguous');self.assertNotIn('download',result)
        with patch.object(resolver,'request',return_value=response(data)):
            result=resolver.resolve({**REQ,'source':'https://huggingface.co/author/style','sha256':SHA})
        self.assertEqual(result['status'],'resolved');self.assertEqual(result['download']['sha256'],SHA)

    def test_gated_source_does_not_stop_other_searches(self):
        resolver=self.resolver()
        def manager():
            resolver.add('https://huggingface.co/public/repo/resolve/'+COMMIT+'/'+NAME,SHA,123,'https://huggingface.co/public/repo',NAME)
        with patch.object(resolver,'request',return_value=response({'gated':'manual'})),patch.object(resolver,'manager',side_effect=manager):
            result=resolver.resolve({**REQ,'source':'https://huggingface.co/private/repo'})
        self.assertEqual(result['status'],'resolved');self.assertTrue(result['errors'])

    def test_filename_and_category_and_format_must_match(self):
        for name,category in [(NAME,'vae'),('other.safetensors','loras')]:
            resolver=self.resolver();data=hf_data(name);data['siblings'][0]['rfilename']=category+'/'+name
            with patch.object(resolver,'request',return_value=response(data)),patch.object(resolver,'manager'),patch.object(resolver,'runninghub'),patch.object(resolver,'civitai_search'),patch.object(resolver,'web_search'),patch.object(resolver,'hf_search'):
                result=resolver.resolve({**REQ,'source':'https://huggingface.co/author/repo'})
            self.assertNotIn('download',result)
        resolver=self.resolver()
        with patch.object(resolver,'request') as request:
            result=resolver.resolve({'name':'unknown-model.pkl','category':'loras'})
        request.assert_not_called();self.assertEqual(result['status'],'manual')

    def test_workflow_cannot_fetch_local_or_arbitrary_urls(self):
        for source in ['http://127.0.0.1/secrets','https://huggingface.co.evil.example/a/b','https://user:pass@huggingface.co/a/b','https://huggingface.co/a/../b']:
            resolver=self.resolver()
            with patch.object(resolver,'request') as request,patch.object(resolver,'manager'),patch.object(resolver,'runninghub'),patch.object(resolver,'civitai_search'),patch.object(resolver,'web_search'),patch.object(resolver,'hf_search'):
                result=resolver.resolve({**REQ,'source':source})
            request.assert_not_called();self.assertNotIn('download',result)

    def test_runninghub_page_without_file_is_not_downloadable(self):
        resolver=self.resolver()
        listing={'code':0,'data':{'records':[{'id':'123','versions':[{'resourceStorageName':'models/loras/'+NAME}]}]}}
        detail={'code':0,'data':{'versions':[{'resourceStorageName':'models/loras/'+NAME,'sha256':SHA}]}}
        def request(method,url,**kwargs):
            if url.endswith('/list'):return response(listing)
            self.assertEqual(kwargs['json'],{'resourceId':'123'});return response(detail)
        with patch.object(resolver,'request',side_effect=request),patch.object(resolver,'manager'),patch.object(resolver,'civitai_search'),patch.object(resolver,'web_search'),patch.object(resolver,'hf_search'):
            result=resolver.resolve(REQ)
        self.assertEqual(result['status'],'not_found');self.assertEqual(result['sha256'],SHA)
        self.assertEqual(result['links'][0]['url'],'https://www.runninghub.cn/model/public/123')

    def test_cancel_and_network_failure_are_distinct(self):
        resolver=self.resolver();resolver.cancel.set()
        with self.assertRaisesRegex(RuntimeError,'取消'):
            resolver.resolve(REQ)
        resolver=self.resolver()
        with patch.object(resolver,'request',side_effect=requests.Timeout()):
            result=resolver.resolve(REQ)
        self.assertEqual(result['status'],'not_found');self.assertGreaterEqual(len(result['errors']),4)
        self.assertTrue(all('超时' in e['reason'] for e in result['errors']))

    def test_civitai_hash_lookup_can_find_same_file_under_another_name(self):
        resolver=self.resolver()
        version={'modelId':5,'model':{'type':'LORA'},'files':[{'name':'renamed.safetensors','type':'Model','sizeKB':1,'hashes':{'SHA256':SHA},'downloadUrl':'https://civitai.com/api/download/models/42'}]}
        with patch.object(resolver,'manager'),patch.object(resolver,'runninghub'),patch.object(resolver,'web_search'),patch.object(resolver,'hf_search'),patch.object(resolver,'request',return_value=response(version)):
            result=resolver.resolve(REQ,{'sha256':SHA})
        self.assertEqual(result['status'],'resolved');self.assertEqual(result['download']['name'],NAME)

    def test_discovered_download_hash_failure_never_installs(self):
        with tempfile.TemporaryDirectory() as root:
            runtime=ManagedRuntime(root);runtime.base=Path(root)
            plan={'name':NAME,'category':'loras','url':'https://civitai.com/api/download/models/42','size_bytes':3,'sha256':SHA}
            r=MagicMock(status_code=200,headers={'Content-Length':'3'});r.iter_content.return_value=[b'abc']
            with patch('ComfyUI.integration.comfy_app_runtime.requests.get',return_value=r):
                with self.assertRaisesRegex(RuntimeError,'校验失败'):
                    runtime._download_model(plan,Path(root)/'log')
            self.assertFalse((Path(root)/'models/loras'/NAME).exists())
            plan['sha256']=hashlib.sha256(b'abc').hexdigest()
            r=MagicMock(status_code=200,headers={'Content-Length':'3'});r.iter_content.return_value=[b'abc']
            with patch('ComfyUI.integration.comfy_app_runtime.requests.get',return_value=r):
                runtime._download_model(plan,Path(root)/'log')
            self.assertEqual((Path(root)/'models/loras'/NAME).read_bytes(),b'abc')

    def test_saved_search_is_used_by_prepare_download_plan(self):
        with tempfile.TemporaryDirectory() as root:
            host=SimpleNamespace(BASE_DIR=root,CANVAS_TASKS={},CANVAS_TASK_LOCK=threading.RLock(),workflow_path_from_name=lambda n:Path(root)/n,workflow_config_path=lambda n:Path(root)/(n+'.config.json'))
            service=AppLibrary(host);service.runtime.base=Path(root)/'base'
            graph={'1':{'class_type':'LoraLoaderModelOnly','inputs':{'lora_name':NAME}}}
            identity='a'*32
            service.save({'id':identity,'title':'Test','source':graph,'api':graph,'workflow':'custom/test.json','fields':[]})
            plan={'name':NAME,'category':'loras','source':'https://huggingface.co/a/b','url':'https://huggingface.co/a/b/resolve/'+COMMIT+'/'+NAME,'sha256':SHA,'size_bytes':123,'size_note':'123 bytes'}
            with patch('ComfyUI.integration.comfy_apps.ModelSourceResolver.resolve',return_value={'status':'resolved','download':plan}):
                item=service.find_missing_models(identity,lambda s:None)
            dependencies=service._dependency_preflight(item)
            self.assertEqual(service._auto_model_downloads(item,{'dependencies':dependencies}),[plan])
            self.assertEqual(service.read(identity)['source'],graph)
