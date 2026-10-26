"use strict";
const $ = id => document.getElementById(id);
const query = new URLSearchParams(location.search);
const embedded = query.has("embedded");
// The parent frame passes its active theme in the URL, avoiding an initial
// light-mode flash before the first postMessage is received.
const initialTheme = query.get("theme");
if (embedded && (initialTheme === "dark" || initialTheme === "light")) {
  document.documentElement.classList.toggle("dark", initialTheme === "dark");
  document.documentElement.classList.toggle("light", initialTheme === "light");
}
const page = query.get("view") === "siem-integration" ? "siem-integration" : "traffic-flow";
document.body.classList.toggle("embedded", embedded);
document.body.dataset.view = page;
$("traffic-view").hidden = page !== "traffic-flow";
$("siem-view").hidden = page !== "siem-integration";

const NETBIRD_THEME_KEYS = new Set([
  "--page", "--surface", "--field", "--sidebar", "--muted", "--text",
  "--stroke", "--hover", "--primary", "--soft", "--accent", "--table-head",
  "--button-secondary", "--input-border", "--placeholder", "--success", "--danger"
]);
window.addEventListener("message", event => {
  if (event.origin !== location.origin || !event.data || event.data.source !== "shirobird-theme") return;
  const dark = event.data.dark === true;
  document.documentElement.classList.toggle("dark", dark);
  document.documentElement.classList.toggle("light", !dark);
  // Accept only the same-origin parent and a fixed list of hex-only colors.
  // Do not allow arbitrary injected CSS declarations through postMessage.
  if (event.source !== window.parent || !event.data.palette || typeof event.data.palette !== "object")
    return;
  for (const [name, value] of Object.entries(event.data.palette)) {
    if (NETBIRD_THEME_KEYS.has(name) && typeof value === "string" &&
        /^#[0-9a-f]{3,8}$/i.test(value)) {
      document.documentElement.style.setProperty(name, value);
    }
  }
});

let flows = [], stream = null, lastId = 0;
const fmt = value => Number(value || 0).toLocaleString();
const date = ts => ts ? new Date(ts * 1000).toLocaleString() : "—";
function status(value, live = false) {
  $("connection").textContent = value;
  $("connection").className = live ? "status live" : "status";
}
function showLogin() {
  $("auth").classList.remove("hidden");
  if (embedded) {
    $("form").hidden = true;
    $("auth").dataset.netbird = "1";
    status("Waiting for NetBird authentication");
  } else status("Sign in required");
  if (stream) stream.close();
  stream = null;
}
async function req(url, options = {}) {
  const result = await fetch(url, {credentials:"same-origin", cache:"no-store", ...options});
  if (result.status === 401) {
    showLogin();
    throw Error("Authentication required");
  }
  if (!result.ok) throw Error("HTTP " + result.status);
  return result.json();
}

