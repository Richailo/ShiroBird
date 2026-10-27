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
    {name: "SIEM Integration", slug: "siem-integration", glyph: "▤"},
    {name: "Customize", slug: "customize", glyph: "⚙"}
  ];
  // Native NetBird feature visibility: UI only, not security or licensing.
  const FEATURE_LABELS = {
    "control-center":["Control Center"],"peers":["Peers"],
    "access-control":["Access Control"],"network-routing":["Network Routing"],
    "reverse-proxy":["Reverse Proxy"],"dns":["DNS"],"team":["Team"],
    "activity":["Activity"],"settings":["Settings"],
    "integrations":["Integrations"],"documentation":["Documentation"],
    "setup-keys":["Setup Keys"],"access-policies":["Access Policies","Policies"],
    "posture-checks":["Posture Checks"],"networks":["Networks"],
    "network-routes":["Network Routes","Routes"],"users":["Users"],
    "groups":["Groups"],"audit-events":["Audit Events","Audit Logs"],
    "traffic-events":["Traffic Events","Traffic Logging"],
    "event-streaming":["Event Streaming","Events Streaming"],
    "device-approvals":["Device Approvals","Device Approval"],
    "scim":["SCIM","SCIM Provisioning"]
  };
  const visibility = Object.fromEntries(Object.keys(FEATURE_LABELS).map(key => [key,true]));
  for (const key of ["traffic-events","event-streaming","device-approvals","scim"])
    visibility[key] = false;
  visibility["shirobird-traffic-flow"] = true;
  visibility["shirobird-siem-integration"] = true;
  let visibilityFetchTime = 0;
  let prefetchPending = false;
  let lastPrefetch = 0;

  function featureForLabel(label) {
    const normalized = String(label || "").toLowerCase()
      .replace(/[^a-z0-9]+/g," ").trim();
    for (const [key, aliases] of Object.entries(FEATURE_LABELS)) {
      if (aliases.some(alias => normalized === alias.toLowerCase() ||
          normalized.startsWith(alias.toLowerCase() + " beta") ||
          normalized.startsWith(alias.toLowerCase() + " new")))
        return key;
    }
    return null;
  }
  function applyVisibility() {
    const nav = document.querySelector("[data-navigation]");
    if (nav) for (const element of nav.querySelectorAll("button,a[href]")) {
      if (element.closest("#" + NAV_ID)) continue;
      const key = featureForLabel(element.getAttribute("aria-label") ||
          element.innerText || element.textContent);
      if (!key) continue;
      const item = element.closest("[data-nav-item]") || element.closest("li") || element;
      item.classList.toggle("shirobird-custom-hidden", visibility[key] === false);
    }
    for (const element of document.querySelectorAll('[role="tab"]')) {
      const key = featureForLabel(element.getAttribute("aria-label") || element.textContent);
      if (key) element.classList.toggle("shirobird-custom-hidden",visibility[key] === false);
    }
    const menu = document.getElementById(NAV_ID);
    if (menu) for (const button of menu.querySelectorAll("button[data-shirobird-page]")) {
      const key = "shirobird-" + button.dataset.shirobirdPage;
      (button.closest("li") || button).classList.toggle("shirobird-custom-hidden",visibility[key] === false);
    }
  }
  function receiveVisibility(settings) {
    if (!settings || typeof settings !== "object" || Array.isArray(settings)) return;
    for (const [key,value] of Object.entries(settings)) {
      if (Object.prototype.hasOwnProperty.call(visibility,key) && typeof value === "boolean")
        visibility[key] = value;
    }
    applyVisibility();
  }
  async function loadVisibility() {
    if (Date.now() - visibilityFetchTime < 45000) return;
    visibilityFetchTime = Date.now();
    try {
      const result = await fetch("/shirobird/api/customize",{
        credentials:"same-origin",cache:"no-store",headers:{"Accept":"application/json"}
      });
      if (result.ok) receiveVisibility((await result.json()).visibility);
    } catch (_) { /* Keep conservative paid defaults. */ }
  }
  async function preloadVisibility() {
    const token = netbirdToken();
    if (!token || prefetchPending || Date.now() - lastPrefetch < 45000) return;
    prefetchPending = true;
    lastPrefetch = Date.now();
    try {
      const result = await fetch("/shirobird/api/netbird-session", {
        method:"POST",credentials:"same-origin",cache:"no-store",
        headers:{"Authorization":"Bearer " + token}
      });
      if (result.ok) await loadVisibility();
    } catch (_) { /* No credentials are sent to the ShiroBird iframe. */ }
    finally { prefetchPending = false; }
  }
  window.addEventListener("message", event => {
    const frame = document.querySelector("#" + VIEW_ID + " iframe");
    if (!frame || event.origin !== location.origin ||
        event.source !== frame.contentWindow ||
        event.data?.source !== "shirobird-customize-updated") return;
    receiveVisibility(event.data.visibility);
    visibilityFetchTime = Date.now();
  });

  let expanded = location.hash.startsWith(ROOT);
  let lastAuth = 0;
  let peerDirectory = [];
  let userDirectory = [];
  let routeDirectory = {policies:[], routes:[], networks:[], complete:false};
  let directoryFetchedAt = 0;
  let directoryPromise = null;
  let pendingAuth = null;
  let renderQueued = false;
  let frameReady = false;
  let loadedPage = null;

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
  // Layout must follow NetBird's actual navigation box, NOT an ancestor
  // of an injected menu item (which may have 240px intrinsic width).
  function panelGeometry(bounds, viewportWidth, viewportHeight) {
    if (!bounds || !Number.isFinite(bounds.right) || !Number.isFinite(bounds.top))
      return {left: 0, top: 0};
    const left = Math.max(0, Math.min(Math.round(bounds.right), viewportWidth - 64));
    const top = Math.max(0, Math.min(Math.round(bounds.top), viewportHeight - 80));
    return {left, top};
  }
  let activePanelNavigation = null;
  const panelResizeObserver = typeof ResizeObserver === "function"
    ? new ResizeObserver(() => positionPanel()) : null;
  function positionPanel() {
    const panel = document.getElementById(VIEW_ID);
    if (!panel || panel.hidden) return;
    const navigation = document.querySelector("[data-navigation]");
    if (navigation !== activePanelNavigation) {
      if (panelResizeObserver) panelResizeObserver.disconnect();
      activePanelNavigation = navigation;
      if (panelResizeObserver && navigation) panelResizeObserver.observe(navigation);
    }
    const geometry = panelGeometry(
      navigation && navigation.getBoundingClientRect(),
      window.innerWidth, window.innerHeight
    );
    panel.style.left = geometry.left + "px";
    panel.style.top = geometry.top + "px";
    // Explicit width is essential: an iframe's intrinsic min-content sizing
    // otherwise makes this fixed flex container wider than the viewport.
    panel.style.width = Math.max(0, window.innerWidth - geometry.left) + "px";
  }
  // Matches NetBird SidebarItem's Lucide ChevronDownIcon (18px). A 180°
  // rotation gives the same geometry as its ChevronUpIcon when expanded.
  function chevronIcon() {
    const ns = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(ns, "svg");
    for (const [name, value] of Object.entries({
      width: "18", height: "18", viewBox: "0 0 24 24",
      fill: "none", stroke: "currentColor", "stroke-width": "2",
      "stroke-linecap": "round", "stroke-linejoin": "round"
    })) svg.setAttribute(name, value);
    svg.setAttribute("class", "shirobird-chevron");
    svg.setAttribute("aria-hidden", "true");
    const path = document.createElementNS(ns, "path");
    path.setAttribute("d", "m6 9 6 6 6-6");
    svg.append(path);
    return svg;
  }
  function makeNativeButton(reference, label, child) {
    const li = document.createElement("li");
    li.className = "px-3 cursor-pointer list-none";
    const button = document.createElement("button");
    button.type = "button";
    button.className = reference.className;
    button.dataset.shirobirdTab = child ? "child" : "parent";
    button.setAttribute("aria-label", label);
    if (child) {
      button.classList.add("shirobird-child-button");
      // Like NetBird's DotIcon, only shown when collapsed and not hovered.
      const dot = document.createElement("span");
      dot.className = "shirobird-child-dot";
      dot.setAttribute("aria-hidden", "true");
      dot.textContent = "•";
      button.append(dot);
    }
    const inner = document.createElement("div");
    inner.className = "flex w-full items-center shrink-0 shirobird-item-inner";
    if (!child) {
      // Native SidebarItem has the same invisible active-marker before its icon.
      const marker = document.createElement("span");
      marker.className = "peer/icon";
      marker.dataset.active = "false";
      inner.append(marker);
      const glyph = document.createElement("span");
      glyph.textContent = "◈";
      glyph.className = "shirobird-glyph";
      glyph.setAttribute("aria-hidden", "true");
      inner.append(glyph);
    }
    const text = document.createElement("span");
    text.className = "px-3 whitespace-nowrap flex-1 w-full text-left shirobird-label";
    text.textContent = label;
    inner.append(text);
    if (!child) inner.append(chevronIcon());
    button.append(inner);
    li.append(button);
    return {li, button};
  }
  // NetBird's Navigation uses md:w-[64px] and hover expands it back to 15rem.
  // Observe that *native* class rather than guessing from viewport width;
  // a collapsed sidebar can be temporarily wide while the pointer hovers.
  let observedNativeNavigation = null;
  const navigationObserver = new MutationObserver(() => reconcile());
  function syncSidebarMode() {
    const native = document.querySelector("[data-navigation]");
    if (native !== observedNativeNavigation) {
      navigationObserver.disconnect();
      observedNativeNavigation = native;
      if (native) navigationObserver.observe(native, {
        attributes: true, attributeFilter: ["class", "style"]
      });
    }
    const menu = document.getElementById(NAV_ID);
    if (!menu) return;
    const collapsed = native && window.innerWidth >= 768 &&
      native.classList.contains("md:w-[64px]");
    menu.classList.toggle("shirobird-compact", Boolean(collapsed));
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
    const page = selectedPage();
    // NetBird chooses its active item using pathname, whereas ShiroBird uses
    // the hash. While a ShiroBird page is shown, temporarily neutralize only
    // native selection visuals; do not change native React router state.
    document.documentElement.classList.toggle("shirobird-route-active", Boolean(page));
    const nav = document.getElementById(NAV_ID);
    if (!nav) return;
    syncSidebarMode();
    applyVisibility();
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
  // Customize is rendered by the NetBird bridge itself: never depend on the
  // asynchronously upgraded Traffic Flow / SIEM iframe application.
  let customizeState = null;
  let customizeFetching = null;
  let customizeFetchedAt = 0;
  let customizeSaving = false;

  function customizeView() {
    return document.querySelector("#" + VIEW_ID + " #customize-view");
  }
  function createCustomizeView(panel) {
    const view = document.createElement("section");
    view.id = "customize-view";
    view.className = "shirobird-customize-page";
    view.hidden = true;
    // Static, trusted template. No untrusted API content is interpreted as HTML.
    view.innerHTML = `
      <div class="hero customize-hero">
        <div><h1>Customize</h1>
          <p>Choose which NetBird features and tabs appear in the navigation.</p></div>
        <div class="actions">
          <button type="button" class="secondary" id="customize-hide-paid">Hide premium</button>
          <button type="button" class="secondary" id="customize-reset">Restore defaults</button>
        </div>
      </div>
      <section class="panel customize-panel">
        <div class="panelhead">
          <div><h2>Feature visibility</h2>
            <p>Settings apply to all administrators of this ShiroBird installation.</p></div>
          <span class="status" id="customize-count">Loading…</span>
        </div>
        <div id="customize-groups" class="customize-groups"></div>
        <p id="customize-message" class="customize-note" role="status"></p>
        <p class="customize-note">Only the interface is affected. Services, NetBird
          permissions and licenses are unchanged. Customize remains available.</p>
      </section>`;
    panel.append(view);
    view.querySelector("#customize-hide-paid").addEventListener("click", () => {
      if (!customizeState) return;
      const settings = Object.fromEntries(customizeState.features
        .filter(feature => feature.paid).map(feature => [feature.id, false]));
      if (Object.keys(settings).length) void saveCustomize({visibility: settings});
    });
    view.querySelector("#customize-reset").addEventListener("click", () => {
      if (customizeState) void saveCustomize({reset: true});
    });
    return view;
  }
  function renderCustomize() {
    const view = customizeView();
    if (!view || !customizeState) return;
    const host = view.querySelector("#customize-groups");
    const {features, visibility: values} = customizeState;
    const groups = new Map();
    for (const feature of features) {
      if (!groups.has(feature.group)) groups.set(feature.group, []);
      groups.get(feature.group).push(feature);
    }
    const fragment = document.createDocumentFragment();
    for (const [group, items] of groups.entries()) {
      const section = document.createElement("section");
      section.className = "customize-category";
      const title = document.createElement("h3");
      title.textContent = group;
      section.append(title);
      for (const feature of items) {
        const row = document.createElement("label");
        row.className = "customize-option";
        const details = document.createElement("span");
        details.className = "customize-option-label";
        const name = document.createElement("span");
        name.textContent = feature.label;
        details.append(name);
        if (feature.paid) {
          const premium = document.createElement("span");
          premium.className = "customize-premium";
          premium.textContent = "Paid";
          details.append(premium);
        }
        const toggle = document.createElement("input");
        toggle.type = "checkbox";
        toggle.setAttribute("role", "switch");
        toggle.className = "customize-checkbox";
        toggle.checked = values[feature.id] === true;
        toggle.disabled = customizeSaving;
        toggle.setAttribute("aria-label", "Show " + feature.label);
        toggle.addEventListener("change", () => {
          void saveCustomize({visibility: {[feature.id]: toggle.checked}});
        });
        const switchElement = document.createElement("span");
        switchElement.className = "customize-switch";
        switchElement.setAttribute("aria-hidden", "true");
        row.append(details, toggle, switchElement);
        section.append(row);
      }
      fragment.append(section);
    }
    host.replaceChildren(fragment);
    view.querySelector("#customize-count").textContent =
      Object.values(values).filter(Boolean).length + " / " + features.length + " shown";
    view.querySelector("#customize-hide-paid").disabled = customizeSaving;
    view.querySelector("#customize-reset").disabled = customizeSaving;
  }
  async function fetchCustomize(force = false) {
    if (!force && Date.now() - customizeFetchedAt < (customizeState ? 45000 : 10000)) return;
    if (customizeFetching) return customizeFetching;
    customizeFetching = (async () => {
      const view = customizeView();
      if (!view) return;
      const message = view.querySelector("#customize-message");
      try {
        const result = await fetch("/shirobird/api/customize", {
          credentials: "same-origin", cache: "no-store",
          headers: {"Accept": "application/json"}
        });
        if (!result.ok) throw Error("Unable to load settings (HTTP " + result.status + ")");
        const value = await result.json();
        if (!Array.isArray(value.features) || !value.visibility ||
            typeof value.visibility !== "object") throw Error("Invalid server response");
        customizeState = value;
        customizeFetchedAt = Date.now();
        receiveVisibility(value.visibility);
        renderCustomize();
        message.textContent = "";
      } catch (error) {
        customizeFetchedAt = Date.now();
        message.textContent = error.message || "Unable to load Customize";
      }
    })();
    try { await customizeFetching; } finally { customizeFetching = null; }
  }
  async function saveCustomize(change) {
    if (customizeSaving || !customizeState) return;
    const previous = customizeState;
    const view = customizeView();
    customizeSaving = true;
    if (change.visibility) customizeState = {
      ...previous, visibility: {...previous.visibility, ...change.visibility}
    };
    else if (change.reset === true) customizeState = {
      ...previous, visibility: Object.fromEntries(
        previous.features.map(feature => [feature.id, !feature.paid]))
    };
    renderCustomize();
    const message = view.querySelector("#customize-message");
    message.textContent = "Saving…";
    try {
      const response = await fetch("/shirobird/api/customize", {
        method: "POST", credentials: "same-origin", cache: "no-store",
        headers: {"Content-Type": "application/json",
                  "X-ShiroBird-Action": "customize"},
        body: JSON.stringify(change)
      });
      if (!response.ok) throw Error("HTTP " + response.status);
      customizeState = await response.json();
      customizeFetchedAt = Date.now();
      receiveVisibility(customizeState.visibility);
      message.textContent = "Changes saved.";
    } catch (error) {
      customizeState = previous;
      message.textContent = "Save failed: " + (error.message || "unknown error");
    } finally {
      customizeSaving = false;
      renderCustomize();
    }
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
    // Keep the native NetBird-colored surface quiet while ShiroBird loads.
    // Only show text if authentication actually fails.
    message.hidden = true;
    const frame = document.createElement("iframe");
    frame.title = "ShiroBird";
    frame.referrerPolicy = "no-referrer";
    // A hidden lazy iframe may never load. Start the authenticated document
    // eagerly, but only reveal it after the embedded app signals first paint.
    frame.loading = "eager";
    frame.hidden = true;
    frame.addEventListener("load", () => { applyTheme(); sendPeersToFrame(); });
    panel.append(message, frame);
    createCustomizeView(panel);
    document.body.append(panel);
    return panel;
  }
  function sendPeersToFrame() {
    const frame = document.querySelector("#" + VIEW_ID + " iframe");
    if (!frame || !frame.contentWindow) return;
    frame.contentWindow.postMessage({
      source: "shirobird-peer-directory", peers: peerDirectory, users: userDirectory
    }, location.origin);
    frame.contentWindow.postMessage({
      source: "shirobird-policy-directory", directory: routeDirectory
    }, location.origin);
  }
  async function updatePeerDirectory(token) {
    if (directoryPromise) return directoryPromise;
    if (Date.now() - directoryFetchedAt < 180000) {
      sendPeersToFrame();
      return;
    }
    // Read-only NetBird Management API. Only the existing NetBird access token
    // is used; no PAT, no third-party calls, and no credentials sent to iframe.
    const get = async endpoint => {
      const response = await fetch(endpoint, {
        headers: {"Authorization":"Bearer " + token,"Accept":"application/json"},
        credentials:"same-origin",cache:"no-store",redirect:"error"
      });
      if (!response.ok) throw Error("NetBird metadata unavailable: " + response.status);
      return response.json();
    };
    directoryPromise = (async () => {
      const [peers, policies, routes, networks, users] = await Promise.allSettled([
        get("/api/peers"), get("/api/policies"), get("/api/routes"), get("/api/networks"),
        get("/api/users")
      ]);
      const list = result => result.status === "fulfilled" && Array.isArray(result.value)
        ? result.value : null;
      const peerRows = list(peers);
      if (peerRows) peerDirectory = peerRows.slice(0,5000)
        .filter(p=>p && typeof p === "object")
        .map(p=>({
          id:String(p.id||"").slice(0,128),
          name:String(p.name||p.dns_label||"").slice(0,128),
          ip:String(p.ip||"").slice(0,64),
          ipv6:String(p.ipv6||"").slice(0,64),
          connected:Boolean(p.connected),
          user_id:String(p.user_id||"").slice(0,128),
          os:(typeof p.os==="string" ? p.os :
              typeof p.os?.name==="string" ? p.os.name : "").slice(0,80)
        }));
      const userRows = list(users);
      if (userRows) userDirectory=userRows.slice(0,1000)
        .filter(u=>u && typeof u==="object" && u.is_service_user!==true)
        .map(u=>({id:String(u.id||"").slice(0,128),
                  name:String(u.name||u.email||u.id||"").slice(0,128)}));
      const policyRows = list(policies);
      const routeRows = list(routes);
      const networkRows = list(networks);
      const networksWithRouting = [];
      let allNetworksLoaded = Boolean(networkRows);
      if (networkRows) {
        // Fixed upper bound and concurrency; no recursive discovery/crawl.
        const selected = networkRows.slice(0,40);
        if (networkRows.length > selected.length) allNetworksLoaded = false;
        const pages = await Promise.all(selected.map(async n=>{
          const id=String(n.id||"");
          if (!/^[A-Za-z0-9_-]{1,80}$/.test(id)) return null;
          const [routers, resources] = await Promise.allSettled([
            get("/api/networks/" + encodeURIComponent(id) + "/routers"),
            get("/api/networks/" + encodeURIComponent(id) + "/resources")
          ]);
          if (!list(routers) || !list(resources)) allNetworksLoaded = false;
          return {
            id, name:String(n.name||"").slice(0,128),
            routerPeers:(list(routers)||[]).filter(r=>r.enabled!==false && r.peer)
              .map(r=>String(r.peer).slice(0,128)),
            routerGroups:(list(routers)||[]).filter(r=>r.enabled!==false)
              .flatMap(r=>Array.isArray(r.peer_groups)?r.peer_groups:[])
              .map(String).slice(0,100),
            resources:(list(resources)||[]).slice(0,500).map(r=>({
              id:String(r.id||"").slice(0,128),
              name:String(r.name||"").slice(0,128),
              address:String(r.address||"").slice(0,128)
            }))
          };
        }));
        for (const p of pages) if (p) networksWithRouting.push(p);
      }
      routeDirectory = {
        complete: Boolean(policyRows && routeRows && networkRows && allNetworksLoaded && peerRows),
        policies:(policyRows||[]).slice(0,1000).map(p=>({
          id:String(p.id||"").slice(0,128),
          name:String(p.name||"").slice(0,128),
          rules:(Array.isArray(p.rules)?p.rules:[]).slice(0,500).map(r=>({
            id:String(r.id||"").slice(0,128),
            name:String(r.name||"").slice(0,128),
            action:String(r.action||"").slice(0,40)
          }))
        })),
        routes:(routeRows||[]).slice(0,1000).map(r=>({
          id:String(r.id||"").slice(0,128),
          network_id:String(r.network_id||"").slice(0,128),
          name:String(r.description||r.network_id||"").slice(0,128),
          peer:String(r.peer||"").slice(0,128),
          enabled:r.enabled!==false,
          peer_groups:Array.isArray(r.peer_groups)?r.peer_groups.slice(0,50).map(String):[]
        })),
        networks:networksWithRouting
      };
      directoryFetchedAt=Date.now();
      sendPeersToFrame();
    })();
    try { await directoryPromise; } catch (_) { /* metadata optional */ }
    finally { directoryPromise=null; }
  }
  // Tailwind's native NetBird tokens live in the parent document. The iframe
  // does not inherit its CSS variables, so forward only verified color tokens.
  // No OIDC/session information enters this theme message.
  function netbirdPalette(dark) {
    const styles = window.getComputedStyle(document.documentElement);
    const token = (name, fallback) => {
      const value = styles.getPropertyValue("--color-" + name).trim();
      return /^#[0-9a-f]{3,8}$/i.test(value) ? value : fallback;
    };
    if (dark) return {
      "--page": token("nb-gray", "#181a1d"),
      "--surface": token("nb-gray-940", "#1c1e21"),
      "--field": token("nb-gray-900", "#2e3238"),
      "--sidebar": token("nb-gray", "#181a1d"),
      "--muted": token("nb-gray-300", "#a3adb5"),
      "--text": token("nb-gray-100", "#e4e7e9"),
      "--stroke": token("nb-gray-900", "#2e3238"),
      "--hover": token("nb-gray-920", "#25282d"),
      "--primary": token("netbird", "#f68330"),
      "--soft": token("nb-gray-920", "#25282d"),
      "--accent": token("netbird", "#f68330"),
      "--table-head": token("nb-gray-900", "#2e3238"),
      "--button-secondary": token("nb-gray-920", "#25282d"),
      "--input-border": token("nb-gray-700", "#474e57"),
      "--placeholder": token("nb-gray-350", "#8f9ca8"),
      "--success": token("green-400", "#31c48d"),
      "--danger": token("red-400", "#f98080")
    };
    return {
      "--page": token("gray-50", "#f9fafb"),
      "--surface": "#ffffff",
      "--field": "#ffffff",
      "--sidebar": token("gray-50", "#f9fafb"),
      "--muted": token("gray-500", "#6b7280"),
      "--text": token("gray-900", "#111827"),
      "--stroke": token("gray-200", "#e5e7eb"),
      "--hover": token("gray-100", "#f3f4f6"),
      "--primary": token("netbird", "#f68330"),
      "--soft": token("gray-100", "#f3f4f6"),
      "--accent": token("netbird-600", "#e55311"),
      "--table-head": token("gray-100", "#f3f4f6"),
      "--button-secondary": "#ffffff",
      "--input-border": token("gray-300", "#d1d5db"),
      "--placeholder": token("gray-400", "#9ca3af"),
      "--success": token("green-600", "#057a55"),
      "--danger": token("red-700", "#c81e1e")
    };
  }
  function applyTheme() {
    const dark = document.documentElement.classList.contains("dark");
    const palette = netbirdPalette(dark);
    const panel = document.getElementById(VIEW_ID);
    if (panel) panel.style.backgroundColor = palette["--page"];
    const frame = panel && panel.querySelector("iframe");
    if (frame) frame.style.backgroundColor = palette["--page"];
    const customize = panel && panel.querySelector("#customize-view");
    if (customize) {
      for (const [name, value] of Object.entries(palette))
        customize.style.setProperty(name, value);
    }
    if (frame && frame.contentWindow) {
      frame.contentWindow.postMessage({
        source: "shirobird-theme", dark, palette
      }, location.origin);
    }
  }
  function showPage() {
    const panel = document.getElementById(VIEW_ID);
    const page = selectedPage();
    if (!panel || !page) return;
    const frame = panel.querySelector("iframe");
    const customize = panel.querySelector("#customize-view");
    const customizing = page.slug === "customize";
    if (customize) customize.hidden = !customizing || lastAuth <= 0;
    if (customizing) {
      // Never display stale SIEM content for an active Customize route.
      frame.hidden = true;
      panel.querySelector(".shirobird-auth-message").hidden = lastAuth > 0;
      if (lastAuth > 0) void fetchCustomize();
      applyTheme();
      return;
    }
    // If users open SIEM first, then Traffic Flow in the same SSO session,
    // load routing/policy metadata immediately rather than after token refresh.
    if (page.slug === "traffic-flow" && lastAuth > 0 &&
        Date.now() - directoryFetchedAt > 180000) {
      const token = netbirdToken();
      if (token) void updatePeerDirectory(token);
    }
    // Never navigate an already loaded iframe just to switch tabs or themes:
    // navigation used to expose the browser's temporary white about:blank.
    if (!frame.getAttribute("src")) {
      frameReady = false;
      loadedPage = page.slug;
      frame.hidden = true;
      const url = "/shirobird/?embedded=1&view=" + encodeURIComponent(page.slug) +
        "&theme=" + (document.documentElement.classList.contains("dark") ? "dark" : "light");
      frame.setAttribute("src", url);
    } else if (frameReady && loadedPage !== page.slug) {
      loadedPage = page.slug;
      frame.contentWindow.postMessage({
        source: "shirobird-navigate", view: page.slug
      }, location.origin);
    }
    if (frameReady && lastAuth > 0) {
      frame.hidden = false;
      panel.querySelector(".shirobird-auth-message").hidden = true;
    }
    applyTheme();
  }
  // App-ready is sent by the same-origin embedded ShiroBird document AFTER
  // its first render, so a white iframe never appears while it is loading.
  // The embedded Event Streaming card opens the native NetBird-styled
  // ShiroBird SIEM tab without iframe reload or additional authentication.
  window.addEventListener("message", event => {
    const panel=document.getElementById(VIEW_ID);
    const frame=panel && panel.querySelector("iframe");
    if (!frame || event.origin!==location.origin ||
        event.source!==frame.contentWindow ||
        event.data?.source!=="shirobird-request-tab") return;
    const wanted=event.data.view;
    if (!ITEMS.some(item=>item.slug===wanted)) return;
    expanded=true;
    location.hash=ROOT+wanted;
  });
  window.addEventListener("message", event => {
    const panel = document.getElementById(VIEW_ID);
    const frame = panel && panel.querySelector("iframe");
    if (!frame || event.origin !== location.origin ||
        event.source !== frame.contentWindow || !event.data ||
        event.data.source !== "shirobird-ready") return;
    frameReady = true;
    applyTheme();
    sendPeersToFrame();
    showPage();
  });
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
        void loadVisibility();
        if (selectedPage()?.slug === "traffic-flow") void updatePeerDirectory(token);
        // The child iframe remains hidden until it reports ready; do not
        // reveal its initial about:blank/loading surface.
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
    positionPanel();
    applyTheme();
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
      applyVisibility();
      void preloadVisibility();
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
  window.addEventListener("resize", () => { refresh(); positionPanel(); });
  window.addEventListener("pageshow", () => { refresh(); positionPanel(); });
  // Native navigation expands on hover through a CSS width transition.
  // Pointer entry/exit re-check layout; ResizeObserver follows each frame.
  document.addEventListener("pointerover", event => {
    if (event.target instanceof Element && event.target.closest("[data-navigation]"))
      requestAnimationFrame(positionPanel);
  }, {passive: true});
  window.setInterval(() => {
    void preloadVisibility();
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
