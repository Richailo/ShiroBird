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
let page = query.get("view") === "siem-integration" ? "siem-integration" : "traffic-flow";
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
  if (embedded) {
    // NetBird owns authentication in embedded mode. Never reveal a second
    // ShiroBird login screen, including on transient API 401 responses.
    $("auth").hidden = true;
    $("auth").hidden = true;
    $("auth").classList.add("hidden");
    $("form").hidden = true;
    status("Waiting for NetBird authentication");
  } else {
    $("auth").hidden = false;
    $("auth").classList.remove("hidden");
    status("Sign in required");
  }
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
let peerById = new Map();
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
    for (const [i,value] of values.entries()) {
      const td = document.createElement("td");
      if (i === 1) td.append(nativePeer(item.src));
      else if (i === 2) td.append(nativePeer(item.dst, item.dport));
      else if (i === 4) {
        const chip = document.createElement("span");
        chip.className = "native-chip";
        chip.textContent = String(value);
        td.append(chip);
      } else td.textContent = String(value);
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
// Presentation follows NetBird's Traffic Events layout, using only
// fields that the native reporter actually provided.
// These are the exact third-party icon families used upstream by NetBird:
// react-icons/fa6 (Font Awesome Windows), react-icons/fc (Icons8 Linux/Android),
// Lucide (resources, protocols and traffic), Tabler (column sorting).
// Locally served static assets: no CDN or external requests by clients.
const trafficNS = "http://www.w3.org/2000/svg";
const nativeAssets = Object.freeze({
  windows:"icons/windows.svg", macos:"icons/macos.svg",
  linux:"icons/linux.svg", android:"icons/android.svg",
  mobile:"icons/ios.svg", monitor:"icons/monitor.svg",
  globe:"icons/globe.svg", network:"icons/network.svg",
  route:"icons/route.svg", share:"icons/share.svg"
});
function osKind(value) {
  const os = String(value || "").toLowerCase();
  if (/windows/.test(os)) return "windows";
  if (/darwin|mac\s?os|macos|os x/.test(os)) return "macos";
  if (/android/.test(os)) return "android";
  if (/ios|iphone|ipad/.test(os)) return "mobile";
  if (/linux|ubuntu|debian|fedora|centos|arch/.test(os)) return "linux";
  return "monitor";
}
function nativeIcon(kind) {
  const tile = document.createElement("span");
  tile.className = "native-os-icon";
  const mapped = nativeAssets[kind] || nativeAssets.monitor;
  tile.title = kind === "globe" ? "Network resource / IP address" :
    kind === "monitor" ? "Peer (OS not reported)" : kind.toUpperCase();
  tile.setAttribute("aria-label", tile.title);
  const img = document.createElement("img");
  img.className = "native-library-icon" +
    (["windows","macos","linux","android","mobile"].includes(kind) ? " native-os-logo" : "");
  img.setAttribute("src", mapped);
  img.setAttribute("alt", "");
  img.setAttribute("aria-hidden", "true");
  img.setAttribute("width", "18");
  img.setAttribute("height", "18");
  tile.append(img);
  return tile;
}
function lucideIcon(name, size=15) {
  const svg = document.createElementNS(trafficNS,"svg");
  for(const [key,val] of Object.entries({
    viewBox:"0 0 24 24", width:String(size), height:String(size),
    fill:"none", stroke:"currentColor", "stroke-width":"2",
    "stroke-linecap":"round", "stroke-linejoin":"round",
    "aria-hidden":"true"
  })) svg.setAttribute(key,val);
  const marks = name === "arrow-down" ?
    [["path","M12 5v14"],["path","m19 12-7 7-7-7"]] :
    name === "arrow-up" ?
    [["path","M12 19V5"],["path","m5 12 7-7 7 7"]] :
    name === "chevron-down" ?
    [["path","m6 9 6 6 6-6"]] :
    name === "share-2" ?
    [["circle",{cx:18,cy:5,r:3}],["circle",{cx:6,cy:12,r:3}],
     ["circle",{cx:18,cy:19,r:3}],
     ["line",{x1:8.59,x2:15.42,y1:13.51,y2:17.49}],
     ["line",{x1:15.41,x2:8.59,y1:6.51,y2:10.49}]] : [];
  for(const [kind,attributes] of marks) {
    const el=document.createElementNS(trafficNS,kind);
    if(typeof attributes==="string")el.setAttribute("d",attributes);
    else for(const [key,val] of Object.entries(attributes))el.setAttribute(key,String(val));
    svg.append(el);
  }
  return svg;
}
function tablerSortIcon(descending) {
  // Tabler IconSortAscending / IconSortDescending used by DataTableHeader.
  const svg=document.createElementNS(trafficNS,"svg");
  for(const [key,val] of Object.entries({
    viewBox:"0 0 24 24",width:"16",height:"16",fill:"none",
    stroke:"currentColor","stroke-width":"2","stroke-linecap":"round",
    "stroke-linejoin":"round","aria-hidden":"true"
  }))svg.setAttribute(key,val);
  const paths=descending?
    ["M4 6l9 0","M4 12l7 0","M4 18l7 0","M15 15l3 3l3 -3","M18 6l0 12"]:
    ["M4 6l7 0","M4 12l7 0","M4 18l9 0","M15 9l3 -3l3 3","M18 6l0 12"];
  for(const path of paths){const el=document.createElementNS(trafficNS,"path");
    el.setAttribute("d",path);svg.append(el);}
  return svg;
}
function nativePeer(ip, port=0) {
  const peer = peerByIP.get(ip);
  const wrapper = document.createElement("span");
  wrapper.className = "native-peer";
  const kind = peer ? osKind(peer.os) : "globe";
  wrapper.append(nativeIcon(kind));
  const caption = document.createElement("span");
  caption.className = "native-peer-details";
  const name = document.createElement("strong");
  name.className = "native-peer-name";
  name.textContent = peer?.name || ip || "Unknown";
  name.title = name.textContent;
  const address = document.createElement("small");
  address.className = "native-peer-address";
  address.textContent = (ip || "—") + (Number(port)>0 ? ":"+Number(port) : "");
  caption.append(name,address);
  wrapper.append(caption);
  return wrapper;
}
function nativeProtocol(row) {
  const container = document.createElement("span");
  container.className = "native-protocol";
  const proto = document.createElement("span");
  proto.className = "native-chip";
  const num = Number(row.protocol);
  proto.append(lucideIcon("share-2",12));
  const protoLabel=document.createElement("span");
  protoLabel.textContent = ({6:"TCP",17:"UDP",1:"ICMP",58:"ICMPv6",132:"SCTP"})[num] || ("IP "+num);
  proto.append(protoLabel);
  container.append(proto);
  const port = num === 6 || num === 17 ? Number(row.dport) :
    num === 1 || num === 58 ? null : 0;
  const meta = document.createElement("span");
  meta.className = "native-chip native-chip-port";
  if (port !== null && port > 0) meta.textContent = String(port);
  else if (num === 1 || num === 58) {
    const type = Number(row.icmp_type);
    meta.textContent = (type === 8 || type === 128) ? "Echo request" :
      (type === 0 || type === 129) ? "Echo reply" : "Type " + (Number.isFinite(type) ? type : "?");
  } else meta.textContent = "—";
  container.append(meta);
  return container;
}
function nativeSeverity(row) {
  const drops = Number(row.num_of_drops || 0);
  const starts = Number(row.num_of_starts || 0);
  const ends = Number(row.num_of_ends || 0);
  return drops > 0 && starts > 0 ? "mixed" :
    drops > 0 ? "blocked" : starts > 0 ? "started" :
    ends > 0 ? "ended" : "unknown";
}
function nativeEventDescription(row) {
  const reporter = peerById.get(row.reporter_id)?.name || row.reporter_id || "Peer";
  const severity = nativeSeverity(row);
  const direction = Number(row.direction);
  if (severity === "mixed") return "Connection activity with blocked attempts";
  if (severity === "blocked") return "Connection blocked by reporting peer";
  if (severity === "started")
    return direction === 2 ? "Connection requested by peer" :
      direction === 1 ? "Connection received by peer" : "Connection started";
  if (severity === "ended") return "Connection stopped";
  return "Traffic flow reported";
}
function nativeEventCell(row) {
  const holder = document.createElement("div");
  holder.className = "native-event";
  const badge = document.createElement("span");
  const level = nativeSeverity(row);
  badge.className = "native-event-dot native-event-" + level;
  badge.setAttribute("aria-label",level);
  const text = document.createElement("div");
  const title = document.createElement("strong");
  title.textContent = nativeEventDescription(row);
  const lines = document.createElement("small");
  const counts = [];
  if (Number(row.num_of_starts)) counts.push(fmt(row.num_of_starts)+" starts");
  if (Number(row.num_of_ends)) counts.push(fmt(row.num_of_ends)+" ends");
  if (Number(row.num_of_drops)) counts.push(fmt(row.num_of_drops)+" drops");
  const reporter = peerById.get(row.reporter_id)?.name || row.reporter_id || "Unknown";
  lines.textContent = counts.join(" · ") + " · Reported by " + reporter +
    (Number(row.direction) === 1 ? " (incoming)" :
     Number(row.direction) === 2 ? " (outgoing)" : "");
  text.append(title,lines);
  holder.append(badge,text);
  return holder;
}
function nativeTrafficCell(row) {
  const box = document.createElement("span");
  box.className = "native-traffic";
  for (const [direction,value] of [
    ["rx",row.rx_bytes],["tx",row.tx_bytes]]) {
    const line = document.createElement("span");
    line.className = "native-traffic-line native-traffic-" + direction;
    const arrow = document.createElement("span");
    arrow.className = "native-traffic-arrow";
    arrow.append(lucideIcon(direction === "rx" ? "arrow-down" : "arrow-up", 15));
    arrow.setAttribute("aria-label",direction === "rx" ?
      "Received by reporting peer" : "Sent by reporting peer");
    const number = document.createElement("span");
    number.textContent = Number.isFinite(Number(value)) ?
      humanBytes(Number(value)) : "—";
    line.append(arrow,number);box.append(line);
  }
  box.title = "Transfer measured from the reporting peer's perspective";
  return box;
}
// Only Management API configuration and explicit event IDs are used for
// attribution. The current configuration is NOT a historical policy snapshot.
let nativeDirectory = {policies:[],routes:[],networks:[],complete:false};
let nativeExpanded = new Set();
function eventRefCandidates(raw) {
  if (typeof raw !== "string" || !raw || raw.length > 512) return [];
  const ids = [raw];
  if (/^(?:[0-9a-fA-F]{2})+$/.test(raw)) {
    let decoded = "";
    for (let i=0;i<raw.length;i+=2) {
      const n=parseInt(raw.slice(i,i+2),16);
      if (n < 33 || n > 126) { decoded=""; break; }
      decoded+=String.fromCharCode(n);
    }
    if (decoded) ids.push(decoded);
  }
  return ids;
}
function matchingRef(raw, id) {
  return typeof id === "string" && id.length>0 && eventRefCandidates(raw).includes(id);
}
function nativeResourceId(row) {
  return row.destination_resource_id || row.source_resource_id || "";
}
function resolveNativeRouter(row) {
  const ref=nativeResourceId(row);
  if (!ref) return {state:"p2p", reason:"No routing resource ID in this event."};
  const matchingRoutes = nativeDirectory.routes.filter(r=>r.enabled &&
    (matchingRef(ref,r.id) || matchingRef(ref,r.network_id)));
  const matchingNetworks = nativeDirectory.networks.filter(n=>
    n.resources?.some(r=>matchingRef(ref,r.id)) || matchingRef(ref,n.id));
  const known = new Set();
  const labels=[];
  let unresolvedGroup=false;
  for (const route of matchingRoutes) {
    if(route.peer)known.add(route.peer);
    if(route.peer_groups?.length)unresolvedGroup=true;
    labels.push(route.name || route.id);
  }
  for (const network of matchingNetworks) {
    for (const peer of network.routerPeers||[]) known.add(peer);
    if (network.routerGroups?.length) unresolvedGroup=true;
    const resource=network.resources?.find(r=>matchingRef(ref,r.id));
    labels.push(resource?.name || network.name || network.id);
  }
  const candidates=[...known];
  if (!matchingRoutes.length && !matchingNetworks.length)
    return {state:"unresolved",resourceId:ref,reason:
      nativeDirectory.complete ? "No matching route/resource in current NetBird configuration." :
      "Routing metadata not available or incomplete."};
  if (candidates.includes(row.reporter_id)) return {
    state:"confirmed",peerId:row.reporter_id,resourceId:ref,
    resourceName:labels[0]||"",reason:"Reporting peer matches the configured router."
  };
  if (candidates.length===1 && !unresolvedGroup) return {
    state:"configured",peerId:candidates[0],resourceId:ref,
    resourceName:labels[0]||"",reason:"Single configured router for this resource (current configuration)."
  };
  return {state:"ambiguous",resourceId:ref,
    resourceName:labels[0]||"",candidateIds:candidates,
    reason:unresolvedGroup ? "A peer group may select a router; the chosen peer is not in this event." :
      "Multiple router candidates exist for this resource."};
}
function resolveNativePolicy(row) {
  const ref=row.rule_id;
  if (!ref) return {state:"missing",reason:
    "This native event contains no rule_id. An exact NetBird Policy cannot be determined."};
  const matched=[];
  for (const policy of nativeDirectory.policies) {
    if (matchingRef(ref,policy.id)) matched.push({
      policy,rule:null
    });
    for(const rule of policy.rules||[])
      if(matchingRef(ref,rule.id))matched.push({policy,rule});
  }
  if(matched.length!==1)return {state:"unresolved",raw:ref,
    reason: matched.length>1 ? "Multiple configuration entries match this ID." :
      "No exact matching policy or rule in the current NetBird configuration."};
  const {policy,rule}=matched[0];
  return {state:"matched",raw:ref,policyName:policy.name,
    policyId:policy.id,ruleName:rule?.name||"",ruleId:rule?.id||"",
    action:rule?.action||"",reason:
      "Exact ID correlation with today's NetBird configuration; not a historical snapshot."};
}
function nativeRouterCell(row) {
  const resolved=resolveNativeRouter(row);
  if (resolved.peerId) {
    const peer=peerById.get(resolved.peerId);
    if(peer?.ip || peer?.ipv6) {
      const cell=nativePeer(peer.ip||peer.ipv6,0);
      cell.title=resolved.reason;
      if(resolved.state==="configured")cell.classList.add("native-router-config");
      return cell;
    }
    const holder=document.createElement("span");
    holder.className="native-router-id";
    holder.textContent=peer?.name||resolved.peerId;
    holder.title=resolved.reason;
    return holder;
  }
  const empty=document.createElement("span");
  empty.className="native-unknown";
  empty.textContent=resolved.state==="ambiguous" ? "Multiple" : "—";
  empty.title=resolved.reason;
  return empty;
}
function nativeDetails(row) {
  const router=resolveNativeRouter(row);
  const policy=resolveNativePolicy(row);
  const wrap=document.createElement("div");
  wrap.className="native-details";
  const header=document.createElement("strong");
  header.textContent="Traffic event details";
  wrap.append(header);
  const grid=document.createElement("dl");
  grid.className="native-details-grid";
  const item=(label,value)=> {
    const entry=document.createElement("div");
    const dt=document.createElement("dt");dt.textContent=label;
    const dd=document.createElement("dd");dd.textContent=String(value??"—");
    entry.append(dt,dd);grid.append(entry);
  };
  const friendly=id=>eventRefCandidates(id).at(-1)||"—";
  item("Reported by",peerById.get(row.reporter_id)?.name||row.reporter_id||"Unknown");
  item("Flow direction",Number(row.direction)===1?"Incoming":Number(row.direction)===2?"Outgoing":"Unknown");
  item("Router",router.peerId ?
    (peerById.get(router.peerId)?.name||router.peerId) :
    router.state==="p2p" ? "Not applicable (P2P)" :
    router.state==="ambiguous" ? "Cannot identify uniquely" : "Not identified");
  item("Router evidence",router.reason);
  item("Network resource",router.resourceName||friendly(nativeResourceId(row)));
  item("Policy",policy.state==="matched" ? policy.policyName||policy.policyId :
    policy.state==="missing" ? "Not reported by this peer" : "Not identified");
  item("Policy rule",policy.state==="matched" ? policy.ruleName||policy.ruleId||"Policy-level ID" : "—");
  item("Policy action",policy.action||"Not available");
  item("Policy evidence",policy.reason);
  item("Raw rule ID",policy.raw||"Not supplied");
  item("Flow ID",row.flow_id||"—");
  item("Event ID",row.event_id||"—");
  item("Event source",row.source||"netbird_native");
  wrap.append(grid);
  const caveat=document.createElement("p");
  caveat.className="native-details-caveat";
  caveat.textContent="The displayed router and policy names come from current NetBird configuration. The native event does not contain a historical configuration snapshot.";
  wrap.append(caveat);
  return wrap;
}

let nativeCursor = 0;
let nativeRowsLoaded = [];
let nativeSort = "ts";
let nativeDescending = true;
function renderNativeRows() {
  const filter = $("native-search").value.toLowerCase().trim();
  const rows = nativeRowsLoaded.filter(row => {
    if (!filter) return true;
    const src = peerByIP.get(row.src)?.name || "";
    const dst = peerByIP.get(row.dst)?.name || "";
    const reporter = peerById.get(row.reporter_id)?.name || "";
    return [row.src,row.dst,src,dst,reporter,row.sport,row.dport,
      row.reporter_id,row.rule_id].some(x=>String(x||"").toLowerCase().includes(filter));
  });
  const order = nativeDescending ? -1 : 1;
  rows.sort((a,b)=>{
    if (nativeSort === "severity") {
      const rating = {blocked:4,mixed:3,started:2,ended:1,unknown:0};
      return order * (rating[nativeSeverity(a)]-rating[nativeSeverity(b)]);
    }
    if (nativeSort === "src" || nativeSort === "dst") {
      const left = String(peerByIP.get(a[nativeSort])?.name || a[nativeSort] || "");
      const right = String(peerByIP.get(b[nativeSort])?.name || b[nativeSort] || "");
      return order * left.localeCompare(right);
    }
    return order * (Number(a.ts)-Number(b.ts));
  });
  const fragment = document.createDocumentFragment();
  for (const row of rows) {
    const tr = document.createElement("tr");
    tr.className = "native-row native-row-" + nativeSeverity(row);
    const columns = [
      [date(row.ts),"native-time"],[nativeEventCell(row),"native-event-cell"],
      [nativePeer(row.src,row.sport),"native-endpoint-cell"],
      [nativeProtocol(row),"native-protocol-cell"],
      [nativePeer(row.dst,row.dport),"native-endpoint-cell"],
      [nativeTrafficCell(row),"native-traffic-cell"],
      [nativeRouterCell(row),"native-router-cell"]
    ];
    const eventKey=String(row.reporter_id||"")+":"+String(row.event_id||row.id||row.flow_id||"");
    for (const [i,entry] of columns.entries()) {
      const [value,className]=entry;
      const td = document.createElement("td");
      td.className = className;
      if (typeof value === "string") td.textContent = value;
      else td.append(value);
      if (i === 1) {
        const toggle=document.createElement("button");
        toggle.type="button";
        toggle.className="native-event-expand";
        toggle.dataset.eventKey=eventKey;
        toggle.setAttribute("aria-label","Show event details and NetBird Policy");
        toggle.setAttribute("aria-expanded",String(nativeExpanded.has(eventKey)));
        toggle.append(lucideIcon("chevron-down",14));
        const title=document.createElement("span");
        title.textContent="Details";
        toggle.append(title);
        td.append(toggle);
      }
      tr.append(td);
    }
    fragment.append(tr);
    if(nativeExpanded.has(eventKey)) {
      const detailsRow=document.createElement("tr");
      detailsRow.className="native-expanded-row";
      const cell=document.createElement("td");
      cell.colSpan=7;
      cell.append(nativeDetails(row));
      detailsRow.append(cell);
      fragment.append(detailsRow);
    }
  }
  if (!rows.length) fragment.append(makeEmptyRow(7,
    nativeRowsLoaded.length ? "No events match this filter on the loaded page" :
    "No native reports received yet. Events appear when NetBird peers report activity."));
  $("native-rows").replaceChildren(fragment);
  for (const btn of document.querySelectorAll("[data-native-sort]")) {
    const active = btn.dataset.nativeSort === nativeSort;
    btn.setAttribute("aria-sort", active ?
      (nativeDescending ? "descending" : "ascending") : "none");
    const arrow = btn.querySelector(".native-sort-arrow");
    if (arrow) arrow.replaceChildren(tablerSortIcon(active ? nativeDescending : false));
  }
}
async function refreshNative(next = false) {
  if (!next) nativeCursor = 0;
  try {
    const data = await req("api/traffic/native?limit=100&since=" + nativeCursor);
    $("native-note").textContent = data.note || "Native receiver status unavailable.";
    $("native-table").hidden = !data.available;
    const returned = Array.isArray(data.flows) ? data.flows : [];
    nativeRowsLoaded = returned;
    $("native-next").hidden = !data.available || returned.length < 100 || !data.next_cursor;
    nativeCursor = data.next_cursor || 0;
    renderNativeRows();
  } catch (_) {
    $("native-note").textContent = "Native reports unavailable";
    $("native-table").hidden = true;
    $("native-next").hidden = true;
  }
}
$("native-next").addEventListener("click", () => refreshNative(true));
$("native-search").addEventListener("input", renderNativeRows);
$("native-rows").addEventListener("click", event => {
  const toggle=event.target.closest?.("button[data-event-key]");
  if (!toggle || !$("native-rows").contains(toggle)) return;
  const key=toggle.dataset.eventKey;
  if(nativeExpanded.has(key))nativeExpanded.delete(key);
  else nativeExpanded.add(key);
  renderNativeRows();
  const replacement=Array.from($("native-rows").querySelectorAll("button[data-event-key]"))
    .find(b=>b.dataset.eventKey===key);
  replacement?.focus();
});
window.addEventListener("message", event => {
  if(event.origin!==location.origin || event.source!==window.parent ||
     event.data?.source!=="shirobird-policy-directory" ||
     !event.data.directory || typeof event.data.directory!=="object")return;
  const d=event.data.directory;
  // Parent sends read-only, curated Management API metadata only.
  nativeDirectory={
    complete:d.complete===true,
    policies:Array.isArray(d.policies)?d.policies.slice(0,1000):[],
    routes:Array.isArray(d.routes)?d.routes.slice(0,1000):[],
    networks:Array.isArray(d.networks)?d.networks.slice(0,40):[]
  };
  renderNativeRows();
});
document.querySelectorAll("[data-native-sort]").forEach(button =>
  button.addEventListener("click", () => {
    const next = button.dataset.nativeSort;
    if (nativeSort === next) nativeDescending = !nativeDescending;
    else { nativeSort = next; nativeDescending = true; }
    renderNativeRows();
  }));
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
  peerById = new Map();
  for (const peer of event.data.peers.slice(0, 5000)) {
    if (!peer || typeof peer !== "object" || typeof peer.name !== "string") continue;
    for (const ip of [peer.ip, peer.ipv6]) {
      if (typeof ip === "string" && ip.length && ip.length < 65)
        peerByIP.set(ip.split("/")[0], {name: peer.name, id: peer.id,
          ip: peer.ip, ipv6: peer.ipv6, connected: !!peer.connected, os: peer.os});
    }
  }
  for (const peer of event.data.peers.slice(0,5000)) {
    if (typeof peer?.id === "string" && typeof peer.name === "string")
      peerById.set(peer.id, {name:peer.name,ip:peer.ip,ipv6:peer.ipv6,os:peer.os});
  }
  renderAnalytics();
  renderFlows();
  renderNativeRows();
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
    for (const [i,value] of values.entries()) {
      const cell = document.createElement("td");
      if (i === 4) cell.append(nativePeer(row.src, row.sport));
      else if (i === 5) cell.append(nativePeer(row.dst, row.dport));
      else if (i === 2) {
        const status = document.createElement("span");
        status.className = "native-event-inline";
        const dot = document.createElement("span");
        dot.className = "native-event-dot native-event-" +
          (row.type === "BLOCK" || row.type === "DROP" ? "blocked" :
          row.type === "ALLOW" || row.type === "NEW" ? "started" :
          row.type === "DESTROY" ? "ended" : "unknown");
        const label = document.createElement("span");
        label.textContent = String(value);
        status.append(dot,label);
        cell.append(status);
      } else if (i === 3) {
        const chip = document.createElement("span");
        chip.className = "native-chip";
        chip.textContent = String(value);
        cell.append(chip);
      } else cell.textContent = String(value);
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
let firstPaintNotified = false;
let currentLoad = 0;
function notifyParentReady() {
  if (!embedded || firstPaintNotified) return;
  // The deferred script starts after HTML is parsed and CSS has loaded.
  // A message after initialization is sufficient: the parent keeps the iframe
  // display:none until it receives this explicit first-paint handshake.
  firstPaintNotified = true;
  window.parent.postMessage({source: "shirobird-ready", view: page}, location.origin);
}
async function start() {
  const loadingPage = page;
  const generation = ++currentLoad;
  try {
    if (loadingPage === "siem-integration") await refreshSiem();
    else {
      await Promise.all([refreshFlows(), refreshAnalytics(), refreshNative()]);
      if (page === loadingPage) connectFlows();
    }
    if (generation === currentLoad) {
      $("auth").hidden = true;
      $("auth").classList.add("hidden");
    }
  } catch (error) {
    if (generation === currentLoad) {
      if (error.message !== "Authentication required") {
        status("Unavailable");
        if (page === "siem-integration") $("siem-error").textContent = error.message;
      }
      showLogin();
    }
  } finally {
    notifyParentReady();
  }
}
function switchEmbeddedView(nextPage) {
  if (!embedded || !["traffic-flow", "siem-integration"].includes(nextPage) ||
      nextPage === page) return;
  page = nextPage;
  document.body.dataset.view = page;
  $("traffic-view").hidden = page !== "traffic-flow";
  $("siem-view").hidden = page !== "siem-integration";
  if (stream) stream.close();
  stream = null;
  // Reuse the existing document, styles and SSO cookie, without any navigation.
  void start();
}
window.addEventListener("message", event => {
  if (!embedded || event.origin !== location.origin ||
      event.source !== window.parent || !event.data ||
      event.data.source !== "shirobird-navigate") return;
  switchEmbeddedView(event.data.view);
});
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
