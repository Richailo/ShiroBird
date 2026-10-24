# Wazuh and SIEM integration

ShiroBird appends one JSON object per observed flow to `/opt/shirobird/data/siem/events.jsonl` (host path in the default installation). The `integration` field is `shirobird`.

## Wazuh agent localfile

When the Wazuh agent is installed and enrolled separately on the ShiroBird host, add to its `/var/ossec/etc/ossec.conf` inside `<ossec_config>`:

```xml
<localfile>
  <log_format>json</log_format>
  <location>/opt/shirobird/data/siem/events.jsonl</location>
</localfile>
```

Restart the Wazuh agent and verify the decoded JSON events arrive. Update the host path if installed elsewhere. No change to NetBird is needed.

## Other integrations

- CSV export: `GET /api/export.csv` (admin cookie required).
- NDJSON export: `GET /api/export.ndjson` (admin cookie required).
- SSE live stream: `GET /api/stream?since=123` (admin cookie required).
- Optional unencrypted best-effort UDP syslog: set `SHIROBIRD_SYSLOG_HOST` and `SHIROBIRD_SYSLOG_PORT` in `.env`; use only a trusted LAN or a protected relay.

The JSONL file grows independently of SQLite retention. Configure monitored log rotation and available disk space. Conntrack events do not represent NetBird policy allow/deny decisions.