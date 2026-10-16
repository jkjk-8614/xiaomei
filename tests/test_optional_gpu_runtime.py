import importlib.util
from pathlib import Path
import runpy
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]


def module_at(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class OptionalGpuTests(unittest.TestCase):
    def test_cpu_build_guard(self):
        guard = module_at("cpu_guard", ROOT / "scripts/verify_cpu_runtime.py")
        guard.verify(["onnxruntime", "numpy"], ["CPUExecutionProvider"])
        for name in ["onnxruntime-gpu", "onnxruntime_gpu", "nvidia-cudnn-cu12"]:
            with self.assertRaises(RuntimeError):
                guard.verify(["onnxruntime", name], ["CPUExecutionProvider"])
        with self.assertRaises(RuntimeError):
            guard.verify(["onnxruntime"], ["CUDAExecutionProvider", "CPUExecutionProvider"])

    def test_optional_download_success_and_reuse(self):
        installer = module_at("gpu_install", ROOT / "tools/install_windows_gpu_runtime.py")
        with tempfile.TemporaryDirectory() as folder, patch.object(installer.subprocess, "run") as run:
            result = installer.install(Path(folder))
            command = run.call_args_list[0].args[0]
            self.assertIn(f"onnxruntime-gpu[cuda,cudnn]=={installer.GPU_VERSION}", command)
            self.assertIn(str(Path(folder) / "components" / f"onnx-gpu-{installer.GPU_VERSION}"), command)
            self.assertEqual(run.call_count, 2)
            self.assertTrue((Path(result["path"]) / "gpu-ready.json").is_file())
            self.assertTrue(installer.install(Path(folder))["already_installed"])
            self.assertEqual(run.call_count, 2)

    def test_failed_download_never_activates_component(self):
        installer = module_at("gpu_install_failure", ROOT / "tools/install_windows_gpu_runtime.py")
        with tempfile.TemporaryDirectory() as folder, patch.object(installer.subprocess, "run", side_effect=subprocess.CalledProcessError(1, "pip")):
            with self.assertRaises(subprocess.CalledProcessError):
                installer.install(Path(folder))
            self.assertFalse(list(Path(folder).rglob("gpu-ready.json")))

    def test_api_entry_activates_only_completed_component(self):
        with tempfile.TemporaryDirectory() as folder:
            gpu = Path(folder) / "components" / "onnx-gpu-1.23.2"
            gpu.mkdir(parents=True)
            for ready in [False, True]:
                if ready:
                    (gpu / "gpu-ready.json").write_text('{}', encoding="utf-8")
                with patch.dict("os.environ", {"XIAOMEI_CANVAS_DATA_ROOT": folder}), patch.object(sys, "path", list(sys.path)), patch("runpy.run_path"):
                    exec(compile((ROOT / "windows_api_entry.py").read_text(encoding="utf-8"), str(ROOT / "windows_api_entry.py"), "exec"), {"__file__": str(ROOT / "windows_api_entry.py")})
                    self.assertEqual(str(gpu) in sys.path, ready)


if __name__ == '__main__':
    unittest.main()
