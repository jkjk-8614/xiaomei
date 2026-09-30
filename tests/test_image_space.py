import json
import tempfile
import unittest
from fastapi.testclient import TestClient
from image_space_support import build_app
from image_space import replace_ai


class ImageSpaceTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix='图片空间测试-')
        self.app, self.ns, self.library = build_app(self.directory.name)
        self.client = TestClient(self.app)

    def tearDown(self):
        self.client.close()
        self.directory.cleanup()

    def test_combination_filters_before_pagination(self):
        response = self.client.get('/api/storage-files',params={'filters':json.dumps({'color':'金色,黑色','materials':'金属','shape':'portrait','min_edge':300}),'limit':20})
        self.assertEqual(response.status_code,200)
        data=response.json()
        self.assertEqual(data['total'],1)
        self.assertEqual(data['items'][0]['name'],'相框24.png')
        self.assertFalse(data['has_more'])
        self.assertEqual(self.client.get('/api/storage-files',params={'filters':'bad'}).status_code,422)
        self.assertEqual(self.client.get('/api/storage-files',params={'filters':'{"min_edge":-1}'}).status_code,422)

    def test_collections_persist_update_delete_without_touching_assets(self):
        payload={'name':'金色主图','source':'assets','library_id':'default','filters':{'color':'金色'}}
        response=self.client.post('/api/image-space/collections',json=payload)
        self.assertEqual(response.status_code,200)
        ident=response.json()['item']['id']
        payload['name']='竖版金色主图';payload['filters']['shape']='portrait'
        self.assertEqual(self.client.patch('/api/image-space/collections/'+ident,json=payload).status_code,200)
        with open(self.directory.name+'/image_space_collections.json',encoding='utf-8') as handle:
            self.assertEqual(json.load(handle)[0]['name'],'竖版金色主图')
        self.assertEqual(self.client.delete('/api/image-space/collections/'+ident).json()['collections'],[])
        self.assertEqual(len(self.library['libraries'][0]['categories'][0]['items']),4)
        self.assertEqual(self.client.patch('/api/image-space/collections/missing',json=payload).status_code,404)
        payload['name']=' '
        self.assertEqual(self.client.post('/api/image-space/collections',json=payload).status_code,400)

    def test_manual_changes_survive_ai_reanalysis_and_clear_fields(self):
        payload={'source':'assets','id':'asset_0','manual':{'tags':['精选'],'categories':{'color':['金色'],'materials':[]},'summary':'人工说明'}}
        response=self.client.patch('/api/image-space/classification',json=payload)
        self.assertEqual(response.status_code,200)
        old=response.json()['classification']
        new=replace_ai(old,{'summary':'新的 AI 说明','tags':['AI 标签'],'categories':{'color':['黑色'],'materials':['塑料'],'subject':['相框']}},self.ns['_normalize_asset_classification_fields'])
        self.assertEqual(new['tags'],['精选'])
        self.assertEqual(new['categories']['color'],['金色'])
        self.assertNotIn('materials',new['categories'])
        self.assertEqual(new['categories']['subject'],['相框'])
        self.assertEqual(new['summary'],'人工说明')
        self.library['libraries'][0]['categories'][0]['items'][0]['classification']=new
        payload['manual']=None
        restored=self.client.patch('/api/image-space/classification',json=payload).json()['classification']
        self.assertEqual(restored['tags'],['AI 标签'])
        self.assertEqual(restored['categories']['color'],['黑色'])

    def test_edit_during_ai_request_is_preserved_and_removed_asset_not_restored(self):
        async def analyse_with_manual_edit(*args):
            self.library['libraries'][0]['categories'][0]['items'][0]['classification']['manual'] = {'tags':['分析中手动编辑']}
            return {'tags':['AI 新标签'],'categories':{'color':['黑色']}}
        self.ns['classify_image_with_provider'] = analyse_with_manual_edit
        response = self.client.post('/api/asset-library/items/classify',json={'ids':['asset_0'],'library_id':'default'})
        self.assertEqual(response.status_code,200)
        self.assertEqual(response.json()['items'][0]['classification']['tags'],['分析中手动编辑'])
        async def analyse_after_removal(*args):
            items = self.library['libraries'][0]['categories'][0]['items']
            items[:] = [item for item in items if item['id'] != 'asset_0']
            return {'tags':['AI 新标签']}
        self.ns['classify_image_with_provider'] = analyse_after_removal
        response = self.client.post('/api/asset-library/items/classify',json={'ids':['asset_0'],'library_id':'default'})
        self.assertEqual(response.json()['count'],0)
        self.assertFalse(any(item['id']=='asset_0' for item in self.library['libraries'][0]['categories'][0]['items']))

    def test_local_and_generated_edits_roundtrip_and_invalid_input(self):
        for source,ident in [('local','相框00.png'),('generated','generated:相框00.png')]:
            response=self.client.patch('/api/image-space/classification',json={'source':source,'id':ident,'manual':{'tags':['人工标签']}})
            self.assertEqual(response.status_code,200)
        self.ns['_write_local_upload_classification']('相框00.png',{'tags':['重新分析']})
        self.assertEqual(self.ns['_read_local_upload_classification']('相框00.png')['tags'],['人工标签'])
        data=self.client.get('/api/storage-files',params={'filters':json.dumps({'tags':'人工标签'})}).json()
        self.assertEqual(data['total'],1)
        self.assertEqual(self.client.patch('/api/image-space/classification',json={'source':'assets','id':'missing','manual':{}}).status_code,404)
        self.assertEqual(self.client.patch('/api/image-space/classification',json={'source':'local','id':'../outside.png','manual':{}}).status_code,400)
        self.assertEqual(self.client.patch('/api/image-space/classification',json={'source':'assets','id':'asset_0','manual':{'tags':'wrong'}}).status_code,400)


if __name__ == '__main__': unittest.main()
