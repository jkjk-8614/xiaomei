import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from types import SimpleNamespace

from fastapi import HTTPException
import bridge_api as bridge


class PhotoshopPsdTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='psd-bridge-')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        for name, value in {'ROOT':self.root, 'DATA_DIR':self.root/'data', 'QUEUE_FILE':self.root/'queue.json', 'STATE_FILE':self.root/'state.json'}.items():
            patcher = patch.object(bridge, name, value)
            patcher.start(); self.addCleanup(patcher.stop)
        (self.root/'output').mkdir()
        (self.root/'output/test.psd').write_bytes(b'8BPS\x00\x01' + bytes(20))
        self.payload = bridge.PhotoshopSend(url='/output/test.psd', name='分层.psd', open_mode='document', request_id='psd-request-1')

    def heartbeat(self, capabilities=None):
        return bridge.photoshop_heartbeat(bridge.PhotoshopHeartbeat(bridge_id='new-plugin', capabilities=capabilities or []), SimpleNamespace(client=SimpleNamespace(host='127.0.0.1')))

    def test_old_or_offline_plugin_rejected_without_queue_entry(self):
        for online in (False, True):
            if online:
                self.heartbeat()
            with self.assertRaises(HTTPException) as caught:
                bridge.photoshop_send(self.payload)
            self.assertEqual(caught.exception.status_code, 409)
            self.assertEqual(bridge._queue(), [])

    def test_psd_delivery_is_targeted_idempotent_and_acknowledged(self):
        self.heartbeat(['open-layered-psd'])
        first = bridge.photoshop_send(self.payload)['job']
        self.assertEqual(first['open_mode'], 'document')
        self.assertEqual(first['bridge_id'], 'new-plugin')
        self.assertIsNone(bridge.photoshop_latest(True, 'old-plugin')['job'])
        self.assertIsNone(bridge.photoshop_latest(True)['job'])
        with self.assertRaises(HTTPException):
            bridge.photoshop_take(first['id'], True, 'old-plugin')
        self.assertEqual(bridge.photoshop_latest(True, 'new-plugin')['job']['status'], 'taken')
        bridge.photoshop_ack(bridge.PhotoshopAck(job_id=first['id'], bridge_id='new-plugin', status='done', import_mode='opened-document'))
        second = bridge.photoshop_send(self.payload)['job']
        self.assertEqual(second['id'], first['id'])
        self.assertEqual(second['status'], 'done')
        self.assertEqual(len(bridge._queue()), 1)

    def test_normal_image_send_still_works_without_plugin(self):
        result = bridge.photoshop_send(bridge.PhotoshopSend(url='/output/image.png'))
        self.assertEqual(result['job']['open_mode'], 'place')
        self.assertEqual(bridge.photoshop_latest(True)['job']['id'], result['job']['id'])

    def test_changed_file_cannot_reuse_request_identity(self):
        self.heartbeat(['open-layered-psd'])
        bridge.photoshop_send(self.payload)
        with self.assertRaises(HTTPException) as caught:
            bridge.photoshop_send(self.payload.model_copy(update={'url':'/output/other.psd'}))
        self.assertEqual(caught.exception.status_code, 409)

    def test_invalid_psd_never_reaches_plugin(self):
        self.heartbeat(['open-layered-psd'])
        (self.root/'output/test.psd').write_bytes(b'not psd')
        with self.assertRaises(HTTPException) as caught:
            bridge.photoshop_send(self.payload)
        self.assertEqual(caught.exception.status_code, 400)
        self.assertEqual(bridge._queue(), [])

    def test_old_plugin_error_receipt_is_not_marked_done(self):
        job = bridge.photoshop_send(bridge.PhotoshopSend(url='/output/image.png'))['job']
        result = bridge.photoshop_ack(bridge.PhotoshopAck(job_id=job['id'], status='error', error='Unable to open file'))
        self.assertEqual(result['job']['status'], 'failed')
