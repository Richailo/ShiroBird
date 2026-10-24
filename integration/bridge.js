/* ShiroBird: upgrade-safe expandable submenu inside NetBird's native sidebar. */
(() => {
  "use strict";
  if (window.self !== window.top || window.__shirobirdIntegration) return;
  window.__shirobirdIntegration = true;

  const NAV_ID = "shirobird-nav-link";
  const VIEW_ID = "shirobird-integrated-view";
  const ROOT = "#shirobird/";
  const ITEMS = [
    {name: "Traffic Flow", slug: "traffic-flow", glyph: "↗"},
    {name: "SIEM Integration", slug: "siem-integration", glyph: "▤"}
  ];
  let expanded = location.hash.startsWith(ROOT);
  let lastAuth = 0;
  let peerDirectory = [];
  let directoryFetchedAt = 0;
  let pendingAuth = null;
  let renderQueued = false;

  function selectedPage() {
    const slug = location.hash.startsWith(ROOT) ? location.hash.slice(ROOT.length) : "";
    return ITEMS.find(item => item.slug === slug) || null;
  }
  function navCandidate() {
    const buttons = Array.from(document.querySelectorAll('button[data-testid="left-navigation-item"]'))
      .filter(button => {
        const r = button.getBoundingClientRect();
        return !button.closest("#" + NAV_ID) && r.left < 350 && r.width > 30 && r.height > 18;
      });
    return buttons.find(b => /^settings$/i.test((b.textContent || "").trim())) ||
      buttons.find(b => /^activity$/i.test((b.textContent || "").trim())) ||
      buttons[buttons.length - 1] || null;
  }
  function sidebarFrom(button) {
    let node = button && button.parentElement;
    while (node && node !== document.body) {
      const r = node.getBoundingClientRect();
      if (r.left < 40 && r.width >= 54 && r.width < 420 && r.height > innerHeight * .4)
        return node;
      node = node.parentElement;
    }
    return button && button.closest("aside,nav");
  }
  function makeNativeButton(reference, label, child) {
    const li = document.createElement("li");
    li.className = "px-3 cursor-pointer list-none";
    const button = document.createElement("button");
    button.type = "button";
    button.className = reference.className;
    button.dataset.shirobirdTab = child ? "child" : "parent";
    button.setAttribute("aria-label", label);
    if (child) button.classList.add("shirobird-child-button");
    const inner = document.createElement("div");
    inner.className = "flex w-full items-center shrink-0";
    if (!child) {
      const glyph = document.createElement("span");
      glyph.textContent = "◈";
      glyph.className = "shirobird-glyph";
      glyph.setAttribute("aria-hidden", "true");
      inner.append(glyph);
    }
    const text = document.createElement("span");
    text.className = "px-3 whitespace-nowrap flex-1 w-full text-left";
    text.textContent = label;
    inner.append(text);
    if (!child) {
      const chevron = document.createElement("span");
      chevron.className = "shirobird-chevron";
      chevron.setAttribute("aria-hidden", "true");
      chevron.textContent = "⌄";
      inner.append(chevron);
    }
    button.append(inner);
    li.append(button);
    return {li, button};
  }
  function createNavigation(reference) {
    const original = reference.closest("[data-nav-item]") || reference.closest("li") || reference;
    const holder = document.createElement("div");
    holder.id = NAV_ID;
    holder.className = "shirobird-menu-group";
    const parent = makeNativeButton(reference, "ShiroBird", false);
    parent.button.id = "shirobird-menu-toggle";
    parent.button.setAttribute("aria-controls", "shirobird-submenu");
    parent.button.addEventListener("click", () => {
      expanded = !expanded;
      updateNavigation();
    });
    const children = document.createElement("ul");
    children.id = "shirobird-submenu";
    children.className = "shirobird-submenu";
    for (const item of ITEMS) {
      const sub = makeNativeButton(reference, item.name, true);
      sub.button.dataset.shirobirdPage = item.slug;
      sub.button.addEventListener("click", () => {
        expanded = true;
        const next = ROOT + item.slug;
        if (location.hash === next) refresh();
        else location.hash = next;
      });
      children.append(sub.li);
    }
    holder.append(parent.li, children);
    original.insertAdjacentElement("afterend", holder);
    updateNavigation();
  }
  function updateNavigation() {
    const nav = document.getElementById(NAV_ID);
    if (!nav) return;
    const page = selectedPage();
    nav.classList.toggle("shirobird-expanded", expanded);
    nav.classList.toggle("shirobird-active", Boolean(page));
    const parent = nav.querySelector("#shirobird-menu-toggle");
    parent.setAttribute("aria-expanded", String(expanded));
    parent.setAttribute("aria-current", page ? "true" : "false");
    const submenu = nav.querySelector("#shirobird-submenu");
    submenu.hidden = !expanded;
    for (const button of submenu.querySelectorAll("button[data-shirobird-page]")) {
      const active = Boolean(page && page.slug === button.dataset.shirobirdPage);
      button.classList.toggle("shirobird-selected", active);
      if (active) button.setAttribute("aria-current", "page");
      else button.removeAttribute("aria-current");
    }
  }
  function netbirdToken() {
    try {
      const entry = JSON.parse(sessionStorage.getItem("oidc.default") || "null");
      const token = entry && entry.tokens && entry.tokens.accessToken;
      return typeof token === "string" && token.length > 15 ? token : null;
    } catch (_) { return null; }
  }
  function createPanel() {
    const panel = document.createElement("section");
    panel.id = VIEW_ID;
    panel.hidden = true;
    panel.setAttribute("aria-label", "ShiroBird observability");
    const message = document.createElement("div");
    message.className = "shirobird-auth-message";
    message.setAttribute("role", "status");
    message.textContent = "Connecting with NetBird…";
    const frame = document.createElement("iframe");
    frame.title = "ShiroBird";
    frame.referrerPolicy = "no-referrer";
    frame.loading = "lazy";
    frame.hidden = true;
    frame.addEventListener("load", () => { applyTheme(); sendPeersToFrame(); });
    panel.append(message, frame);
    document.body.append(panel);
    return panel;
  }
  function sendPeersToFrame() {
    const frame = document.querySelector("#" + VIEW_ID + " iframe");
    if (!frame || !frame.contentWindow) return;
    frame.contentWindow.postMessage({
      source: "shirobird-peer-directory", peers: peerDirectory
    }, location.origin);
  }
  async function updatePeerDirectory(token) {
    if (Date.now() - directoryFetchedAt < 300000) {
      sendPeersToFrame();
      return;
    }
    try {
      const response = await fetch("/api/peers", {
        headers: {"Authorization": "Bearer " + token, "Accept": "application/json"},
        credentials: "same-origin", cache: "no-store"
      });
      if (!response.ok) return;
      const entries = await response.json();
      if (!Array.isArray(entries)) return;
      peerDirectory = entries.slice(0, 5000).filter(peer => peer && typeof peer === "object")
        .map(peer => ({
          id: String(peer.id || "").slice(0, 128),
          name: String(peer.name || peer.dns_label || "").slice(0, 128),
          ip: String(peer.ip || "").slice(0, 64),
          ipv6: String(peer.ipv6 || "").slice(0, 64),
          connected: Boolean(peer.connected),
          os: String(peer.os || "").slice(0, 80)
        }));
      directoryFetchedAt = Date.now();
      sendPeersToFrame();
    } catch (_) { /* Optional peer enrichment; fail with bare IP. */ }
  }
  function applyTheme() {
    const frame = document.querySelector("#" + VIEW_ID + " iframe");
    if (frame && frame.contentWindow) {
      frame.contentWindow.postMessage({
        source: "shirobird-theme",
        dark: document.documentElement.classList.contains("dark")
      }, location.origin);
    }
  }
  function showPage() {
    const panel = document.getElementById(VIEW_ID);
    const page = selectedPage();
    if (!panel || !page) return;
    const frame = panel.querySelector("iframe");
    if (frame.hidden) return;
    const url = "/shirobird/?embedded=1&view=" + encodeURIComponent(page.slug);
    if (frame.getAttribute("src") !== url) frame.setAttribute("src", url);
    else applyTheme();
  }
  async function netbirdLogin() {
    if (pendingAuth) return pendingAuth;
    pendingAuth = (async () => {
      const panel = document.getElementById(VIEW_ID);
      if (!panel || !selectedPage()) return;
      const frame = panel.querySelector("iframe");
      const message = panel.querySelector(".shirobird-auth-message");
      const token = netbirdToken();
      if (!token) {
        frame.hidden = true;
        message.hidden = false;
        message.textContent = "Sign in to NetBird to use ShiroBird.";
        lastAuth = 0;
        return;
      }
      try {
        const response = await fetch("/shirobird/api/netbird-session", {
          method: "POST", credentials: "same-origin", cache: "no-store",
          headers: {"Authorization": "Bearer " + token}
        });
        if (!response.ok) throw Error(response.status === 403
          ? "Only NetBird Owners and Admins can access ShiroBird."
          : "NetBird session verification failed.");
        lastAuth = Date.now();
        if (selectedPage()?.slug === "traffic-flow") void updatePeerDirectory(token);
        frame.hidden = false;
        message.hidden = true;
        showPage();
      } catch (error) {
        frame.hidden = true;
        message.hidden = false;
        message.textContent = error.message || "NetBird session unavailable.";
        lastAuth = 0;
      }
    })();
    try { await pendingAuth; } finally { pendingAuth = null; }
  }
  function refresh() {
    const page = selectedPage();
    if (page) expanded = true;
    updateNavigation();
    let panel = document.getElementById(VIEW_ID);
    if (!panel && !page) return;
    if (!panel) panel = createPanel();
    panel.hidden = !page;
    if (!page) return;
    const parent = document.getElementById("shirobird-menu-toggle") || navCandidate();
    const sidebar = sidebarFrom(parent);
    const bounds = sidebar && sidebar.getBoundingClientRect();
    panel.style.left = Math.round(bounds && bounds.right > 48 && bounds.right < innerWidth * .55
      ? bounds.right : 0) + "px";
    panel.style.top = Math.round(bounds && bounds.top >= 40 && bounds.top < 180
      ? bounds.top : 0) + "px";
    if (Date.now() - lastAuth > 90000) void netbirdLogin();
    else showPage();
  }
  function reconcile() {
    if (renderQueued) return;
    renderQueued = true;
    requestAnimationFrame(() => {
      renderQueued = false;
      if (!document.getElementById(NAV_ID)) {
        const candidate = navCandidate();
        if (candidate) createNavigation(candidate);
      }
      refresh();
    });
  }
  new MutationObserver(reconcile).observe(document.documentElement, {
    subtree: true, childList: true
  });
  new MutationObserver(applyTheme).observe(document.documentElement, {
    attributes: true, attributeFilter: ["class"]
  });
  window.addEventListener("hashchange", refresh);
  window.addEventListener("popstate", refresh);
  window.addEventListener("resize", refresh);
  window.setInterval(() => {
    if (selectedPage()) void netbirdLogin();
  }, 90000);
  document.addEventListener("click", event => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    if (!target.closest('button[data-testid="left-navigation-item"]')) return;
    if (!selectedPage()) return;
    history.replaceState(history.state, "", location.pathname + location.search);
    refresh();
  }, true);
  document.addEventListener("DOMContentLoaded", reconcile);
  // Old links from the first version of ShiroBird open the traffic page.
  if (location.hash === "#shirobird") {
    history.replaceState(history.state, "", location.pathname + location.search + ROOT + ITEMS[0].slug);
  }
  reconcile();
})();
