"""Start the API with the bundled Windows Python runtime.

The embedded interpreter keeps its own standard library and site-packages.
This entry point adds the application root before loading ``main.py`` so the
same backend works from an installed package and from a source checkout.
"""

import os
import runpy
import sys
from pathlib import Path


project_root = Path(os.environ.get("XIAOMEI_CANVAS_PROJECT_ROOT") or Path(__file__).resolve().parent).resolve()
if str(project_root) not in sys.path:
    sys.path.insert(0, str(project_root))

data_root = os.environ.get("XIAOMEI_CANVAS_DATA_ROOT")
if data_root:
    gpu_root = Path(data_root) / "components" / "onnx-gpu-1.23.2"
    if (gpu_root / "gpu-ready.json").is_file():
        sys.path.insert(0, str(gpu_root))

runpy.run_path(str(project_root / "main.py"), run_name="__main__")
