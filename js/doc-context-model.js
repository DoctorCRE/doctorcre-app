import { compareInstants } from './change-receipts.mjs';
// App-owned, ephemeral context. Values come from the same authorized responses
// as the page; names and screen text never resolve an identity or authorize work.
const text = value => typeof value === 'string' && value.trim() ? value : null;
const field = (label, value) => ({ label, value: ['string','boolean'].includes(typeof value) || typeof value === 'number' && Number.isFinite(value) ? value : null });
export const DOC_CONTEXT_TTL_MS = 60_000;
export const DOC_PAGES = Object.freeze({
  home: { label: 'Home', reads: ['getHomeAgenda', 'getLeadBoard'] },
  deals: { label: 'Local Deals', reads: ['getBoard', 'getDeal'] },
  leads: { label: 'Leads', reads: ['getWorkspace', 'getLeadDetail'] },
  tours: { label: 'Tours', reads: ['tourLibrary', 'tourDetail', 'tourProperties'] },
  clients: { label: 'Clients', reads: ['businessList', 'businessRecord', 'businessActivity'] },
  vendors: { label: 'Vendors', reads: ['businessList', 'businessRecord', 'businessActivity'] },
  calendar: { label: 'Calendar', reads: ['getBoard', 'getDeal'] },
  updates: { label: 'Updates', reads: ['notificationFeed'] },
  chats: { label: 'Ask Doc', reads: ['listDocConversations', 'readDocConversation'] },
  search: { label: 'Search', reads: ['find'] },
  charts: { label: 'Charts', reads: ['getBoard'] },
  status: { label: 'Status', reads: ['readAssuranceHealth'] },
  page: { label: 'DoctorCRE', reads: [] },
});

const routes = { '/': 'home', '/review-workflows': 'home', '/workspace': 'home', '/workspace.html': 'home', '/business': 'home',
  '/deals': 'deals', '/index.html': 'deals', '/pipeline': 'deals', '/pipeline.html': 'deals',
  '/leads': 'leads', '/leads.html': 'leads', '/tours': 'tours', '/tours/index.html': 'tours', '/tours/route-editor.html':'tours',
  '/clients': 'clients', '/vendors': 'vendors', '/business.html': 'clients',
  '/calendar': 'calendar', '/calendar.html': 'calendar',
  '/doc-chats': 'chats', '/doc-chats.html': 'chats', '/conversations.html': 'chats',
  '/updates': 'updates', '/notifications.html': 'updates',
  '/search': 'search', '/search.html': 'search', '/charts.html': 'charts', '/status': 'status', '/status.html': 'status',
};
export function docPage(location = {}) {
  const page = routes[location.pathname] || 'page';
  if(page === 'home' && new URLSearchParams(location.search).get('view') === 'charts') return 'charts';
  return page;
}

function record(kind, row, id, title, fields, activity = []) {
  if (!row) return null;
  if (!(typeof id === 'string' && text(id) || typeof id === 'number' && Number.isSafeInteger(id)) || !text(title)) return null;
  const candidate = row.version ?? row.record_version ?? row.base_version ?? row.revision ?? row.updated_at ?? null;
  const version = typeof candidate === 'string' && text(candidate) || typeof candidate === 'number' && Number.isSafeInteger(candidate) && candidate >= 0 ? candidate : null;
  return { kind, id: String(id), title, version, fields,
    activity: activity.filter(item => text(item.text)).map(item => ({ text: item.text, at: item.at ?? null })) };
}
const deal = (row = {}) => record('deal', row, row.id, row.name, [field('Owner', row.owner), field('Stage', row.phase),
  field('Next step', row.next_step), field('Due', row.next_date), field('Needs attention', row.attention)]);
const lead = (row = {}) => record('lead', row, row.id, row.doctor_name || row.practice_name || row.entity_name || row.name,
  [field('Owner', row.owner), field('Stage', row.stage), field('Score', row.score), field('Next step', row.next_action), field('Market', row.city || row.market)]);
const conversation = (row = {}) => record('conversation', row, row.id, row.title,
  [field('Visibility', row.visibility), field('Last activity', row.latest_turn_at), field('Status', row.archived_at ? 'Archived' : 'Open')]);

