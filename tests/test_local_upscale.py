import os
import subprocess
import tempfile
import unittest
from unittest.mock import patch

from PIL import Image

import main


class LocalUpscaleTests(unittest.TestCase):
    def test_scale_mode_uses_real_ai_scale(self):
        plan = main.local_upscale_plan(1024, 768, "scale", 2, "4k", "real-esrgan")

        self.assertEqual(plan["target_size"], (2048, 1536))
        self.assertEqual(plan["input_size"], (1024, 768))
        self.assertEqual(plan["inference_scale"], 2)
        self.assertFalse(plan["repair_mode"])

    def test_target_mode_rebuilds_an_already_4k_image(self):
        plan = main.local_upscale_plan(4096, 4096, "target", 2, "4k", "real-esrgan")

        self.assertEqual(plan["target_size"], (4096, 4096))
        self.assertEqual(plan["input_size"], (2048, 2048))
        self.assertEqual(plan["inference_scale"], 2)
        self.assertTrue(plan["repair_mode"])

    def test_target_mode_rejects_more_than_one_four_x_pass(self):
        with self.assertRaisesRegex(ValueError, "超过单次 4x"):
            main.local_upscale_plan(1024, 768, "target", 2, "8k", "real-esrgan")

    def test_seedvr2_does_not_claim_8k_support(self):
        with self.assertRaisesRegex(ValueError, "最多输出长边 4096"):
            main.local_upscale_plan(4096, 4096, "scale", 2, "4k", "seedvr2-3b-fp8")

    def test_real_esrgan_process_creates_a_new_file_without_paid_api(self):
        with tempfile.TemporaryDirectory() as directory:
            model_root = os.path.join(directory, "models")
            install_dir = os.path.join(model_root, "realesrgan")
            output_dir = os.path.join(directory, "output")
            os.makedirs(os.path.join(install_dir, "models"))
            os.makedirs(output_dir)
            executable = os.path.join(install_dir, "realesrgan-ncnn-vulkan.exe")
            with open(executable, "wb") as handle:
                handle.write(b"test")
            source_path = os.path.join(directory, "source.png")
            Image.new("RGB", (16, 12), (40, 80, 120)).save(source_path)

            def fake_run(command, **_kwargs):
                input_path = command[command.index("-i") + 1]
                output_path = command[command.index("-o") + 1]
                scale = int(command[command.index("-s") + 1])
                with Image.open(input_path) as image:
                    image.resize((image.width * scale, image.height * scale)).save(output_path)
                return subprocess.CompletedProcess(command, 0, b"", b"")

            payload = main.LocalImageUpscaleRequest(
                source_url="/assets/output/source.png",
                name="source.png",
                model_id="real-esrgan",
                mode="scale",
                scale=2,
                strength="high",
                output_format="png",
            )
            with patch.object(main, "LOCAL_UPSCALE_MODEL_DIR", model_root), patch.object(
                main, "OUTPUT_OUTPUT_DIR", output_dir
            ), patch.object(
                main, "_local_upscale_realesrgan_executable", return_value=executable
            ), patch.object(main.subprocess, "run", side_effect=fake_run) as process_call:
                result = main._local_upscale_process(
                    source_path,
                    payload.source_url,
                    payload.name,
                    payload,
                )

            generated = [os.path.join(output_dir, name) for name in os.listdir(output_dir)]
            self.assertEqual(len(generated), 1)
            with Image.open(generated[0]) as image:
                self.assertEqual(image.size, (32, 24))
            command = process_call.call_args.args[0]
            self.assertIn("realesrgan-x4plus", command)
            self.assertEqual(command[command.index("-s") + 1], "4")
            self.assertEqual(command[command.index("-j") + 1], "1:1:1")
            self.assertEqual(result["upscale"]["native_scale"], 4)
            self.assertEqual(result["upscale"]["paid_api"], False)
            self.assertEqual(result["derived_from"]["operation"], "local-upscale")
            self.assertTrue(os.path.isfile(source_path))

    def test_optional_models_never_silently_fall_back(self):
        capabilities = {
            "swinir": {"ready": False, "address": "", "models": [], "message": "ComfyUI 未启动"},
            "seedvr2": {"ready": False, "address": "", "dit_model": "", "vae_model": "", "message": "ComfyUI 未启动"},
        }
        with patch.object(main, "_local_upscale_comfy_capabilities", return_value=capabilities), patch.object(
            main, "_local_upscale_realesrgan_state", return_value={"id": "real-esrgan"}
        ):
            models = main.local_upscale_model_states()

        self.assertFalse(models[1]["available"])
        self.assertFalse(models[2]["available"])
        self.assertEqual(models[1]["backend"], "comfyui")
        self.assertEqual(models[2]["backend"], "comfyui")

    def test_canvas_exposes_local_upscale_controls(self):
        root = os.path.dirname(os.path.dirname(__file__))
        with open(os.path.join(root, "static", "smart-canvas.html"), encoding="utf-8") as handle:
            html = handle.read()
        with open(os.path.join(root, "static", "js", "smart-canvas.js"), encoding="utf-8") as handle:
            script = handle.read()

        self.assertIn('id="smartUpscalePopover"', html)
        self.assertIn('id="smartUpscaleModelHelpText"', html)
        self.assertIn('data-smart-upscale-scale="2"', html)
        self.assertIn('data-smart-upscale-scale="4"', html)
        self.assertIn("{key:'upscale'", script)
        self.assertIn("/api/image/local-upscale", script)
        self.assertIn("SMART_LOCAL_UPSCALE_MODEL_COPY", script)
        self.assertIn("产品、Logo、文字", script)
        self.assertIn("addConnection(sourceNode.id, outputNode.id, 'flow')", script)


if __name__ == "__main__":
    unittest.main()
