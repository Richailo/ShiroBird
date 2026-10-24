/* ShiroBird — upgrade-safe, same-origin UI integration for NetBird. */
(() => {
  "use strict";
  if (window.top !== window.self || window.__shirobirdIntegration) return;
  window.__shirobirdIntegration = true;
  const ROUTE = "#shirobird", NAV_ID = "shirobird-nav-link", VIEW_ID = "shirobird-integrated-view";
  function navCandidate() {
    // NetBird v2 uses SidebarItem with button[data-testid], not anchor tags.
    const buttons = Array.from(document.querySelectorAll(
      'button[data-testid="left-navigation-item"]'
    )).filter(button => {
      const rect = button.getBoundingClientRect();
      return rect.left < 350 && rect.width > 30 && rect.height > 18;
    });
    return buttons.find(b => /^settings$/i.test((b.textContent || "").trim())) ||
      buttons.find(b => /^activity$/i.test((b.textContent || "").trim())) ||
      buttons[buttons.length - 1] || null;
  }
  function sidebarFrom(link) {
    if (!link) return null;
    let node = link.parentElement;
    while (node && node !== document.body) {
      const r = node.getBoundingClientRect();
      if (r.left < 40 && r.width >= 54 && r.width < 420 && r.height > innerHeight * .4)
        return node;
      node = node.parentElement;
    }
    return link.closest("aside,nav");
  }
  function addNavigation(reference) {
    const original = reference.closest('[data-nav-item]') ||
      reference.closest('li') || reference;
    const holder = document.createElement('div');
    holder.id = NAV_ID;
    const li = document.createElement('li');
    li.className = 'px-3 cursor-pointer list-none';
    const button = document.createElement('button');
    button.type = 'button';
    button.className = reference.className;
    button.setAttribute('aria-label', 'ShiroBird');
    button.setAttribute('data-shirobird-tab', 'true');
    const body = document.createElement('div');
    body.className = 'flex w-full items-center shrink-0';
    const glyph = document.createElement('span');
    glyph.className = 'shirobird-glyph';
    glyph.setAttribute('aria-hidden', 'true');
    glyph.textContent = '◈';
    const title = document.createElement('span');
    title.className = 'px-3 whitespace-nowrap flex-1 w-full text-left';
    title.textContent = 'ShiroBird';
    body.append(glyph, title);
    button.append(body);
    li.append(button);
    holder.append(li);
    button.addEventListener('click', () => {
      if (location.hash === ROUTE) refresh();
      else location.hash = ROUTE;
    });
    original.insertAdjacentElement('afterend', holder);
  }
  // NetBird's OIDC client keeps accessToken inside oidc.default in sessionStorage.
  // The token is sent only to our same-origin /shirobird/ auth endpoint, which
  // independently validates it against NetBird Management. It is never persisted.
  function currentNetBirdToken() {
    for (const store of [sessionStorage, localStorage]) {
      try {
        const entry = JSON.parse(store.getItem("oidc.default") || "null");
        const token = entry && entry.tokens && entry.tokens.accessToken;
        if (typeof token === "string" && token.length > 15) return token;
      } catch (_) { /* Session not available yet. */ }
    }
    return null;
  }
  function createPanel() {
    const host = document.createElement("section");
    host.id = VIEW_ID;
    host.hidden = true;
    host.setAttribute("aria-label", "ShiroBird network monitoring");
    const message = document.createElement("div");
    message.className = "shirobird-auth-message";
    message.setAttribute("role", "status");
    message.textContent = "Connecting with your NetBird account…";
    const iframe = document.createElement("iframe");
    iframe.title = "ShiroBird traffic observability";
    iframe.referrerPolicy = "no-referrer";
    iframe.hidden = true;
    iframe.addEventListener("load", applyTheme);
    host.append(message, iframe);
    document.body.append(host);
    return host;
  }
  function applyTheme() {
    const frame = document.querySelector("#" + VIEW_ID + " iframe");
    if (frame && frame.contentWindow)
      frame.contentWindow.postMessage({
        source: "shirobird-theme",
        dark: document.documentElement.classList.contains("dark")
      }, location.origin);
  }
  let validating = null, lastAuth = 0;
  async function netbirdLogin() {
    if (validating) return validating;
    validating = (async () => {
      const panel = document.getElementById(VIEW_ID);
      if (!panel) return;
      const frame = panel.querySelector("iframe");
      const message = panel.querySelector(".shirobird-auth-message");
      const token = currentNetBirdToken();
      if (!token) {
        frame.hidden = true;
        message.hidden = false;
        message.textContent = "Sign in to NetBird to use ShiroBird.";
        await fetch("/shirobird/api/logout", {method: "POST",
          credentials: "same-origin"}).catch(() => {});
        lastAuth = 0;
        return;
      }
      try {
        const response = await fetch("/shirobird/api/netbird-session", {
          method: "POST",
          credentials: "same-origin",
          cache: "no-store",
          headers: {"Authorization": "Bearer " + token}
        });
        if (!response.ok) throw new Error(response.status === 403
          ? "ShiroBird is available to NetBird Owners and Admins only."
          : "NetBird login verification failed.");
        lastAuth = Date.now();
        frame.hidden = false;
        message.hidden = true;
        if (!frame.hasAttribute("src")) frame.src = "/shirobird/?embedded=1";
        else applyTheme();
      } catch (error) {
        frame.hidden = true;
        message.hidden = false;
        message.textContent = error.message || "NetBird session is unavailable.";
        lastAuth = 0;
      }
    })();
    try { await validating; } finally { validating = null; }
  }
  function refresh() {
    const active = location.hash === ROUTE;
    const nav = document.getElementById(NAV_ID);
    if (nav) {
      nav.classList.toggle("shirobird-active", active);
      nav.setAttribute("aria-current", active ? "page" : "false");
    }
    let panel = document.getElementById(VIEW_ID);
    if (!panel && !active) return;
    if (!panel) panel = createPanel();
    panel.hidden = !active;
    if (!active) return;
    const sidebar = sidebarFrom(nav || navCandidate());
    const bounds = sidebar ? sidebar.getBoundingClientRect() : null;
    const left = bounds && bounds.right > 48 && bounds.right < innerWidth * .55
      ? bounds.right : 0;
    panel.style.left = Math.round(left) + "px";
    panel.style.top = bounds && bounds.top >= 40 && bounds.top < 180
      ? Math.round(bounds.top) + "px" : "0px";
    if (Date.now() - lastAuth > 90000) void netbirdLogin();
    applyTheme();
  }
  let pending = false;
  function reconcile() {
    if (pending) return;
    pending = true;
    requestAnimationFrame(() => {
      pending = false;
      if (!document.getElementById(NAV_ID)) {
        const candidate = navCandidate();
        if (candidate) addNavigation(candidate);
      }
      refresh();
    });
  }
  new MutationObserver(reconcile).observe(document.documentElement,
    {subtree: true, childList: true});
  window.addEventListener("hashchange", refresh);
  window.addEventListener("popstate", refresh);
  window.addEventListener("resize", refresh);
  window.setInterval(() => { if (location.hash === ROUTE) void netbirdLogin(); }, 90000);
  // NetBird uses buttons for its own routes; dismiss the overlay when one is selected.
  document.addEventListener("click", event => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    if (!target.closest('button[data-testid="left-navigation-item"]')) return;
    if (location.hash !== ROUTE) return;
    history.replaceState(history.state, "", location.pathname + location.search);
    refresh();
  }, true);
  document.addEventListener("DOMContentLoaded", reconcile);
  reconcile();
})();
