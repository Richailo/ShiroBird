"""Activate a validated release with a stopped-database rollback snapshot.

Keeps the original Compose file. A persistent override protects the adapter from
ordinary `docker compose pull/up` and unattended image replacement.
"""
import argparse
from contextlib import closing
from datetime import datetime, timezone
import json
from pathlib import Path
import shutil
import sqlite3
import subprocess
import time

from release import run


def inspect(name):
    return json.loads(run("docker", "inspect", name, capture=True))[0]


def atomic_json(path, data):
    temporary = path.with_suffix(path.suffix + ".new")
    temporary.write_text(json.dumps(data, indent=2))
    temporary.chmod(0o600)
    temporary.replace(path)


def health_code(url):
    from urllib.error import HTTPError
    from urllib.request import urlopen
    try:
        with urlopen(url, timeout=3) as response:
            return response.status
    except HTTPError as error:
        return error.code
    except OSError:
        return None


def wait_health(url, timeout=60):
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        if health_code(url) == 401:
            return
        time.sleep(2)
    raise RuntimeError("management authenticated API did not become healthy")


def copy_live_data(source, target):
    """Only for the disconnected trial; final rollback snapshot uses a pause."""
    target.mkdir()
    for path in source.iterdir():
        if path.name.endswith(("-wal", "-shm", "-journal")):
            continue
        if path.is_file() and path.suffix == ".db":
            with closing(sqlite3.connect("file:" + str(path) + "?mode=ro", uri=True)) as src:
                with closing(sqlite3.connect(target / path.name)) as dst:
                    src.backup(dst)
        elif path.is_file():
            shutil.copy2(path, target / path.name)
        elif path.is_dir():
            shutil.copytree(path, target / path.name)


def public_receiver_check(receiver_image, url):
    code = '''import sys,grpc
from urllib.parse import urlsplit
import flow_pb2 as pb,flow_pb2_grpc as rpc
u=urlsplit(sys.argv[1])
assert u.scheme=="https" and u.hostname and not u.username and u.path in ("","/")
with grpc.secure_channel(u.netloc,grpc.ssl_channel_credentials()) as channel:
 try:
  list(rpc.FlowServiceStub(channel).Events(iter([pb.FlowEvent(isInitiator=True)]),timeout=10))
 except grpc.RpcError as error:
  assert error.code()==grpc.StatusCode.UNAUTHENTICATED,error.code()
 else: raise RuntimeError("receiver accepted unauthenticated traffic")
print("Public TLS/gRPC receiver and authentication verified")
'''
    run("docker", "run", "--rm", "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
        receiver_image, "python", "-c", code, url)


def rollback(folder):
    folder = Path(folder).resolve(strict=True)
    state = json.loads((folder / "state.json").read_text())
    data = Path(state["data"])
    live = inspect(state["container"])
    actual = [m["Source"] for m in live["Mounts"] if m["Destination"] == "/var/lib/netbird"]
    if actual != [str(data)] or data.name != "_data":
        raise RuntimeError("data volume differs from the recorded rollback target")
    run("docker", "stop", state["container"])
    failed = folder / ("failed-data-" + str(time.time_ns()))
    failed.mkdir()
    for item in data.iterdir():
        shutil.move(str(item), failed / item.name)
    for item in (folder / "data").iterdir():
        if item.is_dir():
            shutil.copytree(item, data / item.name)
        else:
            shutil.copy2(item, data / item.name)
    override = Path(state["override"])
    old = state["old_override"] or {"services": {}}
    old.setdefault("services", {}).setdefault("netbird-server", {})["image"] = state["old_image_id"]
    old["services"]["netbird-server"]["pull_policy"] = "never"
    old["x-shirobird-managed"] = True
    atomic_json(override, old)
    run(*state["compose_command"], "up", "-d", "--no-deps", "--pull", "never", "netbird-server")
    wait_health(state["health_url"])
    atomic_json(folder / "rollback-result.json", {"ok": True, "failed_data_preserved": str(failed)})
    print("Previous image and data restored; failed-attempt data preserved", flush=True)


