import asyncio
import os
import tempfile
import unittest
from unittest.mock import AsyncMock, patch

from PIL import Image

import main


class GeminiCliNativeImageTests(unittest.TestCase):
    def test_cli_image_timeout_is_fixed_at_five_minutes(self):
        with patch.dict(
            os.environ,
            {
                "GEMINI_CLI_TIMEOUT": "777",
                "GEMINI_CLI_IMAGE_TIMEOUT": "333",
                "ANTIGRAVITY_IMAGE_TIMEOUT": "999",
            },
            clear=True,
        ):
            self.assertEqual(main.gemini_cli_image_timeout(), 300)

    def test_cli_result_is_not_lanczos_upscaled(self):
        with tempfile.TemporaryDirectory() as directory:
            source_path = os.path.join(directory, "source.png")
            Image.new("RGB", (32, 32), "white").save(source_path)

            self.assertEqual(
                main.codex_postprocess_image_to_requested_size(source_path, "512x512", "gemini-cli"),
                "",
            )
            self.assertFalse(os.path.exists(os.path.join(directory, "source_upscaled_512x512.png")))

    def test_cli_ai_upscale_keeps_original_when_local_seedvr2_is_unavailable(self):
        with tempfile.TemporaryDirectory() as directory:
            source_path = os.path.join(directory, "source.png")
            Image.new("RGB", (32, 32), "white").save(source_path)
            with patch.object(main, "gemini_cli_seedvr2_backend_status", return_value=("", "ComfyUI 未启动")):
                result_path, metadata = asyncio.run(
                    main.gemini_cli_local_ai_upscale_image(source_path, "512x512")
                )

            self.assertEqual(result_path, source_path)
            self.assertEqual(metadata["status"], "skipped")
            self.assertIn("ComfyUI 未启动", metadata["message"])

    def test_cli_ai_upscale_uses_seedvr2_workflow_when_local_backend_is_ready(self):
        with tempfile.TemporaryDirectory() as directory:
            source_path = os.path.join(directory, "source.png")
            result_path = os.path.join(directory, "seedvr2.png")
            Image.new("RGB", (32, 32), "white").save(source_path)
            Image.new("RGB", (64, 64), "white").save(result_path)

            with patch.object(main, "gemini_cli_upload_image_to_comfy", return_value="uploaded.png"), patch.object(
                main, "generate", return_value={"images": ["/output/seedvr2.png"]}
            ) as generate_call, patch.object(main, "output_file_from_url", return_value=result_path):
                output_path, metadata = main.gemini_cli_local_ai_upscale_sync(
                    source_path,
                    "2256x3840",
                    "127.0.0.1:8188",
                )

            request = generate_call.call_args.args[0]
            self.assertEqual(output_path, result_path)
            self.assertEqual(metadata["status"], "succeeded")
            self.assertEqual(metadata["engine"], "SeedVR2")
            self.assertEqual(request.workflow_json, "upscale.json")
            self.assertEqual(request.params["15"]["image"], "uploaded.png")
            self.assertEqual(request.params["172"]["resolution"], 3840)
            self.assertFalse(request.record_history)
            self.assertEqual(request.timeout_seconds, 300)

    def test_native_artifact_is_materialized_and_prompt_requires_generate_image(self):
        with tempfile.TemporaryDirectory() as directory:
            brain_root = os.path.join(directory, "brain")
            output_root = os.path.join(directory, "output")
            os.makedirs(brain_root)
            original_output_dir = main.OUTPUT_OUTPUT_DIR

            async def fake_run(prompt, **kwargs):
                artifact_path = os.path.join(brain_root, "canvas_image_result.png")
                Image.new("RGB", (24, 24), "red").save(artifact_path)
                return {"text": f"已生成：{artifact_path}", "raw": {}}

            async def fake_upscale(path, _size):
                return path, {"status": "skipped", "engine": "SeedVR2", "message": "ComfyUI 未启动"}

            main.OUTPUT_OUTPUT_DIR = output_root
            try:
                cli_call = AsyncMock(side_effect=fake_run)
                with patch.object(main, "gemini_cli_executable", return_value="C:\\Users\\test\\agy.exe"), patch.object(
                    main, "gemini_cli_image_storage_roots", return_value=[brain_root]
                ), patch.object(main, "run_gemini_cli", cli_call), patch.object(
                    main, "gemini_cli_local_ai_upscale_image", fake_upscale
                ):
                    result, metadata = asyncio.run(
                        main.generate_gemini_cli_provider_image(
                            "生成一张红色圆形图片",
                            "1024x1024",
                            "auto",
                            provider={"id": "gemini-cli", "protocol": "gemini-cli"},
                        )
                    )
            finally:
                main.OUTPUT_OUTPUT_DIR = original_output_dir

            prompt = cli_call.await_args.args[0]
            self.assertEqual(result["type"], "url")
            self.assertEqual(len(metadata["images"]), 1)
            self.assertTrue(os.path.isfile(os.path.join(output_root, os.path.basename(metadata["images"][0]))))
            self.assertIn("generate_image", prompt)
            self.assertIn("ImageName:", prompt)
            self.assertIn("ImagePaths:", prompt)
            self.assertIn("toolAction:", prompt)
            self.assertIn("toolSummary:", prompt)
            self.assertTrue(cli_call.await_args.kwargs["allow_tools"])
            self.assertEqual(cli_call.await_args.kwargs["task_kind"], "image")

    def test_native_artifact_scan_ignores_old_and_temporary_images(self):
        with tempfile.TemporaryDirectory() as directory:
            brain_root = os.path.join(directory, "brain")
            temp_root = os.path.join(brain_root, ".tempmediaStorage")
            os.makedirs(temp_root)
            old_path = os.path.join(brain_root, "old.png")
            temp_path = os.path.join(temp_root, "input.png")
            new_path = os.path.join(brain_root, "new.png")
            for path in (old_path, temp_path, new_path):
                Image.new("RGB", (8, 8), "white").save(path)
            os.utime(old_path, (1, 1))
            since = os.path.getmtime(new_path) - 0.1

            with patch.object(main, "gemini_cli_image_storage_roots", return_value=[brain_root]):
                files = main.gemini_cli_generated_image_files(since)

            self.assertIn(os.path.abspath(new_path), files)
            self.assertNotIn(os.path.abspath(old_path), files)
            self.assertNotIn(os.path.abspath(temp_path), files)

    def test_antigravity_quota_failure_is_reported_without_provider_fallback(self):
        detail = main.gemini_cli_image_failure_detail(
            {"text": "generate_image failed: 429 RESOURCE_EXHAUSTED quota exceeded"},
            "C:\\Users\\test\\agy.exe",
            "auto",
        )
        self.assertIn("图片配额", detail)
        self.assertNotIn("6789", detail)
        self.assertNotIn("API Key", detail)

    def test_non_antigravity_cli_is_rejected_before_image_generation(self):
        cli_call = AsyncMock()
        with patch.object(main, "gemini_cli_executable", return_value="gemini"), patch.object(
            main, "run_gemini_cli", cli_call
        ):
            with self.assertRaises(main.HTTPException) as caught:
                asyncio.run(main.generate_gemini_cli_provider_image("生成一张图片", "1024x1024", "auto"))

        self.assertEqual(caught.exception.status_code, 400)
        self.assertIn("Antigravity CLI", str(caught.exception.detail))
        cli_call.assert_not_awaited()


if __name__ == "__main__":
    unittest.main()
