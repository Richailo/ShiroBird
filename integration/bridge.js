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
      const left = bounds && bounds.right > 48 && bounds.right < innerWidth * .55
        ? bounds.right : 0;
      panel.style.left = Math.round(left) + "px";
      panel.style.top = bounds && bounds.top >= 40 && bounds.top < 180
        ? Math.round(bounds.top) + "px" : "0px";
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
