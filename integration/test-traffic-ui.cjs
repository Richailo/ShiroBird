/* Native Traffic Flow presentation tests: no DOM library needed. */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const source = fs.readFileSync(path.join(__dirname,"..","web","app.js"),"utf8");
const html = fs.readFileSync(path.join(__dirname,"..","web","index.html"),"utf8");
const css = fs.readFileSync(path.join(__dirname,"..","web","style.css"),"utf8");
const start=source.indexOf('const trafficNS = "http://www.w3.org/2000/svg"');
const stop=source.indexOf('let nativeRowsLoaded = [];',start);
assert.ok(start > 0 && stop > start,"native DOM helpers found");
class Node {
  constructor(tag){this.tagName=tag;this.children=[];this.attributes={};this.dataset={};
    this.textContent="";this.className="";this.title="";}
  append(...nodes){this.children.push(...nodes);}
  setAttribute(key,val){this.attributes[key]=String(val);}
}
const document={
  createElement:tag=>new Node(tag),
  createElementNS:(_ns,tag)=>new Node(tag)
};
const peerByIP=new Map([
  ["100.64.1.10",{name:"WINN-10",os:"Windows 11"}],
  ["100.64.1.11",{name:"MacBook",os:"Darwin"}],
  ["100.64.1.12",{name:"LINUX",os:"Ubuntu 24.04"}]
]);
const peerById=new Map([["peer1",{name:"WINN-10",ip:"100.64.1.10",os:"Windows 11"}]]);
const fmt=n=>Number(n||0).toLocaleString("en-US");
const humanBytes=n=>n===0?"0 B":n<1024?n+" B":(n/1024).toFixed(1)+" KB";
const helper=Function("document","peerByIP","peerById","fmt","humanBytes","date",
  source.slice(start,stop)+
  "\nreturn {osKind,nativeIcon,nativePeer,nativeProtocol,nativeSeverity,nativeEventDescription,nativeEventCell,nativeTrafficCell,nativeRouterCell,resolveNativeRouter,resolveNativePolicy,nativeInlineEvidence,nativeTimelineRows,nativeEventKey,nativeFlowIdentity,sameNativeConnection,setDirectory:d=>{nativeDirectory=d},setExpanded:k=>nativeExpanded.add(k),setCache:(k,v)=>nativeTimelineCache.set(k,v)};")(
    document,peerByIP,peerById,fmt,humanBytes,n=>new Date(n*1000).toISOString());
const treeText=node=>[node.textContent||"",...node.children.map(treeText)].join(" ");
assert.equal(helper.osKind("Windows 11"),"windows");
assert.equal(helper.osKind("Darwin"),"macos");
assert.equal(helper.osKind("Debian GNU/Linux"),"linux");
assert.equal(helper.osKind("iOS"),"mobile");
assert.equal(helper.osKind("Unknown"),"monitor");
const windows=helper.nativePeer("100.64.1.10",55444);
assert.equal(windows.children[0].children[0].tagName,"img","Windows uses upstream Font Awesome asset");
assert.equal(windows.children[0].children[0].attributes.src,"icons/windows.svg");
assert.match(treeText(windows),/WINN-10/);
assert.match(treeText(windows),/100.64.1.10:55444/);
const mac=helper.nativePeer("100.64.1.11");
assert.match(mac.children[0].title,/MACOS/);
assert.equal(mac.children[0].children[0].attributes.src,"icons/macos.svg");
const linux=helper.nativePeer("100.64.1.12");
assert.match(linux.children[0].title,/LINUX/);
assert.equal(linux.children[0].children[0].attributes.src,"icons/linux.svg");
const unknown=helper.nativePeer("8.8.8.8");
assert.match(unknown.children[0].title,/Network resource/);
assert.doesNotMatch(treeText(unknown),/Windows|Linux/);
const row={ts:1730000000,protocol:6,dport:443,src:"100.64.1.10",
  dst:"100.64.1.11",reporter_id:"peer1",direction:2,
  rx_bytes:1024,tx_bytes:2048,num_of_starts:1,
  num_of_ends:1,num_of_drops:0};
