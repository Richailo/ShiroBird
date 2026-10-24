# ShiroBird native-flow extension (prepared, not activated)

Independent receiver for NetBird's publicly documented gRPC FlowService wire
protocol. This is a traffic-telemetry component, not an implementation of the
entire NetBird Enterprise product.

**The official ZS1 NetBird server and the deployed ShiroBird are unchanged.**
The user selected preparation only. Do not run this Compose file as an upgrade
of the existing production Compose project.

## What is ready

- Bidirectional /flow.FlowService/Events gRPC endpoint, initiator handshake,
  nonempty response headers and matching event acknowledgements.
- IPv4/IPv6, TCP/UDP ports, ICMP fields, resource/rule identifiers, direction,
  reporting peer, aggregation window and native starts/ends/drops/byte counters.
- SQLite WAL with synchronous FULL; ACK only after durable commit.
- Deduplication by authenticated reporter + event ID across retries and restarts.
  A reused ID with different content is rejected, not silently overwritten.
- Authenticated, paginated HTTP API and JSONL SIEM export.
- A self-contained container and protocol/integration tests.

This endpoint can accept P2P metadata reported by standard NetBird clients when
a compatible management service supplies the FlowConfig. It cannot remotely
observe P2P traffic which no peer reports, decrypt relay payloads, or enable
reporting by itself.

## Verified activation blocker

NetBird v0.81.3 clients implement flow collection and the public FlowService.
However the Community management dependency at
6e6b0cb01f2e implements ExtendNetBirdConfig as a no-op: it simply returns the
existing configuration. The Community combined config also has no trafficFlow
field. Adding a YAML property, changing the dashboard or starting a receiver
does not activate client reporting.

Sources:
- https://github.com/netbirdio/netbird/blob/v0.81.3/flow/proto/flow.proto
- https://github.com/netbirdio/netbird/blob/v0.81.3/flow/client/client.go
- https://github.com/netbirdio/netbird/blob/v0.81.3/client/internal/netflow/manager.go
- https://github.com/netbirdio/management-integrations/blob/6e6b0cb01f2e/integrations/config/config.go
- https://github.com/netbirdio/netbird/blob/v0.81.3/combined/cmd/config.go

Activation therefore needs either an authorized compatible management extension,
or a supported licensed deployment. Neither was installed or activated on ZS1.
This package does not claim compatibility with proprietary Enterprise credentials.

## Isolated tests

From this directory:

    docker build -t shirobird-native-flow:test .
    docker run --rm --network none shirobird-native-flow:test python -m unittest -v

Tests use a real local gRPC channel inside the isolated container, the vendored
upstream protocol and generated Python client. They are not an end-to-end test
with a live NetBird daemon or a remote P2P connection.

## Receiver runtime (opt-in, currently not deployed)

Create two independent random secrets, at least 32 characters each, in
flow-secret and api-token. Do not commit them. The flow secret belongs only to
a trusted management adapter and the receiver. The API token belongs only to
authorized server-side readers. Never deliver either secret to browsers or peers.

    docker compose -p shirobird-native-flow up -d --build

Both published ports bind only to loopback:
- 8084: internal gRPC (HTTP/2 h2c);
- 8085: read-only HTTP API (/healthz, /api/native/status, /api/native/flows,
  /api/native/export.ndjson).

For remote clients, a separately authorized TLS reverse-proxy configuration must
route /flow.FlowService/ to this receiver with gRPC/HTTP2 support. Plain HTTP must
never be exposed to the internet. WebSocket fallback is not implemented in this
package, so networks requiring NetBird's flow WebSocket transport are not covered.

API requests require Authorization: Bearer <api-token>. Flows are ordered by
database ID; use after=<next_cursor> and limit=1..1000 to page. NDJSON uses the
same pagination and includes the ID to use as the next cursor.

JSONL files are written daily to the data volume after the database commit.
If file export fails, pending records remain in SQLite and retry. A crash after
file fsync and before marking the row exported may duplicate a line: SIEM must
deduplicate on (reporter_id,event_id). No retention deletion is performed by this
prototype; provision storage and define retention before production use.
It is a single-account receiver. Multi-account isolation is not implemented.

## Management adapter contract (not installed)

A compatible adapter must supply proto.NetbirdConfig.Flow to each authenticated
peer through the existing encrypted Login/Sync path:

- url: public HTTPS receiver origin, not the internal loopback address;
- enabled: true only for explicitly selected peers/groups;
- interval: positive reporting interval (e.g. 60 seconds);
- counters: true only when enabled by the administrator;
- tokenPayload and tokenSignature: the ShiroBird per-peer token defined below.

The official client constructs Authorization as
"Bearer " + tokenSignature + "." + tokenPayload, so no client modifications
are needed. The adapter must refresh credentials before expiry and distribute
disabled FlowConfig on revocation. It must not alter routes, ACLs or peer keys.
The issue_token utility in receiver.py implements this token contract for tests;
it is not a public token-issuance endpoint.

Payload is base64url (without padding) of UTF-8 JSON:
{"v":1,"aud":"shirobird-native-flow","peer_id":"<registered-peer-id>","exp":<unix-seconds>}
Signature is standard base64 of HMAC-SHA256(secret, ASCII(tokenPayload)).
Tokens expire within 24 hours. Each incoming event checks expiry.
Reporter identity comes only from the verified token; the reported public_key is
retained as diagnostic peer-supplied data, never trusted to override identity.
A registered peer can misreport its own flow metadata; this is not independent
packet proof. Token revocation before expiry requires an additional denylist or
short token lifetime; no live revocation API is implemented yet.

## Counting and integration boundaries

Native fields are preserved as window aggregates: one record may mean five starts
and two drops. Do not turn each record into one conntrack NEW/DESTROY.
Each side can report the same P2P interaction, so totals across reporters can
double count network volume. Keep reporter perspectives separate.

The existing central conntrack collector is a separate source and can overlap
native observations. Do not add their byte totals together. This prepared module
has its own API/data volume. The optional compose.native-flow.yaml overlay connects
its read-only API to ShiroBird's authenticated /api/traffic/native endpoint and a
separate Native peer reports panel. API credentials stay server-side; native totals
are never added to conntrack totals. This integration is prepared on the branch,
not deployed in production.
Kernel-mode reporting still has NetBird's native limitations for policy IDs and
blocked events. Seeing a start does not prove successful connection completion.

The package includes upstream flow.proto under BSD-3-Clause; see NETBIRD-LICENSE.
No proprietary server code or license checks are copied or bypassed.

## Validation on ZS1 (isolated preparation)

12 receiver protocol/storage/auth/API tests and 46 ShiroBird tests passed.
JavaScript syntax and Python compilation passed. The receiver image was built
and exercised in a temporary --network none container with no production mounts
or published ports. Live remote-peer reporting remains untested and disabled.
