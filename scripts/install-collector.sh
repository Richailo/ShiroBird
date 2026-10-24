#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
test "$(id -u)" -eq 0 || { echo "Run with sudo/root"; exit 1; }
command -v conntrack >/dev/null || { echo "Install conntrack first (apt install conntrack)"; exit 1; }
test -f .env || { echo "Install server first or create .env"; exit 1; }
umask 077
install -d -m 700 /etc/shirobird
install -m 644 shirobird/collector.py /usr/local/lib/shirobird-collector.py
TOKEN="$(sed -n 's/^SHIROBIRD_INGEST_TOKEN=//p' .env)"
test "${#TOKEN}" -ge 32 || { echo "Invalid ingest token"; exit 1; }
cat > /etc/shirobird/collector.env <<EOF
SHIROBIRD_SERVER_URL=http://127.0.0.1:8666
SHIROBIRD_INGEST_TOKEN=$TOKEN
SHIROBIRD_SENSOR=$(hostname)
SHIROBIRD_NETWORKS=100.64.0.0/10
EOF
chmod 600 /etc/shirobird/collector.env
install -m 644 packaging/shirobird-collector.service /etc/systemd/system/shirobird-collector.service
systemctl daemon-reload
systemctl enable --now shirobird-collector
echo "Collector started. Check: journalctl -u shirobird-collector -n 30 --no-pager"