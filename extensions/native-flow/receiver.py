"""Independent receiver for the public NetBird v0.81.3 FlowService protocol.

No Enterprise binaries, license emulation or changes to the official server.
Tokens belong to the ShiroBird management adapter contract, not NetBird Enterprise.
"""
import base64
from concurrent.futures import ThreadPoolExecutor
from contextlib import closing
import hashlib
import hmac
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import ipaddress
import json
import os
from pathlib import Path
import re
import sqlite3
import threading
import time
from urllib.parse import parse_qs, urlsplit

import grpc
import flow_pb2 as pb
import flow_pb2_grpc as rpc

AUDIENCE = "shirobird-native-flow"
PEER = re.compile(r"[A-Za-z0-9_-]{1,80}\Z")
MAX_TOKEN_TTL = 86400
MAX_MESSAGE = 65536


def issue_token(secret, peer_id, expires):
    """Adapter/test utility; never exposed over HTTP."""
    if len(secret) < 32 or not PEER.fullmatch(peer_id):
        raise ValueError("invalid token configuration")
    body = json.dumps({"v": 1, "aud": AUDIENCE, "peer_id": peer_id, "exp": expires},
                      separators=(",", ":"), sort_keys=True).encode()
    payload = base64.urlsafe_b64encode(body).decode().rstrip("=")
    signature = base64.b64encode(hmac.digest(secret, payload.encode(), "sha256")).decode()
    return signature + "." + payload


def authenticate(header, secret, now=None):
    now = int(time.time()) if now is None else now
    try:
        if len(secret) < 32 or not header.startswith("Bearer ") or len(header) > 2048:
            raise ValueError()
        signature, payload = header[7:].split(".", 1)
        decoded = base64.b64decode(signature, validate=True)
        if not hmac.compare_digest(decoded, hmac.digest(secret, payload.encode(), "sha256")):
            raise ValueError()
        body = json.loads(base64.b64decode(payload + "=" * (-len(payload) % 4),
                                          altchars=b"-_", validate=True))
        peer_id, exp = body["peer_id"], body["exp"]
        if (body["v"] != 1 or body["aud"] != AUDIENCE or
                not isinstance(peer_id, str) or not PEER.fullmatch(peer_id) or
                type(exp) is not int or not now < exp <= now + MAX_TOKEN_TTL):
            raise ValueError()
        return peer_id, exp
    except (ValueError, TypeError, KeyError, UnicodeError):
        raise ValueError("invalid or expired flow credential") from None


def event_record(event, peer_id):
    if event.isInitiator or len(event.event_id) != 16 or len(event.public_key) != 32:
        raise ValueError("invalid event identity")
    if not event.HasField("flow_fields") or not event.HasField("timestamp"):
        raise ValueError("missing flow or timestamp")
    fields = event.flow_fields
    if fields.type not in (0, 1, 2, 3) or fields.direction not in (0, 1, 2):
        raise ValueError("invalid flow type/direction")
    if fields.protocol > 255 or len(fields.flow_id) != 16 or len(fields.rule_id) > 128:
        raise ValueError("invalid flow fields")
    if len(fields.source_resource_id) > 256 or len(fields.dest_resource_id) > 256:
        raise ValueError("invalid resource identifier")
    # Validate canonical protobuf timestamps, including nanos and window ordering.
    event.timestamp.ToDatetime()
    ts = event.timestamp.seconds
    if not 0 <= ts <= int(time.time()) + 300:
        raise ValueError("invalid event timestamp")
    start = end = None
    if event.HasField("window_start") != event.HasField("window_end"):
        raise ValueError("incomplete aggregation window")
    if event.HasField("window_start"):
        event.window_start.ToDatetime()
        event.window_end.ToDatetime()
        start, end = event.window_start.seconds, event.window_end.seconds
        if not 0 <= start <= end <= int(time.time()) + 300:
            raise ValueError("invalid aggregation window")
    port = fields.port_info
    if port.source_port > 65535 or port.dest_port > 65535:
        raise ValueError("invalid port")
    if fields.icmp_info.icmp_type > 255 or fields.icmp_info.icmp_code > 255:
        raise ValueError("invalid ICMP fields")
    if fields.protocol in (6, 17) and fields.WhichOneof("connection_info") != "port_info":
        raise ValueError("missing TCP/UDP ports")
    counters = {key: getattr(fields, key) for key in (
        "rx_packets", "tx_packets", "rx_bytes", "tx_bytes",
        "num_of_starts", "num_of_ends", "num_of_drops")}
    if any(value > 2**63 - 1 for value in counters.values()):
        raise ValueError("counter out of range")
    # Pre-aggregation clients use Type rather than the three count fields.
    if not any(counters[k] for k in ("num_of_starts", "num_of_ends", "num_of_drops")):
        key = {1: "num_of_starts", 2: "num_of_ends", 3: "num_of_drops"}.get(fields.type)
        if key:
            counters[key] = 1
    return {
        "source": "netbird_native", "reporter_id": peer_id,
        "event_id": event.event_id.hex(), "flow_id": fields.flow_id.hex(),
        "reported_public_key": base64.b64encode(event.public_key).decode(),
        "ts": ts, "window_start": start, "window_end": end,
        "src": str(ipaddress.ip_address(fields.source_ip)),
        "dst": str(ipaddress.ip_address(fields.dest_ip)),
        "sport": port.source_port, "dport": port.dest_port,
        "protocol": fields.protocol, "direction": fields.direction, "type": fields.type,
        "rule_id": fields.rule_id.hex(),
        "source_resource_id": fields.source_resource_id.hex(),
        "destination_resource_id": fields.dest_resource_id.hex(),
        "icmp_type": fields.icmp_info.icmp_type, "icmp_code": fields.icmp_info.icmp_code,
        **counters,
    }


