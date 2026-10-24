#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
test "$(id -u)" -eq 0 || { echo "Use sudo"; exit 1; }
command -v docker >/dev/null || { echo "Docker is required"; exit 1; }
docker compose version >/dev/null || { echo "Docker Compose v2 is required"; exit 1; }
docker inspect netbird-dashboard >/dev/null 2>&1 || {
  echo "The local netbird-dashboard container is not present."
  echo "Install NetBird first, then run this script on its Docker host."
  exit 1
}
if [[ ! -f .env ]]; then
  bash scripts/install.sh
fi
network="$(docker inspect -f '{{range $n, $v := .NetworkSettings.Networks}}{{println $n}}{{end}}' netbird-dashboard | head -n 1)"
[[ -n "$network" ]] || { echo "Unable to find the dashboard Docker network"; exit 1; }
if ! grep -q '^SHIROBIRD_NETBIRD_NETWORK=' .env; then
  printf '\nSHIROBIRD_NETBIRD_NETWORK=%s\n' "$network" >> .env
fi
if [[ -e compose.override.yaml && ! -L compose.override.yaml ]]; then
  echo "compose.override.yaml exists; refusing to replace it. Merge compose.bridge.yaml manually."
  exit 1
fi
if [[ -L compose.override.yaml ]] && [[ "$(readlink compose.override.yaml)" != compose.bridge.yaml ]]; then
  echo "An unrelated compose.override.yaml symlink exists; refusing to replace it."
  exit 1
fi
ln -sfn compose.bridge.yaml compose.override.yaml
chmod 600 .env
docker compose config --quiet
docker compose up -d --build shirobird shirobird-bridge
echo
echo "ShiroBird bridge is deployed. Your NetBird containers have not been modified."
echo "To activate the tab: change ONLY the NetBird dashboard upstream in your"
echo "existing reverse proxy from port 8080 to port ${SHIROBIRD_BRIDGE_PORT:-8082}."
echo "Keep NetBird API, OAuth2, WebSocket, gRPC and relay upstreams unchanged."
echo "For a remote proxy, set SHIROBIRD_BRIDGE_BIND to the NetBird host's LAN IP"
echo "in .env, then rerun this script (protect the port with firewall rules)."
