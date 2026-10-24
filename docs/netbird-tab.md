# Embed the ShiroBird tab in the original NetBird Dashboard

ShiroBird uses a separate **HTTP dashboard bridge**, not an unsupported patch to NetBird's
Next.js source code or Docker image. On each HTML page the bridge injects a same-origin
JS/CSS adapter that adds a ShiroBird entry to the dashboard navigation. Clicking it
opens ShiroBird inside a dedicated panel. The original NetBird backend, API, OAuth2,
gRPC routes and WireGuard tunnels remain unchanged.

## Setup

1. Install NetBird Self-Hosted with its standard NetBird Dashboard and working reverse proxy.
2. Clone the ShiroBird project on the NetBird Docker host.
3. Run `sudo bash scripts/install-integrated.sh`. This deploys both the existing
   ShiroBird service and the Nginx UI bridge; it creates a symlink
   `compose.override.yaml -> compose.bridge.yaml` for normal Docker Compose upgrades.
4. If Nginx Proxy Manager (NPM) runs on a **different host**, add
   `SHIROBIRD_BRIDGE_BIND=YOUR_NETBIRD_HOST_PRIVATE_LAN_IP` to `.env` and
   rerun `sudo bash scripts/install-integrated.sh`. Restrict TCP/8082 to your
   trusted reverse proxy; never port-forward it directly to the public internet.
5. Check the new UI bridge at `http://NETBIRD_HOST:8082/` (or `127.0.0.1:8082`
   when bound to loopback). The HTML must contain
   `/shirobird-integration/bridge.js`; `/shirobird/healthz` must return `ok`.
6. **NPM:** in the NetBird Proxy Host, change only the main dashboard
   upstream port **8080 → 8082**, retaining the original NetBird dashboard
   upstream host and all existing Advanced API, OAuth2, WebSocket and gRPC
   location rules (typically port 8081 in a combined-server installation).
   NPM must reach the new bridge port and use HTTPS for browser connections.
7. Refresh NetBird and sign in. The new ShiroBird menu item appears alongside
   normal NetBird navigation. The embedded ShiroBird session has its own
   administrator token and cookie scoped to `/shirobird/`.

### Verify without altering NetBird

```bash
docker compose ps
curl -fsS http://127.0.0.1:8082/ | grep -o 'shirobird-integration/bridge.js' | head -1
curl -fsS http://127.0.0.1:8082/shirobird/healthz
```

Replace `127.0.0.1` above with the binding address if using a private LAN IP.

## Updating and removing

Run `git pull --ff-only && sudo docker compose up -d --build` inside
ShiroBird. Because Compose automatically loads the integration override,
the adapter remains in place without modifying NetBird, and its containers can
be updated independently.

To disable: **first** point NPM's original NetBird dashboard upstream back
to port **8080** and verify NetBird is accessible. Then run
`sudo docker compose -f compose.yaml -f compose.bridge.yaml stop shirobird-bridge`,
`sudo docker compose -f compose.yaml -f compose.bridge.yaml rm -f shirobird-bridge`,
`sudo rm compose.override.yaml`, and `sudo docker compose up -d shirobird`.

## Compatibility and trust model

- The bridge injects navigation through DOM observation. It is resilient to
  static asset hashes and container replacements, but may require updates when
  NetBird changes its sidebar markup. Test after major dashboard upgrades.
- This adds no NetBird authorization scope or licensed functionality.
- It does not automatically sign the user into ShiroBird with their NetBird
  identity. ShiroBird uses its own administrator token.
- The bridge only forwards Dashboard HTML/static files to the original
  NetBird Dashboard, and forwards `/shirobird/` to ShiroBird.
- The upstream NPM configuration must continue to route `/api/`,
  `/oauth2/` and gRPC/WebSocket paths to NetBird. Do not use the bridge as
  a replacement for NetBird's complete external reverse-proxy configuration.
- The embedded ShiroBird frame allows only same-origin embedding; it uses
  a scoped HttpOnly Secure session cookie. Keep ShiroBird's source trusted.
- Port 8082 is an HTTP-only backend intended for a trusted reverse proxy,
  not direct public exposure.