class Store:
    def __init__(self, directory):
        self.directory = Path(directory)
        self.directory.mkdir(parents=True, exist_ok=True)
        self.path = self.directory / "native.sqlite3"
        with closing(self.connect()) as db, db:
            db.execute("PRAGMA journal_mode=WAL")
            db.execute("""CREATE TABLE IF NOT EXISTS events (
                id INTEGER PRIMARY KEY, reporter TEXT NOT NULL, event_id TEXT NOT NULL,
                received INTEGER NOT NULL, payload TEXT NOT NULL, exported INTEGER NOT NULL DEFAULT 0,
                UNIQUE(reporter,event_id))""")
            db.execute("CREATE INDEX IF NOT EXISTS events_received ON events(received)")
        self.export_lock = threading.Lock()

    def connect(self):
        db = sqlite3.connect(self.path, timeout=20)
        db.row_factory = sqlite3.Row
        db.execute("PRAGMA synchronous=FULL")
        return db

    def save(self, record):
        payload = json.dumps(record, sort_keys=True, separators=(",", ":"))
        with closing(self.connect()) as db, db:
            db.execute("INSERT OR IGNORE INTO events(reporter,event_id,received,payload) VALUES(?,?,?,?)",
                       (record["reporter_id"], record["event_id"], int(time.time()), payload))
            row = db.execute("SELECT payload FROM events WHERE reporter=? AND event_id=?",
                             (record["reporter_id"], record["event_id"])).fetchone()
            if row["payload"] != payload:
                raise ValueError("event ID reused with different data")
        # Context manager committed with synchronous FULL before returning to ACK.

    def list_events(self, after=0, limit=200):
        with closing(self.connect()) as db:
            rows = db.execute("SELECT id,received,payload FROM events WHERE id>? ORDER BY id LIMIT ?",
                              (after, min(max(limit, 1), 1000))).fetchall()
        return [{"id": r["id"], "received": r["received"], **json.loads(r["payload"])} for r in rows]

    def search_events(self, before=0, limit=100, start=0, end=0, query="",
                      protocol=0, state="", reporters=(), ips=()):
        """Filtered, newest-first cursor pagination over the full durable store.

        Filtering is done in SQLite, not just over the browser's first page.
        Event time uses the aggregation window end when available.
        """
        if limit not in (25, 50, 100, 200) or before < 0 or start < 0 or end < 0:
            raise ValueError("invalid pagination or time")
        if end and start > end:
            raise ValueError("invalid time range")
        if protocol not in (0, 1, 6, 17, 58, 132):
            raise ValueError("invalid protocol")
        if state not in ("", "started", "ended", "blocked", "p2p", "routed"):
            raise ValueError("invalid event filter")
        if len(query) > 120 or any(ord(c) < 32 for c in query):
            raise ValueError("invalid search")
        if len(reporters) > 60 or len(ips) > 90:
            raise ValueError("too many peer filters")
        if any(len(x)>128 for x in reporters) or any(len(x)>65 for x in ips):
            raise ValueError("invalid peer filter")
        conditions = []
        args = []
        timestamp = "COALESCE(CAST(json_extract(payload,'$.window_end') AS INTEGER),CAST(json_extract(payload,'$.ts') AS INTEGER))"
        if start:
            conditions.append(timestamp + " >= ?")
            args.append(start)
        if end:
            conditions.append(timestamp + " <= ?")
            args.append(end)
        if protocol:
            conditions.append("CAST(json_extract(payload,'$.protocol') AS INTEGER)=?")
            args.append(protocol)
        if state == "p2p":
            conditions.append("COALESCE(json_extract(payload,'$.source_resource_id'),'')='' AND COALESCE(json_extract(payload,'$.destination_resource_id'),'')=''")
        elif state == "routed":
            conditions.append("(COALESCE(json_extract(payload,'$.source_resource_id'),'')!='' OR COALESCE(json_extract(payload,'$.destination_resource_id'),'')!='')")
        elif state:
            field = {"started":"num_of_starts","ended":"num_of_ends","blocked":"num_of_drops"}[state]
            conditions.append("CAST(COALESCE(json_extract(payload,'$." + field + "'),0) AS INTEGER)>0")
        if reporters or ips:
            selections = []
            if reporters:
                selections.append("reporter IN (" + ",".join("?" for _ in reporters) + ")")
                args.extend(reporters)
            if ips:
                target = ",".join("?" for _ in ips)
                selections.append("(json_extract(payload,'$.src') IN (" + target + ") OR json_extract(payload,'$.dst') IN (" + target + "))")
                args.extend(ips)
                args.extend(ips)
            conditions.append("(" + " OR ".join(selections) + ")")
        if query:
            q = "%" + query.lower().replace("!", "!!").replace("%", "!%").replace("_", "!_") + "%"
            fields = ["reporter", "json_extract(payload,'$.src')",
                      "json_extract(payload,'$.dst')",
                      "CAST(json_extract(payload,'$.sport') AS TEXT)",
                      "CAST(json_extract(payload,'$.dport') AS TEXT)",
                      "json_extract(payload,'$.event_id')",
                      "json_extract(payload,'$.rule_id')"]
            conditions.append("("+" OR ".join("LOWER("+field+") LIKE ? ESCAPE '!'" for field in fields)+")")
            args.extend([q]*len(fields))
        where = " WHERE " + " AND ".join(conditions) if conditions else ""
        with closing(self.connect()) as db:
            total = db.execute("SELECT COUNT(*) FROM events" + where, args).fetchone()[0]
            cursor = (" WHERE id < ?" if not conditions else " AND id < ?") if before else ""
            rows = db.execute("SELECT id,received,payload FROM events" + where + cursor +
                              " ORDER BY id DESC LIMIT ?",
                              args + ([before] if before else []) + [limit+1]).fetchall()
        more = len(rows)>limit
        page = rows[:limit]
        return {"flows":[{"id":r["id"],"received":r["received"],**json.loads(r["payload"])} for r in page],
                "next_cursor":page[-1]["id"] if more and page else None,
                "has_more":more,"total":total}

    def status(self):
        with closing(self.connect()) as db:
            row = db.execute("SELECT COUNT(*) total, MAX(received) last_received, "
                             "COUNT(DISTINCT reporter) reporters FROM events").fetchone()
        return dict(row)

    def export_pending(self):
        """At-least-once JSONL export; crash after fsync can duplicate, never ACK before DB commit."""
        with self.export_lock, closing(self.connect()) as db:
            rows = db.execute("SELECT id,received,payload FROM events WHERE exported=0 ORDER BY id LIMIT 500").fetchall()
            if not rows:
                return 0
            # Daily files avoid an indefinitely growing single log.
            path = self.directory / ("native-" + time.strftime("%Y-%m-%d", time.gmtime()) + ".jsonl")
            with path.open("a", encoding="utf-8") as out:
                for row in rows:
                    record = {"received": row["received"], **json.loads(row["payload"])}
                    out.write(json.dumps(record, separators=(",", ":")) + "\n")
                out.flush()
                os.fsync(out.fileno())
            with db:
                db.executemany("UPDATE events SET exported=1 WHERE id=?", [(r["id"],) for r in rows])
            return len(rows)


