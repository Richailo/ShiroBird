/* Guard against a ShiroBird token-login flash in embedded NetBird pages. */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const read = p => fs.readFileSync(path.join(__dirname, "..", p), "utf8");
const markup = read("web/index.html");
const styles = read("web/style.css");
const app = read("web/app.js");
assert.match(markup, /<div id="auth" class="overlay hidden" hidden>/,
  "auth form starts hidden in HTML before deferred JavaScript runs");
assert.match(styles, /body\.embedded #auth\s*\{display:none!important\}/,
  "embedded login is permanently hidden, including on transient SSO failures");
assert.match(styles, /body\.embedded #form\s*\{display:none!important\}/,
  "token form cannot be flashed in embedded mode");
const start = app.indexOf("function showLogin() {");
const end = app.indexOf("async function req(", start);
assert.ok(start > 0 && end > start, "login routine present");

function create(embedded) {
  const classes = new Set(["overlay", "hidden"]);
  const auth = {
    hidden: true,
    dataset: {},
    classList: {
      add: x => classes.add(x),
      remove: x => classes.delete(x),
      contains: x => classes.has(x)
    }
  };
  const form = {hidden: true};
  const controls = {auth, form};
  let currentStatus = "";
  const factory = Function("$", "embedded", "status", "stream",
    app.slice(start, end) + "\nreturn showLogin;");
  const showLogin = factory(name => controls[name], embedded,
    message => {currentStatus = message;}, null);
  return {showLogin, auth, form, classes, status: () => currentStatus};
}
{
  const embedded = create(true);
  embedded.showLogin();
  assert.equal(embedded.auth.hidden, true);
  assert.equal(embedded.form.hidden, true);
  assert.ok(embedded.classes.has("hidden"));
  assert.equal(embedded.status(), "Waiting for NetBird authentication");
}
{
  const standalone = create(false);
  standalone.showLogin();
  assert.equal(standalone.auth.hidden, false);
  assert.ok(!standalone.classes.has("hidden"));
  assert.equal(standalone.status(), "Sign in required");
}
console.log("ShiroBird first paint stays login-free in NetBird; standalone sign-in works.");