// Optional metadata is received from the logged-in NetBird parent's /api/peers.
let peerByIP = new Map();
let flowSnapshot = null;
function endpoint(ip) {
  const peer = peerByIP.get(ip);
  return peer && peer.name ? peer.name + " (" + ip + ")" : ip;
}
function humanBytes(value) {
  const bytes = Number(value || 0);
  if (bytes < 1024) return fmt(bytes) + " B";
  const unit = ["KB", "MB", "GB", "TB"];
  const idx = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)) - 1, 3);
  return (bytes / 1024 ** (idx + 1)).toFixed(1) + " " + unit[idx];
}
function makeEmptyRow(columns, label) {
  const tr = document.createElement("tr");
  const td = document.createElement("td");
  td.colSpan = columns;
  td.textContent = label;
  tr.append(td);
  return tr;
}
function groupMatches(row, filter, protocol) {
  if (protocol && row.proto !== protocol) return false;
  if (!filter) return true;
  return [row.src, row.dst, row.proto, row.sensor, row.dport,
    row.source, row.direction, row.application, row.filter_id,
    peerByIP.get(row.src)?.name, peerByIP.get(row.dst)?.name]
    .some(part => String(part || "").toLowerCase().includes(filter));
}
function renderAnalytics() {
  if (!flowSnapshot || page !== "traffic-flow") return;
  const proto = $("flow-protocol").value;
  const filter = $("flow-search").value.trim().toLowerCase();
  const rows = flowSnapshot.flows.filter(row => groupMatches(row, filter, proto));
  const nodes = document.createDocumentFragment();
  for (const item of rows) {
    const tr = document.createElement("tr");
    const values = [
      date(item.last_seen), endpoint(item.src), endpoint(item.dst),
      item.dport || "—", item.proto.toUpperCase(), item.sensor,
      item.source === "windows_wfp" ? "Windows WFP" : "Linux conntrack",
      item.direction || "unknown",
      [item.application, item.filter_id ? "filter #" + item.filter_id : ""].filter(Boolean).join(" · ") || "—",
      fmt(item.starts), fmt(item.allows || 0), fmt(item.blocks || 0),
      fmt(item.drops || 0), fmt(item.ends), humanBytes(item.bytes)
    ];
    for (const value of values) {
      const td = document.createElement("td");
      td.textContent = String(value);
      tr.append(td);
    }
    nodes.append(tr);
  }
  if (!rows.length) nodes.append(makeEmptyRow(15, "No observed traffic for these filters"));
  $("flow-groups").replaceChildren(nodes);
  const dest = document.createDocumentFragment();
  const filtered = flowSnapshot.destinations.filter(row => groupMatches({
    ...row, src: "", sensor: ""}, filter, proto));
  const maximum = Math.max(1, ...filtered.map(item => item.starts));
  for (const item of filtered.slice(0, 12)) {
    const line = document.createElement("div");
    line.className = "flow-top-line";
    const label = document.createElement("span");
    label.textContent = endpoint(item.dst) + ":" + item.dport + " / " + item.proto.toUpperCase();
    const count = document.createElement("strong");
    count.textContent = fmt(item.starts);
    const bar = document.createElement("div");
    bar.className = "flow-top-bar";
    const inner = document.createElement("i");
    inner.style.width = (100 * item.starts / maximum).toFixed(2) + "%";
    bar.append(inner);
    line.append(label, count, bar);
    dest.append(line);
  }
  if (!filtered.length) {
    const p = document.createElement("p");
    p.textContent = "No destinations in this period";
    dest.append(p);
  }
  $("flow-top").replaceChildren(dest);
  const bars = document.createDocumentFragment();
  const maxCount = Math.max(1, ...flowSnapshot.trend.map(x => x.starts));
  for (const item of flowSnapshot.trend) {
    const bar = document.createElement("div");
    bar.className = "flow-trend-bar";
    bar.title = date(item.bucket) + " · starts " + item.starts + " · ends " + item.ends;
    bar.style.height = Math.max(3, 100 * item.starts / maxCount) + "%";
    const text = document.createElement("span");
    text.textContent = String(item.starts);
    bar.append(text);
    bars.append(bar);
  }
  if (!flowSnapshot.trend.length) {
    const hint = document.createElement("p");
    hint.textContent = "No observed starts in this period";
    bars.append(hint);
  }
  $("flow-trend").replaceChildren(bars);
}
function renderSensors(data) {
  const list = data.sensors || [];
  const online = list.filter(sensor => sensor.online).length;
  $("flow-sensor-count").textContent = online + " online / " + list.length + " registered";
  const fragment = document.createDocumentFragment();
  for (const item of list) {
    const row = document.createElement("div");
    row.className = "flow-sensor";
    const name = document.createElement("strong");
    name.textContent = item.name;
    const state = document.createElement("span");
    state.className = "flow-sensor-state" + (item.online ? " ready" : "");
    state.textContent = item.online ? "Online" : "Offline";
    const accounting = document.createElement("span");
    accounting.textContent = item.source === "windows_wfp" ?
      "Windows WFP audit (no byte counters)" :
      (item.accounting_enabled ? "Linux kernel byte accounting enabled" :
       "Linux kernel byte accounting disabled");
    accounting.className = "flow-sensor-hint";
    const seen = document.createElement("small");
    seen.textContent = "Last heartbeat: " + date(item.last_seen);
    const coverage = document.createElement("small");
    if (item.coverage?.scope === "local_and_routed") {
      coverage.textContent = "Local/routed observation · " +
        (item.coverage.networks.join(", ") || "no overlay detected");
      if (item.online && (!item.coverage.capture_ready || !item.coverage.networks.length)) {
        state.textContent = "Capture unavailable";
        state.className = "flow-sensor-state";
      }
    }
    row.append(name, state, accounting, coverage, seen);
    fragment.append(row);
  }
  if (!list.length) {
    const message = document.createElement("p");
    message.textContent = "No central collector has reported yet. Check the collector service on the NetBird routing server.";
    fragment.append(message);
  }
  $("flow-sensor-list").replaceChildren(fragment);
}
let nativeCursor = 0;
async function refreshNative(next = false) {
  if (!next) nativeCursor = 0;
  try {
    const data = await req("api/traffic/native?limit=100&since=" + nativeCursor);
    $("native-note").textContent = data.note;
    $("native-table").hidden = !data.available;
    $("native-next").hidden = !data.available || data.flows.length < 100;
    const fragment = document.createDocumentFragment();
    for (const row of data.flows || []) {
      const tr = document.createElement("tr");
      const protocol = ({6:"TCP",17:"UDP",1:"ICMP",58:"ICMPv6"})[row.protocol] || row.protocol;
      const values = [date(row.ts), row.reporter_id, endpoint(row.src) + ":" + row.sport,
        endpoint(row.dst) + ":" + row.dport,
        protocol + " / " + ({1:"ingress",2:"egress"}[row.direction] || "unknown"),
        fmt(row.num_of_starts), fmt(row.num_of_ends), fmt(row.num_of_drops),
        humanBytes(Number(row.rx_bytes) + Number(row.tx_bytes)), row.rule_id || "Unavailable"];
      for (const value of values) {
        const cell = document.createElement("td");
        cell.textContent = String(value);
        tr.append(cell);
      }
      fragment.append(tr);
    }
    if (!(data.flows || []).length)
      fragment.append(makeEmptyRow(10, "No native reports received yet. Reports appear when connected peers generate traffic with native reporting enabled."));
    $("native-rows").replaceChildren(fragment);
    nativeCursor = data.next_cursor || 0;
  } catch (_) {
    $("native-note").textContent = "Native reports unavailable";
    $("native-table").hidden = true;
    $("native-next").hidden = true;
  }
}
$("native-next").addEventListener("click", () => refreshNative(true));
async function refreshAnalytics() {
  const windowMinutes = Number($("flow-window").value);
  const [data, sensorData] = await Promise.all([
    req("api/traffic/analytics?minutes=" + windowMinutes + "&limit=500"),
    req("api/traffic/sensors")
  ]);
  renderSensors(sensorData);
  flowSnapshot = data;
  $("flow-starts").textContent = fmt(data.total.starts);
  $("flow-ends").textContent = fmt(data.total.ends);
  $("flow-bytes").textContent = humanBytes(data.total.bytes);
  $("flow-sensors").textContent = fmt(data.total.sensors);
  $("flow-allowed").textContent = data.wfp_decisions_available ? fmt(data.total.allows) : "N/A";
  $("flow-blocked").textContent = data.wfp_decisions_available ? fmt(data.total.blocks) : "N/A";
  $("flow-dropped").textContent = data.drops_available ? fmt(data.total.drops) : "N/A";
  $("flow-telemetry-note").textContent = data.counters_note + " " +
    data.verdict_note + " NetBird policy rules are not directly observable here.";
  renderAnalytics();
}
window.addEventListener("message", event => {
  if (event.origin !== location.origin || !event.data ||
      event.data.source !== "shirobird-peer-directory" || !Array.isArray(event.data.peers))
    return;
  peerByIP = new Map();
  for (const peer of event.data.peers.slice(0, 5000)) {
    if (!peer || typeof peer !== "object" || typeof peer.name !== "string") continue;
    for (const ip of [peer.ip, peer.ipv6]) {
      if (typeof ip === "string" && ip.length && ip.length < 65)
        peerByIP.set(ip.split("/")[0], {name: peer.name, connected: !!peer.connected});
    }
  }
  renderAnalytics();
  renderFlows();
});
function renderFlows() {
  const filter = $("filter").value.toLowerCase();
  const fragment = document.createDocumentFragment();
  const matches = flows.filter(row => [
    row.src, row.dst, row.sensor, row.proto, row.type, row.source,
    row.application, row.filter_id, String(row.sport), String(row.dport)
  ].some(field => String(field).toLowerCase().includes(filter)));
  for (const row of matches.slice(0, 200)) {
    const tr = document.createElement("tr");
    const values = [
      date(row.ts), row.sensor, row.type, row.proto.toUpperCase(),
      endpoint(row.src) + ":" + row.sport, endpoint(row.dst) + ":" + row.dport,
      row.source === "windows_wfp" ? "Windows WFP" : "Linux conntrack",
      [row.application, row.filter_id ? "filter #" + row.filter_id : ""].filter(Boolean).join(" · ") || "—",
      fmt(row.bytes)
    ];
    for (const value of values) {
      const cell = document.createElement("td");
      cell.textContent = value;
      tr.append(cell);
    }
    fragment.append(tr);
  }
  if (!matches.length) {
    const tr = document.createElement("tr"), cell = document.createElement("td");
    cell.colSpan = 9;
    cell.textContent = "No matching events";
    tr.append(cell);
    fragment.append(tr);
  }
  $("flows").replaceChildren(fragment);
}
async function refreshFlows() {
  const [stats, results] = await Promise.all([
    req("api/stats"), req("api/flows?limit=200")
  ]);
  $("total").textContent = fmt(stats.total);
  $("day").textContent = fmt(stats.last_24h);
  $("sensors").textContent = fmt(stats.sensors);
  $("latest").textContent = date(stats.latest);
  flows = results.flows;
  lastId = flows.reduce((max, row) => Math.max(max, row.id), 0);
  renderFlows();
}
function connectFlows() {
  if (stream) stream.close();
  stream = new EventSource("api/stream?since=" + lastId);
  stream.onopen = () => status("Live streaming", true);
  stream.onerror = () => status("Reconnecting");
  stream.onmessage = event => {
    const row = JSON.parse(event.data);
    if (row.id <= lastId) return;
    lastId = row.id;
    flows.unshift(row);
    flows = flows.slice(0, 200);
    $("latest").textContent = date(row.ts);
    renderFlows();
  };
}

