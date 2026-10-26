const assert=require("node:assert/strict");
const fs=require("node:fs"),path=require("node:path");
const html=fs.readFileSync(path.join(__dirname,"..","web","index.html"),"utf8");
const app=fs.readFileSync(path.join(__dirname,"..","web","app.js"),"utf8");
const css=fs.readFileSync(path.join(__dirname,"..","web","style.css"),"utf8");
for(const id of ["native-range","native-user","native-protocol",
    "native-event-type","native-view","native-page-size"]) {
  assert.match(html,new RegExp('<select id="'+id+'"'),
    "canonical native select remains available for filtering: "+id);
  assert.match(app,new RegExp('"'+id+'"'),
    "custom wrapper for "+id);
}
assert.match(html,/<div id="legacy-local-observability" hidden aria-hidden="true">/,
  "Local monitoring removed from visible Traffic Flow");
assert.ok(html.indexOf('id="native-table"')<html.indexOf(
  'id="legacy-local-observability"'),"native section is foremost");
assert.match(css,/#legacy-local-observability\[hidden\]\{display:none!important\}/);
assert.match(css,/body>\.nb-filter-portal\s*\{[^}]*position:fixed!important;z-index:2147482000!important/s);
assert.match(css,/body>\.nb-select-menu\s*\{[^}]*position:fixed!important;z-index:2147483000!important/s);
assert.match(css,/\.nb-select-option\[aria-selected="true"\]/);
assert.match(app,/document\.body\.append\(panel\)/,
  "filter must be rendered outside the table stacking context");
assert.match(app,/document\.body\.append\(menu\)/,
  "dropdown options must not be clipped by filter or table");
assert.match(app,/item\.select\.dispatchEvent\(new Event\("change",\{bubbles:true\}\)\)/,
  "selection must still trigger the live native filter");
for(const key of ["ArrowDown","ArrowUp","Home","End","Escape","Enter"]) {
  assert.ok(app.includes('"'+key+'"'),"keyboard control "+key);
}
assert.match(app,/event\.target\.closest\?\.\("\.nb-select-menu"\)/,
  "inner dropdown click cannot dismiss parent Filter popover");
assert.match(app,/if\(!item\.host\.closest\("\.nb-filter-portal"\)\)closeNativeFilter\(false\)/,
  "opening inner dropdown must preserve filter");
assert.match(app,/await refreshNative\(\);/,
  "native flow loads without legacy local monitoring polling");
assert.doesNotMatch(app,/await Promise\.all\(\[refreshFlows\(\), refreshAnalytics\(\), refreshNative\(\)\]\)/);
console.log("NetBird-style fixed overlay, layering, keyboard, filter integration and no local monitoring passed.");
