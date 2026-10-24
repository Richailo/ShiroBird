#!/usr/bin/env bash
# Prepare settings for an existing Wazuh Agent; does not install or restart it.
set -euo pipefail
cd "$(dirname "$0")/.."
file="$PWD/data/siem/events.jsonl"
if [[ ! -f /var/ossec/etc/ossec.conf ]]; then
  echo "Wazuh Agent is not installed on this host."
  echo "Install and enroll it first, then rerun this helper."
  exit 0
fi
echo "Wazuh Agent configuration: /var/ossec/etc/ossec.conf"
echo "Add the following localfile block inside <ossec_config>:"
printf '  <localfile>\n    <log_format>json</log_format>\n    <location>%s</location>\n  </localfile>\n' "$file"
echo "Then ensure the Wazuh service user can read the JSONL file and parent directories."
echo "Restart the agent using: sudo systemctl restart wazuh-agent"
echo "Verify ingestion in Wazuh Manager; log export alone is not proof of delivery."
