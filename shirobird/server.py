"""Dependency-free ShiroBird server: API, UI, flow store, live stream and SIEM."""
import csv
import hashlib
import hmac
import io
import ipaddress
import json
import os
from pathlib import Path
import secrets
import socket
import sqlite3
import threading
import time
from http import cookies
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlsplit
from shirobird import netbird_auth

ROOT = Path(__file__).resolve().parent.parent
DATA = Path(os.getenv("SHIROBIRD_DATA", "/data"))
DB_PATH = DATA / "shirobird.sqlite3"
SIEM_PATH = DATA / "siem" / "events.jsonl"
ADMIN_KEY = os.getenv("SHIROBIRD_ADMIN_TOKEN", "")
INGEST_KEY = os.getenv("SHIROBIRD_INGEST_TOKEN", "")
COOKIE_SECURE = os.getenv("SHIROBIRD_COOKIE_SECURE", "true").lower() == "true"
EMBEDDED = os.getenv("SHIROBIRD_EMBEDDED", "false").lower() == "true"
COOKIE_PATH = "/shirobird/" if EMBEDDED else "/"
AUTH_MODE = os.getenv("SHIROBIRD_AUTH_MODE", "token").lower()
NETBIRD_IDENTITY_URL = os.getenv("SHIROBIRD_NETBIRD_IDENTITY_URL", "http://netbird-server:80/api/users/current")
RETENTION_DAYS = max(1, int(os.getenv("SHIROBIRD_RETENTION_DAYS", "30")))
BIND = os.getenv("SHIROBIRD_BIND", "0.0.0.0")
PORT = int(os.getenv("SHIROBIRD_PORT", "8666"))
SYSLOG_TARGET = os.getenv("SHIROBIRD_SYSLOG_HOST", "")
SYSLOG_PORT = int(os.getenv("SHIROBIRD_SYSLOG_PORT", "514"))
MAX_BODY = 1024 * 1024
MAX_QUERY = 10000
WRITE_LOCK = threading.Lock()
STREAM_SLOTS = threading.BoundedSemaphore(12)
FAILED_LOGINS = {}
LOGIN_LOCK = threading.Lock()
VALID_TYPES = {"NEW", "DESTROY", "UPDATE", "SAMPLE"}
FIELDS = ("id", "ts", "sensor", "type", "proto", "src", "dst",
          "sport", "dport", "packets", "bytes")

def connection():
    con = sqlite3.connect(DB_PATH, timeout=20)
    con.row_factory = sqlite3.Row
    con.execute("PRAGMA busy_timeout=20000")
    return con

def init_db():
    DATA.mkdir(parents=True, exist_ok=True)
    SIEM_PATH.parent.mkdir(parents=True, exist_ok=True)
    with connection() as c:
        c.execute("PRAGMA journal_mode=WAL")
        c.execute("""CREATE TABLE IF NOT EXISTS flows (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            ts INTEGER NOT NULL, sensor TEXT NOT NULL, type TEXT NOT NULL,
            proto TEXT NOT NULL, src TEXT NOT NULL, dst TEXT NOT NULL,
            sport INTEGER NOT NULL DEFAULT 0, dport INTEGER NOT NULL DEFAULT 0,
            packets INTEGER NOT NULL DEFAULT 0, bytes INTEGER NOT NULL DEFAULT 0)""")
        c.execute("CREATE INDEX IF NOT EXISTS flows_ts ON flows(ts)")
        c.execute("CREATE INDEX IF NOT EXISTS flows_sensor ON flows(sensor,ts)")

def clean_str(value, maximum):
    if not isinstance(value, str) or not value or len(value) > maximum:
        raise ValueError("invalid string")
    if any(ord(ch) < 32 or ord(ch) == 127 for ch in value):
        raise ValueError("control characters forbidden")
    return value

def number(value, upper):
    if isinstance(value, bool):
        raise ValueError("invalid integer")
    n = int(value)
    if not 0 <= n <= upper:
        raise ValueError("out-of-range integer")
    return n

