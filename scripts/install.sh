#!/usr/bin/env bash
# One-command installer: standalone by default; embedded automatically when NetBird exists.
set -euo pipefail
cd "$(dirname "$0")/.."
[[ "$(id -u)" -eq 0 ]] || { echo "Run with sudo"; exit 1; }
command -v docker >/dev/null || { echo "Docker is required"; exit 1; }
docker compose version >/dev/null || { echo "Docker Compose v2 is required"; exit 1; }
command -v openssl >/dev/null || { echo "openssl is required"; exit 1; }
umask 077
if [[ ! -f .env ]]; then
  cat > .env <<EOF
SHIROBIRD_ADMIN_TOKEN=$(openssl rand -hex 32)
SHIROBIRD_INGEST_TOKEN=$(openssl rand -hex 32)
SHIROBIRD_PORT=8666
SHIROBIRD_COOKIE_SECURE=true
SHIROBIRD_RETENTION_DAYS=30
SHIROBIRD_SYSLOG_HOST=
SHIROBIRD_SYSLOG_PORT=514
EOF
  echo "Generated internal signing and collection secrets automatically."
fi
embedded=false
if docker inspect netbird-dashboard >/dev/null 2>&1; then
  embedded=true
  network="$(docker inspect -f '{{range $n, $v := .NetworkSettings.Networks}}{{println $n}}{{end}}' netbird-dashboard | head -n 1)"
  [[ -n "$network" ]] || { echo "Cannot detect the NetBird Docker network"; exit 1; }
  if grep -q '^SHIROBIRD_NETBIRD_NETWORK=' .env; then
    sed -i "s/^SHIROBIRD_NETBIRD_NETWORK=.*/SHIROBIRD_NETBIRD_NETWORK=$network/" .env
  else
    printf '\nSHIROBIRD_NETBIRD_NETWORK=%s\n' "$network" >> .env
  fi
  if [[ -e compose.override.yaml && ! -L compose.override.yaml ]]; then
    echo "Existing compose.override.yaml: not overwriting. See docs/netbird-tab.md"; exit 1
  fi
  if [[ -L compose.override.yaml && "$(readlink compose.override.yaml)" != compose.bridge.yaml ]]; then
    echo "Existing unrelated compose override symlink: not overwriting"; exit 1
  fi
  ln -sfn compose.bridge.yaml compose.override.yaml
fi
mkdir -p data/siem
chown -R 65532:65532 data
chmod 700 data
chmod 600 .env
if ! grep -q '^SHIROBIRD_HOST_LOG_PATH=' .env; then
  printf '\nSHIROBIRD_HOST_LOG_PATH=%s\n' "$PWD/data/siem/events.jsonl" >> .env
fi
docker compose config --quiet
docker compose up -d --build
if command -v logrotate >/dev/null; then
  sed "s|@ROOT@|$PWD|g" packaging/shirobird.logrotate > /etc/logrotate.d/shirobird
fi
echo
if [[ "$embedded" == true ]]; then
  echo "ShiroBird integrated service installed; NetBird Owner/Admin SSO enabled."
  echo "No token entry or second login is required for the NetBird dashboard tab."
  echo "Set ONLY the dashboard HTTP upstream to port 8082 in your reverse proxy."
  echo "Other NetBird API/OIDC/gRPC/WebSocket routes must stay unchanged."
  echo "Bridge bind address (set SHIROBIRD_BRIDGE_BIND in .env if proxy is remote):"
  docker compose port shirobird-bridge 8080 || true
else
  echo "No netbird-dashboard detected. Installed standalone ShiroBird on loopback port 8666."
  echo "Standalone administrator token remains in protected .env (not shown)."
fi
