/* Native Traffic Events toolbar: selectors and filter semantics. */
const assert=require("node:assert/strict");
const fs=require("node:fs");
const path=require("node:path");
const html=fs.readFileSync(path.join(__dirname,"..","web","index.html"),"utf8");
const js=fs.readFileSync(path.join(__dirname,"..","web","app.js"),"utf8");
const css=fs.readFileSync(path.join(__dirname,"..","web","style.css"),"utf8");
const ids=[
  "native-stream-card","native-stream-status","native-search","native-range",
  "native-user","native-filter-toggle","native-advanced","native-protocol",
  "native-event-type","native-custom-dates","native-from","native-to",
  "native-page-size","native-refresh","native-clear","native-prev","native-next",
  "native-results-count","native-active-filters"
];
for(const id of ids){
  assert.match(html,new RegExp('id="'+id+'"'),"missing "+id);
}
assert.equal((html.match(/id="native-next"/g)||[]).length,1);
assert.match(css,/\.native-stream-status\.receiving/);
assert.match(css,/\.native-advanced\[hidden\]/);
assert.match(js,/filtered:"1"/);
assert.match(js,/nativeSort,order:nativeDescending\?"desc":"asc"/);
const begin=js.indexOf("function nativeTimeFilters() {");
const end=js.indexOf("function renderNativeFilterChips()",begin);
assert.ok(begin>0 && end>begin);
const inputs={
  "native-range":{value:"172800"},
  "native-from":{value:""},
  "native-to":{value:""}
};
const $=id=>inputs[id];
const peerById=new Map([
  ["a",{name:"Peer A",user_id:"user1",ip:"100.64.0.10"}],
  ["b",{name:"Peer B",user_id:"user1",ip:"100.64.0.11"}],
  ["c",{name:"Peer C",user_id:"user2",ip:"100.64.0.12"}]
]);
const peerByIP=new Map([
  ["100.64.0.10",{name:"Peer A"}],
  ["100.64.0.11",{name:"Peer B"}],
  ["100.64.0.12",{name:"Peer C"}]
]);
const check=Function("$","peerById","peerByIP",
  js.slice(begin,end)+"\nreturn {nativeTimeFilters,nativeUserPeerFilter,nativeNameIPs};")(
  $,peerById,peerByIP
);
const recent=check.nativeTimeFilters();
assert.ok(recent.start>0 && Math.abs(Date.now()/1000-recent.start-172800)<10);
assert.equal(recent.end,0);
inputs["native-range"].value="0";
assert.equal(check.nativeTimeFilters().start,0);
inputs["native-range"].value="custom";
inputs["native-from"].value="2026-10-24T09:30";
inputs["native-to"].value="2026-10-25T15:20";
assert.ok(check.nativeTimeFilters().start<check.nativeTimeFilters().end);
inputs["native-from"].value="2026-10-26T20:30";
assert.throws(()=>check.nativeTimeFilters(),/valid date/);
const group=check.nativeUserPeerFilter("user1");
assert.deepEqual(group.reporters,["a","b"]);
assert.deepEqual(group.ips,["100.64.0.10","100.64.0.11"]);
assert.deepEqual(check.nativeNameIPs("peer b"),["100.64.0.11"]);
assert.equal(check.nativeUserPeerFilter("user-missing").reporters.length,0);
assert.match(js,/shirobird-request-tab/);
console.log("NetBird-style toolbar controls, time ranges, real user/peer filters and icon controls passed.");
