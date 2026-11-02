"""Run provider ID migration against isolated user data, including saved accounts."""
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]


def worker():
    import asyncio
    import json
    from unittest.mock import AsyncMock, patch
    sys.path.insert(0, str(ROOT))
    import main

    providers = [
        dict(id='custom-api-3', name='soon', base_url='https://api.soonstudio.ai/v1',
             image_models=['fixture-image'], chat_models=['fixture-chat']),
        dict(id='custom-api-4', name='超算互联网', base_url='https://api.scnet.cn/api/llm/v1',
             video_models=['fixture-video']),
        dict(id='custom-api', name='Other', base_url='https://soonstudio.ai.example/v1'),
        dict(id='custom-api-2', name='千问', base_url='https://maas.qianwenaiapi.com/compatible-mode/v1'),
        dict(id='custom-api-5', name='OpenRouter', base_url='https://openrouter.ai/api/v1'),
        dict(id='custom-api-6', name='其他网站', base_url='https://api.fresh-platform.example/v1'),
        dict(id='custom-api-7', name='未填写地址', base_url=''),
    ]
    main.save_api_providers(providers)
    main.update_env_values({
        main.provider_key_env('custom-api-3'): 'fixture-active',
        main._key_profile_env_key('custom-api-3', 'account_a'): 'fixture-active',
        main._key_profile_env_key('custom-api-3', 'account_b'): 'fixture-second',
        main.provider_key_env('custom-api-4'): 'fixture-scnet',
        main.provider_key_env('custom-api-2'): 'fixture-qwen',
        main.provider_key_env('custom-api-5'): 'fixture-openrouter',
        main.provider_key_env('custom-api-6'): 'fixture-unknown',
    })
    main._save_key_profile_store_locked({'version': 1, 'providers': {'custom-api-3': {
        'active_id': 'account_a', 'profiles': [
            dict(id=pid, name=pid, env_key=main._key_profile_env_key('custom-api-3', pid))
            for pid in ('account_a', 'account_b')
        ]}}})
    cache = Path(main.DATA_DIR) / 'harness_model_modalities.json'
    cache.write_text(json.dumps({'providers': {'custom-api-3': {'fixture-chat': ['text', 'image']}}}), encoding='utf-8')
    migrated = main.load_api_providers()
    assert [p['id'] for p in migrated] == ['soon', 'scnet', 'soonstudio-ai-example', 'qwen', 'openrouter', 'fresh-platform-example', 'custom-api-7']
    assert migrated[0]['image_models'] == ['fixture-image']
    assert migrated[1]['video_models'] == ['fixture-video']
    for old, new in [('custom-api-3', 'soon'), ('custom-api-4', 'scnet'),
                     ('custom-api-2', 'qwen'), ('custom-api-5', 'openrouter'),
                     ('custom-api-6', 'fresh-platform-example')]:
        assert main.get_api_provider(old)['id'] == new
        assert main.get_api_provider_exact(old)['id'] == new
        assert main._key_profile_provider(old)[0] == new
        assert main.provider_env_key_value(new) == main.provider_env_key_value(old)
    assert json.loads(cache.read_text())['providers']['soon']['fixture-chat'] == ['text', 'image']
    store = main._load_key_profile_store()
    assert store['providers']['soon']['active_id'] == 'account_a'
    assert len(store['providers']['soon']['profiles']) == 2
    assert main._read_key_profile_value(main._key_profile_env_key('soon', 'account_b')) == 'fixture-second'
    public = main.public_provider(migrated[0], [], store)
    assert public['key_env'] == 'API_PROVIDER_SOON_KEY'
    assert public['has_key']
    assert 'fixture-active' not in json.dumps(public)
    assert 'fixture-active' not in Path(main.API_KEY_PROFILES_FILE).read_text()
    before = Path(main.API_PROVIDERS_FILE).read_bytes()
    main.load_api_providers()
    assert Path(main.API_PROVIDERS_FILE).read_bytes() == before
    assert Path(main.API_PROVIDERS_FILE + '.before-provider-id-migration').exists()
    with patch.object(main, 'detect_codex_image_capabilities', AsyncMock(return_value={'image_models': []})):
        saved = asyncio.run(main.save_providers([main.ApiProviderPayload(**p) for p in migrated]))
    assert saved['providers'][0]['legacy_ids'] == ['custom-api-3']
    assert main.get_api_provider_exact('custom-api-3')['id'] == 'soon'
    asyncio.run(main.activate_provider_key_profile('soon', 'account_b'))
    assert main.provider_env_key_value('soon') == 'fixture-second'
    # An occupied ID must keep both platforms intact.
    collision = [dict(id='soon', base_url='https://other.example'), providers[0]]
    assert main.migrate_named_provider_ids(collision) == collision
    # A settings page opened before migration must save to the canonical ID too.
    stale = [main.ApiProviderPayload(**{**p, **({'api_key':'fixture-updated'} if index == 0 else {})})
             for index, p in enumerate(providers)]
    with patch.object(main, 'detect_codex_image_capabilities', AsyncMock(return_value={'image_models': []})):
        saved = asyncio.run(main.save_providers(stale))
    assert saved['providers'][0]['id'] == 'soon'
    assert saved['providers'][3]['id'] == 'qwen'
    assert saved['providers'][4]['id'] == 'openrouter'
    assert main.provider_env_key_value('soon') == 'fixture-updated'
    print('provider IDs, keys, accounts, models, legacy references and repeat saves: passed')


class ProviderIdMigrationTest(unittest.TestCase):
    def test_isolated_migration(self):
        with tempfile.TemporaryDirectory(prefix='xiaomei-provider-ids-') as directory:
            env = {**os.environ, 'XIAOMEI_CANVAS_PROJECT_ROOT': directory,
                   'XIAOMEI_CANVAS_DATA_ROOT': directory, 'PYTHONIOENCODING': 'utf-8'}
            result = subprocess.run([sys.executable, str(Path(__file__).resolve()), '--worker'],
                                    cwd=ROOT, env=env, capture_output=True, text=True,
                                    encoding='utf-8', timeout=90)
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)


if __name__ == '__main__':
    if '--worker' in sys.argv:
        worker()
    else:
        unittest.main()
