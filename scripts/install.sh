#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
test "$(id -u)" -eq 0 || { echo "Run with sudo/root"; exit 1; }
command -v docker >/dev/null || { echo "Docker required"; exit 1; }
docker compose version >/dev/null || { echo "Docker Compose v2 required"; exit 1; }
if [[ ! -e .env ]]; then
  umask 077
  cat > .env <<EOF
SHIROBIRD_ADMIN_TOKEN=$(openssl rand -hex 32)
SHIROBIRD_INGEST_TOKEN=$(openssl rand -hex 32)
SHIROBIRD_PORT=8666
SHIROBIRD_COOKIE_SECURE=true
SHIROBIRD_RETENTION_DAYS=30
SHIROBIRD_SYSLOG_HOST=
SHIROBIRD_SYSLOG_PORT=514
EOF
  echo "Generated .env with distinct random secrets"
fi
mkdir -p data/siem
chown -R 65532:65532 data
chmod 700 data
chmod 600 .env
docker compose up -d --build
if command -v logrotate >/dev/null 2>&1; then
  sed "s|@ROOT@|$PWD|g" packaging/shirobird.logrotate > /etc/logrotate.d/shirobird
fi
echo "ShiroBird launched on 127.0.0.1:8666. Access through an HTTPS reverse proxy."
echo "Read your admin token locally: grep ^SHIROBIRD_ADMIN_TOKEN= .env (do not paste it into chats)"