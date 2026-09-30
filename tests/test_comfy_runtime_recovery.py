import tempfile
import unittest
from unittest.mock import MagicMock, patch

import requests
from fastapi import HTTPException
from ComfyUI.integration.comfy_apps import AppLibrary
from ComfyUI.integration.comfy_app_runtime import ManagedRuntime


class RuntimeRecoveryTests(unittest.TestCase):
    def library(self):
        library = AppLibrary.__new__(AppLibrary)
        library.runtime = MagicMock(address='127.0.0.1:8190')
        return library

    def test_running_environment_is_reused(self):
        library = self.library()
        library.runtime.info.return_value = {'LoadImage': {}}
        self.assertEqual(library.backend({'managed': True}, start=True),
                         ('127.0.0.1:8190', {'LoadImage': {}}))
        library.runtime.start_existing.assert_not_called()

    def test_stopped_environment_recovers_without_install(self):
        library = self.library()
        library.runtime.info.side_effect = requests.ConnectionError('offline')
        library.runtime.start_existing.return_value = {'LoadImage': {}}
        self.assertEqual(library.backend({'managed': True}, start=True)[1], {'LoadImage': {}})
        library.runtime.start_existing.assert_called_once_with()
        library.runtime.prepare.assert_not_called()

    def test_inspection_does_not_start_environment(self):
        library = self.library()
        library.runtime.info.side_effect = requests.ConnectionError('offline')
        with self.assertRaises(HTTPException):
            library.backend({'managed': True})
        library.runtime.start_existing.assert_not_called()

    def test_start_failure_preserves_reason(self):
        library = self.library()
        library.runtime.info.side_effect = requests.ConnectionError('offline')
        library.runtime.start_existing.side_effect = RuntimeError('missing environment')
        with self.assertRaises(HTTPException) as caught:
            library.backend({'managed': True}, start=True)
        self.assertEqual(caught.exception.status_code, 503)
        self.assertEqual(caught.exception.detail, 'missing environment')

    def test_live_but_busy_runtime_is_not_relaunched(self):
        with tempfile.TemporaryDirectory() as root:
            runtime = ManagedRuntime(root)
            identity = MagicMock()
            identity.json.return_value = {'root': str(runtime.root), 'output': str(runtime.output)}
            with patch('ComfyUI.integration.comfy_app_runtime.requests.get', return_value=identity), \
                    patch.object(runtime, 'info', side_effect=requests.Timeout()), \
                    patch('ComfyUI.integration.comfy_app_runtime.subprocess.Popen') as spawn:
                with self.assertRaisesRegex(RuntimeError, '已启动'):
                    runtime.start_existing()
                spawn.assert_not_called()
            self.assertTrue(runtime.guard.acquire(blocking=False))
            runtime.guard.release()


if __name__ == '__main__':
    unittest.main()
