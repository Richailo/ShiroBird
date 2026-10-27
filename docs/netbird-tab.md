# Add ShiroBird to the native NetBird Dashboard

No NetBird container or client patches. ShiroBird's sidecar Nginx bridge injects a small navigation extension into the original NetBird Dashboard HTML. It observes the actual NetBird sidebar buttons and displays a dark/light-theme-matched monitoring view alongside native pages.

## Quick installation

```bash
git clone https://github.com/Richailo/ShiroBird.git
cd ShiroBird
sudo bash scripts/install.sh
```

ShiroBird automatically detects a running `netbird-dashboard`, configures Docker networking, generates its internal secrets and starts the bridge on **8082**.

Then change only the **Dashboard HTTP upstream 8080 to 8082** in the existing reverse proxy. Do not change NetBird API, gRPC, OAuth2, Signal or Relay routes (usually pointing to 8081 in combined NetBird). If the reverse proxy runs on another host, add `SHIROBIRD_BRIDGE_BIND=PRIVATE_LAN_IP` to ShiroBird's `.env` and run `sudo bash scripts/install.sh` again. Limit incoming TCP 8082 to that proxy; HTTPS must be enabled on the public reverse proxy.

## Login and authorization

NetBird users first log into the standard NetBird Dashboard. Clicking **ShiroBird** reuses the current OIDC access token from `oidc.default` in the *dashboard's* session storage. The browser sends it **only to the same-origin** `/shirobird/api/netbird-session` endpoint. ShiroBird then validates it directly through NetBird's private `/api/users/current` API. Only active, unblocked **Owner/Admin** accounts are allowed; all other roles receive 403. The user gets an HttpOnly, Secure, SameSite=Strict cookie scoped to `/shirobird/` with a 3-minute lifetime, automatically refreshed while the tab is open. NetBird's original access token is never stored by ShiroBird.

There is **no second login screen or manual ShiroBird token** in integrated mode. The randomly generated administrator secret is used internally only as a cookie-signing key. A NetBird session that disappears causes ShiroBird to deny future session refreshes. Existing short-lived ShiroBird cookies remain valid until expiry (max 3 minutes). For single sign-out across both panels, terminate the authenticated NetBird session and wait for session expiration.

## Verification

```bash
docker compose ps
curl -fsS http://127.0.0.1:8082/shirobird/healthz
curl -fsS http://127.0.0.1:8082/ | grep 'shirobird-integration/bridge.js'
```

Use the configured private bridge IP instead of loopback if needed.

## Updates

Run `git pull --ff-only && sudo bash scripts/install.sh`. NetBird can be upgraded separately. Sidebar adapter selectors could require adaptation if a future NetBird Dashboard changes its navigation internals. GitHub Actions runs a smoke test for the bridge against a mock dashboard.

## Rollback

1. Change the dashboard proxy upstream **8082 → 8080** and verify the original NetBird dashboard works.
2. `sudo docker compose stop shirobird-bridge`
3. `sudo docker compose rm -f shirobird-bridge`
4. Remove only the `compose.override.yaml` symlink (not an unrelated pre-existing override).
5. Run `sudo docker compose -f compose.yaml up -d` for optional standalone ShiroBird.

This never modifies official NetBird server/client files.
