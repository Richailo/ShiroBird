#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
test "$(id -u)" -eq 0 || { echo "Run with sudo/root"; exit 1; }
command -v conntrack >/dev/null || { echo "Install conntrack first (apt install conntrack)"; exit 1; }
umask 077
install -d -m 700 /etc/shirobird
install -m 644 shirobird/collector.py /usr/local/lib/shirobird-collector.py
if [[ -f .env ]]; then
  TOKEN="$(sed -n 's/^SHIROBIRD_INGEST_TOKEN=//p' .env)"
  URL="http://127.0.0.1:8666"
else
  read -r -p "ShiroBird HTTPS server URL: " URL
  read -r -s -p "ShiroBird ingest token: " TOKEN
  echo
fi
test "${#TOKEN}" -ge 32 || { echo "Invalid ingest token (32+ characters required)"; exit 1; }
case "$URL" in
  https://*|http://127.0.0.1:*|http://localhost:*) ;;
  *) echo "Use HTTPS for remote collection; HTTP is only permitted locally"; exit 1 ;;
esac
HOSTNAME_SENSOR="$(hostname)"
if [[ ! -f /etc/shirobird/collector.env ]]; then
cat > /etc/shirobird/collector.env <<EOF
SHIROBIRD_SERVER_URL=$URL
SHIROBIRD_INGEST_TOKEN=$TOKEN
SHIROBIRD_SENSOR=$HOSTNAME_SENSOR
SHIROBIRD_NETWORKS=auto
EOF
fi
chmod 600 /etc/shirobird/collector.env
install -m 644 packaging/shirobird-collector.service /etc/systemd/system/shirobird-collector.service
if [[ "${SHIROBIRD_ENABLE_ACCOUNTING:-0}" == "1" ]]; then
  printf '%s\n' '# ShiroBird byte counters; does not alter routing or firewall rules' \
    'net.netfilter.nf_conntrack_acct = 1' > /etc/sysctl.d/90-shirobird-accounting.conf
  sysctl -w net.netfilter.nf_conntrack_acct=1
fi
systemctl daemon-reload
systemctl enable shirobird-collector
systemctl restart shirobird-collector
echo "Collector started. Check: journalctl -u shirobird-collector -n 30 --no-pager"