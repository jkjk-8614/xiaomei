import asyncio
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch, AsyncMock

from fastapi import FastAPI
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import mcp_settings as m


class McpSettingsTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.path = Path(self.temp.name) / '设置.json'
        self.override = patch.object(m, 'CONFIG_PATH', self.path)
        self.override.start()
        app = FastAPI()
        app.include_router(m.router)
        self.client = TestClient(app)

    def tearDown(self):
        self.override.stop()
        self.temp.cleanup()

    def test_persistence_and_invalid_update_preserves_original(self):
        config = {'servers': [{'name': 'Blender', 'command': sys.executable, 'args': ['服务.py'], 'enabled': False}]}
        self.assertEqual(self.client.put('/api/mcp/settings', json=config).status_code, 200)
        self.assertFalse(self.client.get('/api/mcp/settings').json()['servers'][0]['enabled'])
        original = self.path.read_bytes()
        config['servers'].append(config['servers'][0])
        self.assertEqual(self.client.put('/api/mcp/settings', json=config).status_code, 422)
        self.assertEqual(original, self.path.read_bytes())
        self.assertEqual(self.client.post('/api/mcp/test', json=config['servers'][0]).status_code, 400)

    def test_cross_origin_blocked(self):
        self.assertEqual(self.client.get('/api/mcp/settings', headers={'Origin':'https://evil.example'}).status_code, 403)

    def test_stdio_handshake(self):
        result = asyncio.run(m.probe(m.ServerConfig(name='fixture', command=sys.executable,
            args=[str(Path(__file__).with_name('mcp_fixture.py'))])))
        self.assertTrue(result['ok'])
        self.assertEqual(result['tools'][0]['name'], 'echo')

    def test_missing_executable(self):
        result = self.client.post('/api/mcp/test', json={'name':'missing','command':'xiaomei-no-such-command'}).json()
        self.assertFalse(result['ok'])

    def test_market_search_pagination_no_write(self):
        fixture = {'servers': [{'server': {'name': 'io.example/blender', 'version': '1.2.3',
                   'packages': [{'registryType': 'npm', 'identifier': '@example/blender',
                                 'version': '1.2.3', 'transport': {'type': 'stdio'}}]}}],
                   'metadata': {'nextCursor': 'next-page'}}
        with patch.object(m, 'fetch_market', new_callable=AsyncMock, return_value=fixture) as fetch:
            response = self.client.get('/api/mcp/market', params={'q': 'blender', 'cursor': 'old-page'})
            self.assertEqual(response.status_code, 200)
            fetch.assert_awaited_once_with({'limit': 12, 'version': 'latest', 'search': 'blender', 'cursor': 'old-page'})
        result = response.json()
        self.assertEqual(result['nextCursor'], 'next-page')
        config = result['items'][0]['options'][0]['config']
        self.assertFalse(config['enabled'])
        self.assertEqual(config['args'], ['-y', '@example/blender@1.2.3'])
        self.assertFalse(self.path.exists())

    def test_market_remote_and_unsupported_packages(self):
        item = m.market_item({'server': {'name': 'io.example/remote', 'remotes': [
            {'type': 'sse', 'url': 'https://example.com/sse'},
            {'type': 'streamable-http', 'url': 'javascript:alert(1)'},
            {'type': 'streamable-http', 'url': 'https://example.com/mcp', 'headers': [{'name': 'Authorization'}]}],
            'packages': [{'registryType': 'pypi', 'identifier': 'unknown-entrypoint'},
                         {'registryType': 'npm', 'identifier': 'example', 'version': '1.0',
                          'transport': {'type': 'stdio'}, 'packageArguments': [{'value': '--required'}]}]}})
        self.assertEqual(len(item['options']), 1)
        self.assertEqual(item['options'][0]['config']['headers'], {'Authorization': ''})

    def test_market_errors_and_origin(self):
        for failure, status in [(TimeoutError(), 504), (ValueError(), 502)]:
            with patch.object(m, 'fetch_market', new_callable=AsyncMock, side_effect=failure):
                self.assertEqual(self.client.get('/api/mcp/market').status_code, status)
        with patch.object(m, 'fetch_market', new_callable=AsyncMock) as fetch:
            self.assertEqual(self.client.get('/api/mcp/market', headers={'Origin': 'https://evil.example'}).status_code, 403)
            fetch.assert_not_called()


if __name__ == '__main__':
    unittest.main()
