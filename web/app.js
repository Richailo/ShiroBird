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
  const port = num === 6 || num === 17 ? Number(row.grouped ? row.service_port : row.dport) :
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
  if(row.grouped && Number(row.report_count)>1) {
    return fmt(row.report_count)+" recorded reports · "+
      fmt(row.flow_count)+" distinct flow IDs (5-minute activity)";
  }
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
// Inline Traffic Events timeline: real reports sharing an exact reporter and flow ID.
function nativeEventKey(row) {
  if(row.grouped && row.activity_key)return "activity:"+row.activity_key;
  return String(row.reporter_id || "") + ":" + String(row.event_id || row.id || "");
}
function nativeFlowIdentity(row) {
  if(row.grouped && row.activity_key)return "activity:"+row.activity_key;
  const id = String(row.flow_id || "");
  return /^[0-9a-f]{32}$/.test(id) && typeof row.reporter_id === "string" &&
    row.reporter_id.length > 0 ? row.reporter_id + ":" + id : "";
}
const nativeTimelineCache = new Map();
function sameNativeConnection(a, b) {
  return !a.grouped && !b.grouped && Boolean(nativeFlowIdentity(a)) &&
    nativeFlowIdentity(a) === nativeFlowIdentity(b) &&
    ["src", "dst", "protocol", "sport", "dport"].every(k =>
      String(a[k] ?? "") === String(b[k] ?? ""));
}
function nativeTimelineRows(row) {
  const cache=nativeTimelineCache.get(nativeFlowIdentity(row));
  if(row.grouped) {
    if(!cache || !Array.isArray(cache.flows))return [row];
    // Summary first, followed by actual separate raw records. A grouped
    // service interval is NOT one persistent network connection.
    return [row,...cache.flows];
  }
  if (!cache || !Array.isArray(cache.flows)) return [row];
  const matching=cache.flows.filter(e=>sameNativeConnection(row,e));
  if(!matching.some(e=>nativeEventKey(e)===nativeEventKey(row)))matching.push(row);
  matching.sort((a,b)=>Number(a.window_end || a.ts || 0)-Number(b.window_end || b.ts || 0) ||
    Number(a.id || 0)-Number(b.id || 0));
  return matching;
}
function nativeEventCell(row) {
  const key=nativeEventKey(row), opened=nativeExpanded.has(key);
  const identity=nativeFlowIdentity(row);
  const root=document.createElement("div");
  root.className="native-event" + (opened ? " native-event-open" : "");
  const timeline=document.createElement("div");
  timeline.className="native-inline-timeline" + (opened ? " native-timeline-open" : "");
  const reports=opened ? nativeTimelineRows(row) : [row];
  for(const report of reports) {
    const selected=report===row || (!row.grouped && nativeEventKey(report)===key);
    const item=document.createElement("div");
    item.className="native-timeline-item"+(selected ? " native-current-item" : "");
    const dot=document.createElement("span");
    dot.className="native-event-dot native-event-"+nativeSeverity(report);
    dot.setAttribute("aria-label",nativeSeverity(report));
    const body=document.createElement("div");
    body.className="native-timeline-body";
    if(opened) {
      const timestamp=document.createElement("span");
      timestamp.className="native-timeline-date";
      timestamp.textContent=report.grouped ?
        date(Number(report.activity_start || report.ts || 0))+" – "+
          date(Number(report.activity_end || report.ts || 0)) :
        date(Number(report.window_end || report.ts || 0));
      body.append(timestamp);
    }
    const line=document.createElement("div");
    line.className="native-event-heading";
    const title=document.createElement("span");
    title.className="native-event-title";
    title.textContent=nativeEventDescription(report);
    line.append(title);
    if(selected) {
      const toggle=document.createElement("button");
      toggle.type="button";
      toggle.className="native-inline-chevron";
      toggle.dataset.eventKey=key;
      toggle.setAttribute("aria-label",opened ? "Collapse connection history" : "Expand connection history");
      toggle.setAttribute("aria-expanded",String(opened));
      toggle.title=opened ? "Collapse connection history" : "View recorded connection history and Policy";
      toggle.append(lucideIcon("chevron-down",16));
      line.append(toggle);
    }
    body.append(line);
    if(opened) {
      const counts=[];
      if(Number(report.num_of_starts))counts.push(fmt(report.num_of_starts)+" starts");
      if(Number(report.num_of_ends))counts.push(fmt(report.num_of_ends)+" ends");
      if(Number(report.num_of_drops))counts.push(fmt(report.num_of_drops)+" drops");
      if(row.grouped && !selected) {
        const policy=resolveNativePolicy(report);
        counts.push("Flow "+String(report.flow_id||"unknown").slice(0,8));
        if(policy.state==="matched")counts.push("Policy: "+(policy.policyName||policy.policyId));
      }
      if(counts.length) {
        const meta=document.createElement("span");
        meta.className="native-timeline-counts";
        meta.textContent=counts.join(" · ");
        body.append(meta);
      }
    }
    item.append(dot,body);
    timeline.append(item);
  }
  root.append(timeline);
  if(opened) {
    const cache=nativeTimelineCache.get(identity);
    const note=document.createElement("div");
    note.className="native-timeline-hint";
    if(!identity)note.textContent="A verified flow ID was not reported; related events cannot be linked.";
    else if(!cache)note.textContent=row.grouped?"Loading individual recorded reports…":"Loading recorded flow history…";
    else if(cache.error)note.textContent="History unavailable: "+cache.error;
    else if(cache.total > cache.flows.length)
      note.textContent="Showing "+cache.flows.length+" of "+cache.total+
        " raw reports. Use All native reports to inspect more.";
    else if(reports.length===1 && !row.grouped)
      note.textContent="No other recorded reports for this exact connection.";
    if(note.textContent)root.append(note);
    root.append(nativeInlineEvidence(row));
  }
  return root;
}
function nativeInlineEvidence(row) {
  if(row.grouped) {
    const span=document.createElement("div");
    span.className="native-inline-evidence";
    const info=document.createElement("span");
    info.textContent="Activity grouping only: "+fmt(row.report_count)+
      " independent reports, "+fmt(row.flow_count)+
      " flow IDs. Policies, router decisions and bytes remain per reporting peer;"+
      " view raw entries for individual evidence.";
    span.append(info);
    return span;
  }
  const policy=resolveNativePolicy(row),router=resolveNativeRouter(row);
  const container=document.createElement("div");
  container.className="native-inline-evidence";
  const facts=[
    ["Policy",policy.state==="matched" ?
      (policy.policyName || policy.policyId) : "Not reported / not verified",
      policy.reason],
    ["Rule",policy.state==="matched" ?
      (policy.ruleName || policy.ruleId || "Policy-level ID") : "—",
      policy.reason],
    ["Router",router.peerId ?
      (peerById.get(router.peerId)?.name || router.peerId) :
      router.state==="p2p" ? "P2P · not applicable" : "Not confirmed",
      router.reason]
  ];
  for (const [label,value,reason] of facts) {
    const fact=document.createElement("span");
    fact.className="native-inline-fact";
    fact.title=reason || "";
    const name=document.createElement("span");
    name.textContent=label+": ";
    const val=document.createElement("strong");
    val.textContent=value;
    fact.append(name,val);
    container.append(fact);
  }
  // Hidden technical identifiers are available through native HTML disclosure,
  // not through a bulky full-width details card.
  const technical=document.createElement("details");
  technical.className="native-technical-details";
  const summary=document.createElement("summary");
  summary.textContent="Technical identifiers";
  technical.append(summary);
  const info=document.createElement("div");
  const list=[
    ["Flow",row.flow_id || "—"],
    ["Event",row.event_id || String(row.id || "—")],
    ["Rule",row.rule_id || "Not supplied"],
    ["Resource",nativeResourceId(row) || "Not supplied"],
    ["Reporting peer",peerById.get(row.reporter_id)?.name || row.reporter_id || "Unknown"],
    ["Policy evidence",policy.reason],
    ["Router evidence",router.reason]
  ];
  for(const [label,value] of list) {
    const line=document.createElement("div");
    line.textContent=label+": "+String(value || "—");
    info.append(line);
  }
  technical.append(info);
  container.append(technical);
  return container;
}
async function loadNativeTimeline(row) {
  const identity=nativeFlowIdentity(row);
  if(!identity || nativeTimelineCache.has(identity))return;
  nativeTimelineCache.set(identity,{flows:[],total:0,pending:true});
  try {
    const query=new URLSearchParams(row.grouped?{
      filtered:"1",activity_key:row.activity_key,
      limit:"200",page:"0",sort:"time",order:"asc"
    }:{
      filtered:"1",reporters:row.reporter_id,flow_id:row.flow_id,
      limit:"25",page:"0",sort:"time",order:"desc"
    });
    const result=await req("api/traffic/native?"+query.toString());
    if(!result.available || !Array.isArray(result.flows))
      throw Error(result.note || "receiver not available");
    nativeTimelineCache.set(identity,{flows:result.flows,
      total:Number(result.total || result.flows.length)});
  }catch(err) {
    nativeTimelineCache.set(identity,{flows:[],total:0,
      error:String(err.message || err).slice(0,160)});
  }
  if(nativeExpanded.size)renderNativeRows();
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
  if(row.grouped && Number(row.report_count)>1) {
    const scope=document.createElement("span");
    scope.className="native-unknown";
    scope.textContent="Per report";
    scope.title="This activity bucket contains independent flow IDs; routing may vary.";
    return scope;
  }
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

let nativeRowsLoaded = [];
let nativePage = 0;
let nativeTotal = 0;
let nativeSort = "time";
let nativeDescending = true;
let nativeRequestVersion = 0;
let nativeSearchTimer = null;
let nativeUsers = [];
function renderNativeRows() {
  // Already filtered, sorted and paginated in the receiver's durable SQLite.
  const fragment = document.createDocumentFragment();
  for (const row of nativeRowsLoaded) {
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
    if(nativeExpanded.has(nativeEventKey(row)))tr.classList.add("native-row-expanded");
    for (const [value,className] of columns) {
      const td=document.createElement("td");
      td.className=className;
      if(typeof value==="string")td.textContent=value;
      else td.append(value);
      tr.append(td);
    }
    fragment.append(tr);
  }
  if (!nativeRowsLoaded.length) fragment.append(makeEmptyRow(7,
    "No recorded traffic events match the selected filters."));
  $("native-rows").replaceChildren(fragment);
  for (const btn of document.querySelectorAll("[data-native-sort]")) {
    const active = btn.dataset.nativeSort === nativeSort ||
      (nativeSort === "time" && btn.dataset.nativeSort === "ts") ||
      (nativeSort === "event" && btn.dataset.nativeSort === "severity");
    btn.setAttribute("aria-sort", active ?
      (nativeDescending ? "descending" : "ascending") : "none");
    const arrow = btn.querySelector(".native-sort-arrow");
    if (arrow) arrow.replaceChildren(tablerSortIcon(active ? nativeDescending : false));
  }
}
function renderNativePagination() {
  const size=Number($("native-page-size").value);
  const first=nativeTotal ? nativePage*size+1 : 0;
  const last=Math.min(nativeTotal,(nativePage+1)*size);
  $("native-results-count").textContent=first+"–"+last+" of "+
    nativeTotal.toLocaleString()+($("native-view").value==="compact"?" activity groups":" raw reports");
  $("native-page-label").textContent="Page "+(nativePage+1);
  $("native-prev").disabled=nativePage===0;
  $("native-next").disabled=last>=nativeTotal;
}
function nativeTimeFilters() {
  const value=$("native-range").value;
  if (value !== "custom") return {start:value==="0"?0:Math.floor(Date.now()/1000)-Number(value),end:0};
  const start=$("native-from").value ? Math.floor(new Date($("native-from").value).getTime()/1000) : 0;
  const end=$("native-to").value ? Math.floor(new Date($("native-to").value).getTime()/1000) : 0;
  if (!Number.isFinite(start) || !Number.isFinite(end) || (start && end && start>end))
    throw Error("Choose a valid date range");
  return {start,end};
}
function nativeUserPeerFilter(id) {
  if (!id) return null;
  const list=[...peerById.entries()].filter(([,p])=>p.user_id===id).slice(0,50);
  return {
    reporters:list.map(([id])=>id),
    ips:list.flatMap(([,p])=>[p.ip,p.ipv6]).filter(Boolean).slice(0,80)
  };
}
function nativeNameIPs(search) {
  if (!search) return [];
  const needle=search.toLowerCase();
  return [...peerByIP.entries()]
    .filter(([,p])=>String(p.name||"").toLowerCase().includes(needle))
    .map(([ip])=>ip).slice(0,60);
}
// NetBird-like selects: the native select remains the single source of truth
// for filters, but the visible listbox is rendered in a fixed body portal.
// This prevents browser-native blue menus and OS icons bleeding through.
const NATIVE_SELECT_IDS = [
  "native-range","native-user","native-protocol","native-event-type",
  "native-view","native-page-size"
];
const netbirdDropdowns = new Map();
let netbirdOpenDropdown = null;
const overlayMargin = 10;
function syncNetbirdSelect(id) {
  const item=netbirdDropdowns.get(id);
  if(!item)return;
  const selected=item.select.selectedOptions[0];
  item.text.textContent=selected ? selected.textContent : "Select…";
  item.trigger.setAttribute("aria-label",
    (item.select.getAttribute("aria-label") || "Select option")+
    ": "+item.text.textContent);
}
function closeNetbirdDropdown(restoreFocus=false) {
  if(!netbirdOpenDropdown)return;
  const item=netbirdOpenDropdown;
  item.menu.hidden=true;
  item.trigger.setAttribute("aria-expanded","false");
  netbirdOpenDropdown=null;
  if(restoreFocus)item.trigger.focus({preventScroll:true});
}
function placeNetbirdOverlay(element,anchor,width=0) {
  const rect=anchor.getBoundingClientRect();
  const winWidth=document.documentElement.clientWidth;
  const winHeight=document.documentElement.clientHeight;
  const idealWidth=width||Math.max(190,rect.width);
  const menuWidth=Math.min(idealWidth,Math.max(160,winWidth-overlayMargin*2));
  element.style.width=menuWidth+"px";
  const availableBelow=winHeight-rect.bottom-overlayMargin;
  const availableAbove=rect.top-overlayMargin;
  const useAbove=availableBelow<180 && availableAbove>availableBelow;
  const maxHeight=Math.max(88,Math.min(310,
    useAbove ? availableAbove-7 : availableBelow-7));
  element.style.maxHeight=maxHeight+"px";
  const height=Math.min(element.scrollHeight,maxHeight);
  element.style.left=Math.max(overlayMargin,Math.min(
    rect.left,winWidth-menuWidth-overlayMargin))+"px";
  element.style.top=Math.max(overlayMargin,
    useAbove ? rect.top-height-7 : rect.bottom+7)+"px";
}
function buildNetbirdDropdownOptions(item) {
  const fragment=document.createDocumentFragment();
  const values=Array.from(item.select.options).filter(o=>!o.disabled);
  item.choices=[];
  for(const [index,option] of values.entries()) {
    const row=document.createElement("div");
    row.className="nb-select-option";
    row.id=item.listId+"-opt-"+index;
    row.setAttribute("role","option");
    row.setAttribute("aria-selected",String(option.value===item.select.value));
    row.dataset.value=option.value;
    const text=document.createElement("span");
    text.textContent=option.textContent;
    const check=document.createElementNS("http://www.w3.org/2000/svg","svg");
    check.setAttribute("viewBox","0 0 24 24");
    check.setAttribute("aria-hidden","true");
    const path=document.createElementNS("http://www.w3.org/2000/svg","path");
    path.setAttribute("d","M5 12l5 5L19 7");
    path.setAttribute("fill","none");
    path.setAttribute("stroke","currentColor");
    path.setAttribute("stroke-width","2.3");
    path.setAttribute("stroke-linecap","round");
    check.append(path);
    row.append(text,check);
    row.addEventListener("pointermove",()=>{
      if(netbirdOpenDropdown===item)setNetbirdActiveOption(item,index,false);
    });
    row.addEventListener("click",()=>{
      item.select.value=option.value;
      syncNetbirdSelect(item.id);
      closeNetbirdDropdown();
      item.select.dispatchEvent(new Event("change",{bubbles:true}));
      item.trigger.focus({preventScroll:true});
    });
    item.choices.push(row);
    fragment.append(row);
  }
  item.menu.replaceChildren(fragment);
  const idx=values.findIndex(option=>option.value===item.select.value);
  setNetbirdActiveOption(item,Math.max(0,idx),false);
}
function setNetbirdActiveOption(item,index,scroll=true) {
  if(!item.choices.length)return;
  item.activeIndex=Math.max(0,Math.min(index,item.choices.length-1));
  for(const [i,row] of item.choices.entries()) {
    row.classList.toggle("nb-option-active",i===item.activeIndex);
    if(i===item.activeIndex)item.menu.setAttribute("aria-activedescendant",row.id);
  }
  if(scroll)item.choices[item.activeIndex].scrollIntoView({block:"nearest"});
}
function openNetbirdDropdown(item,startingKey=null) {
  if(netbirdOpenDropdown===item){closeNetbirdDropdown();return;}
  closeNetbirdDropdown();
  // Inner Protocol and Event type menus belong to the open Filter panel.
  if(!item.host.closest(".nb-filter-portal"))closeNativeFilter(false);
  buildNetbirdDropdownOptions(item);
  item.menu.hidden=false;
  item.trigger.setAttribute("aria-expanded","true");
  netbirdOpenDropdown=item;
  if(startingKey==="ArrowDown")setNetbirdActiveOption(item,Math.min(
    item.activeIndex+1,item.choices.length-1),false);
  if(startingKey==="ArrowUp")setNetbirdActiveOption(item,Math.max(
    item.activeIndex-1,0),false);
  placeNetbirdOverlay(item.menu,item.trigger);
  item.menu.focus({preventScroll:true});
  item.choices[item.activeIndex]?.scrollIntoView({block:"nearest"});
}
function initializeNetbirdDropdowns() {
  for(const id of NATIVE_SELECT_IDS) {
    const select=$(id);
    if(!select || netbirdDropdowns.has(id))continue;
    const host=document.createElement("span");
    host.className="nb-select-host";
    const trigger=document.createElement("button");
    trigger.type="button";
    trigger.className="nb-select-trigger";
    trigger.setAttribute("aria-haspopup","listbox");
    trigger.setAttribute("aria-expanded","false");
    const listId="nb-list-"+id;
    trigger.setAttribute("aria-controls",listId);
    const text=document.createElement("span");
    text.className="nb-select-label";
    const arrow=document.createElementNS("http://www.w3.org/2000/svg","svg");
    arrow.setAttribute("viewBox","0 0 24 24");
    arrow.setAttribute("aria-hidden","true");
    const arrowPath=document.createElementNS("http://www.w3.org/2000/svg","path");
    arrowPath.setAttribute("d","m6 9 6 6 6-6");
    arrowPath.setAttribute("fill","none");
    arrowPath.setAttribute("stroke","currentColor");
    arrowPath.setAttribute("stroke-width","2");
    arrowPath.setAttribute("stroke-linecap","round");
    arrowPath.setAttribute("stroke-linejoin","round");
    arrow.append(arrowPath);
    trigger.append(text,arrow);
    const menu=document.createElement("div");
    menu.className="nb-select-menu";
    menu.id=listId;
    menu.hidden=true;
    menu.tabIndex=-1;
    menu.setAttribute("role","listbox");
    menu.setAttribute("aria-label",select.getAttribute("aria-label")||"Options");
    document.body.append(menu);
    select.parentNode.insertBefore(host,select);
    host.append(select,trigger);
    select.classList.add("nb-select-native");
    select.tabIndex=-1;
    select.setAttribute("aria-hidden","true");
    const item={id,select,host,trigger,text,menu,listId,choices:[],activeIndex:0};
    netbirdDropdowns.set(id,item);
    syncNetbirdSelect(id);
    trigger.addEventListener("click",()=>openNetbirdDropdown(item));
    trigger.addEventListener("keydown",event=>{
      if(["Enter"," ","ArrowDown","ArrowUp"].includes(event.key)){
        event.preventDefault();
        openNetbirdDropdown(item,event.key);
      }
    });
    menu.addEventListener("keydown",event=>{
      if(event.key==="Escape"){
        event.preventDefault();event.stopPropagation();closeNetbirdDropdown(true);
      }
      else if(event.key==="Tab"){closeNetbirdDropdown();}
      else if(["ArrowDown","ArrowUp","Home","End"].includes(event.key)){
        event.preventDefault();
        const idx=event.key==="Home"?0:
          event.key==="End"?item.choices.length-1:
          item.activeIndex+(event.key==="ArrowDown"?1:-1);
        setNetbirdActiveOption(item,idx);
      }else if(event.key==="Enter"||event.key===" "){
        event.preventDefault();item.choices[item.activeIndex]?.click();
      }
    });
    select.addEventListener("change",()=>syncNetbirdSelect(id));
  }
}
function placeNativeFilter() {
  if($("native-advanced").hidden)return;
  placeNetbirdOverlay($("native-advanced"),$("native-filter-toggle"),320);
}
function closeNativeFilter(restoreFocus=false) {
  const panel=$("native-advanced");
  if(panel.hidden)return;
  panel.hidden=true;
  $("native-filter-toggle").setAttribute("aria-expanded","false");
  if(restoreFocus)$("native-filter-toggle").focus({preventScroll:true});
}
function showNativeFilter() {
  closeNetbirdDropdown();
  $("native-advanced").hidden=false;
  $("native-filter-toggle").setAttribute("aria-expanded","true");
  placeNativeFilter();
}
function setupNativeFilterPortal() {
  const panel=$("native-advanced");
  document.body.append(panel);
  panel.classList.add("nb-filter-portal");
  panel.setAttribute("role","dialog");
  panel.setAttribute("aria-label","Traffic filters");
  panel.setAttribute("aria-modal","false");
  panel.hidden=true;
  $("native-filter-close").addEventListener("click",()=>{
    closeNetbirdDropdown();closeNativeFilter(true);
  });
  document.addEventListener("keydown",event=>{
    if(event.key==="Escape" && !panel.hidden && !netbirdOpenDropdown){
      event.preventDefault();closeNativeFilter(true);
    }
  });
  // Clicking outside always dismisses overlays; nested popup selections
  // never pass pointer clicks through to the underlying table icons.
  document.addEventListener("pointerdown",event=>{
    if(netbirdOpenDropdown &&
       !netbirdOpenDropdown.menu.contains(event.target) &&
       !netbirdOpenDropdown.trigger.contains(event.target))
      closeNetbirdDropdown();
    if(!panel.hidden &&
       !panel.contains(event.target) &&
       !$("native-filter-toggle").contains(event.target) &&
       !event.target.closest?.(".nb-select-menu"))closeNativeFilter();
  });
  window.addEventListener("resize",()=>{
    if(netbirdOpenDropdown)placeNetbirdOverlay(
      netbirdOpenDropdown.menu,netbirdOpenDropdown.trigger);
    placeNativeFilter();
  });
  // The iframe can scroll independently from the parent NetBird panel.
  window.addEventListener("scroll",()=>{
    if(netbirdOpenDropdown)placeNetbirdOverlay(
      netbirdOpenDropdown.menu,netbirdOpenDropdown.trigger);
    placeNativeFilter();
  },true);
}

const NATIVE_CHIP_DEFAULTS={
  "native-view":"compact",
  "native-search":"",
  "native-range":"172800",
  "native-user":"",
  "native-protocol":"0",
  "native-event-type":""
};
function removeNativeFilterChip(id) {
  if(!Object.hasOwn(NATIVE_CHIP_DEFAULTS,id))return;
  $(id).value=NATIVE_CHIP_DEFAULTS[id];
  if(id==="native-search")clearTimeout(nativeSearchDelay);
  if(id==="native-range"){
    $("native-from").value="";
    $("native-to").value="";
    $("native-custom-dates").hidden=true;
  }
  // Preserve every other filter; refresh the NetBird-style select label.
  closeNetbirdDropdown();
  syncNetbirdSelect(id);
  renderNativeFilterChips();
  void nativeRefilter();
}
function renderNativeFilterChips() {
  const target=$("native-active-filters");
  const chips=[];
  if($("native-view").value==="raw")chips.push(["native-view","View","All native reports"]);
  if($("native-search").value.trim()) chips.push(["native-search","Search",$("native-search").value.trim()]);
  if($("native-range").value!=="172800") chips.push(["native-range","Time",$("native-range").selectedOptions[0].text]);
  if($("native-user").value) chips.push(["native-user","User",$("native-user").selectedOptions[0].text]);
  if($("native-protocol").value!=="0") chips.push(["native-protocol","Protocol",$("native-protocol").selectedOptions[0].text]);
  if($("native-event-type").value) chips.push(["native-event-type","Event",$("native-event-type").selectedOptions[0].text]);
  target.replaceChildren();
  for(const [id,label,content] of chips){
    const chip=document.createElement("span");
    chip.className="native-filter-chip";
    const text=document.createElement("span");
    text.className="native-filter-chip-label";
    text.textContent=label+": "+content;
    const remove=document.createElement("button");
    remove.type="button";
    remove.className="native-filter-chip-remove";
    remove.setAttribute("aria-label","Remove "+label.toLowerCase()+" filter: "+content);
    remove.setAttribute("title","Remove "+label.toLowerCase()+" filter");
    remove.innerHTML='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12"/></svg>';
    remove.addEventListener("click",()=>removeNativeFilterChip(id));
    chip.append(text,remove);
    target.append(chip);
  }
  target.hidden=!chips.length;
}
function renderNativeSummary(data) {
  const keys=["total","received_24h","reporters","reports_with_drops"];
  const targets=["native-stat-total","native-stat-day","native-stat-peers","native-stat-drops"];
  const values=(data.available || data.receiver_online) && data.status && keys.every(
    key => Number.isFinite(Number(data.status[key])));
  for(let i=0;i<targets.length;i++)
    $(targets[i]).textContent=values?fmt(Number(data.status[keys[i]])):"—";
  const recent=values?Number(data.status.last_received||0):0;
  $("native-stat-last").textContent=recent?date(recent):"—";
  $("native-summary-status").textContent=data.available ?
    "Receiver online · native reports, not conntrack sessions" :
    data.receiver_online ? "Receiver online · traffic query failed" :
    "Native receiver unavailable — counts not confirmed";
}
function populateNativeUsers() {
  const dropdown=$("native-user");
  const selected=dropdown.value;
  dropdown.replaceChildren();
  const all=document.createElement("option");
  all.value="";all.textContent="All Users";dropdown.append(all);
  const eligible=new Set([...peerById.values()].map(p=>p.user_id).filter(Boolean));
  for(const user of nativeUsers) {
    if(!eligible.has(user.id))continue;
    const option=document.createElement("option");
    option.value=user.id;
    option.textContent=user.name||user.id;
    dropdown.append(option);
  }
  dropdown.value=selected && Array.from(dropdown.options)
    .some(option=>option.value===selected) ? selected : "";
  syncNetbirdSelect("native-user");
}
async function refreshNative(resetPage=false) {
  if (resetPage) nativePage=0;
  const version=++nativeRequestVersion;
  const query=new URLSearchParams({filtered:"1",
    page:String(nativePage),
    limit:$("native-page-size").value,
    sort:nativeSort,order:nativeDescending?"desc":"asc",
    protocol:$("native-protocol").value,
    state:$("native-event-type").value,
    compact:$("native-view").value==="compact"?"1":"0"});
  let userData;
  try {
    const time=nativeTimeFilters();
    query.set("start",String(time.start));
    query.set("end",String(time.end));
    const search=$("native-search").value.trim().slice(0,120);
    query.set("q",search);
    if(search) query.set("search_ips",nativeNameIPs(search).join(","));
    userData=nativeUserPeerFilter($("native-user").value);
    if (userData) {
      if (!userData.reporters.length) {
        nativeRowsLoaded=[];nativeTotal=0;
        renderNativeRows();renderNativePagination();
        $("native-note").textContent="No peers belonging to this user are available.";
        renderNativeFilterChips();
        return;
      }
      query.set("reporters",userData.reporters.join(","));
      query.set("ips",userData.ips.join(","));
    }
    renderNativeFilterChips();
    $("native-refresh").disabled=true;
    const data=await req("api/traffic/native?"+query.toString());
    if (version!==nativeRequestVersion)return;
    $("native-note").textContent=data.note||"Native peer event activity";
    $("native-table").hidden=!data.available;
    nativeRowsLoaded=Array.isArray(data.flows)?data.flows:[];
    nativeTotal=Number(data.total||0);
    renderNativeSummary(data);
    renderNativeRows();
    renderNativePagination();
  } catch(error) {
    if(version!==nativeRequestVersion)return;
    $("native-note").textContent="Unable to load traffic events: "+error.message;
    nativeRowsLoaded=[];nativeTotal=0;
    renderNativeRows();renderNativePagination();
    renderNativeSummary({available:false});
  } finally {
    if(version===nativeRequestVersion)$("native-refresh").disabled=false;
  }
}
function nativeRefilter() {
  nativeExpanded.clear();
  nativeTimelineCache.clear();
  return refreshNative(true);
}
let nativeSearchDelay=null;
$("native-search").addEventListener("input",()=>{
  clearTimeout(nativeSearchDelay);
  nativeSearchDelay=setTimeout(()=>{void nativeRefilter()},320);
});
$("native-range").addEventListener("change",()=>{
  $("native-custom-dates").hidden=$("native-range").value!=="custom";
  if($("native-range").value==="custom")showNativeFilter();
  void nativeRefilter();
});
for(const id of ["native-user","native-protocol","native-event-type","native-page-size",
                  "native-from","native-to","native-view"]) {
  $(id).addEventListener("change",()=>{void nativeRefilter()});
}
$("native-prev").addEventListener("click",()=>{
  if(nativePage>0){nativePage--;void refreshNative();}
});
$("native-next").addEventListener("click",()=>{
  if((nativePage+1)*Number($("native-page-size").value)<nativeTotal){
    nativePage++;void refreshNative();
  }
});
$("native-refresh").addEventListener("click",()=>void refreshNative());
$("native-clear").addEventListener("click",()=>{
  $("native-search").value="";
  $("native-range").value="172800";
  $("native-user").value="";
  $("native-protocol").value="0";
  $("native-event-type").value="";
  $("native-page-size").value="100";
  $("native-view").value="compact";
  $("native-from").value="";$("native-to").value="";
  $("native-custom-dates").hidden=true;
  closeNetbirdDropdown();
  closeNativeFilter();
  for(const id of NATIVE_SELECT_IDS)syncNetbirdSelect(id);
  void nativeRefilter();
});
$("native-filter-toggle").addEventListener("click",()=>{
  if($("native-advanced").hidden)showNativeFilter();
  else closeNativeFilter();
});
document.addEventListener("keydown",event=>{
  if ((event.ctrlKey||event.metaKey) && event.key.toLowerCase()==="k" &&
      page==="traffic-flow") {
    event.preventDefault();
    $("native-search").focus();
  }
  if(event.key==="Escape"){
    if(netbirdOpenDropdown)closeNetbirdDropdown(true);
    else closeNativeFilter(true);
  }
});
$("native-rows").addEventListener("click", event => {
  const toggle=event.target.closest?.("button[data-event-key]");
  if (!toggle || !$("native-rows").contains(toggle)) return;
  const key=toggle.dataset.eventKey;
  if(nativeExpanded.has(key))nativeExpanded.delete(key);
  else nativeExpanded.add(key);
  const row=nativeRowsLoaded.find(item=>nativeEventKey(item)===key);
  renderNativeRows();
  const replacement=Array.from($("native-rows").querySelectorAll("button[data-event-key]"))
    .find(b=>b.dataset.eventKey===key);
  replacement?.focus({preventScroll:true});
  if(nativeExpanded.has(key) && row)void loadNativeTimeline(row);
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
    const key=button.dataset.nativeSort;
    const next=key==="ts"?"time":key==="severity"?"event":key;
    if(nativeSort===next)nativeDescending=!nativeDescending;
    else{nativeSort=next;nativeDescending=true;}
    void nativeRefilter();
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
  nativeUsers=Array.isArray(event.data.users) ?
    event.data.users.filter(u=>u && typeof u.id==="string" && typeof u.name==="string").slice(0,1000) : [];
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
      peerById.set(peer.id, {name:peer.name,ip:peer.ip,ipv6:peer.ipv6,os:peer.os,user_id:peer.user_id});
  }
  populateNativeUsers();
  renderAnalytics();
  renderFlows();
  if(page==="traffic-flow")void nativeRefilter();
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
  // Legacy Linux/WFP collector events are independent of native peer reports.
  const results = await req("api/flows?limit=200");
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
      // Native NetBird reports are the Traffic Flow source. Legacy local
      // collector widgets are hidden and no longer polled from this view.
      await refreshNative();
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
initializeNetbirdDropdowns();
setupNativeFilterPortal();
start();
