import json
import os
import unittest
from io import BytesIO
from unittest.mock import patch

from shirobird import netbird_auth

class SignedSessionTests(unittest.TestCase):
    def test_valid_session_and_expiry(self):
        key = "secret" * 10
        value = netbird_auth.sign_session("netbird-user-123", key, now=1000000000)
        self.assertTrue(netbird_auth.session_valid(value, key, now=1000000001))
        self.assertFalse(netbird_auth.session_valid(value, key, now=1000000181))
        self.assertFalse(netbird_auth.session_valid(value, key + "changed", now=1000000001))

    def test_non_session_rejected(self):
        self.assertFalse(netbird_auth.session_valid("9999999999." + "0" * 64, "key"))
        self.assertFalse(netbird_auth.session_valid("nb.bad", "key"))

class FakeResponse:
    status = 200
    def __init__(self, user): self.user = user
    def __enter__(self): return self
    def __exit__(self, *args): return False
    def read(self, size): return json.dumps(self.user).encode()

class FakeOpen:
    def __init__(self, user): self.user = user
    def open(self, req, timeout):
        assert req.full_url == "http://netbird-server:80/api/users/current"
        assert req.headers.get("Authorization") == "Bearer test_valid_token"
        assert timeout == 4
        return FakeResponse(self.user)

class NetBirdIdentityTests(unittest.TestCase):
    def identity(self, role, status="active", blocked=False):
        user = {"id": "user-1", "role": role, "status": status,
                "is_blocked": blocked, "is_service_user": False}
        with patch("shirobird.netbird_auth.build_opener", return_value=FakeOpen(user)):
            return netbird_auth.current_admin(
                "test_valid_token", "http://netbird-server:80/api/users/current")

    def test_owner_and_admin_allowed(self):
        self.assertIsNotNone(self.identity("owner"))
        self.assertIsNotNone(self.identity("admin"))

    def test_other_roles_denied(self):
        for role in ("user", "auditor", "network_admin", "billing_admin"):
            with self.subTest(role=role):
                self.assertIsNone(self.identity(role))

    def test_blocked_and_inactive_denied(self):
        self.assertIsNone(self.identity("owner", blocked=True))
        self.assertIsNone(self.identity("admin", status="pending"))

    def test_untrusted_endpoint_fails_closed(self):
        with self.assertRaises(ValueError):
            netbird_auth.current_admin("test_valid_token", "https://attacker.invalid/api/users/current")

    def test_short_or_malformed_token_fails(self):
        self.assertIsNone(netbird_auth.current_admin("", "http://netbird-server:80/api/users/current"))
        self.assertIsNone(netbird_auth.current_admin("a" * 9000, "http://netbird-server:80/api/users/current"))
