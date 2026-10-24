"use strict";
const $ = id => document.getElementById(id);
const query = new URLSearchParams(location.search);
const embedded = query.has("embedded");
const page = query.get("view") === "siem-integration" ? "siem-integration" : "traffic-flow";
document.body.classList.toggle("embedded", embedded);
document.body.dataset.view = page;
$("traffic-view").hidden = page !== "traffic-flow";
$("siem-view").hidden = page !== "siem-integration";

window.addEventListener("message", event => {
  if (event.origin !== location.origin || !event.data || event.data.source !== "shirobird-theme") return;
  document.documentElement.classList.toggle("dark", Boolean(event.data.dark));
  document.documentElement.classList.toggle("light", !event.data.dark);
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

function renderFlows() {
  const filter = $("filter").value.toLowerCase();
  const fragment = document.createDocumentFragment();
  const matches = flows.filter(row => [
    row.src, row.dst, row.sensor, row.proto, row.type,
    String(row.sport), String(row.dport)
  ].some(field => String(field).toLowerCase().includes(filter)));
  for (const row of matches.slice(0, 200)) {
    const tr = document.createElement("tr");
    const values = [
      date(row.ts), row.sensor, row.type, row.proto.toUpperCase(),
      row.src + ":" + row.sport, row.dst + ":" + row.dport, fmt(row.bytes)
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
    cell.colSpan = 7;
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
      await refreshFlows();
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
$("filter").addEventListener("input", renderFlows);
$("refresh").addEventListener("click", () => refreshFlows().catch(() => status("Unavailable")));
$("siem-refresh").addEventListener("click", () => refreshSiem().catch(error => {
  $("siem-error").textContent = error.message;
}));
$("copy-wazuh").addEventListener("click", async event => {
  try {
    await navigator.clipboard.writeText($("wazuh-example").textContent);
    event.currentTarget.textContent = "Copied";
  } catch (_) {
    $("siem-error").textContent = "Clipboard unavailable. Select and copy the configuration manually.";
  }
});
start();
