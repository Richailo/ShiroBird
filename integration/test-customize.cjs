const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const source = fs.readFileSync(path.join(__dirname, "bridge.js"), "utf8");
const a = source.indexOf("  const FEATURE_LABELS =");
const b = source.indexOf("  let expanded =", a);
assert(a > 0 && b > a);
const wrap = {hidden: false, classList: {toggle(name, flag) {this[name] = flag;}}};
const target = {
  innerText: "Audit Events", textContent: "Audit Events",
  getAttribute() {return null;},
  closest(selector) {return selector === "[data-nav-item]" ? wrap : null;}
};
const nav = {querySelectorAll() {return [target];}};
const document = {
  querySelector(selector) {return selector === "[data-navigation]" ? nav : null;},
  querySelectorAll() {return [];},
  getElementById() {return null;}
};
const window = {addEventListener() {}};
const adapter = Function("document", "window", "NAV_ID", "VIEW_ID", "location",
  source.slice(a,b) + "\nreturn {visibility,featureForLabel,applyVisibility,receiveVisibility};"
)(document,window,"shirobird-nav-link","shirobird-integrated-view",{origin:"http://localhost"});
assert.equal(adapter.visibility["audit-events"],true);
assert.equal(adapter.visibility["activity"],true);
assert.equal(adapter.visibility["posture-checks"],true);
assert.equal(adapter.visibility["traffic-events"],false);
assert.equal(adapter.visibility["peers"],true);
assert.equal(adapter.featureForLabel("Network Routes"),"network-routes");
assert.equal(adapter.featureForLabel("Device Approvals"),"device-approvals");
adapter.applyVisibility();
assert.equal(wrap.classList["shirobird-custom-hidden"],false);
adapter.receiveVisibility({"audit-events":false,"unrecognized":false,"peers":"no"});
assert.equal(wrap.classList["shirobird-custom-hidden"],true);
assert.equal(adapter.visibility.peers,true);
assert.equal(adapter.visibility.unrecognized,undefined);
console.log("Feature visibility defaults, mapping and safe updates passed.");
