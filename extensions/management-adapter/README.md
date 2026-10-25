# ShiroBird management adapter — source preparation only

This optional adapter prepares NetBird **v0.81.3** to distribute the independent
ShiroBird flow receiver configuration to selected peers. It is part of the
ShiroBird traffic-events extension, not a replacement for every Enterprise feature.

**Not deployed.** The official ZS1 management image, client daemon, routes and
production ShiroBird are unchanged by this preparation. The adapter is a source
integration, not a dynamically loadable Community plugin. Using it in production
would require a separately approved custom management build or another supported
management integration. Running the receiver alone cannot activate P2P reporting.

## Implemented control path

The preparation script adds calls after the public management integration hook in:

- initial full Sync responses, including the components-envelope response;
- existing TURN/relay credential refresh responses.

The adapter clones the existing protobuf before adding FlowConfig, preserving
relay credentials and every other field. A nil map-only configuration stays nil:
creating a partial nonnil config there can reset the client's relay URLs.

No environment variable means an exact no-op. Set SHIROBIRD_FLOW_CONFIG_FILE only
in an isolated custom management build. The file schema is config.example.json;
the checked-in example is disabled. Enabling requires explicit peer_ids and/or
group_ids, an HTTPS receiver origin, a 10–600 second interval, and a shared signing
secret file of at least 32 bytes. Selection is an OR across peer and group IDs.
counters controls the native byte/packet option. Exit-node and DNS collection
flags remain false.

The secret is shared only by the receiver and trusted management process. Each
selected peer gets a signed, audience-bound credential containing its own peer ID,
never the signing secret. This uses ShiroBird's credential contract, not proprietary
Enterprise credentials. Tokens last at most 24 hours and are stable within five
minute windows to avoid unnecessary sender reconnects.

Renewal uses NetBird's existing relay refresh scheduler. A configured adapter
therefore requires a relay credential TTL greater than zero and at most 16 hours:
refresh occurs at 75% of that TTL, at most every 12 hours. The common 12-hour relay
TTL gives a 9-hour refresh. Startup rejects configurations without that renewal
path. This requirement also applies to a disabled configuration file, since the
file may subsequently be enabled.

Config and secret files are reread on each applicable response. Invalid runtime
configuration disables telemetry in that response. It does not change routes or
ACLs. Changing selection or disabling the file is **not immediate revocation**:
connected peers receive it at their next full Sync/credential response. Previously
issued tokens remain valid until expiry; no denylist is implemented. Peer-group
changes have the same propagation delay. Plan rotation and activation accordingly.

## Reproducible isolated validation

Use a disposable checkout, never the running installation. Download:

    https://codeload.github.com/netbirdio/netbird/tar.gz/refs/tags/v0.81.3

Verify SHA-256 before extraction:

    a06c0c3ffc84a78a5ee019641988cfe0ea38ea980609535f66dd4ae82929daed

prepare.py verifies the exact hashes of all three upstream files before writing
anything. Unsupported or already-patched source is rejected. It copies only the
adapter package and adds the three integration hooks.

    python3 prepare.py --source-dir /path/to/disposable/netbird-0.81.3

In the disposable upstream directory, using Go 1.26.7:

    gofmt -w management/server/shirobirdflow/*.go \
      management/internals/shared/grpc/conversion.go \
      management/internals/shared/grpc/components_envelope_response.go \
      management/internals/shared/grpc/token_mgr.go
    SHIROBIRD_TEST_TOKEN_OUTPUT="$PWD/adapter-test-token.json" \
      go test -race ./management/server/shirobirdflow
    go test -run '^$' ./management/internals/shared/grpc

The last command compiles the actual management integration and its tests without
running upstream integration suites that require external services.

The cross-language probe imports the **unmodified upstream flow/client library**.
Copy native_client_probe.go to flow/shirobirdcompat/main.go in that same checkout,
then build it:

    CGO_ENABLED=0 go build -o native-client-probe ./flow/shirobirdcompat

Build the independent receiver image from ../native-flow. Run verify_receiver.py
inside that image with PYTHONPATH=/app and read-only mounts for this directory,
the binary, and the generated synthetic test-token file:

    python /checks/verify_receiver.py /fixtures/native-client-probe /fixtures/adapter-test-token.json

Use --network none and no published ports. The script starts its receiver on
loopback inside the container. It verifies Go-issued credentials, the official
client's handshake, aggregate counters, duplicate retry ACK, durable SQLite record,
and SIEM export. The fixture secret is public test data; do not use it in production.

test_prepare.py additionally checks source-version guards and repeat-apply safety.
Set SHIROBIRD_NETBIRD_ARCHIVE to the verified archive when running that suite.
The GitHub workflow automates these checks.

## Coverage and remaining activation boundary

The wire test generates synthetic metadata using the official client transport.
It does **not** start a NetBird daemon, capture real peer traffic, establish a P2P
tunnel or test public TLS/reverse-proxy traversal. Those deployment checks remain
outstanding under the user's preparation-only decision.

Native metadata can describe a direct P2P exchange when a reporting peer collects
it. It cannot reveal traffic of peers that do not report, decrypt arbitrary relay
payloads, or remove platform-specific collection limitations. Reports from both
ends can overlap; keep reporter perspectives and central conntrack data separate.

The receiver still needs operational retention, revocation, capacity and TLS
decisions before any future production activation; see ../native-flow/README.md.
WebSocket flow fallback and multi-account isolation are not implemented.

This source integration targets AGPL-3.0-only NetBird management code; its new Go
files carry the same identifier and the upstream management LICENSE is included.
No proprietary implementation or license checks are copied or changed.
