import { isTextEntry } from './ui-keyboard-input.generated.js';
import { mountKeyboardShortcuts } from './ui-keyboard-shortcuts.generated.js';
import { createMcpRequests } from './mcp-requests.mjs';
import { privateSession } from './private-session.js';
import { mountAppLayout } from "./app-layout.js";
import { TOUCH_LAYOUT } from "./touch-layout.js";
import { mountPrefs } from "./shell.js";
import { resolveDealroomBoot } from "./boot-mode.js";
import { mountAutoRefresh } from "./auto-refresh.mjs";
import { mountNavigation } from "./navigation.js";

export function mountAppShell(root = document, pathname = globalThis.location?.pathname || "/") {
  const location = globalThis.location;
  const host = mountNavigation(root, pathname, { location });
  if (!host) return;
  const engineSignIn = root.documentElement.dataset.partnerSignIn === 'engine';
  if (engineSignIn) {
    const scope = new URL('/tours/', location.href);
    void root.defaultView.navigator.serviceWorker?.getRegistration(scope.href).then(registration => {
      if (registration?.scope === scope.href) return registration.update();
    }).catch(() => {});
  }
  const history = () => import('./ui-switcher-history.generated.js');
  // eslint-disable-next-line no-restricted-syntax -- One frame after initial page readiness records local recents; it performs no network reads or polling.
  const track = () => root.defaultView.requestAnimationFrame(() => {
    void Promise.all([history(), import('./doc-context.js')]).then(([{ rememberAddress, rememberDestination }, { pageDocContext }]) => {
      if (retired) return;
      rememberAddress(location.href);
      pageDocContext?.subscribe(snapshot => {
        if (!retired && snapshot.selected?.kind === 'deal') rememberDestination(`deal:${snapshot.selected.id}`);
      });
    }).catch(() => {});
  });
  const homeRoot = pathname === '/' && root.getElementById('homeRoot');
  if (homeRoot && !homeRoot.dataset.homeReady) homeRoot.addEventListener('doctorcre:home-ready', track, { once: true });
  else track();
  root.defaultView.addEventListener('popstate', () => { if (!retired) void history().then(({ rememberAddress }) => rememberAddress(location.href)).catch(() => {}); });
  const search = host.querySelector('.app-shell-search');
  const toggle = root.createElement('button');
  toggle.type = 'button';
  toggle.className = 'app-shell-search quick-switcher-toggle';
  toggle.setAttribute('aria-label', 'Search and quick switcher');
  toggle.setAttribute('aria-haspopup', 'dialog');
  // On a Mac, Ctrl+K is the text fields' delete-to-end-of-line.
  const mac = /Mac|iPhone|iPad/.test(root.defaultView.navigator.platform);
  toggle.setAttribute('aria-keyshortcuts', mac ? 'Meta+K' : 'Control+K');
  toggle.title = mac ? 'Search (⌘K)' : 'Search (Ctrl+K)';
  toggle.innerHTML = search.innerHTML;
  if (search.hasAttribute("aria-current")) toggle.setAttribute("aria-current", "page");
  search.replaceWith(toggle);
  let opening = false, retired = false;
  const open = async () => {
    if (opening || retired) return;
    opening = true;
    const opener = root.activeElement instanceof HTMLElement && root.activeElement !== root.body ? root.activeElement : toggle;
    try {
      const [{ openQuickSwitcher, readQuickSwitcherSources, switcherInboxReader }, { navigationItems, switcherUtilityPages, toursDestination }, { createClient }] = await Promise.all([
        import('./ui-quick-switcher.generated.js'), import('./routes.js'), import('./client.js'),
      ]);
      if (retired) return;
      const boot = resolveDealroomBoot(location);
      const pages = [...navigationItems, ...switcherUtilityPages].filter(page =>
        !engineSignIn || (!page.carrOnly && page !== toursDestination));
      openQuickSwitcher({ opener, pages, read: async (publish) => {
        const client = await createClient(boot.mode, boot.options);
        return readQuickSwitcherSources(() => client.getBoard(), () => client.getRelationshipNetwork(), switcherInboxReader(createMcpRequests(), boot.mode === "fixture"), publish);
      } });
    } catch {
      if (!retired) location.assign('/search');
    } finally { opening = false; }
  };
  toggle.addEventListener('click', open);
  root.defaultView.addEventListener('keydown', event => {
    if (isTextEntry(event)) return;
    if ((mac ? event.metaKey : event.ctrlKey) && event.code === 'KeyK' && !event.altKey && !event.shiftKey) {
      event.preventDefault(); event.stopImmediatePropagation();
      if (!event.repeat) void open();
    }
  }, true);
  const shortcuts = mountKeyboardShortcuts({ root, openSearch: open });
  root.defaultView.addEventListener('doctorcre-session-invalidated', () => { retired = true; toggle.disabled = true; shortcuts.dispose(); void history().then(({ clearRecents }) => clearRecents()).catch(() => {}); }, { once: true });
  const home = pathname === '/' && root.getElementById('homeRoot');
  const ready = home && !home.dataset.homeReady
    ? new Promise(resolve => home.addEventListener('doctorcre:home-ready', resolve, { once: true }))
    : Promise.resolve();
  const reactWorkspace = new URLSearchParams(location?.search || "").get("ui") === "react";
  mountAccount(root, host, pathname, reactWorkspace, ready);
  mountAppLayout(root, host, pathname);
  const topbar = root.getElementById("appTopbar");
  const workspace = root.getElementById("accountWorkspaceControls");
  workspace.hidden = false;
  const controls = host.querySelector(".app-shell-controls");
  const callButton = root.getElementById("callModeButton");
  const displayControls = [host.querySelector('[data-pref="theme"]'), host.querySelector("#colorAssistButton")];
  const topbarEnd = root.getElementById("appTodayToggle");
  topbar.insertBefore(host.querySelector(".app-shell-search"), topbarEnd);
  topbar.insertBefore(host.querySelector("#askDocLink"), topbarEnd);
  const phone = root.defaultView.matchMedia(TOUCH_LAYOUT);
  const arrangeControls = () => {
    for (const control of displayControls) {
      if (phone.matches) workspace.append(control);
      else topbar.insertBefore(control, topbarEnd);
    }
    if (phone.matches) workspace.append(callButton);
    else controls.prepend(callButton);
  };
  phone.addEventListener("change", arrangeControls);
  arrangeControls();

}

