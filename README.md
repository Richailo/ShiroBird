# ShiroBird

**Native-looking, self-hosted NetBird traffic observability and SIEM export.**
ShiroBird is an independent community project, not affiliated with NetBird.

## Install (one command)

On the Linux machine that runs the original `netbird-dashboard` Docker container:

```bash
git clone https://github.com/Richailo/ShiroBird.git
cd ShiroBird
sudo bash scripts/install.sh
```

The installer automatically:
- Detects NetBird Dashboard and its Docker network.
- Generates internal signing and collector keys securely without user input.
- Runs the ShiroBird monitoring server and a separate bridge on port **8082**.
- Adds a **ShiroBird** menu item to the original NetBird sidebar with matching dark/light theme.
- Reuses the *existing NetBird OIDC login* (Owner and Admin roles only). **No ShiroBird login screen, manual token creation, or personal access tokens required.**
- Leaves NetBird containers, client software, OIDC configuration and server files unchanged.

**Reverse proxy integration**: point only the NetBird Dashboard web upstream at port **8082** instead of 8080; preserve the original NetBird management API, OAuth2, gRPC, relay and WebSocket routes. The bridge listens on loopback by default. If your reverse proxy runs on a different host, set `SHIROBIRD_BRIDGE_BIND=YOUR_NETBIRD_HOST_PRIVATE_IP` in `.env`, run the installer again and restrict port 8082 to your proxy. See [detailed NetBird integration](docs/netbird-tab.md).

## What it does

- Live flow monitoring (SSE), source and destination IPs, protocols, ports, optional conntrack counters.
- Linux conntrack collection without patching NetBird or decrypting packets.
- JSONL export for Wazuh, CSV/NDJSON download, optional UDP syslog.
- Searchable table, counts, limited SQLite history and log rotation.
- Independent Docker Compose service and lightweight Nginx bridge.

## Enable traffic monitoring on this Linux host

```bash
sudo apt-get install -y conntrack
sudo bash scripts/install-collector.sh
```

The collector runs independently from the NetBird clients and only observes selected IPv4/IPv6 CIDRs. Deploy collectors on each monitored Linux peer or routing gateway. NetBird management/relay cannot see decrypted direct P2P traffic. Byte counters require kernel connection-tracking accounting; by default this can be disabled. See [Wazuh integration](docs/wazuh.md).

## Standalone (without NetBird Dashboard)

The same installer falls back to standalone mode on `127.0.0.1:8666` and retains separate admin-token authentication. Only the embedded NetBird edition removes manual login.

## Upgrade and uninstall

```bash
git pull --ff-only
sudo bash scripts/install.sh
```

The NetBird installation remains untouched. Roll back the dashboard proxy to port 8080 before removing the bridge. Full [rollback instructions](docs/netbird-tab.md).

## Security and limitations

The browser adapter reads the current NetBird OIDC access token **only from same-origin session storage** and sends it to `/shirobird/api/netbird-session` over the existing HTTPS origin. ShiroBird independently asks NetBird's management API to verify the token and Owner/Admin role. It issues a short-lived (3-minute), scoped, HttpOnly Secure session cookie. No OIDC token is written to ShiroBird's database or log files. This grants no new NetBird privileges and is not a replacement for licensed Enterprise telemetry.

Do not expose port 8082 publicly; use HTTPS and administrative network restrictions. Treat traffic metadata as potentially sensitive. View [security](docs/security.md), run tests with `python3 -m unittest discover -s tests -v`, and keep `.env` private.

MIT License — © 2026 ShiroBird contributors.