const directions=helper.nativeTrafficCell(row);
assert.equal(directions.children.length,2,"RX and TX show as distinct rows");
assert.equal(directions.children[0].children[0].children[0].tagName,"svg");
assert.equal(directions.children[1].children[0].children[0].tagName,"svg");
assert.equal(directions.children[0].children[0].children[0].children[0].attributes.d,"M12 5v14");
assert.equal(directions.children[1].children[0].children[0].children[0].attributes.d,"M12 19V5");
assert.match(treeText(directions),/1.0 KB/);
assert.match(treeText(directions),/2.0 KB/);
assert.match(directions.children[0].children[0].attributes["aria-label"],/Received/);
assert.match(directions.children[1].children[0].attributes["aria-label"],/Sent/);
assert.equal(helper.nativeSeverity(row),"started");
assert.match(helper.nativeEventDescription(row),/requested/);
assert.match(treeText(helper.nativeEventCell(row)),/Connection requested by peer/);
assert.equal(helper.nativeSeverity({...row,num_of_drops:4}),"mixed");
assert.match(helper.nativeEventDescription({...row,num_of_drops:4}),/blocked attempts/);
assert.equal(helper.nativeSeverity({...row,num_of_starts:0,num_of_drops:4}),"blocked");
assert.equal(helper.nativeSeverity({...row,num_of_starts:0,num_of_ends:1}),"ended");
assert.equal(helper.nativeProtocol(row).children[0].children[0].tagName,"svg","Exact Lucide Share2 protocol symbol");
assert.equal(helper.nativeProtocol(row).children[1].textContent,"443");
assert.match(treeText(helper.nativeProtocol({...row,protocol:1,icmp_type:8})),/Echo request/);
assert.equal(treeText(helper.nativeRouterCell(row)).trim(),"—",
  "P2P reporter must not be mislabeled as routing peer");
assert.equal(treeText(helper.nativeRouterCell({
  ...row,destination_resource_id:"abcd",direction:2})).trim(),"—",
  "Initiating peer must not be labeled a routing peer");
assert.equal(treeText(helper.nativeRouterCell({
  ...row,destination_resource_id:"abcd",direction:1})).trim(),"—",
  "A reporting peer alone is not verified as a router");
const hex=s=>Buffer.from(s).toString("hex");
helper.setDirectory({complete:true,policies:[
  {id:"policy1",name:"SSH access",rules:[{id:"rule1",name:"TCP 22",action:"accept"}]}
],routes:[{id:"route1",network_id:"Group 1",name:"LAN1",
           peer:"peer1",enabled:true,peer_groups:[]}],networks:[]});
const routed={...row,destination_resource_id:hex("route1"),direction:2};
assert.equal(helper.resolveNativeRouter(routed).peerId,"peer1",
  "Routing is recovered from configuration for outgoing reporter too");
assert.match(treeText(helper.nativeRouterCell(routed)),/WINN-10/);
assert.equal(helper.resolveNativePolicy({...routed,rule_id:""}).state,"missing",
  "No policy is invented when NetBird omitted rule_id");
const verified=helper.resolveNativePolicy({...routed,rule_id:hex("rule1")});
assert.equal(verified.state,"matched");
assert.equal(verified.policyName,"SSH access");
assert.equal(verified.ruleName,"TCP 22");
assert.equal(verified.action,"accept");
const evidence=helper.nativeInlineEvidence({...routed,rule_id:hex("rule1"),
  flow_id:"abc123",event_id:"event123"});
assert.match(treeText(evidence),/SSH access/);
assert.match(treeText(evidence),/NetBird configuration/);
const selected={...routed,flow_id:"a".repeat(32),
  event_id:"b".repeat(32),num_of_drops:0,num_of_ends:0};
const prior={...selected,event_id:"c".repeat(32),num_of_starts:0,
  num_of_ends:1,ts:selected.ts+60};
const otherPeer={...selected,reporter_id:"peer-OTHER",
  event_id:"d".repeat(32)};
const otherAddress={...selected,dst:"10.0.0.200",
  event_id:"e".repeat(32)};
assert.equal(helper.sameNativeConnection(selected,prior),true);
assert.equal(helper.sameNativeConnection(selected,otherPeer),false);
assert.equal(helper.sameNativeConnection(selected,otherAddress),false);
const identity=helper.nativeFlowIdentity(selected);
assert.equal(identity,"peer1:"+selected.flow_id);
helper.setCache(identity,{flows:[prior,otherPeer,selected,otherAddress],total:4});
helper.setExpanded(helper.nativeEventKey(selected));
const timeline=helper.nativeTimelineRows(selected);
assert.equal(timeline.length,2,"timeline only contains confirmed same-flow reports");
const cell=helper.nativeEventCell(selected);
assert.match(treeText(cell),/Connection requested by peer/);
assert.match(treeText(cell),/Connection stopped/);
assert.match(treeText(cell),/Policy/);
const toggles=cell.children[0].children.flatMap(item=>item.children[1]?.children[1]?.children||[])
  .filter(item=>item.tagName==="button");
