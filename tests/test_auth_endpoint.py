"""Integration tests for NetBird-backed cookie authentication (no live credentials)."""
import http.cookiejar
import json
import os
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer
from unittest.mock import patch

os.environ.setdefault("SHIROBIRD_DATA", tempfile.mkdtemp(prefix="shirobird-auth-tests-"))
os.environ.setdefault("SHIROBIRD_ADMIN_TOKEN", "unit_admin_" * 8)
os.environ.setdefault("SHIROBIRD_INGEST_TOKEN", "unit_ingest_" * 8)

from shirobird import server

class NetBirdSSOHTTPTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        server.init_db()
        cls.http = ThreadingHTTPServer(("127.0.0.1", 0), server.Handler)
        cls.http.daemon_threads = True
        cls.thread = threading.Thread(target=cls.http.serve_forever, daemon=True)
        cls.thread.start()
        cls.url = "http://127.0.0.1:" + str(cls.http.server_port)
    @classmethod
    def tearDownClass(cls):
        cls.http.shutdown()
        cls.http.server_close()

    def _call(self, path, opener=None, **kwargs):
        req = urllib.request.Request(self.url + path, **kwargs)
        return (opener.open(req, timeout=3) if opener else
                urllib.request.urlopen(req, timeout=3))

    def test_netbird_login_sets_short_lived_cookie(self):
        jar = http.cookiejar.CookieJar()
        opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))
        admin = {"id": "owner-1", "role": "owner", "name": "Mock owner"}
        with patch.object(server, "AUTH_MODE", "netbird"), patch.object(server, "EMBEDDED", True), patch.object(server, "COOKIE_PATH", "/shirobird/"), patch.object(server, "COOKIE_SECURE", False), patch.object(server.netbird_auth, "current_admin", return_value=admin) as verify:
            with self._call("/api/netbird-session", opener=opener, method="POST",
                            headers={"Authorization":"Bearer simulated_netbird_session"}) as response:
                self.assertEqual(response.status, 200)
                cookie = response.headers.get("Set-Cookie", "")
                self.assertIn("HttpOnly", cookie)
                self.assertIn("SameSite=Strict", cookie)
                self.assertIn("Path=/shirobird/", cookie)
                self.assertIn("Max-Age=180", cookie)
            verify.assert_called_once()
            # Cookie is restricted to /shirobird/. Mimic Nginx rewrite on the test server
            # by creating a direct request with the signed cookie.
            token = next(iter(jar)).value
            with self._call("/api/stats", headers={"Cookie": "shirobird_session=" + token}) as reply:
                self.assertEqual(reply.status, 200)
            with self.assertRaises(urllib.error.HTTPError) as denial:
                self._call("/api/login", method="POST", data=b"{}")
            self.assertEqual(denial.exception.code, 404)

    def test_rejected_identity_does_not_issue_cookie(self):
        with patch.object(server, "AUTH_MODE", "netbird"), patch.object(server, "EMBEDDED", True), patch.object(server.netbird_auth, "current_admin", return_value=None):
            with self.assertRaises(urllib.error.HTTPError) as denied:
                self._call("/api/netbird-session", method="POST",
                           headers={"Authorization":"Bearer insufficient_role"})
            self.assertEqual(denied.exception.code, 403)

    def test_no_token_is_unauthorized(self):
        with patch.object(server, "AUTH_MODE", "netbird"), patch.object(server, "EMBEDDED", True):
            with self.assertRaises(urllib.error.HTTPError) as denied:
                self._call("/api/netbird-session", method="POST")
            self.assertEqual(denied.exception.code, 401)
