import { createClient } from './client.js';
import { resolveDealroomBoot } from './boot-mode.js';
import { TOUCH_LAYOUT } from './touch-layout.js';
import { createPageBudget } from './read-budget.mjs';
import { mountBriefQueues } from './brief-queues.js';
import { overnightCutoff } from './business-date.js';
import { toDay } from './calendar-model.js';
import { briefInstruction, briefSectionsHtml } from './morning-brief-sections.js';
import { briefPreferences } from './brief-preferences.js';
import { briefOwnerLabel, mountBriefOwnerFilter } from './brief-owner-filter.js';
import {onDialogClosed} from './dialog-lifecycle.js';
import { mountAutoRefresh, readWithDeadline, updatedLabel } from './auto-refresh.mjs';
import { escapeText } from './change-receipts.mjs';
import { entryDetailsHtml } from './entry-details.mjs';
import { localDay, normalizeBrief, morningBriefView } from './morning-brief-model.js';

const dueFormat = new Intl.DateTimeFormat('en-US', { timeZone:'UTC', weekday:'long', month:'short', day:'numeric', year:'numeric' });
const dueLabel = value => {
  const day = toDay(value);
  return day ? dueFormat.format(new Date(`${day}T00:00:00Z`)) : value;
};

export function mountMorningBrief({ document:root, window:win, getClient, intervalMs, now = () => new Date() }) {
  const dialog = root.createElement('dialog'); dialog.id = 'docMorningBrief'; dialog.className = 'morning-brief'; dialog.setAttribute('aria-labelledby','morningTitle');
  dialog.innerHTML = '<header><h2 id="morningTitle">Morning brief</h2><button id="morningClose" type="button" aria-label="Dismiss morning brief">×</button></header><div class="morning-toolbar"><button id="morningBack" type="button" hidden>← Morning brief</button><time id="morningUpdated">Updating…</time><button id="morningRefresh" type="button" aria-label="Refresh morning brief" title="Refresh morning brief">↻</button></div><div id="morningOwners"></div><div id="morningCoverage" role="status"></div><nav id="morningQueues" aria-label="Morning work queues"></nav><div id="morningContent"></div>';
  root.body.append(dialog);
  const $ = id => dialog.querySelector(`#${id}`) || root.getElementById(id), control = $('docMorning');
  let facts = null, calendar, viewOptions, readEpoch = 0, fresh = false;
  let client, view = null, sponsor = null, preferences, since, windowDay, events = [], cursor = null, disposed = false, selected = null, detailEpoch = 0, opener;
  let storage; try { storage = win.localStorage; } catch {}
  const render = () => {
    const updated = queues.active ? queues.updated : {observedAt:view?.observedAt};
    $('morningUpdated').textContent = updated.error ? 'Queue update unavailable' : updatedLabel(updated.observedAt);
    if (updated.observedAt) $('morningUpdated').dateTime = updated.observedAt; else $('morningUpdated').removeAttribute('datetime');
    $('morningCoverage').textContent = view ? view.unavailable.join(' · ') : 'Brief unavailable';
    queues.menu(facts);
    if (queues.active) dialog.dataset.queueOpen = ''; else delete dialog.dataset.queueOpen;
    $('morningOwners').hidden = queues.active;
    if (queues.active) {
      const label = queues.label, count = queues.countLine;
      if (label) $('morningTitle').textContent = count ? `${label} · ${count}` : label;
      return;
    }
    if (selected) return;
    const title = view ? `Morning brief · ${view.sponsor === 'joe' ? 'Joe' : 'Dell'}` : 'Morning brief';
    $('morningTitle').textContent = title;
    $('morningBack').hidden = true;
    const empty = view && !view.unavailable.length ? `<section><p>${owners.current() === 'all' ? 'No selected priority cards' : `No selected priority cards for ${owners.current() === 'joe' ? 'Joe' : 'Dell'}`}</p>${owners.current() !== 'all' ? '<button type="button" data-brief-show-all>Show all</button>' : ''}</section>` : '';
    const cards = view?.groups.map(({label,row},index) => `<section><h3>${label}</h3><button type="button" class="morning-card" data-urgency="${row.due && row.due < localDay(now()) ? 'overdue' : 'today'}" data-brief-record="${index}" data-brief-key="${escapeText(row.key)}"><span class="morning-marker" aria-hidden="true">${index === 0 ? '↗' : '◇'}</span><div><strong>${escapeText(row.title)}</strong>${briefOwnerLabel(row) ? `<small class="morning-owner">${briefOwnerLabel(row)}</small>` : ''}${row.summary ? `<span>${escapeText(row.summary)}</span>` : ''}${row.due ? `<time datetime="${escapeText(row.due)}">Due ${escapeText(dueLabel(row.due))}</time>` : ''}</div><span aria-hidden="true">↗</span></button></section>`).join('') || empty;
    const html = cards + (view ? briefSectionsHtml(view.coverage) : '');
    if ($('morningContent').innerHTML !== html) {
      const focus = root.activeElement?.dataset.briefKey;
      const expanded = [...$('morningContent').querySelectorAll('[data-brief-section][open]')].map(node => node.dataset.briefSection);
      const focusedSection = root.activeElement?.closest('[data-brief-section]')?.dataset.briefSection;
      $('morningContent').innerHTML = html;
      for (const node of $('morningContent').querySelectorAll('[data-brief-section]')) {
        node.open = expanded.includes(node.dataset.briefSection);
        if (node.dataset.briefSection === focusedSection) node.querySelector('summary').focus();
      }
      if (focus !== undefined) focusCard(focus);
    }
  };
  const owners = mountBriefOwnerFilter(root, $('morningOwners'), () => {
    selected = null; ++detailEpoch;
    view = facts ? morningBriefView(facts, {...viewOptions, owner:owners.current()}) : null;
    render();
  });
  const cue = () => {
    const unseen = !!(view && preferences && preferences.value.day !== localDay(now()));
    const doc = $('docOpen');
    doc?.toggleAttribute('data-brief-unseen', unseen);
    if (unseen) doc?.setAttribute('aria-description', 'Morning brief ready'); else doc?.removeAttribute('aria-description');
    control.textContent = unseen ? 'Morning brief · new today' : 'Morning brief';
  };
  const remember = () => { if (preferences && view) preferences.save({ day:localDay(now()), lastShownAt:now().toISOString(), since }); cue(); };
  const close = () => { dialog.close(); };
  const open = async () => {
    opener = root.activeElement;
    const doc = $('docDetail'); if (doc?.open) doc.close();
    const pending = auto.revalidate();
    if (!dialog.open) dialog.showModal();
    const queuesReady = queues.prepare().catch(() => {});
    await pending;
    await queuesReady;
    if (!disposed) queues.menu(facts);
    if (dialog.open && sponsor && view) remember();
  };
  const focusCard = key => ([...$('morningContent').querySelectorAll('[data-brief-key]')].find(node => node.dataset.briefKey === key) || $('morningClose')).focus();
  const back = () => { queues.reset(); const key = selected?.key; selected = null; ++detailEpoch; render(); focusCard(key); };
  const publishCalendar = value => { calendar = value; root.dispatchEvent(new win.CustomEvent('doctorcre:brief-calendar', { detail: value })); };
  const clear = () => { queues.reset(); ++detailEpoch; selected = null; view = null; facts = null; sponsor = null; preferences = null; since = null; events = []; cursor = null; render(); cue(); };
  const suspend = () => { ++readEpoch; fresh = true; clear(); };
  const invalidate = () => { suspend(); publishCalendar(null); };
  const showRecord = async (row, { background = false } = {}) => {
    selected = row; const epoch = ++detailEpoch, owner = sponsor;
    $('morningBack').hidden = false; $('morningTitle').textContent = row.title;
    if (!background) { $('morningBack').focus(); $('morningContent').innerHTML = '<span class="morning-pending" role="status">Updating…</span>'; }
    try {
      const value = await readWithDeadline(() => row.kind === 'action' ? {action:row.action} : row.kind === 'deal' ? client.getDeal(row.id) : client.readLoop({ number:row.id,kind:row.loopKind }));
      if (disposed || epoch !== detailEpoch || owner !== sponsor) return;
      const record = row.kind === 'action' ? value?.action : row.kind === 'deal' ? value?.deal : value?.loop;
      if (!record || (row.kind === 'loop' ? String(record.number) !== row.id || record.kind !== row.loopKind : record.id !== row.id)) throw new Error('Invalid record');
      $('morningTitle').textContent = record.name || record.title || record.subject_name || row.title;
      const facts = row.kind === 'deal' ? [['Next step',row.action ? row.action.what : record.next_step],['Due',row.action ? row.action.due_on : record.next_date],['Phase',record.phase]] : row.kind === 'action' ? [['For',record.subject_name],['Reference',record.subject_ref],['Due',record.due_on],['Owner',record.owner]] : [['Due',record.due_on],['Status',record.status === 'open' ? null : record.status],['Your task',briefInstruction($('morningTitle').textContent,record.blocker_detail)]];
      const entries = row.kind === 'deal' ? value.thread || [] : [{ id:row.key, text:row.kind === 'action' ? record.what : record.body }];
      const expanded = [...$('morningContent').querySelectorAll('details[open]')].map(node => node.dataset.entry);
      const focusedEntry = root.activeElement?.closest('details')?.dataset.entry;
      const html = `<div class="morning-record"><dl>${facts.filter(([,value]) => value).map(([label,value]) => `<div><dt>${label}</dt><dd>${escapeText(label === 'Due' ? dueLabel(value) : value)}</dd></div>`).join('')}</dl><section>${entries.filter(entry => entry.text).slice(0,5).map(entry => `<article>${entryDetailsHtml(entry.text).replace('<details>',`<details${entry.id ? ` data-entry="${escapeText(entry.id)}"` : ''}>`)}</article>`).join('')}</section></div>`;
      if ($('morningContent').innerHTML !== html) {
        $('morningContent').innerHTML = html;
        const details = [...$('morningContent').querySelectorAll('details')];
        for (const detail of details) if (detail.dataset.entry !== undefined && expanded.includes(detail.dataset.entry)) detail.open = true;
        if (focusedEntry !== undefined) (details.find(detail => detail.dataset.entry === focusedEntry)?.querySelector('summary') || $('morningBack')).focus();
      }
    } catch (error) {
      if (disposed || epoch !== detailEpoch || owner !== sponsor) return;
      if ([401,403].includes(error.status)) invalidate();
      if (epoch === detailEpoch && !disposed) $('morningContent').innerHTML = '<span role="status">Record unavailable</span>';
    }
  };
  const refresh = async ({signal} = {}) => {
    const epoch = readEpoch;
    const current = () => !disposed && !signal?.aborted && epoch === readEpoch;
    if (dialog.open) queues.prepare().catch(() => {});
    try {
      if (!current()) return;
      client ||= await getClient();
      if (!current()) return;
      const freshRead = fresh; fresh = false;
      const payload = normalizeBrief(await readWithDeadline(() => client.morningBrief({signal, fresh:freshRead}), {signal}));
      if (!current()) return;
      if (!payload) throw new Error('Invalid brief');
      if (sponsor !== payload.sponsor || windowDay !== localDay(now())) {
        clear(); sponsor = payload.sponsor; preferences = briefPreferences(storage,sponsor); windowDay = localDay(now()); owners.setViewer(sponsor);
        const currentDay = localDay(now());
        if (preferences.value.day === currentDay && Number.isFinite(Date.parse(preferences.value.since))) since = preferences.value.since;
        else if (Number.isFinite(Date.parse(preferences.value.lastShownAt))) since = preferences.value.lastShownAt;
        else since = overnightCutoff(now());
      }
      let caughtUp = false;
      try {
        const takePage = createPageBudget();
        // eslint-disable-next-line no-restricted-syntax -- Brief change catch-up stops after 4 pages and calls takePage before each read.
        for (let page=0; page<4 && client.changeFeedEnabled !== false; page++) {
          takePage();
          const changes = await readWithDeadline(() => client.getChanges(cursor,{signal,since}),{signal});
          if (changes === null) break;
          if (!Array.isArray(changes?.events)) throw new Error('Invalid changes');
          if (!current()) return;
          const ids = new Set(events.map(event => event.id));
          events = [...events,...changes.events.filter(event => !ids.has(event.id))].filter(event => Date.parse(event.recorded_at) >= Date.parse(since));
          cursor = changes.cursor ?? cursor;
          // An empty page establishes completion for this refresh only. A
          // previous poll's completion says nothing about new oldest-first pages.
          if (changes.events.length === 0) { caughtUp = true; break; }
        }
      } catch (error) {
        if ([401,403].includes(error.status)) throw error;
      }
      if (!current()) return;
      publishCalendar(payload.sections.calendar);
      facts = payload; viewOptions = { now:now(),since,events,caughtUp,feedRetired:client.changeFeedEnabled === false };
      const next = morningBriefView(facts,{...viewOptions, owner:owners.current()});
      view = next; render();
      if (dialog.open && preferences.value.day !== localDay(now())) remember(); else cue();
      if (selected) {
        const source = payload.sections[selected.action ? 'today' : selected.kind === 'deal' ? 'deals' : 'loops'];
        const admitted = source.state !== 'unavailable' && source.items.find(row => selected.kind === 'loop' ? String(row.number) === selected.id && row.kind === selected.loopKind : row.id === (selected.action?.id || selected.id) && (selected.kind !== 'action' || ['next_action','post_call_action','critical_date'].includes(row.item_kind)));
        if (admitted) await showRecord(selected.action ? {...selected,action:admitted} : selected,{background:true}); else back();
      }
    } catch (error) { if (current()) { if ([401,403].includes(error.status)) invalidate(); else { clear(); publishCalendar({ state: 'unavailable' }); } } }
  };
  const queues = mountBriefQueues({menu:$('morningQueues'),content:$('morningContent'),getClient:()=>client,getSponsor:()=>sponsor,
    onOpen:title=>{selected=null;++detailEpoch;$('morningTitle').textContent=title;$('morningBack').hidden=false;$('morningOwners').hidden=true;},onBack:back,onInvalidate:invalidate,onChange:render});
  const auto = mountAutoRefresh({ document:root,window:win,refresh,onResume:suspend,onWake:suspend,intervalMs });
  const refreshCalendar = () => auto.refresh();
  const currentCalendar = () => publishCalendar(calendar);
  root.addEventListener('doctorcre:request-brief-calendar', currentCalendar);
  root.addEventListener('doctorcre:refresh-brief-calendar', refreshCalendar);
  win.addEventListener('doctorcre-session-invalidated', invalidate);
  control.onclick = open;
  $('morningClose').onclick = close;
  onDialogClosed(dialog, () => { queues.reset(); ++detailEpoch; selected = null; if (root.querySelector('dialog[open]')) return; (opener?.isConnected && !opener.closest('dialog:not([open])') ? opener : $('docOpen'))?.focus(); });
  $('morningBack').onclick = back;
  $('morningRefresh').onclick = () => queues.active ? queues.refresh() : auto.refresh();
  $('morningContent').onclick = event => { if(queues.click(event))return; if (event.target.closest('[data-brief-show-all]')) { owners.setOwner('all'); $('morningOwners').querySelector('[data-brief-owner="all"]').focus(); return; } const link = event.target.closest('[data-brief-record]'); if (!link) return; event.preventDefault(); const row = view?.groups[Number(link.dataset.briefRecord)]?.row; if (row) showRecord(row); };
  const hidden = () => { if (root.visibilityState === 'hidden') suspend(); };
  // eslint-disable-next-line no-restricted-syntax -- Hidden-state listener suspends private brief content once per event; 0 HTTP reads.
  root.addEventListener('visibilitychange',hidden);
  auto.refresh();
  return { open, refresh:auto.refresh, dispose() { if (disposed) return; disposed = true; queues.dispose(); ++detailEpoch; auto.dispose(); owners.dispose(); root.removeEventListener('doctorcre:refresh-brief-calendar', refreshCalendar); root.removeEventListener('doctorcre:request-brief-calendar', currentCalendar); win.removeEventListener('doctorcre-session-invalidated', invalidate); root.removeEventListener('visibilitychange',hidden); dialog.remove(); } };
}

