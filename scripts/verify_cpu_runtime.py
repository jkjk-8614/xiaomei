"""Reject GPU dependencies in the default packaged API runtime."""

import importlib.metadata
import re


def verify(distributions=None, providers=None):
    if distributions is None:
        distributions = [item.metadata.get("Name", "") for item in importlib.metadata.distributions()]
    names = {re.sub(r"[-_.]+", "-", name).lower() for name in distributions}
    forbidden = sorted(name for name in names if name == "onnxruntime-gpu" or name.startswith("nvidia-"))
    if forbidden:
        raise RuntimeError("Optional GPU packages found in base runtime: " + ", ".join(forbidden))
    if "onnxruntime" not in names:
        raise RuntimeError("CPU ONNX Runtime is missing")
    if providers is None:
        import onnxruntime
        providers = onnxruntime.get_available_providers()
    if "CPUExecutionProvider" not in providers or "CUDAExecutionProvider" in providers:
        raise RuntimeError("Base runtime must provide CPU inference without CUDA")


if __name__ == "__main__":
    verify()
    print("CPU runtime verified; GPU/CUDA/cuDNN components are separate downloads")
