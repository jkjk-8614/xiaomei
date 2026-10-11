import asyncio
import tempfile
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch

from fastapi import HTTPException

import main


class JimengLoginMetadataTests(unittest.TestCase):
    def test_device_flow_url_is_not_mistaken_for_an_image(self):
        text = (
            "verification_uri: https://jimeng.jianying.com/ai-tool/cli-auth?\n"
            "verification_uri_complete: https%3A%2F%2Fjimeng.jianying.com%2Fai-tool%2Fcli-auth%3Fuser_code%3DABC123\n"
            "user_code: ABC123\n"
            "device_code: secret-device-code"
        )

        metadata = main.jimeng_login_metadata(text)

        self.assertEqual(metadata["qr_url"], "")
        self.assertEqual(
            metadata["verification_uri_complete"],
            "https://jimeng.jianying.com/ai-tool/cli-auth?user_code=ABC123",
        )
        self.assertEqual(metadata["user_code"], "ABC123")

    def test_headless_login_is_followed_by_checklogin(self):
        with patch("main.time.time", return_value=1_700_000_000):
            args = main.jimeng_login_check_args(
                "DEVICE123",
                "expires_at: 2023-11-14T22:14:20+00:00",
            )

        self.assertEqual(args[:2], ["login", "checklogin"])
        self.assertEqual(args[2], "--device_code=DEVICE123")
        self.assertEqual(args[3], "--poll=60")

    def test_expired_or_invalid_expiry_uses_safe_fallback(self):
        with patch("main.time.time", return_value=1_700_000_000):
            self.assertEqual(main.jimeng_login_poll_seconds("expires_at: invalid"), 300)
            self.assertEqual(
                main.jimeng_login_poll_seconds("expires_at: 2023-11-14T22:13:19+00:00"),
                1,
            )

    def test_missing_complete_url_gets_a_local_fallback(self):
        metadata = main.jimeng_login_metadata(
            "verification_uri: https://jimeng.jianying.com/ai-tool/cli-auth?\n"
            "user_code: ABC123"
        )

        self.assertEqual(
            metadata["verification_uri_complete"],
            "https://jimeng.jianying.com/ai-tool/cli-auth?user_code=ABC123",
        )


class JimengVersionTests(unittest.TestCase):
    def test_cli_version_falls_back_to_installer_metadata(self):
        async def scenario():
            with patch("main.jimeng_cli_executable", return_value="wsl.exe"), \
                 patch("main.jimeng_cli_binary_available", new=AsyncMock(return_value=True)), \
                 patch("main.run_jimeng_cli", new=AsyncMock(return_value={"_stdout": '{"version":"ec1b9fa-dirty"}'})), \
                 patch("main.jimeng_version_file_text", new=AsyncMock(return_value='{"version":"1.4.18"}')):
                return await main.jimeng_cli_version()

        version, raw = asyncio.run(scenario())
        self.assertEqual(version, (1, 4, 18))
        self.assertIn("1.4.18", raw)

    def test_cli_version_reads_semver_from_json_output(self):
        async def scenario():
            with patch("main.jimeng_cli_executable", return_value="dreamina"), \
                 patch("main.jimeng_cli_binary_available", new=AsyncMock(return_value=True)), \
                 patch("main.run_jimeng_cli", new=AsyncMock(return_value={"_stdout": '{"version":"1.4.18"}'})):
                return await main.jimeng_cli_version()

        version, _raw = asyncio.run(scenario())
        self.assertEqual(version, (1, 4, 18))


class JimengReferenceMediaTests(unittest.TestCase):
    def test_storage_file_upload_url_resolves_to_local_path(self):
        async def scenario(directory):
            with patch.object(main, "OUTPUT_INPUT_DIR", directory):
                return await main.jimeng_prepare_local_media(
                    "/api/storage-files/upload/ai_ref_example.jpg", "image"
                )

        with tempfile.TemporaryDirectory() as directory:
            image_path = Path(directory) / "ai_ref_example.jpg"
            image_path.write_bytes(b"reference")
            path, temp_paths = asyncio.run(scenario(directory))

            self.assertEqual(path, str(image_path))
            self.assertEqual(temp_paths, [])

    def test_unknown_local_reference_still_reports_a_clear_error(self):
        async def scenario():
            return await main.jimeng_prepare_local_media(
                "/api/storage-files/upload/missing.jpg", "image"
            )

        with tempfile.TemporaryDirectory() as directory, \
             patch.object(main, "storage_kind_roots", return_value=[directory]):
            with self.assertRaises(HTTPException) as caught:
                asyncio.run(scenario())
            self.assertEqual(caught.exception.status_code, 404)
            self.assertIn("即梦参考素材不存在", caught.exception.detail)

    def test_image_generation_passes_storage_reference_as_wsl_path(self):
        with tempfile.TemporaryDirectory(prefix="即梦参考图-") as directory:
            image_path = Path(directory) / "商品 参考.jpg"
            image_path.write_bytes(b"reference")
            ref_url = "/api/storage-files/upload/" + main.urllib.parse.quote(image_path.name)
            expected_path = main.windows_path_to_wsl(str(image_path))
            cli = AsyncMock(return_value={"submit_id": "test-submit"})
            with patch.object(main, "storage_kind_roots", return_value=[directory]), \
                 patch.object(main, "jimeng_use_wsl", return_value=True), \
                 patch.object(main, "run_jimeng_cli", cli), \
                 patch.object(main, "jimeng_store_outputs", AsyncMock(return_value=["/output/result.png"])):
                result, _raw = asyncio.run(main.generate_jimeng_provider_image(
                    "编辑参考图", "2448x3264", "5.0", [{"url": ref_url}]
                ))

            args = cli.call_args.args[0]
            self.assertEqual(args[0], "image2image")
            self.assertIn(f"--images={expected_path}", args)
            self.assertIn("--model_version=5.0", args)
            self.assertIn("--ratio=3:4", args)
            self.assertIn("--resolution_type=4k", args)
            self.assertEqual(result, {"type": "url", "value": "/output/result.png"})
            self.assertEqual(image_path.read_bytes(), b"reference")


if __name__ == "__main__":
    unittest.main()
