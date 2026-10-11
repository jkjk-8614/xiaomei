"""Install optional ONNX Runtime CUDA dependencies in persistent user data."""

import argparse
import json
import os
from pathlib import Path
import subprocess
import sys


GPU_VERSION = "1.23.2"


def install(data_root: Path) -> dict:
    target = data_root / "components" / f"onnx-gpu-{GPU_VERSION}"
    marker = target / "gpu-ready.json"
    if marker.is_file():
        return {"ok": True, "already_installed": True, "path": str(target)}
    target.mkdir(parents=True, exist_ok=True)
    command = [
        sys.executable, "-m", "pip", "install",
        "--disable-pip-version-check", "--no-cache-dir", "--no-compile",
        "--only-binary=:all:", "--upgrade", "--target", str(target),
        f"onnxruntime-gpu[cuda,cudnn]=={GPU_VERSION}",
        "numpy==2.2.6", "protobuf==7.36.0", "sympy==1.14.0",
    ]
    subprocess.run(command, check=True)
    probe = (
        "import sys; sys.path.insert(0, sys.argv[1]); "
        "import onnxruntime as ort; "
        "assert 'CUDAExecutionProvider' in ort.get_available_providers(), "
        "'CUDAExecutionProvider is unavailable'"
    )
    subprocess.run([sys.executable, "-c", probe, str(target)], check=True)
    temporary = marker.with_suffix(".tmp")
    temporary.write_text(json.dumps({"version": GPU_VERSION}) + "\n", encoding="utf-8")
    os.replace(temporary, marker)
    return {"ok": True, "already_installed": False, "path": str(target)}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("data_root", type=Path)
    args = parser.parse_args()
    print(json.dumps(install(args.data_root.resolve()), ensure_ascii=False))
