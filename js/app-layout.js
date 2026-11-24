import { TOUCH_LAYOUT } from './touch-layout.js';
import { scopedDeals } from './deal-review-model.js';
import { createClient } from './client.js';
import { resolveDealroomBoot, updatesFromEngine } from './boot-mode.js';

import { mountAutoRefresh } from './auto-refresh.mjs';
import { escapeText as escape } from './change-receipts.mjs';

const time = value => { const date = new Date(value || ''); return Number.isFinite(date.valueOf()) ? date.toLocaleTimeString([], { hour:'numeric', minute:'2-digit', hour12:true }) : '—'; };

function createAppLayout(root, title) {
  const todayContent = `<section class="calendar-panel" aria-label="Meetings"><h3>Meetings</h3><div id="appScheduleSlot" role="status">Loading meetings…</div><div id="appMeetingReviews" hidden></div></section>
      <section aria-labelledby="appRemindersTitle"><h3 id="appRemindersTitle">Dated reminders</h3><div id="appTodayOwners" hidden></div><div id="appTodayLate" hidden><h4>Late</h4><div id="appTodayNeeds"></div></div><div id="appTodayNext" role="status">Loading dated reminders…</div></section>
      <button type="button" id="appTodayRetry" class="app-layout-item" hidden>Retry Today</button>`;
  const layout = root.createElement('div');
  layout.id = 'appLayout';
  layout.className = 'app-layout';
  layout.innerHTML = `<aside id="appSidebar" class="app-layout-sidebar" aria-label="${escape(title)} workspace"><div class="app-layout-sidebar-head"><h2>${escape(title)}</h2><button type="button" data-layout-close="sidebar" aria-label="Close workspace">‹</button></div></aside>
    <div class="app-layout-center"><div id="appTopbar" class="app-layout-topbar" role="region" aria-label="App controls"></div><div class="app-layout-tabbar" role="navigation" aria-label="Page controls"><button type="button" id="appSidebarToggle" aria-label="Workspace sidebar" aria-controls="appSidebar" aria-expanded="false" title="Workspace sidebar">☷</button><div id="appTabsSlot" class="app-layout-tabs" role="group" aria-label="${escape(title)} views"></div><button type="button" id="appTodayToggle" aria-label="Today sidebar" aria-controls="appToday" aria-expanded="true" title="Today">◷</button></div><div id="appMainSlot" class="app-layout-main"></div><details class="app-layout-page-tools"><summary>Page tools</summary><div id="appSidebarSlot"></div></details></div>
    <aside id="appToday" class="app-layout-today" aria-labelledby="appTodayTitle"><div class="app-layout-sidebar-head"><h2 id="appTodayTitle">Today</h2><time id="appSyncTime" hidden></time><button type="button" data-layout-close="today" aria-label="Close Today">›</button></div><p id="appConnection" role="status" hidden></p>${todayContent}</aside>
    <button class="app-layout-scrim" id="appDrawerScrim" type="button" aria-label="Close sidebar" hidden></button>`;
  return layout;
}