class FlowService(rpc.FlowServiceServicer):
    def __init__(self, secret, store):
        self.secret, self.store = secret, store

    def Events(self, requests, context):
        headers = [m.value for m in context.invocation_metadata() if m.key == "authorization"]
        try:
            if len(headers) != 1:
                raise ValueError()
            peer_id, expires = authenticate(headers[0], self.secret)
        except ValueError:
            context.abort(grpc.StatusCode.UNAUTHENTICATED, "invalid or expired flow credential")
        context.send_initial_metadata((("shirobird-flow-version", "1"),))
        first = True
        for event in requests:
            if time.time() >= expires:
                context.abort(grpc.StatusCode.UNAUTHENTICATED, "flow credential expired")
            if first:
                first = False
                if not event.isInitiator or event.event_id or event.HasField("flow_fields"):
                    context.abort(grpc.StatusCode.INVALID_ARGUMENT, "initiator required")
                yield pb.FlowEventAck(isInitiator=True)
                continue
            try:
                record = event_record(event, peer_id)
                self.store.save(record)
            except (ValueError, OverflowError):
                context.abort(grpc.StatusCode.INVALID_ARGUMENT, "invalid flow event")
            except sqlite3.Error:
                context.abort(grpc.StatusCode.UNAVAILABLE, "flow storage unavailable")
            yield pb.FlowEventAck(event_id=event.event_id)


