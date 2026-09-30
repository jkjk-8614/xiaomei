import json,struct,tempfile,threading,unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
from fastapi import FastAPI,HTTPException
from fastapi.testclient import TestClient
from ComfyUI.integration.comfy_apps import install_comfy_apps

OLD='z-image-Turbo-细节增强v2.safetensors'
NEW='Z-Detail-Slider.safetensors'
def weights(lora=True):
 h=json.dumps({'model.lora_A.weight' if lora else 'model.weight':{'dtype':'F32','shape':[1],'data_offsets':[0,4]}}).encode()
 return struct.pack('<Q',len(h))+h+b'1234'

class ReplacementTests(unittest.TestCase):
 def setUp(self):
  self.temp=tempfile.TemporaryDirectory();self.root=Path(self.temp.name);self.identity='a'*32
  self.host=SimpleNamespace(BASE_DIR=self.root,CANVAS_TASKS={},CANVAS_TASK_LOCK=threading.RLock(),workflow_path_from_name=lambda n:self.root/n,workflow_config_path=lambda n:self.root/(n+'.config.json'))
  self.app=FastAPI();self.service=install_comfy_apps(self.app,self.host);self.service.runtime.base=self.root/'base'
  self.graph={'13':{'class_type':'LoraLoaderModelOnly','inputs':{'lora_name':OLD,'strength_model':1}},'14':{'class_type':'CLIPTextEncode','inputs':{'text':OLD}}}
  self.source={'nodes':[{'id':13,'type':'LoraLoaderModelOnly','widgets_values':[OLD,1],'properties':{'models':[{'name':OLD,'url':'https://example.com/old','directory':'loras'}]}},{'id':14,'type':'CLIPTextEncode','widgets_values':[OLD]}],'links':[]}
  self.service.save({'id':self.identity,'title':'Test','description':'Test','source':self.source,'api':self.graph,'fields':[],'workflow':'custom/test.json'})
  self.mock=patch.object(self.service,'backend',side_effect=HTTPException(503,'offline'));self.mock.start()
  self.client=TestClient(self.app);self.client.__enter__()
  self.base='/api/comfy-apps/'+self.identity
 def tearDown(self):
  self.client.__exit__(None,None,None);self.mock.stop();self.temp.cleanup()
 def test_upload_replaces_references_and_preserves_original_and_strength(self):
  r=self.client.post(self.base+'/models/import',data={'dependency':OLD,'category':'loras','replace':'true'},files={'file':(NEW,weights())})
  self.assertEqual(r.status_code,200,r.text)
  item=self.service.read(self.identity)
  self.assertEqual(item['api']['13']['inputs']['lora_name'],NEW)
  self.assertEqual(item['api']['13']['inputs']['strength_model'],1)
  self.assertEqual(item['source']['nodes'][0]['widgets_values'],[NEW,1])
  self.assertEqual(item['source']['nodes'][0]['properties']['models'],[])
  self.assertEqual(item['api']['14']['inputs']['text'],OLD)
  self.assertEqual(item['source']['nodes'][1]['widgets_values'],[OLD])
  self.assertEqual(item['model_replacement_original']['source'],self.source)
  self.assertEqual(item['model_replacement_original']['api'],self.graph)
  self.assertTrue((self.root/'base/models/loras'/NEW).exists())
  self.assertFalse((self.root/'base/models/loras'/OLD).exists())
 def test_original_import_still_requires_original_name(self):
  r=self.client.post(self.base+'/models/import',data={'dependency':OLD,'category':'loras'},files={'file':(NEW,weights())})
  self.assertEqual(r.status_code,400)
 def test_existing_expected_model_is_rechecked_without_overwrite(self):
  destination=self.root/'base/models/loras'/OLD;destination.parent.mkdir(parents=True)
  existing=weights();destination.write_bytes(existing)
  item=self.service.read(self.identity)
  item['report']['missing_models']=[OLD]
  item['report']['reasons']=['需要下载模型：'+OLD]
  self.service.save(item)
  r=self.client.post(self.base+'/models/import',data={'dependency':OLD,'category':'loras'},files={'file':(OLD,b'not copied')})
  self.assertEqual(r.status_code,200,r.text)
  self.assertTrue(r.json()['already_present'])
  self.assertEqual(destination.read_bytes(),existing)
  self.assertEqual(r.json()['item']['report']['missing_models'],[])
  self.assertNotIn('需要下载模型：'+OLD,r.json()['item']['report']['reasons'])
 def test_base_model_replacement_does_not_change_same_name_in_other_category(self):
  graph={'1':{'class_type':'VAELoader','inputs':{'vae_name':OLD}},'2':{'class_type':'LoraLoaderModelOnly','inputs':{'lora_name':OLD}}}
  item=self.service.read(self.identity);item.update(api=graph,source=graph);self.service.save(item)
  r=self.client.post(self.base+'/models/import',data={'dependency':OLD,'category':'vae','replace':'true'},files={'file':('new-vae.safetensors',weights(False))})
  self.assertEqual(r.status_code,200,r.text)
  item=self.service.read(self.identity)
  self.assertEqual(item['api']['1']['inputs']['vae_name'],'new-vae.safetensors')
  self.assertEqual(item['api']['2']['inputs']['lora_name'],OLD)
 def test_existing_model_selection_and_stale_reference(self):
  path=self.root/'base/models/loras'/NEW;path.parent.mkdir(parents=True);path.write_bytes(weights())
  r=self.client.get(self.base+'/models/replacements',params={'dependency':OLD,'category':'loras'})
  self.assertEqual(r.json()['models'],[NEW])
  r=self.client.post(self.base+'/models/replace',json={'dependency':OLD,'category':'loras','replacement':NEW})
  self.assertEqual(r.status_code,200,r.text)
  r=self.client.post(self.base+'/models/replace',json={'dependency':OLD,'category':'loras','replacement':NEW})
  self.assertEqual(r.status_code,400)
 def test_wrong_category_busy_and_path_traversal_do_not_edit_graph(self):
  for category,target in [('vae',NEW),('loras','../../escape.safetensors')]:
   r=self.client.post(self.base+'/models/replace',json={'dependency':OLD,'category':category,'replacement':target})
   self.assertEqual(r.status_code,400)
  self.host.CANVAS_TASKS['busy']={'app_id':self.identity,'status':'running'}
  r=self.client.post(self.base+'/models/import',data={'dependency':OLD,'category':'loras','replace':'true'},files={'file':(NEW,weights())})
  self.assertEqual(r.status_code,409)
  self.assertEqual(self.service.read(self.identity)['api'],self.graph)
 def test_wrong_weights_and_truncated_upload_are_rejected(self):
  for data in [weights(False),weights()[:-2],b'not weights',struct.pack('<Q',2)+b'[]']:
   r=self.client.post(self.base+'/models/import',data={'dependency':OLD,'category':'loras','replace':'true'},files={'file':(NEW,data)})
   self.assertEqual(r.status_code,400,r.text)
   self.assertFalse((self.root/'base/models/loras'/NEW).exists())
  self.assertEqual(self.service.read(self.identity)['api'],self.graph)
