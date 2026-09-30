import unittest
from unittest.mock import patch

import main


class JimengLoginMetadataTests(unittest.TestCase):
    def test_device_flow_url_is_not_mistaken_for_an_image(self):
        text = (
            "verification_uri: https://jimeng.jianying.com/ai-tool/cli-auth?\n"
            "verification_uri_complete: https%3A%2F%2Fjimeng.jianying.com%2Fai-tool%2Fcli-auth%3Fuser_code%3DABC123\n"
            "user_code: ABC123\n"
            "device_code: secret-device-code"
        )

        metadata = main.jimeng_login_metadata(text)

        self.assertEqual(metadata["qr_url"], "")
        self.assertEqual(
            metadata["verification_uri_complete"],
            "https://jimeng.jianying.com/ai-tool/cli-auth?user_code=ABC123",
        )
        self.assertEqual(metadata["user_code"], "ABC123")

    def test_headless_login_is_followed_by_checklogin(self):
        with patch("main.time.time", return_value=1_700_000_000):
            args = main.jimeng_login_check_args(
                "DEVICE123",
                "expires_at: 2023-11-14T22:14:20+00:00",
            )

        self.assertEqual(args[:2], ["login", "checklogin"])
        self.assertEqual(args[2], "--device_code=DEVICE123")
        self.assertEqual(args[3], "--poll=60")

    def test_expired_or_invalid_expiry_uses_safe_fallback(self):
        with patch("main.time.time", return_value=1_700_000_000):
            self.assertEqual(main.jimeng_login_poll_seconds("expires_at: invalid"), 300)
            self.assertEqual(
                main.jimeng_login_poll_seconds("expires_at: 2023-11-14T22:13:19+00:00"),
                1,
            )

    def test_missing_complete_url_gets_a_local_fallback(self):
        metadata = main.jimeng_login_metadata(
            "verification_uri: https://jimeng.jianying.com/ai-tool/cli-auth?\n"
            "user_code: ABC123"
        )

        self.assertEqual(
            metadata["verification_uri_complete"],
            "https://jimeng.jianying.com/ai-tool/cli-auth?user_code=ABC123",
        )


if __name__ == "__main__":
    unittest.main()
