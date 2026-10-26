"""Build tested ShiroBird management images from a specified official NetBird release.

Does not change the running service. Use rollout.py only after a successful build.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tarfile
import time
from urllib.request import urlopen

import prepare

HERE = Path(__file__).resolve().parent
REPO = HERE.parent.parent
VERSION = re.compile(r"[0-9]+\.[0-9]+\.[0-9]+(?:-[A-Za-z0-9.-]+)?\Z")


def run(*args, capture=False, **kwargs):
    output = kwargs.pop("stdout", subprocess.PIPE if capture else None)
    return subprocess.run(list(map(str, args)), check=True, text=True,
                          stdout=output, **kwargs).stdout


def digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def download(url, path, maximum=100 * 1024 * 1024):
    with urlopen(url, timeout=60) as response, Path(path).open("xb") as out:
        total = 0
        while chunk := response.read(1024 * 1024):
            total += len(chunk)
            if total > maximum:
                raise ValueError("upstream download exceeds size limit")
            out.write(chunk)


def toolchain(go_mod):
    match = re.search(r"(?m)^toolchain go(\d+\.\d+\.\d+)\s*$", go_mod)
    if not match:
        match = re.search(r"(?m)^go (\d+\.\d+\.\d+)\s*$", go_mod)
    if not match:
        raise ValueError("unsupported upstream Go toolchain declaration")
    # Debian bookworm's glibc is compatible with the official Ubuntu runtime.
    return "golang:" + match.group(1) + "-bookworm"


def source_revision(buildinfo, version):
    ver = re.search(r"version\.version=v?([0-9][A-Za-z0-9.+-]*)", buildinfo)
    rev = re.search(r"(?m)^\s*build\s+vcs.revision=([a-f0-9]{40})\s*$", buildinfo)
    if not ver or ver.group(1) != version or not rev or "vcs.modified=true" in buildinfo:
        raise ValueError("official image version/revision cannot be verified")
    return rev.group(1)


def extract(archive, target):
    target.mkdir()
    with tarfile.open(archive) as source:
        members = source.getmembers()
        if sum(m.size for m in members) > 1024 * 1024 * 1024:
            raise ValueError("upstream source archive too large")
        source.extractall(target, filter="data")
    roots = list(target.iterdir())
    if len(roots) != 1 or not roots[0].is_dir():
        raise ValueError("unexpected upstream archive layout")
    return roots[0]


def build(version, work_root, cache=None, base_image=None):
    version = version.removeprefix("v")
    if not VERSION.fullmatch(version):
        raise ValueError("supply an explicit NetBird version, e.g. 0.81.3")
    root = Path(work_root).resolve()
    root.mkdir(parents=True, exist_ok=True)
    root.chmod(0o700)
    release = root / ("netbird-" + version + "-" + time.strftime("%Y%m%dT%H%M%SZ", time.gmtime()))
    release.mkdir(mode=0o700)
    cache = Path(cache).resolve() if cache else root / "cache"
    cache.mkdir(parents=True, exist_ok=True)
    base = base_image or "netbirdio/netbird-server:" + version
    if not base_image:
        run("docker", "pull", base)
    info = json.loads(run("docker", "image", "inspect", base, capture=True))[0]
    base_id = info["Id"]
    # A unique local tag pins the exact pulled runtime, never a moving latest tag.
    pinned_base = "shirobird/netbird-base:" + base_id.split(":")[1][:20]
    run("docker", "tag", base_id, pinned_base)
    download("https://raw.githubusercontent.com/netbirdio/netbird/v" + version + "/go.mod",
             release / "tag.go.mod", maximum=1024 * 1024)
    builder = toolchain((release / "tag.go.mod").read_text())
    temporary = run("docker", "create", "--network", "none", base_id, capture=True).strip()
    try:
        run("docker", "cp", temporary + ":/go/bin/netbird-server", release / "official-server")
    finally:
        run("docker", "rm", temporary, capture=True)
    buildinfo = run("docker", "run", "--rm", "--network", "none", "--cap-drop", "ALL",
                    "-v", str(release / "official-server") + ":/server:ro",
                    builder, "go", "version", "-m", "/server", capture=True)
    revision = source_revision(buildinfo, version)
    (release / "official-buildinfo.txt").write_text(buildinfo)
    download("https://codeload.github.com/netbirdio/netbird/tar.gz/" + revision, release / "source.tar.gz")
    source = extract(release / "source.tar.gz", release / "source")
    if toolchain((source / "go.mod").read_text()) != builder:
        raise ValueError("official image source and release tag disagree on toolchain")
    protocol = REPO / "extensions/native-flow/flow.proto"
    if (source / "flow/proto/flow.proto").read_bytes() != protocol.read_bytes():
        raise ValueError("native flow protocol changed; update and test the receiver before upgrading")
    prepare.prepare(source, compatible=True)
    probe = source / "flow/shirobirdcompat"
    probe.mkdir()
    shutil.copy2(HERE / "native_client_probe.go", probe / "main.go")
    commands = """set -eu
