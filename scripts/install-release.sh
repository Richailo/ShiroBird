#!/usr/bin/env bash
# Safe installer for ShiroBird registry release or local release build.
set -euo pipefail
cd "$(dirname "$0")/.."
command -v docker >/dev/null || { echo "Docker is required"; exit 1; }
docker compose version >/dev/null || { echo "Docker Compose v2 required"; exit 1; }
command -v openssl >/dev/null || { echo "openssl is required"; exit 1; }
if docker container inspect shirobird >/dev/null 2>&1; then
  echo "Existing ShiroBird container detected. No changes made."
  echo "Back up ./data and switch stacks manually after verification; do not run this installer on an active deployment."
  exit 2
fi
umask 077
if [[ ! -f .env ]]; then
  cat > .env <<EOF
SHIROBIRD_ADMIN_TOKEN=$(openssl rand -hex 32)
SHIROBIRD_INGEST_TOKEN=$(openssl rand -hex 32)
SHIROBIRD_PORT=8666
SHIROBIRD_COOKIE_SECURE=true
SHIROBIRD_RETENTION_DAYS=30
EOF
fi
mkdir -p data/siem
chown -R 65532:65532 data
chmod 700 data
chmod 600 .env
args=(-f compose.release.yaml)
if docker container inspect netbird-dashboard >/dev/null 2>&1; then
  net="$(docker inspect -f '{{range $n, $v := .NetworkSettings.Networks}}{{println $n}}{{end}}' netbird-dashboard | head -n 1)"
  [[ -n "$net" ]] || { echo "NetBird network not found"; exit 1; }
  if ! grep -q '^SHIROBIRD_NETBIRD_NETWORK=' .env; then
    printf 'SHIROBIRD_NETBIRD_NETWORK=%s\n' "$net" >> .env
  fi
  args+=(-f compose.release.netbird.yaml)
fi
mode="${SHIROBIRD_INSTALL_MODE:-build}"
if [[ "$mode" == "build" ]]; then
  args+=(-f compose.release.build.yaml)
  if docker container inspect netbird-dashboard >/dev/null 2>&1; then
    args+=(-f compose.release.build.netbird.yaml)
  fi
elif [[ "$mode" != "pull" && "$mode" != "load" ]]; then
  echo "SHIROBIRD_INSTALL_MODE must be build, pull or load"; exit 1
fi
docker compose "${args[@]}" config -q
if [[ "$mode" == "build" ]]; then
  docker compose "${args[@]}" up -d --build
elif [[ "$mode" == "pull" ]]; then
  docker compose "${args[@]}" pull
  docker compose "${args[@]}" up -d --no-build
else
  docker compose "${args[@]}" up -d --no-build --pull never
fi
docker compose "${args[@]}" ps
echo "ShiroBird ready. NetBird Dashboard reverse proxy remains unchanged."
echo "If embedded, switch ONLY the Dashboard HTTP upstream to bridge port 8082."
