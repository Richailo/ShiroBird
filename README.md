# ShiroBird

**Independent, self-hosted NetBird flow monitoring and SIEM export.** ShiroBird is a separate community project, **not affiliated with or endorsed by NetBird**. No modifications to the NetBird server, Docker images, databases or clients are required.

## Features

- Live flow event streaming using Server-Sent Events (SSE).
- Linux conntrack sensors on selected hosts and routing peers: NEW/DESTROY events for TCP/UDP/ICMP with optional kernel packet/byte counters.
- Dark-mode browser dashboard, search, counters and 12-hour cookie sessions.
- Wazuh-compatible JSONL file export, CSV/NDJSON downloads and optional UDP syslog.
- SQLite database, 30-day default database retention, dedicated ingest and admin secrets.
- Docker Compose server + independent systemd collector; no NetBird restarts.

## Install the server

Linux prerequisites: Docker Compose v2, OpenSSL and Python 3 for tests.

```bash
git clone https://github.com/Richailo/ShiroBird.git
cd ShiroBird
sudo bash scripts/install.sh
docker compose ps
curl -fsS http://127.0.0.1:8666/healthz
```

The server binds to **127.0.0.1:8666** only. Publish it through your existing HTTPS reverse proxy restricted to administrators. The login requires HTTPS by default (Secure cookie). View the token locally with `sudo grep ^SHIROBIRD_ADMIN_TOKEN= .env` — never paste it in chats or commit it.

## Install a collector on the server

```bash
sudo apt-get install -y conntrack
sudo bash scripts/install-collector.sh
sudo systemctl status shirobird-collector
```

On other Linux peers, provision `collector.py` and `/etc/shirobird/collector.env` securely; set `SHIROBIRD_SERVER_URL=https://YOUR_REVERSE_PROXY` and the appropriate ingest token. Restart only the ShiroBird collector. Configure `SHIROBIRD_NETWORKS` with comma-separated CIDRs; default `100.64.0.0/10` filters addresses (not interfaces). IPv6 needs explicitly configured networks.

## Limitations

**The NetBird management/relay server does not see decrypted P2P traffic.** Deploy collectors on monitored devices or routing peers. ShiroBird cannot inspect uninstrumented clients, infer NetBird policy decisions, extract websites, read payloads or substitute Enterprise audit logging. Conntrack byte counters can be zero if kernel accounting is disabled. Sensor queue is bounded/in-memory and may lose events during outages. SIEM JSONL is not covered by database retention: monitor and rotate separately. Review applicable privacy and retention policies before deploying in production.

## Operations

`sudo docker compose up -d --build` upgrades ShiroBird after `git pull --ff-only`. `sudo docker compose down` stops only ShiroBird, without affecting NetBird. Database/exports stay in `./data`. Run `python3 -m unittest discover -s tests -v` for tests.

Read [Wazuh export](docs/wazuh.md) and [Security](docs/security.md). Released under the MIT license. **Keep `.env` and all credentials private.**