def validate_event(raw, sensor):
    if not isinstance(raw, dict):
        raise ValueError("event must be an object")
    event_type = clean_str(raw.get("type", ""), 16).upper()
    if event_type not in VALID_TYPES:
        raise ValueError("unsupported event type")
    proto = clean_str(raw.get("proto", ""), 12).lower()
    if proto not in {"tcp", "udp", "icmp", "icmpv6", "sctp"}:
        raise ValueError("unsupported protocol")
    src = str(ipaddress.ip_address(clean_str(raw.get("src", ""), 64)))
    dst = str(ipaddress.ip_address(clean_str(raw.get("dst", ""), 64)))
    ts = number(raw.get("ts", int(time.time())), 4102444800)
    if ts < 946684800:
        raise ValueError("invalid timestamp")
    return (ts, sensor, event_type, proto, src, dst,
            number(raw.get("sport", 0), 65535), number(raw.get("dport", 0), 65535),
            number(raw.get("packets", 0), 10**13),
            number(raw.get("bytes", 0), 10**16))

def write_events(events, sensor):
    rows = [validate_event(event, sensor) for event in events]
    with WRITE_LOCK:
        with connection() as c:
            cur = c.executemany("""INSERT INTO flows
                (ts,sensor,type,proto,src,dst,sport,dport,packets,bytes)
                VALUES (?,?,?,?,?,?,?,?,?,?)""", rows)
        with SIEM_PATH.open("a", encoding="utf-8") as file:
            for row in rows:
                obj = dict(zip(FIELDS[1:], row))
                obj["integration"] = "shirobird"
                file.write(json.dumps(obj, separators=(",", ":")) + "\n")
            file.flush()
        if SYSLOG_TARGET:
            for row in rows:
                try:
                    payload = json.dumps(dict(zip(FIELDS[1:], row)), separators=(",", ":"))
                    msg = f"<134>1 {time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime(row[0]))} shirobird shirobird - flow - {payload}"
                    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
                        s.settimeout(1)
                        s.sendto(msg.encode(), (SYSLOG_TARGET, SYSLOG_PORT))
                except OSError as ex:
                    print(f"syslog export failed: {ex}", flush=True)
    return len(rows)

def siem_status():
    """Report local SIEM export configuration, not remote ingestion success."""
    try:
        info = SIEM_PATH.stat()
    except FileNotFoundError:
        info = None
    writable = SIEM_PATH.parent.is_dir() and os.access(SIEM_PATH.parent, os.W_OK)
    return {
        "jsonl": {
            "ready": bool(writable),
            "exists": info is not None,
            "size_bytes": info.st_size if info else 0,
            "last_write": int(info.st_mtime) if info else None,
            "container_path": "/data/siem/events.jsonl"
        },
        "syslog": {
            "configured": bool(SYSLOG_TARGET),
            "protocol": "UDP",
            "port": SYSLOG_PORT if SYSLOG_TARGET else None
        },
        "remote_ingestion_verified": False,
        "retention_days": RETENTION_DAYS,
        "total_flow_events": stats()["total"]
    }

def query_flows(limit=100, since=0):
    with connection() as c:
        rows = c.execute("""SELECT * FROM flows WHERE id > ?
            ORDER BY id DESC LIMIT ?""", (since, min(MAX_QUERY, max(1, limit)))).fetchall()
    return [dict(row) for row in rows]

def stats():
    with connection() as c:
        total = c.execute("SELECT count(*) FROM flows").fetchone()[0]
        day = c.execute("SELECT count(*) FROM flows WHERE ts>=?", (int(time.time()) - 86400,)).fetchone()[0]
        sensors = c.execute("SELECT count(DISTINCT sensor) FROM flows").fetchone()[0]
        latest = c.execute("SELECT MAX(ts) FROM flows").fetchone()[0]
    return {"total": total, "last_24h": day, "sensors": sensors, "latest": latest}

def session_value(expires):
    digest = hmac.new(ADMIN_KEY.encode(), f"session:{expires}".encode(), hashlib.sha256).hexdigest()
    return f"{expires}.{digest}"

def session_valid(value):
    try:
        expiry = int(value.split(".", 1)[0])
        return int(time.time()) < expiry and hmac.compare_digest(value, session_value(expiry))
    except (ValueError, AttributeError):
        return False

