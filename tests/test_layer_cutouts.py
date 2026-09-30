import asyncio
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace

import numpy as np
from PIL import Image, ImageDraw

from canvas_layer_cutouts import color_mask, merge_completion, prepare_cutouts, validate_cutout_plan
from canvas_image_layers import LayerService, validate_plan


class CutoutTests(unittest.IsolatedAsyncioTestCase):
    def test_matching_text_colors_stay_opaque(self):
        source=Image.new('RGB',(8,8),(255,230,180))
        region=dict(polygon=[[0,0],[1000,0],[1000,1000],[0,1000]],colors=['#FFF2DC'],tolerance=55)
        self.assertEqual(color_mask(source,region).getextrema(),(255,255))
        source.paste('darkred',(0,0,4,4))
        self.assertEqual(color_mask(source,region).getpixel((0,0)),0)

    async def test_product_under_text_fills_only_the_occluded_region(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp);out=root/'output';out.mkdir()
            source=Image.new('RGBA',(100,100),'navy')
            draw=ImageDraw.Draw(source);draw.rectangle((20,20,79,79),fill='red');draw.rectangle((35,40,64,49),fill='white')
            source.save(out/'source.png')
            local_calls=[]
            async def ready():return {},'already-installed'
            def remove(path,model,model_path,auto_center):
                local_calls.append(auto_center)
                image=Image.open(path).convert('RGBA')
                a=np.asarray(image);image.putalpha(Image.fromarray(((a[:,:,0]>100)*255).astype('uint8')))
                return image,{}
            host=SimpleNamespace(DATA_DIR=root/'data',OUTPUT_DIR=out,
                local_media_path_from_url=lambda url:root/url.lstrip('/').split('?')[0],
                _ready_background_removal_model=ready,_remove_background_image_from_path=remove)
            service=LayerService(host)
            layers=[
                dict(id='layer-1',name='background',transparent=False,extraction='background',regions=[],occluded_by=['layer-2','layer-3']),
                dict(id='layer-2',name='product',transparent=True,extraction='local',regions=[{'polygon':[[150,150],[850,150],[850,850],[150,850]]}],occluded_by=['layer-3'],repair_regions=[[[300,350],[700,350],[700,550],[300,550]]]),
                dict(id='layer-3',name='text',transparent=True,extraction='color',regions=[{'polygon':[[300,350],[700,350],[700,550],[300,550]],'colors':['#FFFFFF'],'tolerance':40}],occluded_by=[])]
            job=dict(id='b'*32,width=100,height=100,source_url='/output/source.png',layers=layers)
            (service.output/job['id']).mkdir(parents=True)
            await prepare_cutouts(service,job)
            self.assertEqual(local_calls,[False])
            self.assertTrue(layers[1]['needs_fill']);self.assertFalse(layers[2]['needs_fill'])
            with Image.open(service.source_path(layers[1]['cutout_url'])) as cutout:
                self.assertEqual(cutout.getpixel((25,25)),(255,0,0,255))
                self.assertEqual(cutout.getpixel((40,45))[3],0)
            filled=merge_completion(service,job,layers[1],Image.new('RGBA',(100,100),'green'))
            self.assertEqual(filled.getpixel((25,25)),(255,0,0,255))
            self.assertEqual(filled.getpixel((40,45)),(0,128,0,255))
            self.assertEqual(filled.getpixel((0,0))[3],0)
            # Recovery must reuse cached cutouts and not rerun the segmentation model.
            await prepare_cutouts(service,job);self.assertEqual(local_calls,[False])
            with self.assertRaises(ValueError):merge_completion(service,job,layers[1],Image.new('RGBA',(100,50),'green'))

    async def test_invalid_occlusion_and_mask_plan_are_rejected(self):
        plan={'bbox_format':'xyxy'}
        layers=[dict(id='layer-1',extraction='background',regions=[],occluded_by=[]),dict(id='layer-2',extraction='color',regions=[dict(polygon=[[0,0],[500,0],[500,500]],colors=['#FFFFFF'],tolerance=40)],occluded_by=['layer-1'])]
        with self.assertRaises(ValueError):validate_cutout_plan(plan,layers)
        layers[1]['occluded_by']=[];validate_cutout_plan(plan,layers)
        layers[1]['regions'][0]['colors']=['white']
        with self.assertRaises(ValueError):validate_cutout_plan(plan,layers)