assert.equal(toggles.length,1,"one inline chevron; no Details button");
assert.equal(toggles[0].attributes["aria-expanded"],"true");
assert.equal(helper.nativeFlowIdentity({...selected,flow_id:""}),"");
assert.equal(helper.nativeFlowIdentity({...selected,reporter_id:""}),"");
const grouped={...selected,grouped:true,activity_key:"abcDEF12",service_port:8006,
  report_count:5,flow_count:4,num_of_starts:9,num_of_ends:7,num_of_drops:1};
helper.setCache("activity:abcDEF12",{flows:[prior,otherPeer,selected],total:3});
helper.setExpanded(helper.nativeEventKey(grouped));
assert.equal(helper.nativeEventKey(grouped),"activity:abcDEF12");
assert.equal(helper.nativeFlowIdentity(grouped),"activity:abcDEF12");
assert.equal(helper.nativeTimelineRows(grouped).length,4,
  "compact summary expands genuine separate reporter-perspective raw reports");
const compactCell=helper.nativeEventCell(grouped);
assert.match(treeText(compactCell),/5 recorded reports/);
assert.match(treeText(compactCell),/4 distinct flow IDs/);
assert.match(treeText(compactCell),/Activity grouping only/);
assert.equal(helper.nativeProtocol(grouped).children[1].textContent,"8006");
assert.equal(treeText(helper.nativeRouterCell(grouped)),"Per report",
  "independent connections must not be assigned the same guessed router");

helper.setDirectory({complete:true,policies:[],routes:[
  {id:"route1",peer:"peer1",enabled:true,peer_groups:[]},
  {id:"route1",peer:"peer2",enabled:true,peer_groups:[]}
],networks:[]});
const ambiguous=helper.resolveNativeRouter({...routed,reporter_id:"client"});
assert.equal(ambiguous.state,"ambiguous");
assert.equal(ambiguous.peerId,undefined);
assert.equal(helper.resolveNativeRouter({...routed,reporter_id:"peer1"}).peerId,"peer1");
// Real NetBird FlowService sends ASCII resource IDs encoded as bytes, while
// the Networks API exposes their plain identifiers.
helper.setDirectory({complete:true,policies:[],routes:[],
  networks:[{id:"network1",name:"Office",routerPeers:["peer1"],routerGroups:[],
    resources:[{id:"resource-14",name:"Office LAN",address:"192.168.0.0/24"}]}]});
const routedResource={...row,reporter_id:"client",
  destination_resource_id:hex("resource-14")};
assert.equal(helper.resolveNativeRouter(routedResource).peerId,"peer1");
assert.equal(helper.resolveNativeRouter(routedResource).resourceName,"Office LAN");
assert.equal(helper.resolveNativePolicy(routedResource).state,"missing");
helper.setDirectory({complete:true,policies:[],routes:[],
  networks:[{id:"network1",routerPeers:["peer1"],routerGroups:["dynamic-group"],
    resources:[{id:"resource-14"}]}]});
assert.equal(helper.resolveNativeRouter(routedResource).state,"ambiguous",
  "Dynamic peer groups cannot be treated as unique routers");

assert.ok(html.includes('data-native-sort="ts"'),"sortable native time header");
assert.ok(html.includes('data-native-sort="src"'),"sortable source header");
assert.ok(html.includes('data-native-sort="dst"'),"sortable destination header");
assert.ok(html.includes("PROTOCOL &amp; PORT"),"native column layout");
assert.ok(css.includes(".native-traffic-rx .native-traffic-arrow"),"RX styling");
assert.ok(css.includes(".native-traffic-tx .native-traffic-arrow"),"TX styling");

const sortGlyph=Function("document", "trafficNS", source.slice(
  source.indexOf("function tablerSortIcon(descending) {"),
  source.indexOf("function nativePeer(ip, port=0) {"))+"\nreturn tablerSortIcon")(
  document,"http://www.w3.org/2000/svg");
assert.equal(sortGlyph(true).children[0].attributes.d,"M4 6l9 0","Tabler descending glyph");
assert.equal(sortGlyph(false).children[0].attributes.d,"M4 6l7 0","Tabler ascending glyph");
assert.match(css,/native-library-icon/, "Native NetBird library icon styles");

console.log("Original NetBird icon libraries, traffic arrows, sorting and flow semantics passed.");
