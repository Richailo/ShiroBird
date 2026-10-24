/* ShiroBird — upgrade-safe, same-origin UI integration for NetBird. */
(() => {
  "use strict";
  if (window.top !== window.self || window.__shirobirdIntegration) return;
  window.__shirobirdIntegration = true;
  const ROUTE = "#shirobird", NAV_ID = "shirobird-nav-link", VIEW_ID = "shirobird-integrated-view";
  function navCandidate() {
    const links = Array.from(document.querySelectorAll(
      "aside a[href], nav a[href], [role='navigation'] a[href], [data-sidebar] a[href]"
    )).filter(a => {
      const r = a.getBoundingClientRect();
      return r.left < 350 && r.width > 30 && r.height > 18
        && a.getAttribute("href") !== ROUTE;
    });
    return links.find(a => /settings|activity|audit/i.test(a.textContent || "")) ||
      links[links.length - 1] || null;
  }
  function sidebarFrom(link) {
    if (!link) return null;
    let node = link.parentElement;
    while (node && node !== document.body) {
      const r = node.getBoundingClientRect();
      if (r.left < 40 && r.width >= 120 && r.width < 420 && r.height > innerHeight * .4)
        return node;
      node = node.parentElement;
    }
    return link.closest("aside,nav");
  }
  function addNavigation(reference) {
    const link = document.createElement("a");
    link.id = NAV_ID;
    link.href = ROUTE;
    link.className = reference.className;
    link.setAttribute("aria-label", "ShiroBird");
    const glyph = document.createElement("span");
    glyph.className = "shirobird-glyph";
    glyph.textContent = "◈";
    glyph.setAttribute("aria-hidden", "true");
    const text = document.createElement("span");
    text.textContent = "ShiroBird";
    link.append(glyph, text);
    reference.insertAdjacentElement("afterend", link);
  }
  function createPanel() {
    const host = document.createElement("section");
    host.id = VIEW_ID;
    host.hidden = true;
    host.setAttribute("aria-label", "ShiroBird network monitoring");
    const toolbar = document.createElement("div");
    toolbar.className = "shirobird-toolbar";
    const heading = document.createElement("strong");
    heading.textContent = "◈  ShiroBird";
    const back = document.createElement("button");
    back.type = "button";
    back.textContent = "Back to NetBird";
    back.addEventListener("click", () => {
      history.replaceState(history.state, "", location.pathname + location.search);
      refresh();
    });
    toolbar.append(heading, back);
    const iframe = document.createElement("iframe");
    iframe.title = "ShiroBird traffic observability";
    iframe.referrerPolicy = "no-referrer";
    iframe.loading = "lazy";
    host.append(toolbar, iframe);
    document.body.append(host);
    return host;
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
    if (active) {
      const frame = panel.querySelector("iframe");
      if (!frame.hasAttribute("src")) frame.src = "/shirobird/";
      const sidebar = sidebarFrom(nav || navCandidate());
      const bounds = sidebar ? sidebar.getBoundingClientRect() : null;
      const left = bounds && bounds.right > 120 && bounds.right < innerWidth * .55
        ? bounds.right : 0;
      panel.style.left = Math.round(left) + "px";
    }
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
  document.addEventListener("DOMContentLoaded", reconcile);
  reconcile();
})();
