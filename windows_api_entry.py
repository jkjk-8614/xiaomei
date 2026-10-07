"""Start the desktop API with the official Windows embedded Python runtime.

The embedded interpreter is deliberately kept separate from the application
source tree.  This small entry point adds the source root before importing
``main.py`` so local modules work while the interpreter remains isolated from
any Python installation on the user's machine.
"""

import os
import runpy
import sys
from pathlib import Path


project_root = Path(os.environ.get("XIAOMEI_CANVAS_PROJECT_ROOT") or Path(__file__).resolve().parent)
project_root = project_root.resolve()
if str(project_root) not in sys.path:
    sys.path.insert(0, str(project_root))

runpy.run_path(str(project_root / "main.py"), run_name="__main__")