// Normalizers enumerate supported fields; hostile note text stays inert text.
// A malformed collection fails closed, including a successful HTTP response.
export function normalizeDocRead(method, payload, args = []) {
  if (!payload || payload.ok === false || payload.error) return null;
  let rows, map;
  switch (method) {
    case 'getHomeAgenda':
    case 'getBoard': rows = payload.deals; map = deal; break;
    case 'getDeal': {
      const row = deal(payload.deal || {});
      if (!row || row.id !== String(args[0])) return null;
      row.activity = [...(payload.activities || []), ...(payload.thread || []), ...(payload.history || [])]
        .map(item => ({ text: item.summary || item.text || item.description, at: item.occurred_at || item.at || item.created_at || item.recorded_at }))
        .filter(item => text(item.text));
      sortActivity(row);
      return [row];
    }
    case 'getLeadBoard': rows = payload.leads; map = row => record('lead', row, row.id, row.name,
      [field('Owner', row.owner), field('Stage', row.stage), field('Score', row.score), field('Next step', row.next_action), field('Market', row.city || row.market)]); break;
    case 'getWorkspace': rows = payload.leads; map = lead; break;
    case 'getLeadDetail': {
      const row = lead(payload.detail);
      if (!row || row.id !== args[0]?.id) return null;
      row.activity = (payload.detail.correspondence || []).map(item => ({ text:item.summary, at:item.occurred_at })).filter(item => text(item.text));
      sortActivity(row);
      return [row];
    }
    case 'notificationFeed': rows = payload.notifications; map = row => record('notification', row, row.id, row.reason,
      [field('Priority', row.severity), field('Date', row.created_at), field('Status', row.read_at ? 'Seen' : 'Unseen')]); break;
    case 'listDocConversations': rows = payload.conversations; map = conversation; break;
    case 'readDocConversation': {
      const row = conversation(payload.identity || payload.conversation);
      if (!row || row.id !== args[0]?.conversation_id) return null;
      row.latestSequence = payload.latest_sequence ?? null;
      row.activityComplete = payload.more !== true;
      row.activity = (payload.turns || []).map(item => ({ text: item.body, at: item.at || item.created_at })).filter(item => text(item.text));
      sortActivity(row);
      return [row];
    }
    case 'businessList': rows = payload.rows; map = row => record(args[0]?.dataset || 'party', row, row.id, row.name,
      [field('Owner', row.owner_label), field('Status', args[0]?.dataset === 'vendors' ? row.recorded_stage_label || row.recorded_stage : row.recorded_status_label || row.recorded_status), field('Market', row.city)]); break;
    case 'businessRecord': if (payload.record?.id !== args[0]?.id) return null; rows = payload.record ? [payload.record] : null; map = row => record(args[0]?.dataset || 'party', row, row.id, row.name,
      [field('Owner', row.owner_label), field('Status', args[0]?.dataset === 'vendors' ? row.recorded_stage_label || row.recorded_stage : row.recorded_status_label || row.recorded_status), field('Market', row.city), field('Last activity', row.last_touch)]); break;
    case 'businessActivity': {
      const base = normalizeDocRead('businessRecord', payload, args);
      if (!base || !Array.isArray(payload.activities)) return null;
      base[0].activity = payload.activities.map(item => ({ text:item.what, at:item.when })).filter(item => text(item.text));
      sortActivity(base[0]);
      return base;
    }
    case 'tourLibrary': rows = payload.tours || (Array.isArray(payload) ? payload : null); map = row => record('tour', row, row.id, row.name || row.title,
      [field('Status', row.status), field('Date', row.scheduled_at || row.tour_date), field('Client', row.client_name)]); break;
    case 'tourDetail': if ((payload.tour || payload).id !== args[0]) return null; rows = payload.tour ? [payload.tour] : [payload]; map = row => record('tour', row, row.id, row.name || row.title,
      [field('Status', row.status), field('Date', row.scheduled_at || row.tour_date), field('Client', row.client_name)]); break;
    case 'tourProperties': rows = payload.items || payload.properties; map = row => record('property', row, row.id || row.property_id, row.name || row.display_name,
      [field('Size', row.area_sf), field('Rent', row.asking_rent), field('Address', row.address)]); break;
    case 'find': rows = payload.parties; map = row => record('party', row, row.id || row.ref, row.name,
      [field('Market', row.city), field('Specialty', row.specialty)]); break;

    case 'readAssuranceHealth': rows = [payload]; map = row => record('workflow', row, row.scope?.workflow_key, row.scope?.workflow_key,
      [field('Status', row.state), field('Capability', row.capability_stage)]); break;
    default: return null;
  }
  if (!Array.isArray(rows) || rows.some(row => !row || typeof row !== 'object')) return null;
  const normalized = rows.map(map);
  for (const item of normalized.filter(Boolean)) { sortActivity(item); }
  // Identity-less search matches cannot safely become the active record.
  if (method === 'find') return normalized.filter(Boolean);
  if (normalized.some(row => !row)) return null;
  return normalized;
}

function sortActivity(row) { row.activity.sort((a,b) => compareInstants(a.at, b.at)); }
function compareRevision(a,b) {
  if (a === b) return 0;
  if (a == null || b == null) return a == null ? -1 : 1;
  const numeric = value => typeof value === 'number' || /^\d+$/.test(value);
  if (numeric(a) && numeric(b)) return Math.sign(Number(a)-Number(b));
  if (numeric(a) !== numeric(b)) return null;
  const left=Date.parse(a), right=Date.parse(b);
  if (Number.isFinite(left) && Number.isFinite(right)) return Math.sign(left-right);
  return String(a).localeCompare(String(b), 'en', {numeric:true});
}

// The Leads workspace request reads the whole authorized collection without
// local search/filter arguments. Retain that source across filters; its old
// scope remains ineligible until the page explicitly projects the response.
const survivesFilters = method => method === 'getWorkspace';