async function refreshSiem() {
  const data = await req("api/siem/status");
  const syslog = data.syslog;
  $("syslog-enabled").checked = Boolean(syslog.configured);
  $("syslog-host").value = syslog.host || "";
  $("syslog-port").value = String(syslog.port || 514);
  const hostPath = data.jsonl.host_path || "/opt/shirobird/data/siem/events.jsonl";
  // textContent deliberately avoids interpreting HTML in paths.
  $("wazuh-example").textContent = "<localfile>\\n" +
    "  <log_format>json</log_format>\\n" +
    "  <location>" + hostPath + "</location>\\n" +
    "</localfile>";
  $("siem-jsonl").textContent = data.jsonl.ready ? "Ready" : "Unavailable";
  $("siem-events").textContent = fmt(data.total_flow_events);
  $("siem-syslog").textContent = data.syslog.configured ? "Configured" : "Disabled";
  $("siem-delivery").textContent = "Not verified";
  $("siem-path").textContent = data.jsonl.container_path;
  $("siem-size").textContent = data.jsonl.exists ?
    fmt(data.jsonl.size_bytes) + " B" : "No file yet";
  $("siem-updated").textContent = date(data.jsonl.last_write);
  $("siem-retention").textContent = data.retention_days + " days (SQLite)";
  $("siem-protocol").textContent = data.syslog.configured ?
    "UDP/" + data.syslog.port : "Not enabled";
  $("siem-error").textContent = data.jsonl.ready ?
    "" : "Check permissions of the ShiroBird SIEM export directory.";
  status("Exporter status", true);
}
async function start() {
  try {
    if (page === "siem-integration") await refreshSiem();
    else {
      await Promise.all([refreshFlows(), refreshAnalytics(), refreshNative()]);
      connectFlows();
    }
    $("auth").classList.add("hidden");
  } catch (error) {
    if (error.message !== "Authentication required") {
      status("Unavailable");
      if (page === "siem-integration") $("siem-error").textContent = error.message;
    }
    showLogin();
  }
}
$("form").addEventListener("submit", async event => {
  event.preventDefault();
  $("error").textContent = "";
  try {
    const response = await fetch("api/login", {
      method:"POST", headers:{"Content-Type":"application/json"},
      body:JSON.stringify({token:$("token").value}), credentials:"same-origin"
    });
    if (!response.ok) throw Error(response.status === 429 ?
      "Too many attempts" : "Invalid administrator token");
    $("token").value = "";
    await start();
  } catch (error) { $("error").textContent = error.message; }
});
$("logout").addEventListener("click", async () => {
  try { await req("api/logout", {method:"POST"}); } catch (_) { /* logout best effort */ }
  showLogin();
});
$("flow-window").addEventListener("change", () =>
  Promise.all([refreshAnalytics(), refreshNative()]).catch(() => status("Analytics unavailable")));