export function mountMorningBriefLauncher(root) {
  const win = root.defaultView;
  const topbar = root.getElementById('appTopbar');
  const workspace = root.getElementById('accountWorkspaceControls');
  const avatar = root.getElementById('selfAvatar');
  const phone = win.matchMedia(TOUCH_LAYOUT);
  const style = root.createElement('link');
  style.rel = 'stylesheet';
  style.href = '/css/morning-brief.css';
  root.head.append(style);
  const strip = root.createElement('section');
  strip.className = 'doc-presence';
  strip.id = 'docPresence';
  strip.innerHTML = '<button id="docOpen" class="doc-identity" type="button" aria-label="Open morning brief options" title="Morning brief" aria-haspopup="dialog" aria-controls="docDetail"><span class="doc-orb" aria-hidden="true">◍</span></button>';
  const button = strip.querySelector('button');
  const dialog = root.createElement('dialog');
  dialog.id = 'docDetail';
  dialog.className = 'doc-detail';
  dialog.setAttribute('aria-labelledby', 'docTitle');
  dialog.innerHTML = '<header><h2 id="docTitle">Morning brief</h2><button id="docClose" type="button" aria-label="Close morning brief options">×</button></header><button id="docMorning" type="button">Morning brief</button>';
  root.body.append(dialog);

  const place = () => {
    const popups = root.querySelectorAll('dialog[open]:not(#docDetail):not(#docMorningBrief):not([data-quick-switcher]), aside#recordPanel:not([hidden]), main.deal-workspace:not([hidden])');
    const popup = popups[popups.length - 1];
    const host = popup?.querySelector('[data-doc-presence-slot]') || popup || (phone.matches ? workspace : topbar);
    if (strip.parentElement === host) return;
    if (host === workspace) host.querySelector('h3').after(strip);
    else if (host === topbar) host.append(strip);
    else host.prepend(strip);
  };
  place();
  const placement = new win.MutationObserver(place);
  placement.observe(root.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['open', 'hidden'] });
  phone.addEventListener('change', place);

  let opener;
  button.onclick = () => {
    opener = strip.closest('#accountWorkspaceControls') ? avatar : button;
    if (opener === avatar) { avatar.click(); avatar.focus(); }
    dialog.showModal();
  };
  dialog.querySelector('#docClose').onclick = () => dialog.close();
  const stopClosed = onDialogClosed(dialog, () => {
    if (!root.getElementById('docMorningBrief')?.open) opener?.focus();
  });
  const boot = resolveDealroomBoot(win.location);
  const brief = mountMorningBrief({ document: root, window: win,
    getClient: () => createClient(boot.mode, { ...boot.options, docContext: false }) });
  return { dispose() {
    brief.dispose();
    stopClosed();
    placement.disconnect();
    phone.removeEventListener('change', place);
    strip.remove();
    dialog.remove();
    style.remove();
  } };
}