export function partnerIdentity(session) {
  const slug = session?.actor?.slug;
  return slug === "joe" || slug === "dell" ? { slug, name: slug === "joe" ? "Joe" : "Dell", initial: slug === "joe" ? "J" : "D" } : null;
}

function mountFlaggedWorkspace(root, pathname, sessionIsValid) {
  const win = root.defaultView;
  const phone = win.matchMedia(pathname === "/leads" ? "(max-width:1023px)" : TOUCH_LAYOUT);
  let identity = null, workspace = null, container = null, layout = null, observer = null, loading = false, disposed = false;
  let sidebarWidth = 236, todayWidth = 260;
  const tabs = id => ({ kind: "tabs", id: `${id}-group`, panels: [id], active: id });
  const stageLayout = () => {
    const sidebar = layout.dataset.sidebar === "open", today = layout.dataset.today === "open";
    const width = Math.max(1, layout.clientWidth);
    const mainWidth = Math.max(1, width - (sidebar ? sidebarWidth : 0) - (today ? todayWidth : 0));
    let stage = tabs("main");
    if (today) stage = { kind: "split", id: "main-today", axis: "horizontal", ratio: mainWidth / (mainWidth + todayWidth), first: stage, second: tabs("today") };
    if (sidebar) stage = { kind: "split", id: "sidebar-main", axis: "horizontal", ratio: sidebarWidth / (sidebarWidth + mainWidth + (today ? todayWidth : 0)), first: tabs("sidebar"), second: stage };
    return { version: 1, stage };
  };
  const restore = () => {
    observer?.disconnect(); observer = null;
    workspace?.unmount(); workspace = null;
    container?.remove(); container = null;
    layout?.classList.remove("is-react-workspace");
  };
  const reconcile = async () => {
    if (disposed || !identity || phone.matches || !sessionIsValid()) { restore(); return; }
    if (workspace) { workspace.update(stageLayout()); return; }
    if (loading) return;
    loading = true;
    try {
      const { mountZoomableWorkspace } = await import("./ui-zoom.generated.js");
      if (disposed || !identity || phone.matches || !sessionIsValid()) return;
      layout = root.getElementById("appLayout");
      if (!layout) return;
      const sidebar = layout.querySelector("#appSidebar"), main = layout.querySelector(".app-layout-center"), today = layout.querySelector("#appToday");
      if (!sidebar || !main || !today) return;
      sidebarWidth = sidebar.getBoundingClientRect().width || sidebarWidth;
      todayWidth = today.getBoundingClientRect().width || todayWidth;
      const panels = [{ id: "sidebar", title: "Workspace", node: sidebar }, { id: "main", title: "Page", node: main }, { id: "today", title: "Today", node: today }];
      const initial = stageLayout();
      container = root.createElement("div");
      container.dataset.appWorkspace = "";
      layout.append(container);
      workspace = mountZoomableWorkspace({ container, panels, layout: initial });
      layout.classList.add("is-react-workspace");
      observer = new win.MutationObserver(() => { void reconcile(); });
      observer.observe(layout, { attributes: true, attributeFilter: ["data-sidebar", "data-today"] });
    } catch { restore(); }
    finally { loading = false; }
  };
  phone.addEventListener("change", reconcile);
  win.addEventListener("resize", reconcile);
  return {
    setIdentity(next) {
      if (identity?.slug === next?.slug) return;
      restore();
      identity = next;
      void reconcile();
    },
    dispose() {
      disposed = true; identity = null; restore();
      phone.removeEventListener("change", reconcile);
      win.removeEventListener("resize", reconcile);
    },
  };
}

