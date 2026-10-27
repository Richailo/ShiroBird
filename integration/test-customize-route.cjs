/* Regression: Customize is hosted by the bridge, never by the updatable SIEM iframe. */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const source = fs.readFileSync(path.join(__dirname,"bridge.js"),"utf8");
const from = source.indexOf("  function showPage() {");
const to = source.indexOf("  async function netbirdLogin()",from);
assert.ok(from>0 && to>from);
const panelView = {hidden:true};
const frame = {
  hidden:false,
  attributes:{src:"/shirobird/?embedded=1&view=siem-integration&theme=dark"},
  getAttribute(key){return this.attributes[key]||null;},
  setAttribute(key,value){this.attributes[key]=value;},
  contentWindow:{postMessage(){}}
};
const message = {hidden:true};
const panel = {querySelector(key){
  if(key==="iframe") return frame;
  if(key==="#customize-view") return panelView;
  if(key===".shirobird-auth-message") return message;
  return null;
}};
const document = {
  getElementById(id){return id==="shirobird-integrated-view"?panel:null;},
  documentElement:{classList:{contains(){return true;}}}
};
let selected = {slug:"siem-integration"};
let loaded=0, themes=0;
const window = {addEventListener(){}};
const methods = Function("document","window","location","VIEW_ID","selectedPage",
  "fetchCustomize","applyTheme",
  "let frameReady=true, loadedPage='siem-integration', lastAuth=1234, directoryFetchedAt=Date.now();"+
  "const netbirdToken=()=>null,updatePeerDirectory=()=>{};"+source.slice(from,to)+
  "\nreturn {showPage};"
)(document,window,{origin:"https://example.com"},"shirobird-integrated-view",
  ()=>selected,()=>{loaded++;},()=>{themes++;});
methods.showPage();
assert.equal(frame.hidden,false);
selected={slug:"customize"};
methods.showPage();
assert.equal(panelView.hidden,false,"Customize view must be shown");
assert.equal(frame.hidden,true,"Stale SIEM iframe must ALWAYS be hidden");
assert.equal(message.hidden,true);
assert.equal(loaded,1);
const original = frame.attributes.src;
selected={slug:"siem-integration"};
methods.showPage();
assert.equal(panelView.hidden,true);
assert.equal(frame.hidden,false);
assert.equal(frame.attributes.src,original,"SIEM iframe should be reused when returning");
selected={slug:"customize"};
methods.showPage();
assert.equal(panelView.hidden,false);
assert.equal(frame.hidden,true);
assert.equal(loaded,2);
assert.ok(themes>=4);
assert.match(source,/createCustomizeView\(panel\)/);
assert.match(source,/if \(customizing\) \{/);
assert.match(source,/void fetchCustomize\(\)/);
assert.match(source,/const customizing = page\.slug === "customize"/);
console.log("Customize always hides the SIEM iframe and keeps a separate native view.");
