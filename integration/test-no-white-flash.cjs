/* Regression test: no white about:blank and no iframe navigation on tab/theme changes. */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const parent = fs.readFileSync(path.join(__dirname, "bridge.js"), "utf8");
const child = fs.readFileSync(path.join(__dirname, "..", "web", "app.js"), "utf8");

const start = parent.indexOf("  function showPage() {");
const end = parent.indexOf("  async function netbirdLogin() {", start);
assert.ok(start > 0 && end > start, "stable frame lifecycle exists");
const emitted = [];
let messages = {};
let page = {slug:"traffic-flow"};
let dark = true;
const frame = {
  hidden:true,
  attributes:{},
  contentWindow: {
    postMessage(payload, origin) { emitted.push({payload,origin}); }
  },
  getAttribute(name) {return this.attributes[name] || null;},
  setAttribute(name, value) {this.attributes[name] = value;}
};
const notice = {hidden:true};
const panel = {querySelector(sel) {
  return sel==="iframe" ? frame : sel===".shirobird-auth-message" ? notice : null;
}};
const document = {getElementById:id=>id==="shirobird-integrated-view"?panel:null,
  documentElement:{classList:{contains:()=>dark}}};
const window = {addEventListener(name, callback) {messages[name]=callback;}};
const location = {origin:"https://netbird.test"};
let frameReady = false, loadedPage=null, lastAuth=100;
let themes = 0;
let peers=0;
const methods = Function("document","window","VIEW_ID","location","selectedPage",
 "applyTheme","sendPeersToFrame","initial",
  "let frameReady=initial.frameReady,loadedPage=initial.loadedPage,lastAuth=initial.lastAuth;\n" +
  "let directoryFetchedAt=Date.now(); const netbirdToken=()=>null; const updatePeerDirectory=()=>{};\n" +
  parent.slice(start,end) +
  "\nreturn {showPage,getState:()=>({frameReady,loadedPage})};"
)(document, window, "shirobird-integrated-view", location, ()=>page,
 ()=>{themes++},()=>{peers++},
 {frameReady,loadedPage,lastAuth});
methods.showPage();
assert.equal(frame.hidden,true,"first iframe never visible before ready");
assert.match(frame.attributes.src,/view=traffic-flow&theme=dark/);
const firstSrc = frame.attributes.src;
assert.equal(notice.hidden,true);
assert.equal(methods.getState().frameReady,false);
methods.showPage();
assert.equal(frame.attributes.src,firstSrc,"repeat refresh does not reload");
messages.message({origin:"https://outside.example",source:frame.contentWindow,
  data:{source:"shirobird-ready",view:"traffic-flow"}});
assert.equal(frame.hidden,true,"reject unrelated origin");
messages.message({origin:location.origin,source:{},
  data:{source:"shirobird-ready",view:"traffic-flow"}});
assert.equal(frame.hidden,true,"reject foreign source");
messages.message({origin:location.origin,source:frame.contentWindow,
  data:{source:"shirobird-ready",view:"traffic-flow"}});
assert.equal(frame.hidden,false,"show only after app-ready message");
assert.ok(themes>0);
dark=false; methods.showPage();
assert.equal(frame.attributes.src,firstSrc,"theme toggles must not navigate iframe");
page={slug:"siem-integration"};
methods.showPage();
assert.equal(frame.attributes.src,firstSrc,"tab navigation must not reload iframe");
assert.equal(emitted.at(-1).payload.source,"shirobird-navigate");
assert.equal(emitted.at(-1).payload.view,"siem-integration");
assert.equal(emitted.at(-1).origin,location.origin);
assert.equal(notice.hidden,true);

assert.match(child,/function notifyParentReady\(\)/);
assert.match(child,/window\.parent\.postMessage\(\{source: "shirobird-ready"/);
assert.match(child,/finally\s*\{\s*notifyParentReady\(\)/);
assert.match(child,/function switchEmbeddedView\(nextPage\)/);
assert.match(child,/stream\.close\(\)/);
assert.doesNotMatch(parent.slice(start,end),/frame\.setAttribute\("src", url\);[\s\S]*?else if \(frameReady[^)]*\)[\s\S]*?frame\.setAttribute\("src"/,
  "reusing frame cannot accidentally navigate");
console.log("No-flash handshake, dark theme, same-origin messaging and iframe reuse passed.");
