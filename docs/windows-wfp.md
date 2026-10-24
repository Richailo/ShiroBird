# Windows WFP sensor for ShiroBird

This is a **separate, optional** Windows Security event collector. It does not patch NetBird, the WireGuard driver, Windows Firewall rules, or NetBird policies.

## What it captures

- **5156**: connection permitted by Windows Filtering Platform (WFP)
- **5157**: connection blocked by WFP
- **5152**: individual packet dropped by WFP

ShiroBird labels these records as **Windows WFP**, not as confirmed NetBird policy decisions. Where available it preserves the process path, connection direction, timestamp, source and destination, protocol, port, Windows filter runtime ID and Security event record ID. A runtime filter ID is **not** a NetBird access-policy ID.

The default CIDR filter is `100.64.0.0/10`; pass additional NetBird IPv6 prefixes and routed resource CIDRs where authorized. Monitoring is performed on the **Windows peer itself**, not on the management server.

## Before installation

1. Install and connect the official NetBird client independently.
2. Ensure that this Windows host can reach the ShiroBird ingest endpoint over HTTPS, e.g. `https://your-netbird-domain/shirobird`. Keep TLS certificate checks on.
3. Retrieve the collector ingestion secret securely from the Linux ShiroBird host's protected `.env` (variable `SHIROBIRD_INGEST_TOKEN`). Treat it as a sensitive service credential.
4. Choose which Windows auditing categories, if any, you permit. **Failure-only** WFP connection auditing produces less data than auditing successful connections. Microsoft warns success auditing has **high event volume**, potentially one event per connection.

Run PowerShell **as Administrator** from the cloned repository:

```powershell
cd .\ShiroBird\windows
.\install.ps1 -ServerUrl "https://your-netbird-domain/shirobird" -EnableBlockedConnectionAudit
```

The installer asks for the token through a hidden prompt. It stores it beneath `C:\ProgramData\ShiroBird` with access restricted to SYSTEM and Administrators, registers an auto-start task running under SYSTEM, and starts monitoring. It does **not** enable success or packet-drop auditing unless explicitly requested.

To include permitted connections, add `-EnableAllowedConnectionAudit`. To collect 5152 packet drops, add `-EnablePacketDropAudit`. Both can be extremely high-volume; test in a small pilot and check Security log throughput/disk retention before broader rollout. The installer only enables audit categories you explicitly choose; it does not disable other existing audit settings.

On a network using a custom IPv6 overlay range, supply both CIDRs:

```powershell
.\install.ps1 -ServerUrl "https://your-netbird-domain/shirobird" `
  -Networks @("100.64.0.0/10","fdba:3a54::/32") -EnableBlockedConnectionAudit
```

Audit settings may be overridden by domain Group Policy.

## Operation

- Task Scheduler task name: `ShiroBird WFP Collector`.
- Collector files: `C:\ProgramData\ShiroBird`.
- Server-side status: **ShiroBird → Traffic Flow → Collector coverage**.
- Heartbeat every 30 seconds; online threshold 120 seconds.
- Per-connection events include a stable Windows `EventRecordID`. The server deduplicates retries by sensor, source and record reference.
- The collector starts at the **current** Security log position on its first run, not by uploading the entire historical log. The cursor is stored locally for subsequent runs.
- Windows logs provide **no connection byte counters** in these events. No packet contents or URLs are captured.
- If delivery fails, the agent retries from the stored cursor; events can still be lost if Windows rolls over the Security log during a prolonged outage. Monitor log size and audit volume.

### Testing

The source includes independent Windows runner tests:

```powershell
.\test.ps1
```

Check the Security log and Task Scheduler for permissions, audit configuration and running state. On the ShiroBird server, check that a Windows collector is online and the event source is `windows_wfp`.

## Disabling

Stop/disable the scheduled task, remove the directory after preserving any needed local state and revoke/rotate the shared ingestion secret when appropriate. **Do not blindly disable Windows audit categories**: they may be configured by existing security policies and shared with other monitoring systems.

## Limitations

A 5157 firewall block is not proof that the official NetBird client or a specific NetBird access policy blocked the connection. NetBird-enforced drops may not appear as ordinary Windows Security audit events, depending on which WFP layer and component implements enforcement. Matching NetBird's enterprise traffic-event semantics exactly requires peer-side NetBird policy/flow instrumentation, not mere event-log correlation.
