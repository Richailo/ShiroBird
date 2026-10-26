/* Regression tests for the real ShiroBird sidebar adapter without a browser dependency. */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const script = fs.readFileSync(path.join(__dirname, "bridge.js"), "utf8");
const styles = fs.readFileSync(path.join(__dirname, "bridge.css"), "utf8");
const start = script.indexOf("  function chevronIcon()");
const stop = script.indexOf("  function createNavigation(", start);
assert.ok(start > 0 && stop > start, "adapter factory source is present");

class FakeElement {
  constructor(tag) {
    this.tagName = tag;
    this.children = [];
    this.attributes = {};
    this.dataset = {};
    this.className = "";
    this.hidden = false;
    this.textContent = "";
    this.classList = {
      add: name => this.addClass(name),
      remove: name => this.removeClass(name),
      contains: name => this.className.split(/\s+/).includes(name),
      toggle: (name, enabled) => enabled ? this.addClass(name) : this.removeClass(name)
    };
  }
  addClass(name) {
    if (!this.classList.contains(name)) this.className = [this.className, name].filter(Boolean).join(" ");
  }
  removeClass(name) {
    this.className = this.className.split(/\s+/).filter(value => value !== name).join(" ");
  }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  append(...nodes) { this.children.push(...nodes); }
}
const native = new FakeElement("div");
native.className = "group/navigation md:w-[64px]";
const menu = new FakeElement("div");
const document = {
  createElement: tag => new FakeElement(tag),
  createElementNS: (_, tag) => new FakeElement(tag),
  querySelector: selector => selector === "[data-navigation]" ? native : null,
  getElementById: id => id === "shirobird-nav-link" ? menu : null
};
let observed = 0;
class MutationObserver {
  observe() { observed++; }
  disconnect() {}
}
const window = { innerWidth: 1200 };
const factories = Function("document", "window", "MutationObserver", "NAV_ID", "reconcile",
  script.slice(start, stop) +
  "\nreturn { makeNativeButton, chevronIcon, syncSidebarMode };"
)(document, window, MutationObserver, "shirobird-nav-link", () => {});
const nativeReference = {className: "rounded-lg text-[.87rem] w-full relative"};
const parent = factories.makeNativeButton(nativeReference, "ShiroBird", false);
assert.ok(parent.button.classList.contains("shirobird-child-button") === false);
const inner = parent.button.children[0];
const arrow = inner.children.at(-1);
assert.equal(arrow.tagName, "svg");
assert.equal(arrow.attributes.width, "18");
assert.equal(arrow.attributes.height, "18");
assert.equal(arrow.children[0].attributes.d, "m6 9 6 6 6-6");
assert.ok(inner.children.some(child => child.className.includes("shirobird-label")));
assert.equal(parent.button.attributes["aria-label"], "ShiroBird");

const child = factories.makeNativeButton(nativeReference, "Traffic Flow", true);
assert.ok(child.button.classList.contains("shirobird-child-button"));
assert.ok(child.button.children[0].className.includes("shirobird-child-dot"));
assert.ok(child.button.children[1].children.every(el => el.tagName !== "svg"));

factories.syncSidebarMode();
assert.ok(menu.classList.contains("shirobird-compact"), "NetBird collapsed class is inherited");
assert.equal(observed, 1);
native.classList.remove("md:w-[64px]");
factories.syncSidebarMode();
assert.ok(!menu.classList.contains("shirobird-compact"), "menu expands when NetBird expands");
native.classList.add("md:w-[64px]");
window.innerWidth = 600;
factories.syncSidebarMode();
assert.ok(!menu.classList.contains("shirobird-compact"), "mobile menu stays readable");
window.innerWidth = 1200;
factories.syncSidebarMode();
assert.ok(menu.classList.contains("shirobird-compact"), "desktop collapse still works");
assert.match(styles, /\.shirobird-compact \.shirobird-label[\s\S]*?opacity:\s*0;/);
assert.match(styles, /\[data-navigation\]:hover #shirobird-nav-link\.shirobird-compact \.shirobird-label/);
assert.match(styles, /\.shirobird-expanded \.shirobird-chevron\s*\{\s*transform:\s*rotate\(180deg\)/);
console.log("ShiroBird native chevron, compact sidebar and hover regression tests passed.");