export function createDocContext({ page = 'home', now = () => Date.now() } = {}) {
  let epoch = 0, authorizationGeneration = 0, selected = null, filters = {}, reads = new Map(), tickets = new Map();
  const listeners = new Set();
  const emit = () => listeners.forEach(listener => listener(snapshot()));
  function snapshot() {
    // Sources retain their read state and observation time across filters,
    // but only an explicit projection makes that source eligible in this scope.
    const current = [...reads.values()].filter(read => read.epoch === epoch || read.state === 'unavailable');
    const valid = current.filter(read => read.state === 'ready' && now() - read.at < DOC_CONTEXT_TTL_MS);
    const unique = new Map();
    for (const read of valid.sort((a, b) => a.at - b.at)) for (const row of read.records) {
      const key = `${row.kind}:${row.id}`; const previous = unique.get(key);
      const order = previous ? compareRevision(row.version,previous.version) : 1;
      if (order === null || order > 0 || order === 0 && (row.activity.length || !previous.activity.length)) unique.set(key, row);
    }
    const records = [...unique.values()];
    const active = selected ? records.find(row => row.kind === selected.kind && row.id === selected.id) || null : null;
    const ready = valid.length > 0 && valid.length === current.length && (!selected || !!active);
    return { schema: 'doctorcre-doc-context.v1', page, label: DOC_PAGES[page].label, epoch, authorizationGeneration, filters: { ...filters },
      selected: selected ? { ...selected } : null, active, records, ready,
      observedAt: valid.length ? new Date(Math.min(...valid.map(read => read.at))).toISOString() : null,
      recentActivity: active?.activityComplete === false ? [] : active?.activity.slice(0, 5) || [], state: ready ? 'ready' : current.some(read => read.state === 'pending') ? 'updating' : 'unavailable' };
  }
  const clear = () => { authorizationGeneration++; epoch++; selected = null; filters = {}; reads.clear(); tickets.clear(); emit(); };
  return {
    snapshot,
    subscribe(listener) { listeners.add(listener); listener(snapshot()); return () => listeners.delete(listener); },
    navigate(next, nextFilters = {}) { page = next; epoch++; selected = null; filters = { ...nextFilters }; reads = new Map(); tickets = new Map(); emit(); },
    filter(next) {
      epoch++; selected = null; filters = { ...next };
      for (const [key, ticket] of tickets) if (!survivesFilters(ticket.method)) tickets.delete(key);
      emit();
    },
    project(method, payload, args = []) {
      const source = reads.get(method);
      if (!source || source.state !== 'ready') return false;
      let records; try { records=normalizeDocRead(method,payload,args); } catch { records=null; }
      if (!records) return false;
      reads.set(method,{...source,records,epoch}); emit(); return true;
    },
    release(method) { reads.delete(method); tickets.delete(method); emit(); },
    select(kind, id) { selected = id ? { kind, id: String(id) } : null; emit(); },
    begin(method, args = []) {
      if (!DOC_PAGES[page].reads.includes(method)) return null;
      const key = method;
      const ticket = { key, method, args, epoch, sequence: (tickets.get(key)?.sequence || 0) + 1 };
      tickets.set(key, ticket); reads.set(key, { state: 'pending', records: [], at: now(), epoch }); emit(); return ticket;
    },
    finish(ticket, payload, { at = now() } = {}) {
      if (!ticket || tickets.get(ticket.key) !== ticket || ticket.epoch !== epoch && !survivesFilters(ticket.method)) return false;
      let records;
      try { records = normalizeDocRead(ticket.method, payload, ticket.args); } catch { records = null; }
      reads.set(ticket.key, { state: records ? 'ready' : 'unavailable', records: records || [], at, epoch: ticket.epoch }); emit(); return records !== null;
    },
    fail(ticket, error = {}) {
      if ([401, 403].includes(error.status) || error.code === 'authentication_required') { clear(); return; }
      if (!ticket || tickets.get(ticket.key) !== ticket || ticket.epoch !== epoch && !survivesFilters(ticket.method)) return;
      reads.set(ticket.key, { state: 'unavailable', records: [], at: now(), epoch });
      emit();
    },
    clear,
    tick: emit,
  };
}

export function docAnswer(context, { recordId, kind, question }) {
  if (question === 'page') return { state: 'answered', value: context.label };
  if (!context.ready) return { state: 'unavailable', value: null };
  const matches = context.records.filter(row => row.id === recordId && (!kind || row.kind === kind));
  if (matches.length !== 1) return { state: 'unknown', value: null };
  const row = matches[0];
  if (question === 'Recent activity') {
    const value = row.activityComplete === false ? null : row.activity[0]?.text ?? null;
    return { state: value === null ? 'unknown' : 'answered', value, recordId: row.id, version: row.version };
  }
  const value = question === 'Name' ? row.title : row.fields.find(item => item.label === question)?.value ?? null;
  return { state: value === null || value === '' ? 'unknown' : 'answered', value: value === '' ? null : value, recordId: row.id, version: row.version };
}
