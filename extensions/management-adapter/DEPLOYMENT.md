# ZS1 deployment — 2026-10-25

The user approved replacing the official management image with a compatible custom
build and requested a maintained update path. The current deployment uses NetBird
0.81.3, official revision f47ace7d52a182d2ee75e6d821c26260e601c89e, with the ShiroBird
FlowConfig adapter. Existing clients were not modified or given extra software.

- Management: `shirobird/netbird-server:0.81.3-40807aa9c8520e2c`.
- Receiver: `shirobird/native-flow:40807aa9c8520e2c`.
- Release manifest: `/opt/shirobird/releases/netbird-0.81.3-20261025T204250Z/manifest.json`.
- Native reporting selection: the existing All group; 30-second aggregation interval.
- Public receiver: `https://velora.novaris.osamu.eu`, native `/flow.FlowService/` RPC path.
- NPM-ZS1 host 15 routes that path to the private ZS1 gRPC listener. The API remains
  loopback/container-network only and requires a separate server-side credential.
- ShiroBird displays native reports separately from central conntrack observations.

The standard ZS1 daemon logged receipt of the new flow endpoint and started its
native conntrack listener. Management and signal reconnected. Authenticated receiver
access from the ShiroBird container succeeded; unauthenticated dashboard/API access
returned 401. Public TLS/gRPC refused an unauthenticated stream as expected.

## Actual P2P validation

The isolated test used two unmodified official NetBird 0.81.3 Docker clients,
a separate management database copy, a separate receiver and a temporary internal
Docker network. Production peers, policies and routes were not changed by the test.
Both clients reported **Connected / P2P**, with host/server-reflexive ICE candidates,
before HTTP traffic was generated. The transfer succeeded and the receiver stored
two native start records, one from each peer. This proves native reporting of a
direct exchange; it is not just a hand-written protobuf fixture or a relay transfer.

Evidence: `/opt/shirobird/work/shirobird-lab-024f9640/result.json` and `peer-status.json`.
The observed records were start events with zero byte counters; this run does not
claim validation of completed-flow byte totals. Counter serialization and aggregate
preservation are separately covered by protocol tests. All temporary containers and
the laboratory network were removed. Laboratory records were not inserted into the
production database or SIEM export.

At deployment, ZS1 was the only connected production peer and the other four
registered peers were offline. Production reports appear when supported peers
connect and generate traffic. Reporting does not bypass existing access policies.

## Preservation and recovery

Comparison with the management backup confirmed unchanged routes, policies,
policy rules, networks, resources, routing peers and the original NetBird YAML.
The original dashboard image was preserved. Docker's default Compose invocation
selects the tested management override with pull policy `never`.

- Management rollback: `/opt/netbird/shirobird-backups/20261025T204851Z`.
- ShiroBird application backup: `/opt/shirobird/backups/native-activation-20261025T204833Z`.
- NPM database/config backup: `/data/shirobird-backups/20261025T204847Z` on NPM-ZS1.

Use the commands in [UPDATES.md](UPDATES.md) for future upstream updates and rollback.
The update path verifies upstream version/revision, checks integration anchors and
wire schema, runs tests, checks runtime startup on an isolated database copy, keeps
a consistent pre-upgrade snapshot and restores it if post-upgrade health fails.
