# Traffic Flow

The primary screen presents native peer reports in a compact Traffic Events table.
Server conntrack observations, WFP information, charts and raw server exports remain
available under the collapsed **Server observation & diagnostics** section. They are
not added to native traffic totals. Diagnostics are loaded only when opened.

The table supports search by address, port, peer name and reported identifiers;
time presets and a custom date range; source and destination address filters;
protocol, direction, event-count, reporting-peer and flow-type filters; sorting;
25/50/100-row pages; and NDJSON export of the displayed page. Filtering and sorting
run against stored native history, not just the browser's current page. Pagination
keeps a maximum database ID until refresh so new arrivals do not shift pages.

Click an event to inspect its aggregation window, start/end/drop counts, separate
received/sent bytes and packets, reporting peer, rule/resource IDs and receipt time.
The timeline represents aggregate counts, not invented individual timestamps.
Mixed accepted/blocked activity is explicitly labelled. A source-side request does
not prove that the remote peer allowed it. Separate reporter perspectives remain
separate records.

Peer names and operating-system labels come from the authenticated parent NetBird
dashboard. Without that directory, addresses remain visible and P2P classification
is unavailable. P2P requires both endpoints in the directory and no resource ID;
routed-resource classification requires a reported resource ID. Unknown flows are
not guessed. This classification does not claim whether transport used ICE or relay.
Rule IDs are shown as reported; policy names, user names and geographic flags are
not fabricated. Export is explicitly page-only. Native retention and SIEM delivery
are separate capabilities, not implied by this UI.

The receiver's new authenticated `/api/native/events` endpoint is read-only. The
legacy cursor API and durable ingest/acknowledgment path are unchanged. UI/API
upgrades require only the ShiroBird app and receiver to restart, not management,
clients, proxy routing or network policies.
