import copy
import math
import unittest
import sys
from pathlib import Path
import numpy as np
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from physical_dimensions import (dimension_defaults, migrate_dimensions, convertToMillimeters,
    convertFromMillimeters, calculateAspectRatio, calculateThicknessRatio,
    validatePhysicalDimensions, buildNormalizedDimensions, GeometryGuideGenerator, dimension_signature)
from geometry_validator import GeometryValidator


class DimensionTests(unittest.TestCase):
    def config(self, **changes):
        return {**dimension_defaults(), 'enabled': True, 'width': 300, 'height': 400, 'depth': 20, **changes}

    def test_required_conversion_and_ratios(self):
        self.assertEqual([convertToMillimeters(v,'cm') for v in [30,40,2]],[300,400,20])
        self.assertEqual(calculateAspectRatio(300,400),dict(value=.75,label='3:4'))
        self.assertEqual(calculateThicknessRatio(300,400,20)['depthToHeight'],.05)
        self.assertEqual(convertToMillimeters(1,'in'),25.4)

    def test_unit_switch_never_changes_canonical_values(self):
        data=self.config(); before=copy.deepcopy(data)
        for unit in ['mm','cm','m','in']*100:
            data['unit']=unit
            for key in ['width','height','depth']:
                display=convertFromMillimeters(data[key],unit)
                self.assertAlmostEqual(convertToMillimeters(display,unit),before[key],places=12)
                self.assertEqual(data[key],before[key])
        self.assertEqual(dimension_signature(data),dimension_signature(before))

    def test_unknown_depth_and_invalid_inputs(self):
        data=self.config(depth=None)
        self.assertTrue(validatePhysicalDimensions(data)['valid'])
        self.assertIsNone(buildNormalizedDimensions(data)['thicknessRatio'])
        for value in [0,-1,math.nan,math.inf,'abc',True]:
            result=validatePhysicalDimensions(self.config(depth=value))
            self.assertFalse(result['valid']); self.assertTrue(result['errors'])
        for width,height in [(None,400),(300,None)]:
            self.assertFalse(validatePhysicalDimensions(self.config(width=width,height=height))['valid'])

    def test_legacy_migration_only_treats_old_zero_as_unknown(self):
        legacy=migrate_dimensions(dict(width=30,height=40,depth=0,unit='cm'))
        self.assertEqual((legacy['width'],legacy['height'],legacy['depth']),(300,400,None))
        self.assertFalse(validatePhysicalDimensions(self.config(depth=0))['valid'])
        self.assertEqual(migrate_dimensions(legacy),legacy)
        self.assertFalse(legacy['enabled'])

    def test_budget_roles_original_priority_and_explicit_guide_omission(self):
        import product_fidelity as pf
        from PIL import Image, ImageDraw
        import tempfile
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder);Image.new('RGBA',(120,160),'blue').save(root/'product.png')
            refs=[dict(url='/product.png',kind='image',reference_id=key,name=key) for key in ['a','b','product']]
            # Use separate URLs so they remain distinct original resources.
            for ref in refs:
                Image.new('RGB',(120,160),'blue').save(root/(ref['reference_id']+'.png'));ref['url']='/'+ref['reference_id']+'.png'
            caps=pf.capabilities(dict(id='fixture'), 'nano-banana', 'gemini','openai');caps['applicationReferenceLimit']=2
            def save(image,name,cached=False):image.save(root/name);return '/'+name
            context=pf.preprocess(refs,dict(enabled=True,mode='structure',productReferenceId='product',detail=dict(enabled=False),dimensions=self.config(constraintMode='guide')),caps,lambda u:str(root/u.lstrip('/')),save)
            self.assertEqual(context['usedReferenceIds'],['a','product'])
            self.assertEqual([r['role'] for r in context['reference_images']],['user_reference','product_reference'])
            self.assertFalse(context['geometryGuideUsed'])
            self.assertEqual([r['role'] for r in context['omittedReferences']],['user_reference','geometry_reference'])
            self.assertTrue(any('退化为 Prompt' in w for w in context['warnings']))
            # A size edit cannot reuse a stale guide, even if an old ID is supplied.
            config=self.config(constraintMode='guide',guideAssetId='stale')
            caps['applicationReferenceLimit']=4
            first=pf.preprocess(refs,dict(enabled=True,mode='structure',productReferenceId='product',detail=dict(enabled=False),dimensions=config),caps,lambda u:str(root/u.lstrip('/')),save)
            config['width']=320
            second=pf.preprocess(refs,dict(enabled=True,mode='structure',productReferenceId='product',detail=dict(enabled=False),dimensions=config),caps,lambda u:str(root/u.lstrip('/')),save)
            self.assertNotEqual(first['dimensions']['guideAssetId'],second['dimensions']['guideAssetId'])

    def test_legacy_sizes_do_not_enable_or_change_existing_pixel_protection(self):
        import product_fidelity as pf
        raw=pf.normalize(dict(enabled=True,mode='strict',dimensions=dict(width=30,height=40,depth=0,unit='cm')))
        self.assertEqual(raw['mode'],'strict');self.assertFalse(raw['dimensions']['enabled'])

    def test_circle_axes_are_explicit(self):
        circle=self.config(shape='circle',width=300,height=300)
        self.assertTrue(validatePhysicalDimensions(circle)['valid'])
        self.assertFalse(validatePhysicalDimensions(self.config(shape='circle'))['valid'])
        shapes=GeometryGuideGenerator.primitives(circle)
        self.assertEqual([s['type'] for s in shapes],['ellipse','polygon'])

    def test_guide_is_deterministic_text_free_and_changes_with_dimensions(self):
        data=self.config(); svg=GeometryGuideGenerator.svg(data)
        self.assertNotIn('<text',svg)
        self.assertEqual(svg,GeometryGuideGenerator.svg(copy.deepcopy(data)))
        self.assertEqual(GeometryGuideGenerator.image(data).tobytes(),GeometryGuideGenerator.image(data).tobytes())
        front=GeometryGuideGenerator.primitives(data)[0]['points']
        self.assertAlmostEqual((front[1][0]-front[0][0])/(front[2][1]-front[1][1]),.75)
        self.assertNotEqual(svg,GeometryGuideGenerator.svg(self.config(depth=40)))
        self.assertEqual(len(GeometryGuideGenerator.primitives(self.config(depth=None))),2)