def make_grpc_server(secret, store, address="127.0.0.1:0"):
    server = grpc.server(ThreadPoolExecutor(max_workers=16), maximum_concurrent_rpcs=16,
                         options=[("grpc.max_receive_message_length", MAX_MESSAGE),
                                  ("grpc.max_connection_age_ms", 900000)])
    rpc.add_FlowServiceServicer_to_server(FlowService(secret, store), server)
    port = server.add_insecure_port(address)
    if not port:
        raise RuntimeError("cannot bind receiver")
    return server, port


def make_http_server(store, token, address=("127.0.0.1", 0)):
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_args):
            pass

        def do_GET(self):
            route = urlsplit(self.path)
            if route.path == "/healthz":
                payload, code = {"ok": True}, 200
            elif not hmac.compare_digest(self.headers.get("Authorization", ""), "Bearer " + token):
                payload, code = {"error": "unauthorized"}, 401
            elif route.path == "/api/native/status":
                payload, code = {**store.status(), "source": "netbird_native",
                                 "client_reporting_configured": None,
                                 "note": "Receiver does not enable reporting on Community Management."}, 200
            elif route.path == "/api/native/query":
                try:
                    params=parse_qs(route.query,keep_blank_values=True)
                    def number_param(name,default=0):
                        value=params.get(name,[str(default)])[0]
                        if len(value)>15: raise ValueError("number too long")
                        return int(value)
                    result=store.search_events(
                        before=number_param("before"),
                        limit=number_param("limit",100),
                        start=number_param("start"),
                        end=number_param("end"),
                        query=params.get("q",[""])[0],
                        protocol=number_param("protocol"),
                        state=params.get("state",[""])[0],
                        reporters=tuple(x for x in params.get("reporters",[""])[0].split(",") if x),
                        ips=tuple(x for x in params.get("ips",[""])[0].split(",") if x))
                    payload,code=result,200
                except (ValueError, OverflowError):
                    payload,code={"error":"invalid traffic filters"},400
            elif route.path in ("/api/native/flows", "/api/native/export.ndjson"):
                try:
                    query = parse_qs(route.query)
                    after = max(0, int(query.get("after", ["0"])[0]))
                    limit = int(query.get("limit", ["200"])[0])
                    rows = store.list_events(after, limit)
                    payload, code = {"flows": rows, "next_cursor": rows[-1]["id"] if rows else after}, 200
                    if route.path.endswith(".ndjson"):
                        body = "".join(json.dumps(r) + "\n" for r in rows).encode()
                        self.respond(200, body, "application/x-ndjson")
                        return
                except ValueError:
                    payload, code = {"error": "invalid pagination"}, 400
            else:
                payload, code = {"error": "not found"}, 404
            self.respond(code, json.dumps(payload).encode(), "application/json")

        def respond(self, code, body, mime):
            self.send_response(code)
            self.send_header("Content-Type", mime)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.end_headers()
            self.wfile.write(body)

    return ThreadingHTTPServer(address, Handler)


def read_secret(name):
    path = os.getenv(name + "_FILE")
    value = Path(path).read_text().strip() if path else os.getenv(name, "")
    if len(value) < 32:
        raise SystemExit(name + " requires 32+ characters")
    return value


def main():
    secret = read_secret("SHIROBIRD_FLOW_SECRET").encode()
    api_token = read_secret("SHIROBIRD_NATIVE_API_TOKEN")
    store = Store(os.getenv("SHIROBIRD_NATIVE_DATA", "/data"))
    server, _ = make_grpc_server(secret, store, "0.0.0.0:8084")
    http = make_http_server(store, api_token, ("0.0.0.0", 8085))
    threading.Thread(target=http.serve_forever, daemon=True).start()
    server.start()
    print("ShiroBird native flow receiver ready; client activation requires management integration", flush=True)
    try:
        while True:
            try:
                store.export_pending()
            except (OSError, sqlite3.Error):
                print("Native SIEM export deferred; durable database retained", flush=True)
            time.sleep(1)
    finally:
        http.shutdown()
        server.stop(5).wait()


if __name__ == "__main__":
    main()
