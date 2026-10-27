"use strict";
// All peer/report strings are rendered as text, never interpreted as HTML.
let eventRows = [], eventTotal = 0, eventOffset = 0, eventSnapshot = 0;
let eventSort = "time", eventOrder = "desc", eventRequest = 0, eventTimer;
let eventNow = Date.now();
const expandedEvents = new Set();
const eventProtocols = {6: "TCP", 17: "UDP", 1: "ICMP", 58: "ICMPv6"};
function node(tag, cls, text) {
  const element = document.createElement(tag);
  if (cls) element.className = cls;
  if (text !== undefined) element.textContent = String(text);
  return element;
}
function eventKind(row) {
  if (row.source_resource_id || row.destination_resource_id) return "Routed";
  if (peerByIP.has(row.src) && peerByIP.has(row.dst)) return "P2P";
  return "Connection";
}
function eventName(ip) { return peerByIP.get(ip)?.name || ip; }
function reporterName(row) { return peerByID.get(row.reporter_id)?.name || row.reporter_id; }
function eventState(row) {
  if (row.num_of_drops && (row.num_of_starts || row.num_of_ends)) return ["mixed", "Mixed activity"];
  if (row.num_of_drops) return ["blocked", "Blocked connection"];
  if (row.num_of_ends) return ["ended", "Connection ended"];
  if (row.num_of_starts) return ["started", row.direction === 1 ? "Connection received" : "Connection requested"];
  return ["ended", "Traffic reported"];
}
function peerCell(ip, port, protocol) {
  const cell = node("td");
  const peer = peerByIP.get(ip);
  const wrap = node("div", "event-peer");
  const os = String(peer?.os || "").toLowerCase();
  const symbol = /windows/.test(os) ? "⊞" : /darwin|mac|ios/.test(os) ? "●" : /android/.test(os) ? "A" : /linux/.test(os) ? "L" : "◎";
  const icon = node("span", "event-os", symbol);
  icon.title = peer?.os || (peer ? "Peer" : "Endpoint");
  icon.setAttribute("aria-label", icon.title);
  const label = node("div", "event-peer-label");
  const name = node("strong", "", peer?.name || ip);
  name.title = peer?.name || ip;
  const address = (ip.includes(":") ? "[" + ip + "]" : ip) + ([6, 17].includes(protocol) ? ":" + port : "");
  label.append(name, node("small", "", address));
  wrap.append(icon, label); cell.append(wrap);
  return cell;
}
function detailRow(row) {
  const tr = node("tr", "event-detail"), td = node("td"); td.colSpan = 7;
  const layout = node("div", "event-detail-layout"), timeline = node("div", "event-timeline");
  const point = (text, cls = "") => {
    const item = node("div", "event-timeline-item " + cls, text); timeline.append(item);
  };
  if (row.window_start != null) point("Window opened · " + date(row.window_start));
  if (row.num_of_starts) point(fmt(row.num_of_starts) + " connection start(s) reported", "started");
  if (row.rule_id) point("Reported rule · " + row.rule_id);
  if (row.num_of_drops) point(fmt(row.num_of_drops) + " blocked attempt(s) reported", "blocked");
  if (row.num_of_ends) point(fmt(row.num_of_ends) + " connection end(s) reported");
  if (row.window_end != null) point("Window closed · " + date(row.window_end));
  const facts = node("dl", "event-facts");
  for (const [key, value] of [
    ["Reporting peer", reporterName(row)],
    ["Direction", ({1: "Inbound", 2: "Outbound"})[row.direction] || "Unknown"],
    ["Received / sent packets", fmt(row.rx_packets) + " / " + fmt(row.tx_packets)],
    ["Rule", row.rule_id || "Not reported"],
    ["Source resource", row.source_resource_id || "—"],
    ["Destination resource", row.destination_resource_id || "—"],
    ["Received at", date(row.received)], ["Flow ID", row.flow_id], ["Event ID", row.event_id]
  ]) { const item = node("div"); item.append(node("dt", "", key), node("dd", "", value)); facts.append(item); }
  layout.append(timeline, facts); td.append(layout);
  td.append(node("p", "event-detail-note", "Counts describe this reporting peer’s aggregation window. Individual connection times and policy names are shown only when available. Separate peer perspectives are not combined."));
  tr.append(td); return tr;
}
function renderNative() {
  const fragment = document.createDocumentFragment();
  for (const row of eventRows) {
    const tr = node("tr", "event-row");
    const [state, label] = eventState(row);
    const time = node("td", "event-time");
    const timestamp = new Date(row.ts * 1000);
    time.append(node("span", "", timestamp.toLocaleDateString()), node("small", "", timestamp.toLocaleTimeString()));
    const event = node("td", "event-description");
    const toggle = node("button", "event-expand"); toggle.type = "button";
    toggle.setAttribute("aria-expanded", String(expandedEvents.has(row.id)));
    toggle.setAttribute("aria-label", label + ": " + eventName(row.src) + " to " + eventName(row.dst) + ". Show details");
    toggle.append(node("span", "event-dot " + state));
    const description = node("span");
    description.append(node("strong", "", label), node("small", "", eventKind(row) + " · " + eventName(row.src) + " → " + eventName(row.dst)));
    toggle.append(description, node("span", "event-chevron", expandedEvents.has(row.id) ? "⌃" : "⌄"));
    toggle.addEventListener("click", () => {
      if (expandedEvents.has(row.id)) expandedEvents.delete(row.id); else expandedEvents.add(row.id);
      renderNative();
      $("native-rows").querySelector('[data-event-id="' + row.id + '"]')?.focus();
    });
    toggle.dataset.eventId = row.id; event.append(toggle);
    const protocol = node("td", "event-protocol");
    protocol.append(node("span", "event-chip", eventProtocols[row.protocol] || "IP " + row.protocol));
    protocol.append(node("span", "event-chip", [6, 17].includes(row.protocol) ? row.dport : "Type " + row.icmp_type));
    const traffic = node("td", "event-traffic");
    traffic.append(node("span", "event-rx", "↓ " + humanBytes(row.rx_bytes)), node("span", "event-tx", "↑ " + humanBytes(row.tx_bytes)));
    traffic.title = "Received / sent from the reporting peer’s perspective";
    const router = node("td", "event-router", eventKind(row) === "Routed" && row.direction === 1 ? reporterName(row) : "—");
    router.title = "Reporting peer: " + reporterName(row);
    tr.append(time, event, peerCell(row.src, row.sport, row.protocol), protocol, peerCell(row.dst, row.dport, row.protocol), traffic, router);
    fragment.append(tr);
    if (expandedEvents.has(row.id)) fragment.append(detailRow(row));
  }
  if (!eventRows.length) {
    const empty = makeEmptyRow(7, "No traffic events in this view. Try a wider time range or reset the filters.");
    empty.className = "events-empty"; fragment.append(empty);
  }
  $("native-rows").replaceChildren(fragment);
  $("events-count").textContent = eventTotal ? `${fmt(eventOffset + 1)}–${fmt(eventOffset + eventRows.length)} of ${fmt(eventTotal)} reports` : "0 reports";
  $("events-prev").disabled = eventOffset === 0;
  $("events-next").disabled = eventOffset + eventRows.length >= eventTotal;
  $("events-export").disabled = !eventRows.length;
}
function eventQuery() {
  const query = new URLSearchParams({limit: $("events-size").value, offset: eventOffset, sort: eventSort, order: eventOrder});
  if (eventSnapshot) query.set("snapshot", eventSnapshot);
  const range = $("events-range").value;
  if (range === "custom") {
    for (const [key, id] of [["start", "events-from"], ["end", "events-to"]]) {
      if ($(id).value) query.set(key, Math.floor(new Date($(id).value).getTime() / 1000));
    }
    if (Number(query.get("start") || 0) > Number(query.get("end") || 1e12)) throw Error("Choose an end date after the start date.");
  } else if (Number(range)) query.set("start", Math.floor(eventNow / 1000 - Number(range) * 60));
  for (const field of ["protocol", "direction", "src", "dst", "event", "kind"]) {
    if ($("events-" + field).value) query.set(field, $("events-" + field).value.trim());
  }
  if ($("events-reporter").value) query.set("reporter_id", $("events-reporter").value);
  const search = $("events-search").value.trim();
  if (search) {
    query.set("q", search);
    for (const [ip, peer] of [...peerByIP].slice(0, 100)) {
      if (peer.name.toLowerCase().includes(search.toLowerCase())) query.append("match", ip);
    }
  }
  if (query.get("kind") === "p2p") {
    for (const ip of [...peerByIP.keys()].slice(0, 500)) query.append("peer_ip", ip);
  }
  return query;
}
async function refreshNative(reset = true) {
  const request = ++eventRequest;
  if (reset) { eventOffset = 0; eventSnapshot = 0; eventNow = Date.now(); expandedEvents.clear(); }
  $("events-refresh").disabled = true;
  $("native-table").setAttribute("aria-busy", "true");
  try {
    const data = await req("api/traffic/events?" + eventQuery());
    if (request !== eventRequest) return;
    if (!data.available) throw Error(data.configured ? "Traffic reports are temporarily unavailable. Try refreshing." : "Peer traffic reporting has not been configured.");
    eventRows = data.flows || []; eventTotal = data.total || 0; eventSnapshot = data.snapshot || 0;
    $("native-note").hidden = true;
    renderNative(); status("Connected", true);
  } catch (error) {
    if (request !== eventRequest) return;
    if (error.message === "Authentication required") throw error;
    $("native-note").textContent = error.message;
    $("native-note").hidden = false;
    eventRows = []; eventTotal = 0; renderNative();
  } finally {
    if (request === eventRequest) { $("events-refresh").disabled = false; $("native-table").setAttribute("aria-busy", "false"); }
  }
}
function updateEventPeers() {
  const selection = $("events-reporter").value;
  $("events-reporter").replaceChildren(new Option("All peers", ""));
  $("event-peers").replaceChildren();
  for (const [id, peer] of peerByID) $("events-reporter").append(new Option(peer.name, id));
  for (const [ip, peer] of peerByIP) $("event-peers").append(new Option(peer.name, ip));
  $("events-reporter").value = selection;
  if ($("events-kind").value === "p2p" || $("events-search").value) void refreshNative();
}
$("events-filter-toggle").addEventListener("click", () => {
  $("events-filters").hidden = !$("events-filters").hidden;
  $("events-filter-toggle").setAttribute("aria-expanded", String(!$("events-filters").hidden));
});
for (const field of ["range", "size", "event", "protocol", "kind", "direction", "src", "dst", "reporter", "from", "to"]) {
  $("events-" + field).addEventListener("change", () => {
    $("events-dates").hidden = $("events-range").value !== "custom";
    void refreshNative();
  });
}
$("events-search").addEventListener("input", () => { clearTimeout(eventTimer); eventTimer = setTimeout(() => refreshNative(), 300); });
$("events-refresh").addEventListener("click", () => refreshNative());
$("events-prev").addEventListener("click", () => { eventOffset = Math.max(0, eventOffset - Number($("events-size").value)); void refreshNative(false); });
$("events-next").addEventListener("click", () => { eventOffset += Number($("events-size").value); void refreshNative(false); });
$("events-reset").addEventListener("click", () => {
  for (const field of ["search", "event", "protocol", "kind", "direction", "src", "dst", "reporter", "from", "to"]) $("events-" + field).value = "";
  $("events-range").value = "2880"; $("events-dates").hidden = true;
  void refreshNative();
});
document.querySelectorAll("[data-event-sort]").forEach(button => button.addEventListener("click", () => {
  eventOrder = eventSort === button.dataset.eventSort && eventOrder === "desc" ? "asc" : "desc";
  eventSort = button.dataset.eventSort;
  document.querySelectorAll("[data-event-sort]").forEach(item => {
    const active = item === button;
    item.parentElement.setAttribute("aria-sort", active ? (eventOrder === "asc" ? "ascending" : "descending") : "none");
    item.textContent = item.textContent.replace(/[↕↑↓]$/, active ? (eventOrder === "asc" ? "↑" : "↓") : "↕");
  });
  void refreshNative();
}));
$("events-export").addEventListener("click", () => {
  const url = URL.createObjectURL(new Blob([eventRows.map(row => JSON.stringify(row)).join("\n") + "\n"], {type: "application/x-ndjson"}));
  const a = node("a"); a.href = url; a.download = "traffic-events-page.ndjson"; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
});
document.addEventListener("keydown", event => {
  if (page === "traffic-flow" && (event.ctrlKey || event.metaKey) && event.key === "k") { event.preventDefault(); $("events-search").focus(); }
});
