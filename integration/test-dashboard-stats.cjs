/* Prevent stale "0 events" totals caused by mixing conntrack and NetBird. */
const assert=require("node:assert/strict");
const fs=require("node:fs");
const path=require("node:path");
const html=fs.readFileSync(path.join(__dirname,"..","web","index.html"),"utf8");
const app=fs.readFileSync(path.join(__dirname,"..","web","app.js"),"utf8");
for(const id of ["native-stat-total","native-stat-day","native-stat-peers",
                 "native-stat-drops","native-stat-last","native-summary-status"])
  assert.ok(html.includes('id="'+id+'"'),"missing native summary "+id);
assert.ok(!html.includes("Aggregated traffic flows"),"old aggregated panel removed");
assert.ok(!html.includes('id="flow-groups"'),"old event renderer removed");
assert.ok(!html.includes('id="total"'),"ambiguous legacy total removed");
assert.ok(html.indexOf('id="native-stat-total"')<html.indexOf('id="native-table"'),
  "real counters appear above native event table");
assert.ok(html.indexOf('id="flow-starts"')>html.indexOf('id="native-table"'),
  "legacy collector widgets are retained only in a hidden compatibility section");
assert.match(html,/<div id="legacy-local-observability" hidden aria-hidden="true">/,
  "Local monitoring is not visible in Traffic Flow");
assert.ok(!app.includes('$("flow-groups")'),"renderer cannot access removed DOM");
assert.ok(!app.includes('$("total")'),"old conntrack counts not shown as native");
const start=app.indexOf("function renderNativeSummary(data) {");
const end=app.indexOf("function populateNativeUsers() {",start);
assert.ok(start>0 && end>start);
const nodes=new Map();
const $=id=>{
 if(!nodes.has(id))nodes.set(id,{textContent:"—"});
 return nodes.get(id);
};
const fmt=n=>Number(n||0).toLocaleString("en-US");
const date=n=>n?new Date(n*1000).toISOString():"—";
const render=Function("$","fmt","date",
  app.slice(start,end)+"\nreturn renderNativeSummary;")($,fmt,date);
render({available:true,status:{total:1973,received_24h:1310,reporters:2,
  reports_with_drops:398,last_received:1793022716}});
assert.equal($("native-stat-total").textContent,"1,973");
assert.equal($("native-stat-day").textContent,"1,310");
assert.equal($("native-stat-peers").textContent,"2");
assert.equal($("native-stat-drops").textContent,"398");
assert.notEqual($("native-stat-last").textContent,"—");
assert.match($("native-summary-status").textContent,/not conntrack/);
render({available:false});
assert.equal($("native-stat-total").textContent,"—",
  "unavailable source must not masquerade as zero events");
assert.match($("native-summary-status").textContent,/unavailable/);
render({available:false,receiver_online:true,
 status:{total:1973,received_24h:1310,reporters:2,
 reports_with_drops:398,last_received:1793022716},
 note:"Native receiver rejected traffic filters (HTTP 400)."});
assert.equal($("native-stat-total").textContent,"1,973",
  "upstream query error must retain valid online receiver counters");
assert.match($("native-summary-status").textContent,/traffic query failed/);
render({available:true,status:{total:0,received_24h:0,reporters:0,
  reports_with_drops:0,last_received:null}});
assert.equal($("native-stat-total").textContent,"0",
  "real measured zeros should still show as zeros");
console.log("Native event top metrics, separated conntrack, zero-state and failure-state verified.");
