import { navigationFor, navigationItems, sectionForRoute, routeKey, actionLinkRoute } from "./routes.js";
export { navigationItems };

export function activeDestination(pathname) {
  if (pathname.startsWith('/control-room/progress/board/')) return '/control-room/progress';
  return sectionForRoute[routeKey(actionLinkRoute(pathname))] || pathname;
}

export function appOriginForReport(origin) {
  try {
    const url = new URL(origin);
    if (!url.hostname.startsWith("reports.")) return "";
    url.hostname = `app.${url.hostname.slice("reports.".length)}`;
    return url.origin;
  } catch { return ""; }
}

const destinationIcons = {
  "/": "M3 10.5 12 3l9 7.5M5 9v11h5v-6h4v6h5V9",
  "/deals": "M3 5h18v14H3zM9 5v14m6-14v14",
  "/leads": "M15 20H3v-2a4 4 0 0 1 4-4h4a4 4 0 0 1 4 4zM13 8a4 4 0 1 1-8 0 4 4 0 0 1 8 0zM17 9h5m-2.5-2.5v5",
  "/vendors": "M3 10h18l-2-6H5zM5 10v10h14V10M10 20v-6h4v6",
  "/clients": "M5 3h13v18H5zM3 7h4m-4 5h4m-4 5h4m3 0a2 2 0 0 1 2-2h1a2 2 0 0 1 2 2m-1-7a1.5 1.5 0 1 1-3 0 1.5 1.5 0 0 1 3 0z",
  "/calendar": "M4 6h16v15H4zM8 3v5m8-5v5M4 10h16m-12 4h2m4 0h2m-8 3h2",
  "/calls": "M5 4h4l2 5-3 2c1 2 3 4 5 5l2-3 5 2v4a2 2 0 0 1-2 2C10 21 3 14 3 6a2 2 0 0 1 2-2z",
  "/relationships": "M10 13a4 4 0 0 0 6 1l4-4a4 4 0 0 0-6-6l-2 2m2 5a4 4 0 0 0-6-1l-4 4a4 4 0 0 0 6 6l2-2",
  "/invoices": "M5 3h14v18l-3-2-4 2-4-2-3 2zM9 8h6m-6 4h6m-6 4h3",
  "/leases": "M5 3h10l4 4v14H5zM14 3v5h5M9 12h6m-6 4h6",
  "/ideas-events?tab=events": "m12 3 2.6 5.5 6 .9-4.3 4.3 1 6.1-5.3-2.9-5.3 2.9 1-6.1-4.3-4.3 6-.9z",
  "/updates": "M18 8a6 6 0 0 0-12 0c0 6-1 7-3 9h18c-2-2-3-3-3-9m-8 12a2 2 0 0 0 4 0",
};

function icon(path) {
  return `<svg class="app-shell-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="${path}"/></svg>`;
}

function link({ label, href }, current, base) {
  const active = href === current;
  const badge = label === "Updates" ? '<span class="nav-badge" id="navUnreadBadge" hidden></span>' : "";
  return `<a data-app-nav-item aria-label="${label}" title="${label}" href="${base}${href}"${active ? ' aria-current="page"' : ""}>${icon(destinationIcons[href])}<span class="app-shell-nav-label">${label}</span>${badge}</a>`;
}