$("flow-protocol").addEventListener("change", renderAnalytics);
$("flow-search").addEventListener("input", renderAnalytics);
$("flow-analytics-refresh").addEventListener("click", () =>
  refreshAnalytics().catch(() => status("Analytics unavailable")));
if (page === "traffic-flow") window.setInterval(() => {
  if (!document.hidden) void refreshAnalytics().catch(() => {});
}, 30000);
$("filter").addEventListener("input", renderFlows);
$("refresh").addEventListener("click", () => refreshFlows().catch(() => status("Unavailable")));
$("siem-refresh").addEventListener("click", () => refreshSiem().catch(error => {
  $("siem-error").textContent = error.message;
}));
$("syslog-form").addEventListener("submit", async event => {
  event.preventDefault();
  const message = $("syslog-message");
  message.textContent = "Saving…";
  const options = {
    enabled: $("syslog-enabled").checked,
    host: $("syslog-host").value.trim(),
    port: Number($("syslog-port").value),
    protocol: "udp"
  };
  try {
    const saved = await req("api/siem/syslog", {
      method: "POST",
      headers: {"Content-Type": "application/json", "X-ShiroBird-Action": "siem"},
      body: JSON.stringify(options)
    });
    message.textContent = saved.saved ? "Settings saved; future flow events will use this configuration." : "Unable to save";
    await refreshSiem();
  } catch (error) { message.textContent = "Save failed: " + error.message; }
});
$("syslog-test").addEventListener("click", async () => {
  const message = $("syslog-message");
  message.textContent = "Sending test datagram…";
  try {
    const result = await req("api/siem/syslog/test", {
      method: "POST",
      headers: {"Content-Type": "application/json", "X-ShiroBird-Action": "siem"},
      body: "{}"
    });
    message.textContent = result.sent_locally ?
      "Test sent from ShiroBird. Verify receipt on the Syslog server or SIEM." :
      "Test did not send.";
  } catch (error) { message.textContent = "Test failed: " + error.message; }
});
$("copy-wazuh-script").addEventListener("click", async event => {
  try {
    await navigator.clipboard.writeText($("wazuh-script").textContent);
    event.currentTarget.textContent = "Copied";
  } catch (error) {
    $("siem-error").textContent = "Copy unavailable: select the command manually.";
  }
});
$("copy-wazuh").addEventListener("click", async event => {
  try {
    await navigator.clipboard.writeText($("wazuh-example").textContent);
    event.currentTarget.textContent = "Copied";
  } catch (_) {
    $("siem-error").textContent = "Clipboard unavailable. Select and copy the configuration manually.";
  }
});
start();
