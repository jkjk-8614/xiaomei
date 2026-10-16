"""Check the process proxy exclusion passed to HTTPX without loading user data."""

import ast
import ipaddress
import os
from pathlib import Path
import unittest
from unittest.mock import patch

import httpx


class HttpxNoProxyTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        source = Path(__file__).resolve().parents[1] / "main.py"
        tree = ast.parse(source.read_text(encoding="utf-8"))
        function = next(
            node for node in tree.body
            if isinstance(node, ast.FunctionDef) and node.name == "normalize_httpx_no_proxy"
        )
        namespace = {"os": os, "ipaddress": ipaddress}
        exec(compile(ast.Module(body=[function], type_ignores=[]), str(source), "exec"), namespace)
        cls.normalize = staticmethod(namespace["normalize_httpx_no_proxy"])

    def test_ipv6_single_host_network_keeps_its_proxy_exclusion(self):
        exclusions = "127.0.0.1,localhost,::1/128,127.0.0.0/8"
        with patch.dict(os.environ, {"NO_PROXY": exclusions, "no_proxy": exclusions}):
            self.normalize()
            self.assertEqual(os.environ["NO_PROXY"], "127.0.0.1,localhost,::1,127.0.0.0/8")
            with httpx.Client() as client:
                self.assertIsNotNone(client)

    def test_other_exclusions_and_invalid_entries_are_preserved(self):
        exclusions = "localhost,example.test,invalid/128,2001:db8::/64"
        with patch.dict(os.environ, {"NO_PROXY": exclusions, "no_proxy": exclusions}):
            self.normalize()
            self.assertEqual(os.environ["NO_PROXY"], exclusions)


if __name__ == "__main__":
    unittest.main()