class ValidatorTests(unittest.TestCase):
    def test_states_do_not_use_output_canvas_or_target_for_rectification(self):
        corners=np.array([[40,50],[340,50],[340,450],[40,450]],float)
        angle=math.radians(12);rotation=np.array([[math.cos(angle),-math.sin(angle)],[math.sin(angle),math.cos(angle)]])
        result=GeometryValidator.validate(.75,corners@rotation.T, .99)
        self.assertEqual(result['status'],'pass')
        self.assertAlmostEqual(result['relativeErrorPct'],0,places=10)
        self.assertTrue(result['rectificationMatrix'])
        self.assertEqual(result['thicknessStatus'],'unknown')
        self.assertEqual(GeometryValidator.validate(.75,[[0,0],[314,0],[314,400],[0,400]],.99)['status'],'warning')
        bad=GeometryValidator.validate(.75,[[0,0],[360,0],[360,400],[0,400]],.99)
        self.assertEqual(bad['status'],'fail');self.assertAlmostEqual(bad['relativeErrorPct'],20)
        self.assertAlmostEqual(bad['measuredRatio'],.9)

    def test_missing_ambiguous_and_oblique_corners_are_unknown(self):
        self.assertEqual(GeometryValidator.validate(.75)['status'],'unknown')
        for corners,confidence in [([[0,0],[300,0],[300,400],[0,400]],.5), ([[0,0],[280,60],[330,400],[60,380]],1), ([[0,0],[100,100],[0,100],[100,0]],1), ([[0,0],[300,0],[300,400]],1)]:
            self.assertEqual(GeometryValidator.validate(.75,corners,confidence)['status'],'unknown')
        self.assertEqual(GeometryValidator.validate(.75,shape='circle')['status'],'unknown')

    def test_calibrated_metric_rectification(self):
        K=np.array([[1200,0,800],[0,1200,500],[0,0,1]],float)
        points=np.array([[0,0,10],[3,0,10],[3,4,10],[0,4,10]],float)@K.T
        corners=points[:,:2]/points[:,2:3]
        result=GeometryValidator.validate(.75,corners,1,camera_matrix=K)
        self.assertEqual(result['status'],'pass')
        self.assertEqual(result['rectificationMethod'],'calibrated-homography')

    def test_actual_identity_localization_uses_product_corners(self):
        from PIL import Image, ImageDraw
        import importlib.util
        if importlib.util.find_spec('cv2') is None:self.skipTest('optional OpenCV not installed')
        rng=np.random.default_rng(7)
        source=Image.fromarray(rng.integers(20,230,(500,400,3),dtype=np.uint8)).convert('RGBA')
        ImageDraw.Draw(source).rectangle((50,50,349,449),fill='#a0aab0',outline='#202830',width=8)
        texture=Image.fromarray(rng.integers(20,230,(340,240,3),dtype=np.uint8)).convert('RGBA')
        source.paste(texture,(80,80))
        alpha=np.zeros((500,400),dtype=np.uint8);alpha[50:450,50:350]=255
        source.putalpha(Image.fromarray(alpha));mask=Image.fromarray(alpha)
        generated=Image.new('RGBA',(1536,864),'white');generated.alpha_composite(source,(450,120))
        result=GeometryValidator.from_images(source,mask,generated,{**dimension_defaults(),'enabled':True,'width':300,'height':400})
        self.assertEqual(result['status'],'pass',result)
        self.assertLess(result['relativeErrorPct'],1)
        self.assertAlmostEqual(result['measuredRatio'],.75,places=2)
        self.assertEqual(GeometryValidator.from_images(source,None,generated,dimension_defaults())['status'],'unknown')

if __name__=='__main__':unittest.main()
