"""Pixel invariants and failure handling for local, provider-free patch repair."""
import json
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import patch
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import cv2
import numpy as np
from PIL import Image, ImageDraw
from fastapi import FastAPI
from fastapi.testclient import TestClient
from local_fusion import FusionRequest, FusionPatch, FusionCancelled, fuse
from local_fusion_api import create_fusion_router


class FusionTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='xiaomei-local-fusion-')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        rng = np.random.default_rng(317)
        self.source = np.concatenate([rng.integers(70, 170, (480, 640, 3), dtype=np.uint8),
                                      np.full((480, 640, 1), 255, np.uint8)], axis=2)
        for _ in range(70):
            x, y = rng.integers(0, 600), rng.integers(0, 450)
            cv2.circle(self.source, (x, y), 5, (30, 60, 90, 255), -1)
        self.source[200:220, 270:330, :3] = [190, 35, 25]
        self.write('source.png', self.source)
        self.region = dict(id='r1', sourceUrl='/source.png', sourceWidth=640, sourceHeight=480,
                           x=180, y=130, width=280, height=240)
        self.patch = self.source[130:370, 180:460].copy()
        self.patch[85:125, 80:150, :3] = [255, 255, 255]
        Image.fromarray(self.patch).resize((560, 480), Image.Resampling.NEAREST).save(self.root/'patch.png')

    def write(self, name, array):
        Image.fromarray(array).save(self.root/name)

    def resolve(self, url):
        # The production resolver additionally restricts URLs to managed media roots.
        p = self.root/str(url).lstrip('/')
        return str(p) if p.parent == self.root and p.is_file() else None

    def request(self, **options):
        return FusionRequest(sourceUrl='/source.png', patches=[dict(url='/patch.png', region=self.region)], **options)

    def assert_preserved(self, output, mask):
        result, active = np.array(output), np.array(mask)>0
        self.assertEqual(output.size, (640, 480))
        np.testing.assert_array_equal(result[~active], self.source[~active])
        np.testing.assert_array_equal(result[:, :, 3], self.source[:, :, 3])
        self.assertTrue(active.any())

    def test_different_resolution_detail_and_unchanged_outside(self):
        result, mask, report = fuse(self.request(), self.resolve)
        self.assert_preserved(result, mask)
        self.assertTrue(report['outsideUnchanged'])
        self.assertFalse(report['paidApiCalled'])
        self.assertTrue(np.min(np.array(result)[225:235, 275:315, :3]) > 245)

    def test_mask_and_poisson_are_confined(self):
        mask = np.zeros((240, 280), np.uint8)
        mask[50:180, 60:200] = 255
        self.write('mask.png', mask)
        for blend in ['alpha', 'poisson']:
            req = self.request(blend=blend)
            req.patches[0].maskUrl = '/mask.png'
            result, support, _ = fuse(req, self.resolve)
            self.assert_preserved(result, support)
            full = np.zeros((480, 640), bool)
            full[130:370, 180:460] = mask>0
            np.testing.assert_array_equal(np.array(result)[~full], self.source[~full])

    def test_shift_registration(self):
        moved = cv2.warpAffine(self.patch, np.float32([[1, 0, 8], [0, 1, -6]]), (280, 240), borderMode=cv2.BORDER_REFLECT)
        self.write('patch.png', moved)
        result, support, report = fuse(self.request(), self.resolve)
        self.assert_preserved(result, support)
        self.assertEqual(report['regions'][0]['alignment']['status'], 'registered')
        matrix = report['regions'][0]['alignment']['matrix']
        self.assertAlmostEqual(matrix[0][2], -8, delta=1.5)
        self.assertAlmostEqual(matrix[1][2], 6, delta=1.5)

    def test_auto_locate_without_metadata(self):
        self.write('patch.png', self.patch)
        req = self.request()
        req.patches[0].region = None
        result, support, report = fuse(req, self.resolve)
        self.assert_preserved(result, support)
        self.assertEqual(report['regions'][0]['alignment']['status'], 'located')
        self.assertAlmostEqual(report['regions'][0]['region']['x'], 180, delta=2)

    def test_color_matching_uses_border_and_preserves_text_contrast(self):
        dark = self.patch.copy()
        dark[:, :, :3] = np.maximum(dark[:, :, :3].astype(int)-20, 0)
        self.write('patch.png', dark.astype(np.uint8))
        result, mask, _ = fuse(self.request(), self.resolve)
        self.assert_preserved(result, mask)
        np.testing.assert_array_equal(np.array(result)[165:175, 210:220], self.source[165:175, 210:220])

    def test_overlapping_regions_require_explicit_order(self):
        req = self.request()
        req.patches.append(req.patches[0].model_copy(deep=True))
        with self.assertRaisesRegex(ValueError, '重叠'):
            fuse(req, self.resolve)
        req.overlap = 'ordered'
        result, mask, report = fuse(req, self.resolve)
        self.assert_preserved(result, mask)
        self.assertTrue(report['warnings'])

    def test_reject_wrong_aspect_identity_size_and_unrelated_patch(self):
        req = self.request()
        Image.fromarray(self.patch).resize((600, 300)).save(self.root/'patch.png')
        with self.assertRaisesRegex(ValueError, '宽高比'):
            fuse(req, self.resolve)
        req.patches[0].allowDistortion = True
        req.patches[0].region.sourceWidth = 999
        with self.assertRaisesRegex(ValueError, '尺寸已改变'):
            fuse(req, self.resolve)
        req.patches[0].region.sourceWidth = 640
        req.patches[0].region.sourceUrl = '/other.png'
        self.write('other.png', self.source)
        with self.assertRaisesRegex(ValueError, '另一张原图'):
            fuse(req, self.resolve)
        req.patches[0].region = None
        self.write('patch.png', np.full((240, 280, 4), 255, np.uint8))
        with self.assertRaisesRegex(ValueError, '无法可靠定位'):
            fuse(req, self.resolve)

    def test_manual_and_change_mask(self):
        for mode in ['manual', 'coordinates']:
            req = self.request()
            req.patches[0].alignment = mode
            req.patches[0].maskMode = 'changes'
            result, mask, _ = fuse(req, self.resolve)
            self.assert_preserved(result, mask)
            self.assertLess(np.count_nonzero(np.array(mask)), 280*240/3)

    def test_cancellation(self):
        with self.assertRaises(FusionCancelled):
            fuse(self.request(), self.resolve, cancel=lambda: True)

    def test_large_rotation_rejected_and_manual_can_preview(self):
        moved = cv2.warpAffine(self.patch, cv2.getRotationMatrix2D((140, 120), 23, 1), (280, 240), borderMode=cv2.BORDER_REFLECT)
        self.write('patch.png', moved)
        with self.assertRaisesRegex(ValueError, '视角|对齐不可靠'):
            fuse(self.request(), self.resolve)
        req = self.request()
        req.patches[0].alignment = 'manual'
        result, mask, report = fuse(req, self.resolve)
        self.assert_preserved(result, mask)
        self.assertEqual(report['regions'][0]['alignment']['status'], 'manual')

    def test_multiple_distinct_regions_accumulate(self):
        small = self.source[10:80, 10:100].copy()
        small[20:50, 30:70, :3] = [2, 8, 250]
        self.write('second.png', small)
        req = self.request()
        req.patches.append(FusionPatch(url='/second.png',region=dict(id='r2',sourceUrl='/source.png',sourceWidth=640,sourceHeight=480,x=10,y=10,width=90,height=70)))
        result, mask, report = fuse(req, self.resolve)
        self.assert_preserved(result, mask)
        self.assertEqual(len(report['regions']), 2)
        self.assertGreater(np.array(result)[45, 60, 2], 240)

    def test_http_cancellation_does_not_publish(self):
        entered, release = threading.Event(), threading.Event()
        def wait_fuse(payload, resolve, cancel, progress):
            entered.set()
            release.wait(5)
            if cancel(): raise FusionCancelled()
            return fuse(payload, resolve, cancel, progress)
        saved = []
        app = FastAPI()
        app.include_router(create_fusion_router(self.resolve, lambda *a: saved.append(a), lambda *a, **k: {}))
        with patch('local_fusion_api.fuse', wait_fuse), TestClient(app) as client:
            response = client.post('/api/local-fusion/jobs', json=self.request().model_dump())
            job_id = response.json()['id']
            self.assertTrue(entered.wait(3))
            response = client.delete('/api/local-fusion/jobs/'+job_id)
            self.assertEqual(response.status_code, 200)
            release.set()
            for _ in range(100):
                status = client.get('/api/local-fusion/jobs/'+job_id).json()['status']
                if status == 'cancelled': break
                time.sleep(.02)
            self.assertEqual(status, 'cancelled')
            self.assertEqual(saved, [])

    def test_api_job_and_cancel_no_overwrite(self):
        saves, registered = [], []
        def save(image, filename):
            image.save(self.root/filename)
            saves.append(filename)
            return '/'+filename
        app = FastAPI()
        app.include_router(create_fusion_router(self.resolve, save, lambda *a, **k: registered.append(k) or {}))
        original_bytes = (self.root/'source.png').read_bytes()
        with TestClient(app) as client:
            invalid = self.request().model_dump()
            invalid['patches'] = []
            self.assertEqual(client.post('/api/local-fusion/jobs', json=invalid).status_code, 422)
            response = client.post('/api/local-fusion/jobs', json=self.request().model_dump())
            self.assertEqual(response.status_code, 202)
            job_id = response.json()['id']
            for _ in range(150):
                job = client.get('/api/local-fusion/jobs/'+job_id).json()
                if job['status'] in ['completed', 'failed']: break
                time.sleep(.02)
            self.assertEqual(job['status'], 'completed', job)
            self.assertTrue(job['result']['report']['outsideUnchanged'])
            self.assertEqual(len(registered), 1)
            self.assertEqual(len(saves), 2)
            self.assertTrue((self.root/saves[0]).with_suffix('.json').is_file())
            self.assertEqual((self.root/'source.png').read_bytes(), original_bytes)
            self.assertEqual(client.get('/api/local-fusion/jobs/missing').status_code, 404)


if __name__ == '__main__':
    unittest.main()
