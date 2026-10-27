"""Dedicated ShiroBird Customize API, independent from the Traffic Flow server UI."""
import json
import os
import sqlite3
from http import cookies
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit

from shirobird import customize, netbird_auth

ADMIN_KEY = os.environ.get("SHIROBIRD_ADMIN_TOKEN", "")
DATA = Path(os.environ.get("SHIROBIRD_DATA", "/data"))
DB = DATA / "shirobird.sqlite3"
MAX_BODY = 16384

def initialize():
    DATA.mkdir(parents=True, exist_ok=True)
    with sqlite3.connect(DB, timeout=20) as conn:
        conn.execute("""CREATE TABLE IF NOT EXISTS ui_visibility (
            feature TEXT PRIMARY KEY,
            enabled INTEGER NOT NULL CHECK(enabled IN (0,1))
        )""")

class Handler(BaseHTTPRequestHandler):
    server_version = "ShiroBirdCustomize/1.0"

    def reply(self, code, data):
        body = json.dumps(data, separators=(",", ":")).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("X-Frame-Options", "DENY")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def authorized(self):
        if not ADMIN_KEY:
            return False
        try:
            cookie = cookies.SimpleCookie()
            cookie.load(self.headers.get("Cookie", ""))
            value = cookie.get("shirobird_session")
            return bool(value and netbird_auth.session_valid(value.value, ADMIN_KEY))
        except (cookies.CookieError, ValueError):
            return False

    def do_GET(self):
        route = urlsplit(self.path).path
        if route == "/healthz":
            return self.reply(200, {"status": "ok"})
        if route != "/api/customize":
            return self.reply(404, {"error": "not found"})
        if not self.authorized():
            return self.reply(401, {"error": "unauthorized"})
        try:
            return self.reply(200, customize.get_settings())
        except (sqlite3.Error, OSError):
            return self.reply(503, {"error": "settings unavailable"})

    def do_POST(self):
        if urlsplit(self.path).path != "/api/customize":
            return self.reply(404, {"error": "not found"})
        if not self.authorized():
            return self.reply(401, {"error": "unauthorized"})
        if self.headers.get("Content-Type", "").split(";")[0].strip().lower() != "application/json":
            return self.reply(415, {"error": "application/json required"})
        if self.headers.get("X-ShiroBird-Action") != "customize":
            return self.reply(403, {"error": "action header required"})
        try:
            size = int(self.headers.get("Content-Length", ""))
            if not 0 < size <= MAX_BODY:
                return self.reply(413, {"error": "invalid request size"})
            change = json.loads(self.rfile.read(size))
            result = customize.update_settings(change)
            return self.reply(200, result)
        except (ValueError, TypeError, UnicodeDecodeError) as exc:
            return self.reply(400, {"error": str(exc)})
        except (sqlite3.Error, OSError):
            return self.reply(503, {"error": "settings unavailable"})

if __name__ == "__main__":
    initialize()
    ThreadingHTTPServer(("0.0.0.0", 8777), Handler).serve_forever()
