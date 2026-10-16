import copy
import hashlib
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import numpy as np
from PIL import Image, ImageDraw

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import product_fidelity as pf


class FidelityTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='保真测试-')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        source = Image.new('RGBA', (160, 120), (0, 0, 0, 0))
        draw = ImageDraw.Draw(source)
        draw.rectangle((20, 20, 139, 99), fill=(150, 170, 180), outline='white', width=4)
        draw.text((44, 50), 'XM 4:3', fill='black')
        source.save(self.root/'source.png')
        Image.new('RGBA',(160,120),'blue').save(self.root/'other.png')
        self.refs = [dict(url='/other.png',kind='image',reference_id='other'), dict(url='/source.png',kind='image',reference_id='product')]
        self.config = dict(enabled=True,mode='strict',productReferenceId='product',geometry='plane',
                           detail=dict(inputMode='combined'),rois=[dict(x=.125,y=.167,w=.25,h=.25)])
        self.caps = pf.capabilities(dict(id='fixture',base_url='https://api.openai.com'), 'gpt-image-2', 'openai','openai')

    def resolve(self,url): return str(self.root/url.lstrip('/'))
    def save(self,image,name,cached=False):
        image.save(self.root/name)
        return '/'+name
    def prepare(self,**changes):
        return pf.preprocess(self.refs,{**self.config,**changes},self.caps,self.resolve,self.save)

    def test_original_order_and_stable_ids_are_preserved(self):
        result=self.prepare()
        self.assertEqual(result['usedReferenceIds'][:2],['other','product'])
        self.assertEqual(result['reference_images'][2]['parentReferenceId'],'product')
        self.assertTrue(any('不是第一张' in s for s in result['warnings']))
        self.refs.reverse()
        second=self.prepare()
        self.assertEqual(second['usedReferenceIds'][:2],['product','other'])
        self.assertEqual(second['usedReferenceIds'][2:],result['usedReferenceIds'][2:])
        prompt=pf.prompt_for('场景',second)
        self.assertIn('图片 1：产品真实',prompt)
        self.assertIn('图片 3：高反差',prompt)

    def test_product_descriptions_reach_prompt(self):
        custom = self.prepare(category='other', categoryCustom=' 入户门垫 ',
                              geometry='custom', geometryCustom='半圆形带直边')
        prompt = pf.prompt_for('换背景', custom)
        self.assertIn('用户确认的产品类型：入户门垫', prompt)
        self.assertIn('用户确认的产品形状：半圆形带直边', prompt)
        preset = self.prepare(category='textile', geometry='oval', categoryCustom='旧类型', geometryCustom='旧形状')
        prompt = pf.prompt_for('换背景', preset)
        self.assertIn('用户确认的产品类型：地毯／布艺／家纺', prompt)
        self.assertIn('用户确认的产品形状：椭圆形平面', prompt)
        self.assertNotIn('旧类型', prompt)
        self.assertNotIn('旧形状', prompt)
        for value in [[], '字'*121]:
            with self.assertRaisesRegex(ValueError, '120 字'):
                self.prepare(category='other', categoryCustom=value)

    def test_disabled_modules_do_not_apply_stored_settings(self):
        result=self.prepare(category='other',categoryCustom='旧描述',identification={'enabled':False},
                            structure={'enabled':False,'lockRatio':True},
                            generation={'enabled':False,'allowedEdits':'background'},
                            detail={'enabled':False,'restoreMode':'auto'},validation={'enabled':False},
                            advanced={'enabled':False},maskFeatherPx=8,alignmentThreshold=.99)
        config=result['config']
        self.assertEqual(config['mode'],'structure')
        self.assertFalse(config['structure']['lockRatio'])
        self.assertEqual(config['detail']['restoreMode'],'off')
        self.assertEqual(config['maskFeatherPx'],0)
        self.assertEqual(config['alignmentThreshold'],.85)
        self.assertFalse(any(a['role'] in {'highpass','detail-crop'} for a in result['generatedAssets']))
        prompt=pf.prompt_for('场景',result)
        self.assertNotIn('旧描述',prompt)
        self.assertNotIn('保持产品实体长宽比例',prompt)
        self.assertNotIn('允许改变背景和环境光',prompt)
        view=self.prepare(mode='view',view={'enabled':False,'mode':'target','yaw':45,'proxyEnabled':True},
                          generation={'allowedEdits':'view'})
        self.assertEqual(view['config']['mode'],'structure')
        self.assertEqual(view['config']['view']['yaw'],0)
        self.assertNotIn('目标视角',pf.prompt_for('场景',view))

    def test_dimensions_do_not_reenable_disabled_structure(self):
        dims=dict(version=2,enabled=True,width=300,height=400,depth=20,unit='mm',
                  constraintMode='prompt',aspectRatioLock=True,outlineLock=True)
        result=self.prepare(mode='structure',structure={'enabled':False,'lockRatio':True,'lockOutline':True},dimensions=dims)
        self.assertFalse(result['config']['structure']['lockRatio'])
        self.assertFalse(result['config']['structure']['lockOutline'])
        prompt=pf.prompt_for('场景',result)
        self.assertNotIn('保持产品实体长宽比例',prompt)
        self.assertIn('锁定产品正面宽高比',prompt)
        protected=self.prepare(structure={'enabled':False},dimensions={**dims,'constraintMode':'protect'})
        self.assertEqual(protected['config']['mode'],'strict')
        self.assertFalse(protected['config']['structure']['lockRatio'])
        self.assertFalse(protected['config']['structure']['lockOutline'])
        hidden=self.prepare(identification={'enabled':False},dimensions=dims)
        self.assertNotIn('用户提供的产品物理尺寸',pf.prompt_for('场景',hidden))

    def test_source_is_not_modified_and_cache_tracks_radius(self):
        before=hashlib.sha256((self.root/'source.png').read_bytes()).digest()
        a=self.prepare()['generatedAssets']
        b=self.prepare(detail=dict(inputMode='combined',highPassRadiusPx=7))['generatedAssets']
        ah=next(x for x in a if x['role']=='highpass');bh=next(x for x in b if x['role']=='highpass')
        self.assertNotEqual(ah['url'],bh['url'])
        self.assertNotEqual((self.root/ah['url'].lstrip('/')).read_bytes(),(self.root/bh['url'].lstrip('/')).read_bytes())
        self.assertEqual(before,hashlib.sha256((self.root/'source.png').read_bytes()).digest())

    def test_uniform_highpass_is_neutral_gray(self):
        for color in ('white','black',(131,74,23)):
            hp=pf.highpass(Image.new('RGB',(45,25),color).convert('RGBA'),2)
            self.assertEqual(hp.getextrema(),((128,128),)*3)

    def test_roi_is_original_pixels_without_upscaling(self):
        result=self.prepare()
        crop=next(x for x in result['generatedAssets'] if x['role']=='detail-crop')
        image=pf.load_image(crop['url'],self.resolve)
        source=pf.load_image('/source.png',self.resolve)
        self.assertEqual(image.tobytes(),source.crop(pf.crop_box(self.config['rois'][0],source.size)).tobytes())

    def test_boxed_product_area_uses_the_same_mask_as_paint(self):
        source=pf.load_image('/source.png',self.resolve)
        strokes=[{'rect':[.25,.25,.5,.5]}]
        mask=pf.product_mask(source,{'maskStrokes':strokes},self.resolve)
        self.assertEqual(mask.getpixel((80,60)),255)
        self.assertEqual(mask.getpixel((25,25)),0)
        erased=pf.product_mask(source,{'maskStrokes':strokes+[{'points':[[.5,.5]],'width':.1,'erase':True}]},self.resolve)
        self.assertEqual(erased.getpixel((80,60)),0)
        for rect in ([.9,.2,.2,.2],[-.1,.2,.2,.2],[.2,.2,0,.2]):
            with self.assertRaisesRegex(ValueError,'商品保护框'):
                pf.product_mask(source,{'maskStrokes':[{'rect':rect}]},self.resolve)

    def test_automatic_crops_use_masked_texture_original_pixels_and_manual_priority(self):
        rng=np.random.default_rng(8)
        source=Image.new('RGBA',(600,400),'red')
        texture=Image.fromarray(rng.integers(15,235,(200,250,3),dtype='uint8')).convert('RGBA')
        source.paste(texture,(200,100));source.save(self.root/'source.png')
        mask=Image.new('L',source.size,0);ImageDraw.Draw(mask).rectangle((200,100,449,299),fill=255)
        mask.save(self.root/'auto-mask.png')
        manual=dict(x=.35,y=.3,w=.1,h=.15)
        result=self.prepare(maskUrl='/auto-mask.png',rois=[manual],detail=dict(inputMode='crops',autoCrops=True,cropCount=3))
        self.assertEqual(len(result['detectedRois']),2)
        crops=[x for x in result['reference_images'] if x.get('role')=='detail-crop']
        self.assertEqual(len(crops),3)
        self.assertEqual(pf.load_image(crops[0]['url'],self.resolve).tobytes(),source.crop(pf.crop_box(manual,source.size)).tobytes())
        for roi,crop in zip(result['detectedRois'],crops[1:]):
            box=pf.crop_box(roi,source.size)
            self.assertGreaterEqual(box[0],200);self.assertLessEqual(box[2],450)
            self.assertGreaterEqual(box[1],100);self.assertLessEqual(box[3],300)
            self.assertEqual(crop['parentReferenceId'],'product')
            self.assertEqual(pf.load_image(crop['url'],self.resolve).tobytes(),source.crop(box).tobytes())
        self.assertEqual(result['usedReferenceIds'][:2],['other','product'])

    def test_automatic_crops_do_not_invent_detail_or_replace_manual_rois(self):
        source=Image.new('RGBA',(200,150),'white')
        self.assertEqual(pf.detect_detail_rois(source,None),[])
        self.assertEqual(pf.detect_detail_rois(source,None,count=0),[])
        result=self.prepare(detail=dict(inputMode='crops',autoCrops=True,cropCount=1))
        self.assertEqual(result['detectedRois'],[])
        self.assertEqual(len([x for x in result['reference_images'] if x.get('role')=='detail-crop']),1)
        self.caps['applicationReferenceLimit']=2
        result=self.prepare(rois=[],detail=dict(inputMode='combined',autoCrops=True))
        self.assertEqual(result['usedReferenceIds'],['other','product'])
        self.assertTrue(any('仅附加 0' in w for w in result['warnings']))

    def test_highpass_gain_changes_local_output_and_is_validated(self):
        result=self.prepare(detail=dict(inputMode='highpass',highPassGain=.5))
        other=self.prepare(detail=dict(inputMode='highpass',highPassGain=4))
        a=next(x for x in result['generatedAssets'] if x['role']=='highpass')
        b=next(x for x in other['generatedAssets'] if x['role']=='highpass')
        self.assertNotEqual(a['url'],b['url'])
        self.assertNotEqual(pf.load_image(a['url'],self.resolve).tobytes(),pf.load_image(b['url'],self.resolve).tobytes())
        for detail in (dict(highPassGain=5),dict(autoCrops='yes')):
            with self.assertRaises(ValueError):self.prepare(detail=detail)

    def test_strict_core_pixels_are_exact_and_background_changes(self):
        result=self.prepare()
        output,validation=pf.composite(result['source'],result['mask'],Image.new('RGB',(320,240),'green'))
        core=np.asarray(result['mask'])==255
        np.testing.assert_array_equal(np.asarray(output.convert('RGB'))[core],np.asarray(result['source'].convert('RGB'))[core])
        self.assertEqual(output.getpixel((0,0)),(0,128,0,255))
        self.assertEqual(validation['maxPixelError'],0)
        self.assertEqual(output.size,(160,120))

    def test_strict_requires_mask_before_any_model_call(self):
        config={**self.config,'productReferenceId':'other'}
        with self.assertRaisesRegex(ValueError,'严格保真需要'):
            self.prepare(**config)

    def test_hand_mask_draw_and_erase_are_real(self):
        config=dict(maskStrokes=[dict(points=[[.2,.5],[.8,.5]],width=.2),dict(points=[[.5,.5]],width=.05,erase=True)])
        result=self.prepare(productReferenceId='other',**config)
        self.assertEqual(result['mask'].getpixel((40,60)),255)
        self.assertEqual(result['mask'].getpixel((80,60)),0)

    def test_empty_and_mismatched_mask_are_rejected(self):
        Image.new('RGB',(160,120),'black').save(self.root/'mask.png')
        with self.assertRaisesRegex(ValueError,'蒙版为空'):self.prepare(maskUrl='/mask.png')
        Image.new('RGB',(20,20),'white').save(self.root/'mask.png')
        with self.assertRaisesRegex(ValueError,'尺寸不一致'):self.prepare(maskUrl='/mask.png')

    def test_budget_discards_only_derived_images(self):
        self.caps['applicationReferenceLimit']=2
        result=self.prepare()
        self.assertEqual(result['usedReferenceIds'],['other','product'])
        self.assertTrue(any('仅附加 0' in s for s in result['warnings']))
        self.caps['applicationReferenceLimit']=1
        with self.assertRaisesRegex(ValueError,'不会被丢弃'):self.prepare()

    def test_disabled_mode_is_inert_even_with_invalid_fields(self):
        self.assertIsNone(pf.preprocess([],dict(enabled=False,mode='bad'),{},None,None))

    def test_stale_id_and_duplicate_id_are_rejected(self):
        with self.assertRaisesRegex(ValueError,'移除或替换'):self.prepare(productReferenceId='missing')
        self.refs[0]['reference_id']='product'
        with self.assertRaisesRegex(ValueError,'身份缺失或重复'):self.prepare()

    def test_strict_view_and_paid_retry_conflicts_are_rejected(self):
        for changes in [dict(view=dict(mode='target',yaw=45)),dict(generation=dict(allowedEdits='lighting')),dict(retries=dict(enabled=True))]:
            with self.subTest(changes=changes),self.assertRaises(ValueError):self.prepare(**changes)

    def test_wrong_output_ratio_and_no_opaque_core_are_rejected(self):
        result=self.prepare()
        with self.assertRaisesRegex(ValueError,'比例偏差'):pf.composite(result['source'],result['mask'],Image.new('RGB',(160,160)))
        with self.assertRaisesRegex(ValueError,'核心保护'):pf.composite(result['source'],Image.new('L',(160,120),128),Image.new('RGB',(160,120)))

    def test_new_view_never_restores_old_frequency_or_uses_bbox_ratio(self):
        result=self.prepare(mode='view',view=dict(mode='target',yaw=45))
        output=Image.new('RGBA',(160,160),'red')
        final,validation=pf.align_details(result['source'],output,result['mask'],result['config'])
        self.assertEqual(final.tobytes(),output.tobytes())
        self.assertEqual(validation['status'],'unknown')
        self.assertEqual(validation['restoration'],'skipped')
        self.assertNotIn('ratioDeviation',validation)

    def test_low_information_does_not_pass_alignment(self):
        result=self.prepare(mode='structure')
        output=Image.new('RGBA',(160,120),'red')
        final,validation=pf.align_details(result['source'],output,result['mask'],result['config'])
        self.assertEqual(validation['status'],'unknown')
        self.assertEqual(final.tobytes(),output.tobytes())

    def test_model_specific_capabilities_and_proxy_alias_uncertainty(self):
        for model in ['gpt-image-2','gpt-image-2.5-flare','gpt-image-2.5-sunburst']:
            caps=pf.capabilities(dict(id='oa',base_url='https://api.openai.com'),model,'openai','openai')
            self.assertEqual(caps['maxReferenceImages'],16)
            self.assertEqual(caps['maskEditMode'],'native-raster-mask')
            self.assertFalse(caps['supportsNativeControlNet'])
        for model in ['gemini-2.5-flash-image','gemini-3-pro-image-preview','gemini-3.1-flash-image','gemini-nano-banana-2.1','gemini-3.1-flash-lite-image']:
            caps=pf.capabilities(dict(id='gg',base_url='https://generativelanguage.googleapis.com'),model,'gemini','openai')
            self.assertTrue(caps['supported'],model)
            self.assertEqual(caps['maskEditMode'],'semantic-only')
            self.assertEqual(caps['availableQualities'],[])
        alias=pf.capabilities(dict(id='proxy'), 'nano-banana-2.1','gemini','openai')
        self.assertEqual(alias['modelId'],'nano-banana-2.1')
        self.assertIsNone(alias['maxReferenceImages'])
        self.assertFalse(alias['aliasVersionVerified'])

    def test_canvas_ratio_and_product_ratio_are_distinct(self):
        result=self.prepare()
        self.assertAlmostEqual(result['sourceCanvasRatio'],4/3)
        self.assertAlmostEqual(result['sourceRatio'],120/80)
        result=self.prepare(dimensions=dict(width=20,height=15,depth=2,unit='cm'))
        self.assertAlmostEqual(result['sourceRatio'],4/3)
        self.assertEqual(result['normalizedDimensions']['depth'],20)
        self.assertIn('前后厚度=20.0 mm',pf.prompt_for('场景',result))

    def test_planar_proxy_is_real_and_does_not_change_user_order(self):
        result=self.prepare(mode='view',view=dict(mode='target',yaw=45,proxyEnabled=True))
        self.assertEqual(result['usedReferenceIds'][:2],['other','product'])
        proxy=result['reference_images'][2]
        self.assertEqual(proxy['role'],'perspective-proxy')
        self.assertEqual(proxy['parentReferenceId'],'product')
        image=pf.load_image(proxy['url'],self.resolve)
        self.assertEqual(image.size,(1024,1024))
        self.assertNotEqual(image.getextrema()[0][0],image.getextrema()[0][1])
        other=self.prepare(mode='view',geometry='other',view=dict(mode='target',yaw=45,proxyEnabled=True))
        self.assertFalse(any(x.get('role')=='perspective-proxy' for x in other['reference_images']))
        self.assertTrue(any('已跳过' in s for s in other['warnings']))

    def test_large_angle_skips_planar_proxy_and_reaches_view_prompt(self):
        result=self.prepare(mode='view',view=dict(mode='target',yaw=180,pitch=30,framing='closeup',fov=110,proxyEnabled=True))
        self.assertFalse(any(x.get('role')=='perspective-proxy' for x in result['reference_images']))
        self.assertTrue(any('超过平面透视示意' in warning for warning in result['warnings']))
        prompt=pf.prompt_for('展示产品',result)
        for phrase in ('反向 180°','俯拍 30°','特写','鱼眼广角','不要镜像产品'):
            self.assertIn(phrase,prompt)
        near_back=self.prepare(mode='view',view=dict(mode='target',yaw=179))
        near_prompt=pf.prompt_for('展示产品',near_back)
        self.assertIn('环绕 179°',near_prompt)
        self.assertNotIn('反向 180°',near_prompt)
        with self.assertRaisesRegex(ValueError,'-180° 到 180°'):
            self.prepare(mode='view',view=dict(mode='target',yaw=181))

    def test_unimported_reference_is_rejected(self):
        self.refs[0]['url']='https://example.test/remote.png'
        with self.assertRaisesRegex(ValueError,'先保存到本地'):self.prepare()

    def test_reliable_alignment_restores_only_inside_mask(self):
        try:import cv2
        except ImportError:self.skipTest('optional OpenCV unavailable')
        rng=np.random.default_rng(42)
        source=Image.new('RGBA',(500,400),(0,0,0,0))
        texture=Image.fromarray(rng.integers(30,225,(300,400,3),dtype='uint8')).convert('RGBA')
        source.paste(texture,(50,50))
        mask=source.getchannel('A')
        target=Image.new('RGBA',source.size,'blue');target.paste(texture,(55,55))
        config=pf.normalize(dict(enabled=True,mode='structure',geometry='plane',detail=dict(restoreMode='auto'),validation=dict(enabled=True)))
        restored,validation=pf.align_details(source,target,mask,config)
        self.assertEqual(validation['restoration'],'applied',validation)
        self.assertGreater(validation['alignmentConfidence'],.85)
        self.assertEqual(restored.getpixel((0,0)),target.getpixel((0,0)))
        self.assertNotEqual(restored.tobytes(),target.tobytes())
        config['validation']['enabled']=False
        with patch.object(pf,'planar_geometry',side_effect=AssertionError('校验关闭后不应检查外框')):
            restored_without_check,validation=pf.align_details(source,target,mask,config)
        self.assertNotIn('geometry',validation)
        self.assertEqual(validation['restoration'],'applied')
        self.assertNotEqual(restored_without_check.tobytes(),target.tobytes())
        config['detail']['enabled']=False
        unchanged,validation=pf.align_details(source,target,mask,config)
        self.assertEqual(unchanged.tobytes(),target.tobytes())
        self.assertEqual(validation['restoration'],'skipped')

    def test_experimental_rectangle_check_never_claims_complete_pass(self):
        try:import cv2
        except ImportError:self.skipTest('optional OpenCV unavailable')
        mask=Image.new('L',(500,400),0);ImageDraw.Draw(mask).rectangle((80,100,379,299),fill=255)
        transform=np.array([[1.,0.,0.],[0.,1.,0.]])
        target=Image.new('RGB',(500,400),'black');ImageDraw.Draw(target).rectangle((80,100,379,299),fill='white')
        geometry=pf.planar_geometry(mask,np.asarray(target),transform)
        self.assertEqual(geometry['status'],'warning',geometry)
        ImageDraw.Draw(target).rectangle((80,100,419,299),fill='white')
        geometry=pf.planar_geometry(mask,np.asarray(target),transform)
        self.assertEqual(geometry['status'],'failed',geometry)


if __name__=='__main__':unittest.main()
