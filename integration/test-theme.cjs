/* Regression tests for NetBird light/dark token parity and safe iframe sync. */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const bridge = fs.readFileSync(path.join(__dirname, "bridge.js"), "utf8");
const css = fs.readFileSync(path.join(__dirname, "..", "web", "style.css"), "utf8");
const sidebar = fs.readFileSync(path.join(__dirname, "bridge.css"), "utf8");
const app = fs.readFileSync(path.join(__dirname, "..", "web", "app.js"), "utf8");

const first = bridge.indexOf("  function netbirdPalette(dark) {");
const last = bridge.indexOf("  function applyTheme()", first);
assert.ok(first > 0 && last > first, "same-origin palette extraction exists");
const values = {};
const window = { getComputedStyle: () => ({
  getPropertyValue: name => values[name] ?? ""
}) };
const palette = Function("window", "document",
  bridge.slice(first, last) + "\nreturn netbirdPalette;"
)(window, {documentElement:{}});
const dark = palette(true);
const light = palette(false);
assert.equal(dark["--page"], "#181a1d");
assert.equal(dark["--surface"], "#1c1e21");
assert.equal(dark["--stroke"], "#2e3238");
assert.equal(dark["--primary"], "#f68330");
assert.equal(light["--surface"], "#ffffff");
assert.equal(light["--page"], "#f9fafb");

values["--color-nb-gray"] = "#202429";
values["--color-netbird"] = "#f46d1b";
values["--color-nb-gray-940"] = "#292d32";
values["--color-nb-gray-900"] = "#373c43";
const live = palette(true);
assert.equal(live["--page"], "#202429");
assert.equal(live["--surface"], "#292d32");
assert.equal(live["--stroke"], "#373c43");
assert.equal(live["--primary"], "#f46d1b");
values["--color-netbird"] = "url(https://example.com/evil.css)";
assert.equal(palette(true)["--primary"], "#f68330", "CSS values are sanitized");

const begin = app.indexOf("const NETBIRD_THEME_KEYS");
const stop = app.indexOf("let flows", begin);
assert.ok(begin >= 0 && stop > begin, "iframe theme listener exists");
let receive;
const updated = {};
const classState = {};
const parent = {};
const frame = {
  parent,
  addEventListener: (type, cb) => {
    if (type === "message") receive = cb;
  }
};
const document = {documentElement:{
  classList: {toggle: (key, enabled) => {classState[key] = enabled;}},
  style: {setProperty: (key, val) => {updated[key] = val;}}
}};
Function("window", "document", "location", app.slice(begin, stop))(
  frame, document, {origin:"https://netbird.test"}
);
assert.equal(typeof receive, "function");
receive({origin:"https://other.test",source:parent,
  data:{source:"shirobird-theme",dark:true,palette:{"--page":"#123456"}}});
assert.equal(updated["--page"], undefined, "reject different origin");
receive({origin:"https://netbird.test",source:{},
  data:{source:"shirobird-theme",dark:true,palette:{"--page":"#abcdef"}}});
assert.equal(updated["--page"], undefined, "reject untrusted child frame");
receive({origin:"https://netbird.test",source:parent,
  data:{source:"shirobird-theme",dark:true,palette:{
    "--page":"#202429", "--surface":"#292d32",
    "--sneaky": "#f00", "--accent":"url(javascript:alert(1))"}}});
assert.equal(updated["--page"], "#202429");
assert.equal(updated["--surface"], "#292d32");
assert.equal(updated["--sneaky"], undefined);
assert.equal(updated["--accent"], undefined);
assert.equal(classState.dark, true);
receive({origin:"https://netbird.test",source:parent,
  data:{source:"shirobird-theme",dark:false,palette:light}});
assert.equal(classState.dark, false);
assert.equal(updated["--page"], "#f9fafb");
assert.ok(css.includes("--surface:#1c1e21"), "NetBird dark card palette");
assert.ok(css.includes("--primary:#f68330"), "NetBird orange accent");
assert.ok(!css.includes("#384ce5"), "old arbitrary blue buttons removed");
assert.ok(!css.includes("#718dff"), "old arbitrary blue accent removed");
assert.ok(sidebar.includes("background: #181a1d"), "outer iframe dark matches NetBird");
assert.match(app, /query\.get\("theme"\)/, "URL bootstraps parent theme");
console.log("NetBird palette fallback, live tokens and safe dark/light message synchronization passed.");