function mountAccount(root, host, pathname, reactWorkspaceRequested, ready) {
  const preferences = mountPrefs();
  const avatar = host.querySelector("#selfAvatar");
  const panel = host.querySelector("#accountMenu");
  const askDocLinks = root.querySelectorAll("[data-ask-doc]");
  root.body.append(panel);
  let session = null;
  const showPartner = (identity) => {
    if (!identity) return;
    const title = `${identity.name}'s Workspace`;
    avatar.textContent = identity.initial;
    avatar.setAttribute("aria-label", `${identity.name}: account and settings`);
    panel.querySelector("#accountWorkspace").textContent = title;
    const workspace = root.getElementById("viewerWorkspace");
    if (workspace) workspace.textContent = title;
    panel.querySelector("#accountProfile").onclick = () => {
      const dialog = root.createElement("dialog");
      dialog.className = "app-shell-profile";
      dialog.innerHTML = `<header><h2>Profile</h2><button type="button" aria-label="Close profile">×</button></header><div class="app-shell-profile-identity"><span>${identity.initial}</span><h3>${identity.name}</h3></div>`;
      root.body.append(dialog);
      dialog.querySelector("button").onclick = () => dialog.close();
      dialog.addEventListener("close", () => { dialog.remove(); avatar.focus(); });
      close(); dialog.showModal();
    };
  };
  const close = () => { panel.hidden = true; avatar.setAttribute("aria-expanded", "false"); };
  avatar.onclick = () => { panel.hidden = !panel.hidden; avatar.setAttribute("aria-expanded", String(!panel.hidden)); };
  panel.addEventListener("click", event => {
    if (event.target.closest("#appSyncRefresh")) { close(); avatar.focus(); }
  });
  root.addEventListener("keydown", (event) => {
    if (event.key !== "Tab" || panel.hidden) return;
    const options = [...panel.querySelectorAll("button:not(:disabled), a[href]")].filter(node => node.getClientRects().length);
    const focused = root.activeElement;
    if (focused === avatar && !event.shiftKey) { event.preventDefault(); options[0]?.focus(); }
    else if ((focused === options[0] && event.shiftKey) || (focused === options.at(-1) && !event.shiftKey)) {
      event.preventDefault(); close(); avatar.focus();
    }
  });
  const help = panel.querySelector("#accountHelp");
  if (help) help.onclick = async () => {
    close();
    const { openWalkthrough } = await import("./app-walkthrough.js");
    if (!boundary?.revoked) openWalkthrough(root);
  };
  root.addEventListener("click", (event) => { if (!panel.contains(event.target) && !avatar.contains(event.target)) close(); });
  root.addEventListener("keydown", (event) => { if (event.key === "Escape" && !panel.hidden) { close(); avatar.focus(); } });
  const assist = host.querySelector("#colorAssistButton");
  const applyAssist = (enabled) => { root.documentElement.dataset.colorAssist = enabled ? "on" : "off"; assist.setAttribute("aria-pressed", String(enabled)); };
  try { applyAssist(localStorage.getItem("dealroom-color-assist") === "on"); } catch { applyAssist(false); }
  assist.onclick = () => { const enabled = root.documentElement.dataset.colorAssist !== "on"; applyAssist(enabled); try { localStorage.setItem("dealroom-color-assist", enabled ? "on" : "off"); } catch {} };
  const boot = resolveDealroomBoot(globalThis.location);
  const boundary = privateSession();
  const workspace = reactWorkspaceRequested ? mountFlaggedWorkspace(root, pathname, () => !boundary?.revoked) : null;
  if (workspace) root.defaultView.addEventListener("doctorcre-session-invalidated", () => workspace.dispose(), { once: true });
  let lastVerified = null;
  const sessionStatus = root.createElement('p');
  sessionStatus.setAttribute('role','status'); sessionStatus.hidden = true;
  host.after(sessionStatus);
  const readIdentity = async () => {
    try {
      if (boot.mode === "fixture") session = { actor: { slug: boot.options.selfActor || "joe" } };
      else {
        session = await boundary.verify();
        for (const link of askDocLinks) link.hidden = !boundary.engineSignIn;
        lastVerified = new Date().toLocaleTimeString(); sessionStatus.hidden = true;
        panel.querySelector("#accountStatus").textContent = "";
      }
      const identity = partnerIdentity(session);
      showPartner(identity);
      workspace?.setIdentity(identity);
      if (boot.mode === "live" && pathname === "/" && identity && help && !preferences.hasSeenWalkthrough(identity.slug)) {
        void Promise.all([ready, import("./app-walkthrough.js")]).then(([, { openWalkthrough }]) => {
          if (boundary.revoked || !panel.hidden || root.querySelector('dialog:modal') || preferences.hasSeenWalkthrough(identity.slug)) return;
          openWalkthrough(root);
          preferences.rememberWalkthrough(identity.slug);
        }).catch(() => {});
      }
    } catch {
      if (!boundary?.revoked) {
        sessionStatus.textContent = lastVerified ? `Connection unavailable · Last verified ${lastVerified}` : 'Sign-in unavailable';
        sessionStatus.hidden = false;
      }
    }
  };
  readIdentity();
  mountAutoRefresh({ document: root, window: globalThis.window, refresh: readIdentity });
  panel.querySelector("#accountSignOut").onclick = async (event) => {
    if (boot.mode === "fixture") { panel.querySelector("#accountStatus").textContent = "Demo account"; return; }
    if (!session?.csrf_token) { panel.querySelector("#accountStatus").textContent = "Sign-in unavailable"; return; }
    const button = event.currentTarget;
    button.disabled = true;
    try {
      // The auth service responds with a redirect to /. Fetch must not follow
      // that redirect into a fresh login flow before we check revocation.
      await boundary.verify();
      const response = await fetch("/auth/signout", { method: "POST", credentials: "same-origin",
        redirect: "manual", headers: { "x-carr-csrf": session.csrf_token } });
      if ([401,403].includes(response.status)) { boundary.revoke(); return; }
      if (response.type !== "opaqueredirect") throw new Error();
      const after = await fetch("/auth/session", { credentials: "same-origin", cache: "no-store",
        redirect: "manual", headers: { accept: "application/json" } });
      if (after.status !== 401) throw new Error();
      session = null;
      boundary.revoke('signed-out');
    } catch { if (!boundary?.revoked) { panel.querySelector("#accountStatus").textContent = "Sign-out unavailable"; button.disabled = false; } }
  };
  if (pathname === "/calls") root.querySelector(".app-shell-call-availability").hidden = true;
  if (pathname !== "/calls" && !root.getElementById("callModeDialog")) {
    import("./global-call-mode.js").then(async ({ mountGlobalCallMode }) => {
      if (boundary?.revoked) return;
      const call = await mountGlobalCallMode(root);
      if (boundary?.revoked) { call.dispose(); return; }
      root.querySelector("#callModeButton").onclick = () => { close(); call.open(); };
      root.querySelector("#callModeRetry").onclick = (event) => call.handleClick(event.currentTarget);
    });
  }
}

if (typeof document !== "undefined") {
  mountAppShell();
  const actionHost = document.getElementById('actionLink');
  if (actionHost && location.pathname.startsWith('/a/')) {
    const { mountActionLink } = await import("./ui-action.generated.js");
    if (!privateSession()?.revoked) {
      const view = mountActionLink(actionHost, { ref: location.pathname.slice(3), request: createMcpRequests() });
      window.addEventListener('doctorcre-session-invalidated', () => view.dispose(), { once: true });
    }
  }
}