// Slots contain the page's original nodes, not copies. IDs, listeners, drafts and
// lazy tab reads therefore retain their existing owner across layout changes.
export function mountAppLayout(root, host, pathname) {
  if (root.getElementById('appLayout')) return;
  const win = root.defaultView || globalThis.window;
  const pageKey = pathname === '/deals' ? '/deals' : pathname;
  const calendarPanel = pathname === '/calendar' && root.getElementById('dayPanel');
  const deferToday = ['/updates', '/notifications'].includes(pathname) && updatesFromEngine(root);
  const boardPage = ['/leads','/deals','/pipeline'].includes(pathname);
  const vendorDirectory = pathname === '/vendors';
  const title = pathname === '/' ? 'Home' : pathname === '/vendors' ? 'Vendors' : pathname === '/clients' ? 'Clients' : pathname === '/deals' ? 'Local Deals' : root.querySelector('main h1, .page-kicker')?.textContent.trim().replace(/Loading$/, '').trim() || root.title.split('·')[0].trim();
  const engineToday = root.documentElement.hasAttribute('data-home-today-from-engine');
  const layout = createAppLayout(root, title);
  host.after(layout);
  const skip = root.querySelector('.skip');
  if (skip) host.querySelector('header')?.prepend(skip);
  const main = layout.querySelector('#appMainSlot');
  const pageTools = layout.querySelector('.app-layout-page-tools');
  main.append(pageTools);
  // Modals and fixed feedback belong to the viewport, outside page regions.
  root.querySelectorAll('.record-backdrop, aside.record-panel, .room-toast').forEach(node => root.body.append(node));
  // Lift declarative page slots before putting the remaining page into main.
  const pageViews = layout.querySelector('#appTabsSlot');
  const slots = {
    title: layout.querySelector(".app-layout-tabbar"),
    tabs: pageViews,
    actions: pageViews,
    sidebar: layout.querySelector('#appSidebarSlot'),
    moves: !engineToday && layout.querySelector('#appToday'),
  };
  for (const node of [...root.querySelectorAll('[data-layout-slot]')]) {
    const slot = node.dataset.layoutSlot;
    const target = slots[slot];
    if (!target) continue;
    if (slot === 'title') target.before(node);
    else target.append(node);
  }
  for (const node of [...root.body.children]) {
    if (node === host || node === layout || ['SCRIPT','DIALOG'].includes(node.tagName) || node.matches('.app-shell-account-menu, .skip, .toast, .receipt-dock, .record-backdrop, aside.record-panel, .room-toast')) continue;
    const focusedSearch = pathname === '/search' && node.contains(root.getElementById('searchQuery')) && node.contains(root.activeElement);
    if (focusedSearch && main.moveBefore) main.moveBefore(node, pageTools);
    else if (focusedSearch) {
      let composing = root.getElementById('searchQuery').dataset.composing === 'true';
      const moveWhenReady = event => {
        if (composing || node.contains(event?.relatedTarget) || node.contains(root.activeElement)) return;
        node.removeEventListener('focusout', moveWhenReady);
        node.removeEventListener('compositionstart', startComposition);
        node.removeEventListener('compositionend', endComposition);
        main.insertBefore(node, pageTools);
      };
      const startComposition = () => { composing = true; };
      const endComposition = () => { composing = false; moveWhenReady(); };
      node.addEventListener('compositionstart', startComposition);
      node.addEventListener('compositionend', endComposition);
      node.addEventListener('focusout', moveWhenReady);
    }
    else main.insertBefore(node, pageTools);
  }
  const hasPageTools = Boolean(layout.querySelector('#appSidebarSlot').childElementCount);
  pageTools.open = !vendorDirectory && hasPageTools;
  pageTools.hidden = !hasPageTools;
  root.body.classList.add('has-app-layout');
  const pageRefresh = main.querySelector('[data-layout-slot="status"] [data-layout-refresh]');
  const pageMoves = layout.querySelector('[data-layout-slot="moves"]');
  const phone = win.matchMedia(pathname === "/leads" ? "(max-width:1023px)" : TOUCH_LAYOUT);
  const dealBoard = pathname === '/deals' && root.body.classList.contains('dealroom-page');
  const itineraryPage = Boolean(root.getElementById('accepted-itinerary'));
  let sidebar = !engineToday && !boardPage && !itineraryPage && !vendorDirectory && !calendarPanel, today = !deferToday, drawer = null;
  let drawerOpener = null;
  const background = new Map();
  try {
    const saved = win.localStorage.getItem(`doctorcre:sidebar:${pageKey}`);
    if (!engineToday && saved !== null) sidebar = saved === 'open';
    const savedToday = win.localStorage.getItem(dealBoard ? 'doctorcre:today:/deals' : 'doctorcre:today');
    if (!deferToday && savedToday !== null) today = savedToday !== 'closed';
  } catch {}
  const sidebarToggle = layout.querySelector('#appSidebarToggle'), todayToggle = layout.querySelector('#appTodayToggle');
  sidebarToggle.hidden = engineToday;
  if (calendarPanel) {
    today = false;
    todayToggle.remove();
    layout.querySelector('[data-layout-close="today"]').remove();
  }
  const paint = () => {
    layout.dataset.sidebar = sidebar ? 'open' : 'closed'; layout.dataset.today = today ? 'open' : 'closed'; layout.dataset.drawer = drawer || '';
    const leftOpen = phone.matches ? drawer === 'sidebar' : sidebar;
    const rightOpen = phone.matches ? drawer === 'today' : today;
    layout.querySelector('#appSidebar').inert = !leftOpen;
    layout.querySelector('#appToday').inert = !rightOpen;
    sidebarToggle.setAttribute('aria-expanded', String(leftOpen)); todayToggle.setAttribute('aria-expanded', String(rightOpen));
    layout.querySelectorAll('[data-layout-close]').forEach(button => button.setAttribute('aria-expanded', String(button.dataset.layoutClose === 'sidebar' ? leftOpen : rightOpen)));
    layout.querySelector('#appDrawerScrim').hidden = !phone.matches || !drawer;
    if (phone.matches && drawer) {
      for (const node of [layout.querySelector('.app-layout-center'), ...root.body.children]) {
        if (node === layout || node.tagName === 'DIALOG') continue;
        if (!background.has(node)) background.set(node, node.inert);
        node.inert = true;
      }
    } else {
      for (const [node, inert] of background) node.inert = inert;
      background.clear();
    }
  };
  const openRegion = (region, opener = root.activeElement) => {
    if (phone.matches) {
      drawerOpener = opener;
      drawer = region;
    } else if (region === 'sidebar') sidebar = true;
    else today = true;
    paint();
    if (phone.matches) layout.querySelector(`#${region === 'sidebar' ? 'appSidebar' : 'appToday'} button`).focus();
  };
  const toggle = region => {
    if (phone.matches) { if (drawer === region) closeDrawer(); else openRegion(region); return; }
    else if (region === 'sidebar') { sidebar = !sidebar; try { win.localStorage.setItem(`doctorcre:sidebar:${pageKey}`, sidebar ? 'open' : 'closed'); } catch {} }
    else { today = !today; try { if (!deferToday) win.localStorage.setItem(dealBoard ? 'doctorcre:today:/deals' : 'doctorcre:today', today ? 'open' : 'closed'); } catch {} }
    paint();
    if (region === 'sidebar' && !sidebar) sidebarToggle.focus();
    if (region === 'today' && !today) todayToggle.focus();
  };
  const closeDrawer = () => {
    const previous = drawer; drawer = null; paint();
    if (previous) (drawerOpener?.isConnected && !drawerOpener.closest("[inert]") ? drawerOpener : previous === 'sidebar' ? sidebarToggle : todayToggle).focus();
    drawerOpener = null;
  };
  layout.querySelector('#agendaButton')?.addEventListener('click', () => { if (phone.matches) closeDrawer(); });
  sidebarToggle.onclick = () => toggle('sidebar'); todayToggle.onclick = () => toggle('today');
  layout.querySelector('#appDrawerScrim').onclick = closeDrawer;
  layout.querySelectorAll('[data-layout-close]').forEach(button => button.onclick = () => phone.matches ? closeDrawer() : toggle(button.dataset.layoutClose));
  root.addEventListener('keydown', event => {
    if (!phone.matches || !drawer || root.querySelector('dialog:modal')) return;
    if (event.key === 'Escape') { event.preventDefault(); closeDrawer(); }
    if (event.key === 'Tab') {
      const panel = layout.querySelector(drawer === 'sidebar' ? '#appSidebar' : '#appToday');
      const focusable = [...panel.querySelectorAll(`a,button,input,select,textarea,[tabindex="0"]${drawer === 'today' ? ',summary' : ''}`)].filter(n => !n.disabled && n.getClientRects().length);
      const first = focusable[0], last = focusable.at(-1);
      if (!panel.contains(root.activeElement)) { event.preventDefault(); (event.shiftKey ? last : first)?.focus(); }
      else if (event.shiftKey && root.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && root.activeElement === last) { event.preventDefault(); first?.focus(); }
    }
  });
  phone.addEventListener('change', () => { drawer = null; paint(); });
  paint();
  root.addEventListener('doctorcre:open-today', () => {
    if (calendarPanel) calendarPanel.scrollIntoView({ block: 'start' });
    else if (engineToday && pageMoves) pageMoves.scrollIntoView({ block: 'start' });
    else openRegion('today');
  });
  // Page tab controllers retain selection and lazy reads. Give groups without
  // their own roving focus the same left/right keyboard affordance.
  const tabs = layout.querySelector('#appTabsSlot');
  const showSelectedTab = () => {
    const selected = tabs.querySelector('[aria-current="page"],[aria-selected="true"],[aria-pressed="true"]');
    if (!selected) return;
    const edge = selected.getBoundingClientRect(), viewport = tabs.getBoundingClientRect();
    if (edge.right > viewport.right) tabs.scrollLeft += edge.right - viewport.right;
    else if (edge.left < viewport.left) tabs.scrollLeft -= viewport.left - edge.left;
  };
  // eslint-disable-next-line no-restricted-syntax -- A single initial frame scrolls the selected tab into view; it performs no reads.
  win.requestAnimationFrame(showSelectedTab);
  phone.addEventListener('change', showSelectedTab);
  tabs.addEventListener('keydown', event => {
    if (event.target.closest('[role="tablist"]') || !['ArrowLeft','ArrowRight','Home','End'].includes(event.key)) return;
    const items = [...tabs.querySelectorAll('a,button')].filter(n => !n.disabled && n.getClientRects().length);
    const i = items.indexOf(root.activeElement); if (i < 0) return;
    event.preventDefault(); const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (i + (event.key === 'ArrowRight' ? 1 : -1) + items.length) % items.length;
    items[next]?.focus();
  });
  if (calendarPanel && engineToday) {
    tabs.closest('.app-layout-tabbar').remove();
    return;
  }
  if (pathname === '/' && new URLSearchParams(win.location.search).get('view') !== 'charts') {
    today = false;
    paint();
    todayToggle.remove();
    layout.querySelector('#appToday').hidden = true;
    return;
  }
  const boot = resolveDealroomBoot(globalThis.location);
  let client;
  const homeToday = import('./ui-home-today.generated.js')
    .then(module => module.mountHomeTodayPanel(layout.querySelector('#appToday'), async signal => {
      client ??= await createClient(boot.mode, { ...boot.options, docContext: false });
      const deals = scopedDeals(await client.getBoard({ workspace: 'all', signal }), 'team');
      if (!deals) throw new Error('Could not load meeting deals');
      return deals;
    }, { hideEndedDealReminders: pathname === '/deals' })).catch(() => {
      layout.querySelector('#appScheduleSlot').textContent = "Couldn't load meetings.";
      layout.querySelector('#appTodayNext').textContent = "Couldn't load dated reminders.";
      return null;
    });
  const connection = connected => {
    connected = connected && win.navigator.onLine !== false;
    const notice = layout.querySelector('#appConnection');
    notice.hidden = connected;
    const message = connected ? '' : 'Connection unavailable';
    if (notice.textContent !== message) notice.textContent = message;
  };
  const failedRead = () => {
    void homeToday.then(panel => panel?.clear(win.navigator.onLine === false ? 'offline' : 'unavailable'));
    connection(false);
  };
  const lifetime = new AbortController();
  const loadingRead = () => {
    connection(true);
    void homeToday.then(panel => panel?.clear('loading'));
  };
  const stampSyncTime = () => {
    const observed = new Date().toISOString();
    const stamp = layout.querySelector('#appSyncTime');
    stamp.textContent = `Updated ${time(observed)}`;
    stamp.dateTime = observed;
    stamp.hidden = false;
  };
  const refresh = async ({ signal } = {}) => {
    signal = signal ? AbortSignal.any([signal, lifetime.signal]) : lifetime.signal;
    if (signal.aborted) return;
    if (win.navigator.onLine === false) { failedRead(); return; }
    const panel = await homeToday;
    if (signal.aborted) return;
    const connected = await panel?.refresh(signal);
    if (!signal.aborted) {
      connection(connected);
      if (connected) stampSyncTime();
    }
  };
  win.addEventListener('offline', failedRead);
  let todayRequested = !deferToday;
  const auto = mountAutoRefresh({ document:root, window:win, refresh, onResume:loadingRead, onError:failedRead, shouldRefresh: () => todayRequested });
  layout.querySelector('#appTodayRetry').onclick = () => auto.refresh();
  let fanOut = false;
  const refreshButton = root.createElement('button');
  refreshButton.id = 'appSyncRefresh';
  refreshButton.type = 'button';
  refreshButton.setAttribute('aria-label', 'Refresh workspace');
  refreshButton.textContent = '↻';
  (root.getElementById('accountWorkspaceControls') || layout.querySelector('.app-layout-sidebar-head')).append(refreshButton);
  refreshButton.onclick = () => {
    auto.refresh(); fanOut = true;
    try { root.querySelectorAll('[data-layout-refresh]').forEach(button => button.click()); } finally { fanOut = false; }
  };
  pageRefresh?.addEventListener('click', () => { if (!fanOut) auto.refresh(); });
  const startToday = () => {
    todayToggle.removeEventListener('click', startToday);
    root.removeEventListener('doctorcre:open-today', startToday);
    todayRequested = true;
    void homeToday.then(() => auto.refresh());
  };
  if (deferToday) {
    todayToggle.addEventListener('click', startToday, { once: true });
    root.addEventListener('doctorcre:open-today', startToday, { once: true });
  } else startToday();
  const invalidateSession = () => {
    lifetime.abort();
    auto.dispose();
    failedRead();
    void homeToday.then(panel => panel?.dispose());
  };
  win.addEventListener('doctorcre-session-invalidated', invalidateSession);
  win.addEventListener('pagehide', () => {
    lifetime.abort();
    win.removeEventListener('doctorcre-session-invalidated', invalidateSession);
    auto.dispose();
    win.removeEventListener('offline', failedRead);
  });
}