export function appShellMarkup(pathname, base = "", search = "", items = navigationItems) {
  const current = pathname === "/ideas-events" ? `/ideas-events?tab=${new URLSearchParams(search).get("tab") === "events" ? "events" : "ideas"}` : activeDestination(pathname);
  const primary = items.filter(item => !item.secondary).map((item) => link(item, current, base)).join("");
  const secondary = items.filter(item => item.secondary);
  const more = secondary.map(item => link(item, current, base)).join("");
  const moreActive = secondary.some(item => item.href === current);
  return `<header class="app-shell-header" aria-label="Workspace rail">
    <a class="app-shell-brand" href="${base}/" aria-label="DoctorCRE Home">
      <svg viewBox="0 0 42 42" role="img" aria-label="Work flows from leads through deals to delivery">
        <path class="app-shell-flow" d="M7 21h9l6-9h9M16 21l6 9h9"/>
        <circle cx="7" cy="21" r="3"/><circle cx="22" cy="12" r="3"/><circle cx="31" cy="12" r="3"/><circle cx="22" cy="30" r="3"/><circle cx="31" cy="30" r="3"/>
      </svg><span class="app-shell-brand-name">Doctor<span class="app-shell-brand-accent">CRE</span></span>
    </a>
    <div class="app-shell-menu">
      <nav class="app-shell-navigation" aria-label="Primary navigation">${primary}<div class="app-shell-more"><button type="button" class="app-shell-more-toggle${moreActive ? " app-shell-more-current" : ""}" aria-expanded="false" aria-label="More" title="More">${icon("M5 12h.01M12 12h.01M19 12h.01")}<span class="app-shell-nav-label">More</span></button><div class="app-shell-more-list" hidden>${more}</div></div></nav>
    </div>
    <a class="app-shell-search" href="${base}/search" aria-label="Search" title="Search"${pathname === "/search" ? ' aria-current="page"' : ""}>${icon("M16 10a6 6 0 1 1-12 0 6 6 0 0 1 12 0zm-1.5 4.5L21 21")}</a>
    <div class="app-shell-controls" aria-label="Workspace controls">
      <button class="app-shell-control" type="button" data-pref="theme" data-on="dark" data-off="light" aria-pressed="true" aria-label="Dark mode" title="Dark mode">${icon("M20 15.5A8.5 8.5 0 0 1 8.5 4 8.5 8.5 0 1 0 20 15.5z")}</button>
      <button class="app-shell-control" id="callModeButton" type="button" aria-label="Call mode" title="Call mode" aria-haspopup="dialog" hidden><span aria-hidden="true">☎</span></button>
      <button class="app-shell-control" id="colorAssistButton" type="button" aria-pressed="false" aria-label="Color assist" title="Color assist">${icon("M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0zM12 3v18m-6-5 6-6m-4 9 4-4M4 12l8-8")}</button>
      <div class="app-shell-account"><button class="app-shell-avatar" id="selfAvatar" type="button" aria-label="Account and settings" aria-expanded="false" aria-controls="accountMenu">…</button>
        <div class="app-shell-account-menu" id="accountMenu" hidden>
          <strong id="accountWorkspace">Workspace</strong>
          <div class="app-shell-account-group" role="group" aria-label="Account"><h3>Account</h3>
          <button type="button" id="accountProfile">Profile</button>
          ${pathname === "/share" ? "" : '<button type="button" id="accountHelp" aria-haspopup="dialog">How DoctorCRE works</button>'}
          <a href="${base}/updates#prefForm">Notification preferences</a>
          <a href="${base}/updates#docLinkSettings" id="accountDocLink" hidden>Doc link</a>
          <a href="${base}/doc-activity"${pathname === "/doc-activity" ? ' aria-current="page"' : ""}>Doc Activity</a>
          </div>
          <div id="accountWorkspaceControls" class="app-shell-workspace-group" role="group" aria-label="Workspace" hidden><h3>Workspace</h3></div>
          <div class="app-shell-call-availability">
            <span id="callModeAvailability" role="status">Call recorder not connected</span>
            <button type="button" id="callModeRetry" aria-describedby="callModeAvailability">Check call recorder status</button>
          </div>
          <button type="button" id="accountSignOut">Sign out</button>
          <p id="accountStatus" role="status"></p>
        </div>
      </div>
    </div>
  </header>`;
}

// Reports mount this interface without app layout, identity reads or partner controls.
export function mountNavigation(root = document, pathname = root.defaultView?.location.pathname || "/", { report = false, location = root.defaultView?.location || globalThis.location } = {}) {
  const host = root.getElementById("appShell");
  if (!host) return;
  const fontStylesheet = root.querySelector('link[data-font-stylesheet][rel="preload"][as="style"]');
  if (fontStylesheet) {
    const activate = () => { fontStylesheet.rel = "stylesheet"; };
    if (root.readyState === "complete") activate();
    else root.defaultView.addEventListener("load", activate, { once: true });
  }
  const base = appOriginForReport(location?.origin || "");
  host.innerHTML = appShellMarkup(pathname, base, location?.search || "", navigationFor(root));
  if (report || base) {
    host.querySelector(".app-shell-controls").remove();
  }
  if (report || base || pathname === "/share") root.body.classList.add("report-shell");
  const moreButton = host.querySelector(".app-shell-more-toggle");
  const moreList = host.querySelector(".app-shell-more-list");
  moreButton.addEventListener("click", () => {
    moreList.hidden = !moreList.hidden;
    moreButton.setAttribute("aria-expanded", String(!moreList.hidden));
  });
  host.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    if (!moreList.hidden) { moreList.hidden = true; moreButton.setAttribute("aria-expanded", "false"); moreButton.focus(); }
  });
  root.addEventListener("click", (event) => {
    if (!event.target.closest(".app-shell-more") && !moreList.hidden) { moreList.hidden = true; moreButton.setAttribute("aria-expanded", "false"); }
  });
  return host;
}
