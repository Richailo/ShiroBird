"""Passive Linux conntrack watcher. No changes to NetBird or firewall rules."""
import ipaddress
import json
import os
import queue
import re
import socket
import subprocess
import sys
import threading
import time
import uuid
from urllib.request import Request, urlopen

SERVER = os.getenv("SHIROBIRD_SERVER_URL", "http://127.0.0.1:8666").rstrip("/")
URL = SERVER + "/api/ingest"
HEARTBEAT_URL = SERVER + "/api/sensors/heartbeat"
TOKEN = os.getenv("SHIROBIRD_INGEST_TOKEN", "")
SENSOR = os.getenv("SHIROBIRD_SENSOR", socket.gethostname())
def discover_networks():
    """Use the local overlay interface, never arbitrary LAN ranges by default."""
    configured = os.getenv("SHIROBIRD_NETWORKS", "auto").strip()
    if configured != "auto":
        return [ipaddress.ip_network(x.strip(), strict=False)
                for x in configured.split(",") if x.strip()]
    interface = os.getenv("SHIROBIRD_INTERFACE", "wt0")
    try:
        result = subprocess.run(["ip", "-j", "address", "show", "dev", interface],
                                capture_output=True, text=True, timeout=5, check=True)
        return [ipaddress.ip_network(f"{a['local']}/{a['prefixlen']}", strict=False)
                for link in json.loads(result.stdout) for a in link.get("addr_info", [])
                if a.get("scope") == "global" and a.get("family") in ("inet", "inet6")]
    except (OSError, ValueError, KeyError, subprocess.SubprocessError):
        return []

NETWORKS = discover_networks()
CAPTURE_READY = threading.Event()
OUTPUT_LIMIT = 10000
KEYVAL = re.compile(r"\b(src|dst|sport|dport|packets|bytes)=([^\s]+)")
TYPE = re.compile(r"\[(NEW|DESTROY|UPDATE)\]")
PROTOCOL = re.compile(r"(?:\]\s*|^\s*)(?:ipv[46]\s+\d+\s+)?(tcp|udp|icmp|icmpv6|sctp)\b", re.I)

def parse_line(line, sensor=SENSOR, networks=None):
    event = TYPE.search(line)
    protocol = PROTOCOL.search(line)
    if not event or not protocol:
        return None
    proto = protocol.group(1).lower()
    pairs = KEYVAL.findall(line)
    groups = {}
    for key, val in pairs:
        groups.setdefault(key, []).append(val)
    try:
        src, dst = groups["src"][0], groups["dst"][0]
        relevant = NETWORKS if networks is None else networks
        if not any(ipaddress.ip_address(x) in net for x in (src, dst) for net in relevant):
            return None
        def value(key):
            return int(groups.get(key, ["0"])[0])
        obj = {"ts": int(time.time()), "type": event.group(1), "proto": proto,
               "src": src, "dst": dst, "sport": value("sport"), "dport": value("dport"),
               "event_ref": uuid.uuid4().hex,
               "packets": sum(int(x) for x in groups.get("packets", [])),
               "bytes": sum(int(x) for x in groups.get("bytes", []))}
        if event.group(1) == "DESTROY" and not groups.get("bytes"):
            obj["bytes"] = 0
        return obj
    except (KeyError, ValueError):
        return None

def accounting_enabled():
    try:
        with open("/proc/sys/net/netfilter/nf_conntrack_acct",
                  "r", encoding="ascii") as source:
            return source.read().strip() == "1"
    except OSError:
        return False

def heartbeat():
    """Regular out-of-band proof the collector is online, even without flows."""
    while True:
        body = json.dumps({
            "sensor": SENSOR,
            "source": "linux_conntrack",
            "accounting_enabled": accounting_enabled(),
            "coverage": {"networks": [str(n) for n in NETWORKS],
                         "capture_ready": CAPTURE_READY.is_set(),
                         "scope": "local_and_routed"}
        }).encode()
        req = Request(HEARTBEAT_URL, data=body, method="POST",
                      headers={"Authorization": "Bearer " + TOKEN,
                               "Content-Type": "application/json"})
        try:
            with urlopen(req, timeout=10) as response:
                if response.status != 202:
                    raise RuntimeError(f"heartbeat status {response.status}")
        except Exception as error:
            print(f"ShiroBird heartbeat failed: {error}", file=sys.stderr, flush=True)
        time.sleep(30)

def uploader(q):
    pending = []
    while True:
        if not pending:
            pending.append(q.get())
        deadline = time.monotonic() + 0.5
        while len(pending) < 100 and time.monotonic() < deadline:
            try:
                pending.append(q.get(timeout=max(0.01, deadline - time.monotonic())))
            except queue.Empty:
                break
        body = json.dumps({"sensor": SENSOR, "events": pending}).encode()
        req = Request(URL, data=body, headers={"Authorization": "Bearer " + TOKEN,
                       "Content-Type": "application/json"}, method="POST")
        try:
            with urlopen(req, timeout=10) as response:
                if response.status != 202:
                    raise RuntimeError(f"unexpected status: {response.status}")
            pending.clear()
        except Exception as exc:
            print(f"ShiroBird upload failed, retrying: {exc}", file=sys.stderr, flush=True)
            time.sleep(5)

def main():
    global NETWORKS
    if not TOKEN or len(TOKEN) < 32:
        raise SystemExit("SHIROBIRD_INGEST_TOKEN must be 32+ characters")
    q = queue.Queue(maxsize=OUTPUT_LIMIT)
    threading.Thread(target=uploader, args=(q,), daemon=True).start()
    threading.Thread(target=heartbeat, daemon=True).start()
    while True:
        NETWORKS = discover_networks()
        if not NETWORKS:
            CAPTURE_READY.clear()
            print("No overlay networks discovered; waiting for interface", file=sys.stderr, flush=True)
            time.sleep(5)
            continue
        try:
            with subprocess.Popen(["conntrack", "-E", "-e", "NEW,DESTROY",
                                   "-o", "timestamp,extended"],
                                  stdout=subprocess.PIPE, stderr=None,
                                  text=True, bufsize=1) as proc:
                CAPTURE_READY.set()
                for line in proc.stdout:
                    evt = parse_line(line)
                    if evt is None:
                        continue
                    try:
                        q.put_nowait(evt)
                    except queue.Full:
                        print("ShiroBird queue full: dropped flow", file=sys.stderr, flush=True)
                CAPTURE_READY.clear()
                print(f"conntrack exited: {proc.wait()}", file=sys.stderr, flush=True)
        except (OSError, ValueError) as exc:
            CAPTURE_READY.clear()
            print(f"conntrack unavailable: {exc}", file=sys.stderr, flush=True)
        time.sleep(5)

if __name__ == "__main__":
    main()