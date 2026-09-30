#!/usr/bin/env python3
"""通过浏览器获取 1688 AK（Access Key）"""

COMMAND_NAME = "get_ak"
COMMAND_DESC = "通过浏览器获取AK"

import os
import sys
import subprocess

sys.path.insert(0, os.path.normpath(os.path.join(os.path.dirname(__file__), '..', '..')))

from _output import make_output, print_output


def main():
    timeout = 300
    args = sys.argv[1:]

    for i, arg in enumerate(args):
        if arg == "--timeout" and i + 1 < len(args):
            try:
                timeout = int(args[i + 1])
            except ValueError:
                pass

    scripts_dir = os.path.normpath(os.path.join(os.path.dirname(__file__), '..', '..'))
    script = os.path.join(scripts_dir, "authorize.py")

    if not os.path.isfile(script):
        print_output(make_output(
            success=False,
            error_code="SCRIPT_NOT_FOUND",
            markdown=f"授权脚本未找到: {script}",
        ))
        return 1

    result = subprocess.run(
        [sys.executable, script, "--mode", "AK", "--timeout", str(timeout)],
        capture_output=True, text=True,
        cwd=scripts_dir,
    )

    if result.stdout.strip():
        print(result.stdout.strip(), flush=True)

    if result.returncode != 0 and not result.stdout.strip():
        error_detail = result.stderr.strip() or f"进程退出码: {result.returncode}"
        print_output(make_output(
            success=False,
            error_code="SUBPROCESS_ERROR",
            markdown=f"获取 AK 失败：{error_detail}",
        ))

    return result.returncode


if __name__ == "__main__":
    sys.exit(main())