gofmt -w management/server/shirobirdflow/*.go management/internals/shared/grpc/conversion.go management/internals/shared/grpc/components_envelope_response.go management/internals/shared/grpc/token_mgr.go flow/shirobirdcompat/main.go
SHIROBIRD_TEST_TOKEN_OUTPUT=/src/adapter-test-token.json go test -p 1 -race -v ./management/server/shirobirdflow
go test -p 1 -run '^$' ./management/internals/shared/grpc
CGO_ENABLED=0 go build -p 1 -o /src/native-client-probe ./flow/shirobirdcompat
CGO_ENABLED=1 go build -p 1 -ldflags="-s -w -X github.com/netbirdio/netbird/version.version=$RELEASE_VERSION" -o /src/netbird-server ./combined
"""
    print("Compiling and validating official revision " + revision, flush=True)
    with (release / "build.log").open("w") as log:
        run("docker", "run", "--rm", "--cpus", "2", "--memory", "2g",
            "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
            "-e", "GOMAXPROCS=2", "-e", "GOCACHE=/cache/build", "-e", "GOMODCACHE=/cache/mod",
            "-e", "RELEASE_VERSION=" + version, "-v", str(cache) + ":/cache",
            "-v", str(source) + ":/src", "-w", "/src", builder, "sh", "-c", commands,
            stdout=log, stderr=subprocess.STDOUT)
    # Release-owned tags preserve old receiver/runtime images for rollback too.
    suffix = digest(source / "netbird-server")[:12] + "-" + release.name.rsplit("-", 1)[-1].lower()
    receiver = "shirobird/native-flow:" + suffix
    run("docker", "build", "-t", receiver, REPO / "extensions/native-flow")
    run("docker", "run", "--rm", "--network", "none", "--cap-drop", "ALL",
        "--security-opt", "no-new-privileges", "--memory", "256m", receiver,
        "python", "-m", "unittest", "-v")
    run("docker", "run", "--rm", "--network", "none", "--cap-drop", "ALL",
        "--security-opt", "no-new-privileges", "--memory", "256m", "-e", "PYTHONPATH=/app",
        "-v", str(HERE) + ":/checks:ro",
        "-v", str(source / "native-client-probe") + ":/fixtures/probe:ro",
        "-v", str(source / "adapter-test-token.json") + ":/fixtures/token.json:ro",
        receiver, "python", "/checks/verify_receiver.py", "/fixtures/probe", "/fixtures/token.json")
    image_dir = release / "image"
    image_dir.mkdir()
    shutil.copy2(source / "netbird-server", image_dir / "netbird-server")
    (image_dir / "Dockerfile").write_text(
        "ARG BASE_IMAGE\nFROM ${BASE_IMAGE}\nCOPY netbird-server /go/bin/netbird-server\n"
        'LABEL org.opencontainers.image.title="ShiroBird NetBird native flow adapter"\n'
        'LABEL org.opencontainers.image.version="' + version + '-shirobird"\n')
    image = "shirobird/netbird-server:" + version + "-" + suffix
    run("docker", "build", "--network", "none", "--build-arg", "BASE_IMAGE=" + pinned_base,
        "-t", image, image_dir)
    run("docker", "run", "--rm", "--network", "none", image, "--help", capture=True)
    manifest = {
        "version": version, "upstream_revision": revision, "base_image_id": base_id,
        "source_sha256": digest(release / "source.tar.gz"), "binary_sha256": digest(image_dir / "netbird-server"),
        "flow_proto_sha256": digest(protocol), "image": image,
        "image_id": json.loads(run("docker", "image", "inspect", image, capture=True))[0]["Id"],
        "receiver_image": receiver,
        "receiver_image_id": json.loads(run("docker", "image", "inspect", receiver, capture=True))[0]["Id"],
        "tests": {"adapter_race": True, "management_compilation": True, "receiver": True,
                  "official_client_wire": True, "runtime_help": True},
    }
    (release / "manifest.json").write_text(json.dumps(manifest, indent=2))
    print("Validated release: " + str(release), flush=True)
    return release


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--version", required=True)
    parser.add_argument("--work-root", default="/opt/shirobird/releases")
    parser.add_argument("--cache")
    parser.add_argument("--base-image", help="optional existing official image ID; version/revision still verified")
    args = parser.parse_args()
    build(args.version, args.work_root, args.cache, args.base_image)
