# Updating NetBird with the ShiroBird traffic adapter

Clients remain official NetBird clients. Their normal update mechanism is unchanged.
The management server uses an official release's runtime and source, with the small
ShiroBird flow-config adapter applied. A new upstream version must pass the update
pipeline before replacing the running service.

On ZS1, as the administrator:

    python3 /opt/shirobird/extensions/management-adapter/update.py 0.81.3

Replace the example version with the desired published NetBird version. Use
`--build-only` to prepare and test an image without deploying it. No periodic update
job is installed; an explicit version prevents an unexpected unattended upgrade.

The pipeline:

1. Pulls the versioned official server image and pins its local image ID.
2. Verifies the binary's embedded release version and clean source revision.
3. Downloads that exact public source revision and records the archive hash.
4. Checks the native wire schema and all three management integration anchors.
5. Builds with the upstream Go toolchain, runs race/unit checks, compiles management,
   and tests the official flow client against the receiver.
6. Builds on the same official runtime and checks that the binary starts.
7. Verifies the public receiver's TLS/gRPC endpoint and authentication, then starts
   management on an isolated copy of the current database, without external networking.
8. Briefly pauses the current process to snapshot the complete SQLite volume,
   resumes it, and replaces only the management service. Failed health checks
   restore the previous image and database; failed-attempt data is retained.

A changed protocol, changed integration hook, failed test, incompatible runtime,
or unhealthy receiver stops the update before replacement. This makes compatible
upstream updates repeatable; it cannot guarantee compatibility with every future
NetBird release. Such changes require adapting the extension and rerunning tests.

The managed `/opt/netbird/docker-compose.override.yml` pins the tested custom image,
disables automatic pulling of that image and opts it out of Watchtower. Ordinary
Compose operations therefore preserve the adapter. Use `update.py` for management
updates; explicitly bypassing the override with a different Compose command can
replace the adapter with the original Community server and disable reporting.
The official dashboard and client update paths remain separate.

Release manifests and build logs are under `/opt/shirobird/releases`. Each deployed
release records the private backup directory in `deployment.json`. Manual rollback:

    python3 /opt/shirobird/extensions/management-adapter/rollout.py --rollback /opt/netbird/shirobird-backups/<recorded-backup>

Rollback restores the recorded database snapshot and preserves data written during
the failed/new deployment separately. It is not a merge of old and new databases.
Never delete the recorded prior image or snapshot before accepting an upgrade.

Receiver configuration and signing secrets remain outside upstream source in
`/etc/shirobird`. The NPM route is stored in the selected host's `advanced_config`
as well as its generated file, so NPM regeneration preserves it. `configure_npm.py`
validates Nginx, keeps a private backup and restores the original configuration on
failure. It changes only `/flow.FlowService/` for the explicitly selected domain.

The current receiver supports native gRPC over TLS. WebSocket fallback, instantaneous
credential revocation and multi-account isolation are not implemented. Reporting
requires a connected, supported client; direct P2P is observed through peer reports,
not by forcing traffic through ZS1. Platform-specific native collection limits and
possible overlap between reporter perspectives still apply.
