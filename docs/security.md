# Security and privacy

- Docker runs as a non-root user with no capabilities and a read-only root filesystem. The HTTP listener is host-loopback only.
- HTTPS through an admin-only reverse proxy is required for browser login by default; `SHIROBIRD_COOKIE_SECURE=true`.
- The installer automatically generates two separate random secrets: an internal signing key and a collector-ingestion key. The NetBird-integrated dashboard needs **no user-generated token**, while standalone mode retains token login. Never publish `.env`.
- Integrated mode verifies each NetBird OIDC access token server-side against NetBird's **private** `/api/users/current` API and grants only active Owner/Admin identities. This check runs before a 3-minute ShiroBird session is issued.
- The NetBird token remains transient and is never written to ShiroBird files. Only the current `oidc.default` session-storage entry is read. A ShiroBird session may remain active for at most 3 minutes after NetBird authentication becomes invalid; avoid assuming instantaneous global logout.
- NetBird's original management/login endpoints and dashboard remain unchanged. The UI bridge is an additional same-origin component; restrict who can administer it.
- API input is length-limited and validated. Untrusted flow metadata in the browser uses textContent.
- Kernel conntrack observation requires privileges on Linux sensors. Systemd uses CAP_NET_ADMIN and does not modify routing, VPN, firewall rules or NetBird configuration.
- The optional UDP syslog transport is unencrypted. For Wazuh, prefer a monitored JSONL file ingested by Wazuh agent.
- Avoid monitoring endpoints without appropriate organizational authorization. Source and destination IPs are personal/security telemetry.
- SQLite retention does NOT rotate the JSONL file; implement logrotate/disk alerts before high-volume production.
- A sensor holds unsent events in a bounded memory queue; a process restart may lose them. There is no guaranteed delivery.
- Public deployments should enforce admin subnet restrictions, HTTPS, rate limiting and externally managed backups.