import asyncio
import os
import tempfile
import unittest
from contextlib import ExitStack
from pathlib import Path
from unittest.mock import patch

import httpx
import main


class ApiKeyProfileTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="api-key-profiles-test-")
        root = Path(self.temp.name)
        self.data_dir = root / "data"
        self.data_dir.mkdir()
        self.env_file = root / "API" / ".env"
        self.env_file.parent.mkdir()
        self.env_file.write_text("API_PROVIDER_API_6789_KEY=old-secret-key\n", encoding="utf-8")
        self.profile_file = self.data_dir / "api_key_profiles.json"
        self.provider_file = self.data_dir / "api_providers.json"
        self.provider_file.write_text('[{"id":"api-6789","name":"6789API","protocol":"openai","base_url":"https://example.com/v1"}]', encoding="utf-8")
        self.base_env_key = "API_PROVIDER_API_6789_KEY"
        self.patches = ExitStack()
        self.patches.enter_context(patch.object(main, "DATA_DIR", str(self.data_dir)))
        self.patches.enter_context(patch.object(main, "API_ENV_FILE", str(self.env_file)))
        self.patches.enter_context(patch.object(main, "API_KEY_PROFILES_FILE", str(self.profile_file)))
        self.patches.enter_context(patch.object(main, "API_PROVIDERS_FILE", str(self.provider_file)))
        self.patches.enter_context(patch.dict(os.environ, {self.base_env_key: "old-secret-key"}, clear=False))

    def tearDown(self):
        self.patches.close()
        self.temp.cleanup()

    def provider(self):
        return {"id": "api-6789", "protocol": "openai"}

    def test_first_run_has_no_preconfigured_api_platforms(self):
        self.provider_file.unlink()
        self.assertEqual(main.load_api_providers(), [])

    def test_legacy_key_is_migrated_without_writing_secret_to_metadata(self):
        first = main.ensure_key_profile_store_for_providers([self.provider()])
        second = main.ensure_key_profile_store_for_providers([self.provider()])

        profiles = second["providers"]["api-6789"]["profiles"]
        self.assertEqual(len(profiles), 1)
        self.assertEqual(profiles[0]["id"], "key_legacy")
        self.assertEqual(first["providers"]["api-6789"]["active_id"], "key_legacy")
        self.assertEqual(second["providers"]["api-6789"]["active_id"], "key_legacy")
        metadata = self.profile_file.read_text(encoding="utf-8")
        self.assertNotIn("old-secret-key", metadata)
        self.assertIn("API_PROVIDER_API_6789_KEY_PROFILE_KEY_LEGACY=old-secret-key", self.env_file.read_text(encoding="utf-8"))

    def test_save_switch_and_delete_keep_active_runtime_key_in_sync(self):
        main.ensure_key_profile_store_for_providers([self.provider()])

        saved = asyncio.run(main.save_provider_key_profile(
            "api-6789",
            main.ApiKeyProfilePayload(key="new-secret-key", name="工作账号", create_new=True),
        ))
        created = next(profile for profile in saved["profiles"] if profile["name"] == "工作账号")
        self.assertEqual(saved["active_id"], created["id"])
        self.assertEqual(main.provider_env_key_value("api-6789"), "new-secret-key")

        switched = asyncio.run(main.activate_provider_key_profile("api-6789", "key_legacy"))
        self.assertEqual(switched["active_id"], "key_legacy")
        self.assertEqual(main.provider_env_key_value("api-6789"), "old-secret-key")

        deleted = asyncio.run(main.delete_provider_key_profile("api-6789", "key_legacy"))
        self.assertEqual(deleted["active_id"], created["id"])
        self.assertEqual(main.provider_env_key_value("api-6789"), "new-secret-key")
        metadata = self.profile_file.read_text(encoding="utf-8")
        self.assertNotIn("new-secret-key", metadata)
        self.assertNotIn("old-secret-key", metadata)

    def test_legacy_provider_save_can_create_a_new_record(self):
        main.ensure_key_profile_store_for_providers([self.provider()])
        main._sync_key_profiles_from_provider_payload({
            "api-6789": {
                "key": "compat-secret-key",
                "create_new": True,
                "name": "兼容账号",
            }
        })
        store = main._load_key_profile_store()
        profiles = store["providers"]["api-6789"]["profiles"]
        self.assertTrue(any(profile["name"] == "兼容账号" for profile in profiles))
        self.assertEqual(main.provider_env_key_value("api-6789"), "compat-secret-key")

    def test_existing_key_profile_can_be_renamed_without_resubmitting_secret(self):
        main.ensure_key_profile_store_for_providers([self.provider()])

        renamed = asyncio.run(main.save_provider_key_profile(
            "api-6789",
            main.ApiKeyProfilePayload(profile_id="key_legacy", name="我的 6789 账号"),
        ))

        profile = next(profile for profile in renamed["profiles"] if profile["id"] == "key_legacy")
        self.assertEqual(profile["name"], "我的 6789 账号")
        self.assertEqual(renamed["active_id"], "key_legacy")
        self.assertEqual(main.provider_env_key_value("api-6789"), "old-secret-key")
        self.assertNotIn("old-secret-key", self.profile_file.read_text(encoding="utf-8"))

    def test_existing_key_profile_can_update_name_and_secret_together(self):
        main.ensure_key_profile_store_for_providers([self.provider()])

        updated = asyncio.run(main.save_provider_key_profile(
            "api-6789",
            main.ApiKeyProfilePayload(
                key="rotated-secret-key",
                profile_id="key_legacy",
                name="新的 6789 账号",
            ),
        ))

        profile = next(profile for profile in updated["profiles"] if profile["id"] == "key_legacy")
        self.assertEqual(profile["name"], "新的 6789 账号")
        self.assertEqual(updated["active_id"], "key_legacy")
        self.assertEqual(main.provider_env_key_value("api-6789"), "rotated-secret-key")
        metadata = self.profile_file.read_text(encoding="utf-8")
        self.assertNotIn("rotated-secret-key", metadata)
        self.assertNotIn("old-secret-key", metadata)

    def test_blank_key_is_rejected(self):
        with self.assertRaises(main.HTTPException) as error:
            asyncio.run(main.save_provider_key_profile(
                "api-6789",
                main.ApiKeyProfilePayload(key="   "),
            ))
        self.assertEqual(error.exception.status_code, 400)

    def test_key_profile_http_route_returns_masked_records(self):
        main.ensure_key_profile_store_for_providers([self.provider()])

        async def request():
            transport = httpx.ASGITransport(app=main.app)
            async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
                return await client.get("/api/providers/api-6789/key-profiles")

        response = asyncio.run(request())
        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertEqual(payload["active_id"], "key_legacy")
        self.assertEqual(payload["profiles"][0]["key_preview"], "••••••••-key")
        self.assertNotIn("old-secret-key", response.text)


if __name__ == "__main__":
    unittest.main()
