# Central Traffic Flow without client changes

Run ShiroBird's collector only on the Linux NetBird routing peer. No WFP tasks,
audit-policy changes or additional software are required on client machines.

```bash
sudo apt-get install -y conntrack
sudo SHIROBIRD_ENABLE_ACCOUNTING=1 bash scripts/install-collector.sh
```

The collector detects IPv4 and IPv6 overlay networks from `wt0`. Override
`SHIROBIRD_INTERFACE` for a renamed interface or `SHIROBIRD_NETWORKS` for explicit
comma-separated CIDRs in `/etc/shirobird/collector.env`. On upgrades the installer
preserves this file. Older installs with a hardcoded IPv4-only range should set
`SHIROBIRD_NETWORKS=auto` and restart `shirobird-collector`.
Missing overlay interfaces fail closed; the collector retries discovery.
After changing overlay addresses on a running interface, restart the collector.

## What is observed

- Conntrack NEW and DESTROY metadata for locally originated, terminated or
  forwarded traffic whose original source or destination matches the overlay.
- Original source/destination tuples before SNAT; TCP/UDP ports, protocol,
  event time, and both-direction packet/byte totals on completed sessions.
- Heartbeats distinguish an online reporter from an unavailable capture process,
  and expose the actual CIDR filter. Capture readiness is process availability,
  not proof that every possible packet is tracked.
- Ingest retries use stable event references to prevent duplicate database counts.

## What is outside coverage

Direct P2P between other peers bypasses the routing server. A management server
does not receive that traffic; a relay carries encrypted packets. Neither role
provides decrypted connection metadata for those paths.

This is conntrack observation, not NetBird Traffic Events parity: it cannot prove
a NetBird policy verdict, policy ID, blocked-packet count, client application,
or successful delivery. Untracked traffic is absent. Connections already active
when collection starts have no recorded start. Byte counters apply only to
connections created after accounting is enabled and appear after expiration.
A zero counter is not proof of no traffic. Kernel event loss, collector restart,
a full queue or a host failure can lose events; this is not a durable audit feed.

Existing optional WFP code remains supported, but is not part of central setup.
Unavailable WFP statistics are displayed as N/A, not evidence of zero blocks.

## Native NetBird mechanisms verified

NetBird documents Traffic Events for Cloud Business and licensed self-hosted
Enterprise, with events reported by the standard NetBird peers. The Enterprise
server path requires a flow receiver/enricher and backing services; the community
management audit-events endpoint is not a flow API.
Sources:
- https://docs.netbird.io/manage/activity/traffic-events-logging
- https://docs.netbird.io/selfhosted/maintenance/scaling/high-availability
- https://github.com/netbirdio/netbird/blob/v0.81.3/management/server/http/handlers/events/events_handler.go

## ZS1 deployment verification (2026-10-24)

- NetBird client 0.81.3, kernel interface `wt0`, IPv4 forwarding already enabled.
- Overlay filters: `100.64.0.0/16`, `fdba:3a54:ee71:306b::/64`.
- Advertised resources: `192.168.0.0/24`, `192.168.0.125/32`,
  `192.168.0.20/32`, and `192.168.{104,106,108,109,111,117,118,119}.24/32`.
  Existing NetBird nftables forwarding and masquerade rules confirm router setup.
  The CLI's "networks list" shows no consumed routes; this is different from the
  routing peer's advertised resources.
- Combined community `netbird-server` and dashboard are running; no flow
  receiver/enricher containers or trafficFlow config block were present.
  Local GET `/api/events/traffic` returned 404 while `/api/peers` returned 401.
  No native traffic API was available in this deployment.
- Parser fixed against actual `[NEW] ipv4 2 udp ...` output, previously ignored.
- Accounting changed from 0 to 1; persisted only in ShiroBird's sysctl file.
- No clients changed, no NetBird routes or policy-routing rules changed, and no\n  NetBird containers restarted. Docker recreated ShiroBird virtual interfaces\n  and their automatic IPv6 link-local routes during the container rebuild.\n- All 41 Python tests passed; JavaScript and installer syntax checks passed.
- A real local UDP self-test from the server's overlay address confirms capture,
  authenticated ingestion and JSONL export. IPv4 NEW and DESTROY were observed\n  with 67 bytes / 1 packet; a separate IPv6 packet produced NEW. These are local\n  self-tests, not remote-client tests.
  At inspection time 0/4 peers were connected; routed client-to-resource
  end-to-end coverage remains unverified until a peer generates traffic.

## Rollback on ZS1

The pre-change files and consistent SQLite backup are in
`/opt/shirobird/backups/central-observation-20261024` (root-only).
Restore the collector, web and server files from that directory, rebuild only
the ShiroBird container, restore `collector.env` and the installed collector,
then restart `shirobird-collector`. The added database column is backwards
compatible; do not restore the database unless intentionally discarding new data.

To undo accounting enabled by this deployment, remove only
`/etc/sysctl.d/90-shirobird-accounting.conf` and run
`sysctl -w net.netfilter.nf_conntrack_acct=0`. Existing counters may remain until
their connections expire. Do not change NetBird routing or firewall rules.