def activate(release_dir, compose_file, config_file, secret_file, health_url):
    release_dir = Path(release_dir).resolve(strict=True)
    manifest = json.loads((release_dir / "manifest.json").read_text())
    required = {"adapter_race", "management_compilation", "receiver", "official_client_wire", "runtime_help"}
    if not all(manifest.get("tests", {}).get(name) is True for name in required):
        raise ValueError("release has not passed the required checks")
    for key in ["image", "receiver_image"]:
        if inspect(manifest[key])["Id"] != manifest[key + "_id"]:
            raise ValueError("validated image tag changed")
    compose_file = Path(compose_file).resolve(strict=True)
    config_file = Path(config_file).resolve(strict=True)
    secret_file = Path(secret_file).resolve(strict=True)
    cfg = json.loads(config_file.read_text())
    if not cfg.get("enabled") or not (cfg.get("peer_ids") or cfg.get("group_ids")):
        raise ValueError("explicit enabled peer/group selection is required")
    if cfg.get("secret_file") != "/run/secrets/native_flow_secret":
        raise ValueError("adapter secret path differs from the managed mount")
    public_receiver_check(manifest["receiver_image"], cfg["receiver_url"])
    current = inspect("netbird-server")
    if not current["State"]["Running"] or health_code(health_url) != 401:
        raise RuntimeError("existing management service is not healthy")
    mounts = current["Mounts"]
    data = Path(next(m["Source"] for m in mounts if m["Destination"] == "/var/lib/netbird"))
    if data.name != "_data" or not (data / "store.db").is_file():
        raise ValueError("this rollout supports the inspected local SQLite data volume only")
    netbird_cfg = Path(next(m["Source"] for m in mounts if m["Destination"] == "/etc/netbird/config.yaml"))
    override = compose_file.parent / "docker-compose.override.yml"
    old_override = json.loads(override.read_text()) if override.exists() else None
    if old_override and not old_override.get("x-shirobird-managed"):
        raise ValueError("existing override is not managed by ShiroBird; merge it explicitly first")
    project = current["Config"]["Labels"]["com.docker.compose.project"]
    compose = ["docker", "compose", "-p", project, "-f", str(compose_file), "-f", str(override)]
    backup = compose_file.parent / "shirobird-backups" / datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    backup.mkdir(parents=True, mode=0o700)
    backup.parent.chmod(0o700)
    shutil.copy2(compose_file, backup / "original-compose.yml")
    shutil.copy2(netbird_cfg, backup / "netbird-config.yaml")
    state = {"container": "netbird-server", "data": str(data), "override": str(override),
             "old_override": old_override, "old_image_id": current["Image"],
             "compose_command": compose, "health_url": health_url, "release": str(release_dir)}
    atomic_json(backup / "state.json", state)
    trial_data = backup / "trial-data"
    copy_live_data(data, trial_data)
    trial = "shirobird-management-trial"
    print("Testing startup against an isolated database copy", flush=True)
    run("docker", "run", "-d", "--name", trial, "--network", "none", "--memory", "1g",
        "-v", str(trial_data) + ":/var/lib/netbird",
        "-v", str(netbird_cfg) + ":/etc/netbird/config.yaml:ro",
        "-v", str(config_file) + ":/etc/shirobird-flow.json:ro",
        "-v", str(secret_file) + ":/run/secrets/native_flow_secret:ro",
        "-e", "SHIROBIRD_FLOW_CONFIG_FILE=/etc/shirobird-flow.json", manifest["image"])
    try:
        code = '''import time,urllib.request,urllib.error
for _ in range(30):
 try: urllib.request.urlopen("http://127.0.0.1/api/peers",timeout=2)
 except urllib.error.HTTPError as e:
  if e.code==401: break
 except OSError: pass
 time.sleep(2)
else: raise RuntimeError("isolated management startup failed")
'''
        run("docker", "run", "--rm", "--network", "container:" + trial,
            manifest["receiver_image"], "python", "-c", code)
    finally:
        logs = run("docker", "logs", trial, capture=True, stderr=subprocess.STDOUT)
        (backup / "trial.log").write_text(logs)
        run("docker", "rm", "-f", trial, capture=True)
    candidate = {"x-shirobird-managed": True, "services": {"netbird-server": {
        "image": manifest["image"], "pull_policy": "never",
        "environment": {"SHIROBIRD_FLOW_CONFIG_FILE": "/etc/shirobird-flow.json"},
        "volumes": [str(config_file) + ":/etc/shirobird-flow.json:ro",
                    str(secret_file) + ":/run/secrets/native_flow_secret:ro"],
        "labels": {"com.centurylinklabs.watchtower.enable": "false"}}}}
    candidate_file = backup / "candidate.json"
    atomic_json(candidate_file, candidate)
    run("docker", "compose", "-p", project, "-f", compose_file, "-f", candidate_file,
        "config", "--quiet")
    # Pause all writers only for the consistent snapshot, then immediately resume.
    run("docker", "pause", "netbird-server")
    try:
        shutil.copytree(data, backup / "data")
    finally:
        run("docker", "unpause", "netbird-server")
    try:
        atomic_json(override, candidate)
        run(*compose, "up", "-d", "--no-deps", "--pull", "never", "netbird-server")
        wait_health(health_url)
        if inspect("netbird-server")["Image"] != manifest["image_id"]:
            raise RuntimeError("unexpected running image")
        public_receiver_check(manifest["receiver_image"], cfg["receiver_url"])
    except Exception:
        print("Activation failed; restoring previous image and data", flush=True)
        rollback(backup)
        raise
    atomic_json(release_dir / "deployment.json", {"backup": str(backup), "ok": True,
                                                "running_image_id": manifest["image_id"]})
    print("Activated release; rollback snapshot: " + str(backup), flush=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--rollback", help="restore a recorded backup instead of activating")
    parser.add_argument("--release")
    parser.add_argument("--compose", default="/opt/netbird/docker-compose.yml")
    parser.add_argument("--config", default="/etc/shirobird/native-flow.json")
    parser.add_argument("--secret", default="/etc/shirobird/native-flow-secret")
    parser.add_argument("--health-url", default="http://127.0.0.1:8081/api/peers")
    args = parser.parse_args()
    if args.rollback:
        rollback(args.rollback)
    elif args.release:
        activate(args.release, args.compose, args.config, args.secret, args.health_url)
    else:
        parser.error("--release or --rollback is required")
