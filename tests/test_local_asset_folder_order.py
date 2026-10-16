import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from fastapi import HTTPException
from starlette.requests import Request

import main


class LocalAssetFolderOrderTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        root = Path(directory.name)
        uploads = root / '本地素材'
        data = root / '数据'
        uploads.mkdir()
        data.mkdir()
        for name in ('甲', '乙', '丙'):
            (uploads / name).mkdir()
        for name in ('一', '二'):
            (uploads / '甲' / name).mkdir()
        settings = patch.multiple(main, LOCAL_UPLOAD_DIR=str(uploads), DATA_DIR=str(data))
        settings.start()
        self.addCleanup(settings.stop)
        self.request = Request({
            'type': 'http', 'method': 'POST', 'scheme': 'http',
            'server': ('127.0.0.1', 3000), 'path': '/api/local-assets/folders/reorder',
            'headers': [(b'host', b'127.0.0.1:3000'), (b'origin', b'http://127.0.0.1:3000')],
        })

    async def test_reorder_persists_and_rejects_missing_or_cross_level_paths(self):
        reorder = lambda parent, paths: main.reorder_local_asset_folders(
            main.LocalAssetFolderOrderRequest(parent=parent, paths=paths), self.request,
        )
        response = await reorder('', ['丙', '甲', '乙'])
        self.assertEqual([child['path'] for child in response['tree']['children']], ['丙', '甲', '乙'])
        refreshed = await main.list_local_assets()
        self.assertEqual([child['path'] for child in refreshed['tree']['children']], ['丙', '甲', '乙'])
        with self.assertRaises(HTTPException) as missing:
            await reorder('', ['甲', '乙'])
        self.assertEqual(missing.exception.status_code, 409)
        with self.assertRaises(HTTPException) as cross_level:
            await reorder('', ['甲', '乙', '甲/一'])
        self.assertEqual(cross_level.exception.status_code, 409)
        nested = await reorder('甲', ['甲/二', '甲/一'])
        children = next(child for child in nested['tree']['children'] if child['path'] == '甲')['children']
        self.assertEqual([child['path'] for child in children], ['甲/二', '甲/一'])

    async def test_rename_and_delete_keep_saved_order_consistent(self):
        await main.reorder_local_asset_folders(
            main.LocalAssetFolderOrderRequest(paths=['丙', '甲', '乙']), self.request,
        )
        renamed = await main.rename_local_asset_folder(
            main.LocalAssetFolderRequest(path='甲', name='新甲'), self.request,
        )
        self.assertEqual([child['path'] for child in renamed['tree']['children']], ['丙', '新甲', '乙'])
        deleted = await main.delete_local_asset_folder(
            main.LocalAssetFolderRequest(path='丙'), self.request,
        )
        self.assertEqual([child['path'] for child in deleted['tree']['children']], ['新甲', '乙'])
        refreshed = await main.list_local_assets()
        self.assertEqual([child['path'] for child in refreshed['tree']['children']], ['新甲', '乙'])


if __name__ == '__main__':
    unittest.main()
