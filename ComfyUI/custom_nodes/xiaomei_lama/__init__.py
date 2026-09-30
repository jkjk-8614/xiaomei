"""Load Mixlab's original LaMa node without its unrelated server replacement."""
import importlib.util
from pathlib import Path

source = Path(__file__).parent.parent / "comfyui-mixlab-nodes.disabled" / "nodes" / "Lama.py"
spec = importlib.util.spec_from_file_location("xiaomei_mixlab_lama", source)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
NODE_CLASS_MAPPINGS = {"LaMaInpainting": module.LaMaInpainting}
NODE_DISPLAY_NAME_MAPPINGS = {"LaMaInpainting": "LaMaInpainting"}