class Handler(BaseHTTPRequestHandler):
    server_version = "ShiroBird/0.1"
    def log_message(self, format, *args):
        print("%s - %s" % (self.address_string(), format % args), flush=True)

    def common_headers(self, mime="application/json; charset=utf-8"):
        self.send_header("Content-Type", mime)
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("X-Frame-Options", "SAMEORIGIN" if EMBEDDED else "DENY")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("Content-Security-Policy",
                         "default-src 'self'; script-src 'self'; style-src 'self'; "
                         "connect-src 'self'; img-src 'self' data:; object-src 'none'; " +
                         ("frame-ancestors 'self'; " if EMBEDDED else "frame-ancestors 'none'; ") +
                         "base-uri 'none'; form-action 'self'")

    def reply(self, status, data, mime="application/json; charset=utf-8"):
        body = data if isinstance(data, bytes) else json.dumps(data).encode()
        self.send_response(status)
        self.common_headers(mime)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def authorized(self):
        try:
            jar = cookies.SimpleCookie()
            jar.load(self.headers.get("Cookie", ""))
            item = jar.get("shirobird_session")
            return (item is not None and (netbird_auth.session_valid(item.value, ADMIN_KEY)
                    if AUTH_MODE == "netbird" else session_valid(item.value)))
        except cookies.CookieError:
            return False

    def ingest_authorized(self):
        token = self.headers.get("Authorization", "")
        return hmac.compare_digest(token, "Bearer " + INGEST_KEY)

    def body_json(self):
        size_text = self.headers.get("Content-Length", "")
        try:
            size = int(size_text)
        except ValueError:
            raise ValueError("Content-Length required")
        if not 0 < size <= MAX_BODY:
            raise ValueError("request too large or empty")
        try:
            return json.loads(self.rfile.read(size))
        except (ValueError, UnicodeDecodeError):
            raise ValueError("invalid JSON")

    def route(self):
        return urlsplit(self.path).path

    def do_POST(self):
        route = self.route()
        if route == "/api/netbird-session":
            if AUTH_MODE != "netbird" or not EMBEDDED:
                return self.reply(404, {"error": "not enabled"})
            header = self.headers.get("Authorization", "")
            if not header.startswith("Bearer "):
                return self.reply(401, {"error": "NetBird sign-in required"})
            identity = netbird_auth.current_admin(header[7:], NETBIRD_IDENTITY_URL)
            if identity is None:
                return self.reply(403, {"error": "NetBird Owner/Admin access required"})
            signed = netbird_auth.sign_session(identity["id"], ADMIN_KEY)
            self.send_response(200)
            self.common_headers()
            cookie = (f"shirobird_session={signed}; HttpOnly; SameSite=Strict; "
                      f"Path={COOKIE_PATH}; Max-Age={netbird_auth.SESSION_SECONDS}")
            if COOKIE_SECURE:
                cookie += "; Secure"
            self.send_header("Set-Cookie", cookie)
            self.send_header("Content-Length", "11")
            self.end_headers()
            self.wfile.write(b'{"ok":true}')
            return
        if route == "/api/login":
            if AUTH_MODE == "netbird":
                return self.reply(404, {"error": "Use NetBird login"})
            ip = self.client_address[0]
            with LOGIN_LOCK:
                attempts, started = FAILED_LOGINS.get(ip, (0, time.time()))
                if time.time() - started > 300:
                    attempts, started = 0, time.time()
                if attempts >= 8:
                    return self.reply(429, {"error": "too many attempts"})
            try:
                payload = self.body_json()
                correct = isinstance(payload, dict) and isinstance(payload.get("token"), str) and hmac.compare_digest(payload["token"], ADMIN_KEY)
            except ValueError:
                correct = False
            if not correct:
                with LOGIN_LOCK:
                    FAILED_LOGINS[ip] = (attempts + 1, started)
                return self.reply(401, {"error": "invalid credentials"})
            with LOGIN_LOCK:
                FAILED_LOGINS.pop(ip, None)
            expire = int(time.time()) + 43200
            self.send_response(200)
            self.common_headers()
            cookie = f"shirobird_session={session_value(expire)}; HttpOnly; SameSite=Strict; Path={COOKIE_PATH}; Max-Age=43200"
            if COOKIE_SECURE:
                cookie += "; Secure"
            self.send_header("Set-Cookie", cookie)
            self.end_headers()
            self.wfile.write(b'{"ok":true}')
            return
        if route == "/api/logout":
            if not self.authorized():
                return self.reply(401, {"error": "unauthorized"})
            self.send_response(200)
            self.common_headers()
            self.send_header("Set-Cookie", f"shirobird_session=; HttpOnly; SameSite=Strict; Path={COOKIE_PATH}; Max-Age=0")
            self.end_headers()
            self.wfile.write(b'{"ok":true}')
            return
        if route == "/api/ingest":
            if not self.ingest_authorized():
                return self.reply(401, {"error": "unauthorized"})
            try:
                payload = self.body_json()
                if not isinstance(payload, dict):
                    raise ValueError("object expected")
                sensor = clean_str(payload.get("sensor", ""), 80)
                events = payload.get("events")
                if not isinstance(events, list) or not 1 <= len(events) <= 250:
                    raise ValueError("events must have 1..250 items")
                count = write_events(events, sensor)
                return self.reply(202, {"accepted": count})
            except (ValueError, TypeError) as e:
                return self.reply(400, {"error": str(e)})
        self.reply(404, {"error": "not found"})

    def do_GET(self):
        route = self.route()
        if route == "/healthz":
            return self.reply(200, {"status": "ok", "version": "0.1.0"})
        if route in ("/", "/app.js", "/style.css"):
            names = {"/": ("index.html", "text/html; charset=utf-8"),
                     "/app.js": ("app.js", "application/javascript; charset=utf-8"),
                     "/style.css": ("style.css", "text/css; charset=utf-8")}
            filename, mime = names[route]
            return self.reply(200, (ROOT / "web" / filename).read_bytes(), mime)
        if not self.authorized():
            return self.reply(401, {"error": "unauthorized"})
        qs = parse_qs(urlsplit(self.path).query)
        try:
            limit = number(qs.get("limit", ["100"])[0], MAX_QUERY)
            since = number(qs.get("since", ["0"])[0], 10**15)
        except ValueError:
            return self.reply(400, {"error": "bad query"})
        if route == "/api/stats":
            return self.reply(200, stats())
        if route == "/api/siem/status":
            return self.reply(200, siem_status())
        if route == "/api/flows":
            return self.reply(200, {"flows": query_flows(limit, since)})
        if route in ("/api/export.csv", "/api/export.ndjson"):
            rows = query_flows(limit if "limit" in qs else MAX_QUERY)
            if route.endswith(".csv"):
                buf = io.StringIO()
                writer = csv.DictWriter(buf, fieldnames=FIELDS)
                writer.writeheader()
                writer.writerows(rows)
                return self.reply(200, buf.getvalue().encode("utf-8"), "text/csv; charset=utf-8")
            lines = "".join(json.dumps(row, separators=(",", ":")) + "\n" for row in rows)
            return self.reply(200, lines.encode(), "application/x-ndjson; charset=utf-8")
        if route == "/api/stream":
            if not STREAM_SLOTS.acquire(blocking=False):
                return self.reply(503, {"error": "stream capacity reached"})
            try:
                self.send_response(200)
                self.common_headers("text/event-stream; charset=utf-8")
                self.send_header("Connection", "close")
                self.end_headers()
                cursor = since
                until = time.monotonic() + 1800
                while time.monotonic() < until:
                    rows = list(reversed(query_flows(100, cursor)))
                    for row in rows:
                        cursor = row["id"]
                        self.wfile.write(("id: %s\ndata: %s\n\n" % (
                            cursor, json.dumps(row, separators=(",", ":")))).encode())
                    if not rows:
                        self.wfile.write(b": heartbeat\n\n")
                    self.wfile.flush()
                    time.sleep(2)
            except (BrokenPipeError, ConnectionResetError, OSError):
                pass
            finally:
                STREAM_SLOTS.release()
            return
        self.reply(404, {"error": "not found"})

def maintenance():
    while True:
        try:
            with connection() as c:
                c.execute("DELETE FROM flows WHERE ts < ?", (int(time.time()) - RETENTION_DAYS * 86400,))
        except (OSError, sqlite3.Error) as exc:
            print(f"maintenance error: {exc}", flush=True)
        time.sleep(3600)

def main():
    if AUTH_MODE not in {"token", "netbird"}:
        raise SystemExit("SHIROBIRD_AUTH_MODE must be netbird or token")
    if len(ADMIN_KEY) < 32 or len(INGEST_KEY) < 32 or secrets.compare_digest(ADMIN_KEY, INGEST_KEY):
        raise SystemExit("Set distinct strong SHIROBIRD_ADMIN_TOKEN and SHIROBIRD_INGEST_TOKEN (32+ chars).")
    init_db()
    threading.Thread(target=maintenance, daemon=True).start()
    server = ThreadingHTTPServer((BIND, PORT), Handler)
    server.daemon_threads = True
    print(f"ShiroBird listening on {BIND}:{PORT}", flush=True)
    server.serve_forever()

if __name__ == "__main__":
    main()