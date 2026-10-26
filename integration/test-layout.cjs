/* Fixed overlay geometry and responsive iframe regression tests. */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const script = fs.readFileSync(path.join(__dirname, "bridge.js"), "utf8");
const css = fs.readFileSync(path.join(__dirname, "bridge.css"), "utf8");
const ui = fs.readFileSync(path.join(__dirname, "..", "web", "style.css"), "utf8");

const begin = script.indexOf("  function panelGeometry(");
const end = script.indexOf("  // Matches NetBird SidebarItem", begin);
assert.ok(begin >= 0 && end > begin, "panel positioning exists");
let right = 64;
let top = 98;
let visible = true;
const nav = {getBoundingClientRect: () => ({right, top})};
const panel = {style: {}, get hidden(){return !visible;}};
const document = {
  getElementById: id => id === "shirobird-integrated-view" ? panel : null,
  querySelector: sel => sel === "[data-navigation]" ? nav : null
};
const window = {innerWidth: 1200, innerHeight: 900};
class ResizeObserver {
  constructor(callback) { this.callback = callback; }
  observe() {}
  disconnect() {}
}
const helpers = Function("document", "window", "ResizeObserver", "VIEW_ID",
  script.slice(begin, end) + "\nreturn { panelGeometry, positionPanel };"
)(document, window, ResizeObserver, "shirobird-integrated-view");

helpers.positionPanel();
assert.equal(panel.style.left, "64px", "collapsed NetBird 64px navigation");
assert.equal(panel.style.top, "98px", "aligned below NetBird header");
assert.equal(panel.style.width, "1136px", "iframe fills visible content area");

right = 240;
helpers.positionPanel();
assert.equal(panel.style.left, "240px", "expanded NetBird 240px navigation");
assert.equal(panel.style.width, "960px", "iframe shrinks as navigation expands");

right = 155;
helpers.positionPanel();
assert.equal(panel.style.left, "155px", "hover transition intermediate width");
assert.equal(panel.style.width, "1045px", "hover transition never exposes Peers strip");

window.innerWidth = 375;
right = 64;
helpers.positionPanel();
assert.equal(panel.style.width, "311px", "mobile panel fits remaining viewport");
window.innerWidth = 1200;

visible = false;
helpers.positionPanel();
assert.equal(panel.style.width, "311px", "hidden panel is not unnecessarily moved");

assert.match(css, /#shirobird-integrated-view \{[\s\S]*?overflow: hidden;/);
assert.match(css, /#shirobird-integrated-view iframe \{[\s\S]*?min-width: 0;/);
assert.match(ui, /body\.embedded main \{[\s\S]*?max-width: 100%;/);
assert.match(ui, /body\.embedded \.tablewrap \{[\s\S]*?overflow-x: auto;/);
assert.match(ui, /body\.embedded \.flow-caveat,[\s\S]*?overflow-wrap: anywhere;/);
assert.match(script, /new ResizeObserver\(\(\) => positionPanel\(\)\)/);
console.log("NetBird collapsed/expanded/hover geometry and embedded responsive layout passed.");
