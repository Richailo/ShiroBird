# Traffic Flow: capabilities, sources and real limitations

ShiroBird Traffic Flow is an **independent, passive flow analytics system**. It does not access NetBird's licensed traffic-event receiver or modify NetBird's agents, firewall rules or VPN configuration.

## Implemented

- Linux conntrack NEW and DESTROY observations, plus source/destination, port, protocol and reporter sensor;
- independent per-host collectors, online/offline heartbeat and kernel counter-accounting diagnostics;
- time-windowed sessions grouped by sensor, protocol, source, destination and destination port;
- connection starts and ends, totals from completed conntrack sessions (when accounting is enabled);
- activity trend, top destinations, search by IP/NetBird peer name/port/sensor/protocol;
- optional peer names from a read-only `GET /api/peers` call made using the currently logged-in dashboard admin's existing OIDC session;
- real-time event stream, CSV/NDJSON download and SIEM export.

For peer identity enrichment, the NetBird dashboard session must have permissions to list peers. No personal access token is created or stored.

## Differences from NetBird Traffic Events

NetBird reports peer-side flow events, sometimes with reporter identity, flow direction, resource and policy IDs, an allowance and drop count. Linux conntrack by itself **cannot** determine whether a NetBird policy accepted or blocked a packet. ShiroBird deliberately reports `policy_decisions_available: false` and `drops_available: false`. The events named NEW and DESTROY are **not** policy-allow decisions.

A sensor only sees traffic traversing the Linux host where it runs. Running only on the management server cannot observe other peers' peer-to-peer VPN traffic. To obtain actual coverage, install sensors on the corresponding Linux peers and routing gateways. There is no Windows/macOS WFP/Network Extension sensor in this release.

## Linux byte counters

The dashboard shows whether the sensor reported kernel conntrack accounting. When disabled, do not interpret recorded byte counts of zero as evidence of zero traffic. Enabling accounting consumes kernel resources and should be an explicit operator decision. On a test sensor:

```bash
sysctl net.netfilter.nf_conntrack_acct
sudo sysctl -w net.netfilter.nf_conntrack_acct=1
```

This command adjusts a runtime Linux kernel setting and may affect resource use; it is **not applied by ShiroBird**. Existing conntrack entries may lack complete counters. Validate capacity and packet rates before enabling in production.

## Status and privacy

A 30-second authenticated heartbeat makes the collector visible without requiring flow events. Online means a heartbeat within 120 seconds, not proof that every VPN packet is captured. By default only packets whose source or destination is in `100.64.0.0/10` are sent; inspect `/etc/shirobird/collector.env` when your VPN uses other address families or resources. Traffic metadata can be sensitive; maintain appropriate network monitoring authorization, retention and access control.

## Further coverage

To match NetBird's full Traffic Events, ShiroBird would additionally need a drop-observation sensor at each receiving peer, per-direction packet/byte telemetry, verified policy/routing-resource context and platform-native Windows/macOS collectors. Those capabilities are **not implemented** and must not be advertised as installed or working.
