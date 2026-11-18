import carrSchema from "../contracts/carr-interface.v1/schema.json" with { type: "json" };
import carrVersion from "../contracts/carr-interface.v1/version.json" with { type: "json" };
import { routeContract, routeKey, actionLinkRoute } from "../js/routes.js";
import { BOARD_ROUTE, boardIdFromPath, legacyBoardDestination } from '../js/progress-board-route.js';

const APP_ROUTES = new Map(Object.entries(routeContract.routes));
const REDIRECTS = new Map(Object.entries(routeContract.redirects || {}));
const PROXY_EXACT = new Set(["/mcp", "/pipeline/changes", "/api/call-context", "/api/post-call"]);
const PROXY_PREFIXES = ["/auth/", "/api/v1/", "/api/room/", "/api/system-work/", "/api/tours/", "/api/post-call/"];
const STATIC_EXACT = new Map([
  ["/share-intake.html", "/share-intake.html"],
  ["/artifact-manifest.json", "/artifact-manifest.json"],
  ["/manifest.webmanifest", "/manifest.webmanifest"],
  ["/sw.js", "/public-shell/sw.js"],
  ["/offline.html", "/public-shell/offline.html"],
  ["/favicon.ico", "/public-shell/icons/dealroom.svg"],
]);
const STATIC_PREFIXES = ["/css/", "/data/", "/js/", "/public-shell/", "/tours/"];
const STAGING_ORIGIN = 'https://doctorcre-app-staging.joe-bookout-carr-us.workers.dev';
const STAGING_REPORT_ASSETS = new Set(['/share.css', '/share.js', '/share-bootstrap.js',
  ...['maplibre-gl.mjs', 'maplibre-gl-shared.mjs', 'maplibre-gl-worker.mjs', 'maplibre-gl.css'].map(file => `/vendor/maplibre-gl-6.4.1/${file}`)]);
// V5-UX-C15: the one page route served AHEAD of the CARR gate. Every other app
// page is gated, so a CARR outage takes the Control Room with it and the gated
// page cannot be its own fallback (CR-AC-26). This page reads nothing from CARR
// on the server side; what it can and cannot say is decided in the browser.
const UNGATED_PAGES = new Set(["/status"]);
// Each slice chooses an admitted CARR page gate through its route fragment.
// Authentication and authorization remain entirely in the producer.
const GATE_PATHS = new Map(Object.entries(routeContract.gatePaths));

function gateRequestFor(request, pathname) {
  const gatePath = GATE_PATHS.get(boardIdFromPath(pathname) ? BOARD_ROUTE : routeKey(actionLinkRoute(pathname)));
  if (!gatePath || gatePath === pathname) return request;
  const url = new URL(request.url);
  url.pathname = gatePath;
  url.search = "";
  return new Request(url, request);
}

function restoreOriginalReturnTo(response, request) {
  const location = response.headers.get("location");
  if (response.status < 300 || response.status >= 400 || !location) return response;
  const originalUrl = new URL(request.url);
  const redirectUrl = new URL(location, originalUrl);
  if (redirectUrl.origin !== originalUrl.origin || redirectUrl.pathname !== "/auth/login") return response;
  redirectUrl.searchParams.set("return_to", originalUrl.pathname + originalUrl.search);
  const headers = new Headers(response.headers);
  headers.set("location", redirectUrl.toString());
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" };

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

function unavailable(documentRequest) {
  if (!documentRequest) return json({ error: "carr_unavailable" }, 503);
  return new Response("<!doctype html><title>DoctorCRE unavailable</title><h1>DoctorCRE is temporarily unavailable</h1><p>No cached business data is being shown.</p>", {
    status: 503,
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
  });
}

function secure(response, path) {
  const headers = new Headers(response.headers);
  const capture = path === "/tours/day.html" || path === "/calls" || path === "/calls.html";
  const tourEditor = path === '/tours/route-editor.html';
  headers.set("content-security-policy", [
    "default-src 'self'", "base-uri 'none'", "object-src 'none'", `frame-ancestors ${tourEditor ? "'self'" : "'none'"}`,
    "form-action 'self'", "script-src 'self'", "style-src 'self' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com", "img-src 'self' data:",
    "connect-src 'self' http://127.0.0.1:4682", "worker-src 'self'",
    ...(capture ? ["media-src 'self' blob:"] : []),
  ].join("; "));
  headers.set("strict-transport-security", "max-age=31536000; includeSubDomains");
  headers.set("x-content-type-options", "nosniff");
  headers.set("x-frame-options", tourEditor ? "SAMEORIGIN" : "DENY");
  headers.set("referrer-policy", "same-origin");
  headers.set("permissions-policy", `camera=(), geolocation=(), microphone=${capture ? "(self)" : "()"}, payment=(), usb=()`);
  headers.set("cross-origin-opener-policy", "same-origin");
  headers.set("cross-origin-resource-policy", "same-origin");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

function assetPath(pathname) {
  if (STATIC_EXACT.has(pathname)) return STATIC_EXACT.get(pathname);
  if (pathname.startsWith("/icons/")) return `/public-shell${pathname}`;
  return STATIC_PREFIXES.some((prefix) => pathname.startsWith(prefix)) ? pathname : null;
}

async function assetResponse(request, env, path) {
  if (!env?.ASSETS?.fetch) return json({ error: "app_assets_unavailable" }, 503);
  const url = new URL(request.url);
  url.pathname = path;
  url.search = "";
  const response = await env.ASSETS.fetch(new Request(url, {
    method: request.method === "HEAD" ? "HEAD" : "GET",
    headers: { accept: request.headers.get("accept") || "*/*" },
  }));
  const headers = new Headers(response.headers);
  headers.set("cache-control", path === "/artifact-manifest.json" ? "no-store"
    : path.endsWith(".html") || path.endsWith(".js") || path.endsWith(".css")
    ? "no-cache" : "public, max-age=300");
  if (path === "/public-shell/sw.js") headers.set("service-worker-allowed", "/");
  return secure(new Response(response.body, { status: response.status, statusText: response.statusText, headers }), path);
}

async function carrResponse(request, env, documentRequest = false) {
  if (!env?.CARR?.fetch) return unavailable(documentRequest);
  try {
    const response = await env.CARR.fetch(new Request(request, { redirect: "manual" }));
    return response;
  } catch {
    return unavailable(documentRequest);
  }
}

function copySessionCookies(from, to) {
  const values = typeof from.headers.getSetCookie === "function"
    ? from.headers.getSetCookie() : [from.headers.get("set-cookie")].filter(Boolean);
  if (!values.length) return to;
  const headers = new Headers(to.headers);
  for (const value of values) headers.append("set-cookie", value);
  return new Response(to.body, { status: to.status, statusText: to.statusText, headers });
}

const isString = value => typeof value === 'string';
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const DEALS = 'deals-from-engine';
const NEXT_DEAL_SAVES = 'deals-saves-from-engine';
const LEADS = 'leads-from-engine';
const HOME = 'home-from-engine';
const LEGACY_HOME_MARKS = new Set(['snooze-home-inbox', 'settle-home-inbox', 'unsettle-home-inbox']);
const INVOICES = 'invoices-from-engine';
const CHARTS = 'charts-from-engine';
const NATIONAL_DEALS = 'national-deals-from-engine';
const SEARCH = 'search-from-engine';
const CLIENTS_VENDORS = 'clients-vendors-from-engine';
const RELATIONSHIPS = 'relationships-from-engine';
const FRAME = 'frame-from-engine';
// Each old read the engine can answer, by tool name or business GET path: its
// switch key, its engine path and, for a tool, a check per argument.
// A `segment` argument becomes the last path segment. A business GET keeps its
// query text and, unless listOnly, its record id. The engine checks both.
const ENGINE_READS = new Map([
  ['deal-room-board', { key: DEALS, path: '/api/engine/deals', args: { workspace: isString, account_client_id: isString } }],
  ['get-deal-room', { key: DEALS, path: '/api/engine/deals', segment: 'deal', args: { deal: isString },
    accepts: ({ deal }) => !['', '.', '..', undefined].includes(deal) }],
  ['search-parties-v1', { key: DEALS, path: '/api/engine/parties/search', search: 'kind=person',
    args: { query: isString }, accepts: ({ query }) => Boolean(query?.trim()) }],
  // Without the workspace the old tool answers Home's legacy board, which the engine does not serve.
  ['lead-board', { key: LEADS, path: '/api/engine/leads', accepts: ({ workspace }) => workspace === 'leads',
    args: { workspace: isString, lead_id: isString, correspondence_cursor: isObject, stage_history_cursor: isString } }],
  ['quiet-follow-ups', { key: LEADS, path: '/api/engine/quiet-follow-ups', args: { lead_days: Number.isFinite, vendor_days: Number.isFinite, owner_slug: isString } }],
  ['list-practice-origination', { key: LEADS, path: '/api/engine/reasons-to-reach-out', args: { limit: Number.isFinite, before_id: isString } }],
  ['territory-state-board', { key: LEADS, path: '/api/engine/territory-state-board', args: { vertical: isString, city: isString, state: isString } }],
  ['read-home-inbox-v5', { key: HOME, path: '/api/engine/home/inbox', args: {} }],
  ['read-invoice-tracker', { key: INVOICES, path: '/api/engine/invoices', args: {} }],
  ['ideal-client-profile', { key: CHARTS, path: '/api/engine/client-fit', args: { vertical: isString, city: isString, state: isString } }],
  ['capture-queue', { key: NATIONAL_DEALS, path: '/api/engine/capture-queue', args: {} }],
  // The old tool answers an empty query and the engine refuses it, so only a nonempty one moves.
  ['find', { key: SEARCH, path: '/api/engine/find', args: { query: isString }, accepts: ({ query }) => Boolean(query) }],
  ['find-and-catch-up', { key: CLIENTS_VENDORS, path: '/api/engine/recent-activity', args: { query: isString, limit: Number.isFinite } }],
  ['read-vendor-meetings', { key: CLIENTS_VENDORS, path: '/api/engine/vendor-meetings', args: { view: isString, q: isString, limit: Number.isFinite, cursor: isString } }],
  ['read-vendor-markets-v1', { key: CLIENTS_VENDORS, path: '/api/engine/vendor-markets', args: { market: isString } }],
  ['/api/v1/business/clients', { key: CLIENTS_VENDORS, path: '/api/engine/clients' }],
  ['/api/v1/business/vendors', { key: CLIENTS_VENDORS, path: '/api/engine/vendors' }],
  ['/api/v1/business/relationships', { key: RELATIONSHIPS, path: '/api/engine/relationships', listOnly: true }],
  ['today-triage', { key: FRAME, path: '/api/engine/today-triage', args: {} }],
  ['calendar-meeting-prep', { key: FRAME, path: '/api/engine/calendar-meeting-prep', args: {} }],
]);
const BUSINESS_GET = /^(\/api\/v1\/business\/[a-z]+)(\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})?$/i;

async function mcpCall(request, url) {
  if (request.method !== 'POST' || url.pathname !== '/mcp') return null;
  try { return await request.clone().json(); } catch { return null; }
}

// The old system's tools/call reply around an engine answer's exact text.
function mcpReply(call, response, text, isError) {
  const content = [{ type: 'text', text }];
  return copySessionCookies(response, json({ jsonrpc: '2.0', id: call.id ?? null, result: isError ? { isError, content } : { content } }));
}

// The registered read a request asks for: a business GET, or a tool call with its arguments.
async function engineRead(request, url) {
  if (request.method === 'GET') {
    const [, path, record = ''] = BUSINESS_GET.exec(url.pathname) ?? [];
    const read = ENGINE_READS.get(path);
    return read && !(read.listOnly && record) ? { read, record } : null;
  }
  const call = await mcpCall(request, url);
  const read = ENGINE_READS.get(call?.params?.name);
  const args = call?.params?.arguments === undefined ? {} : call.params.arguments;
  if (call?.method !== 'tools/call' || !read?.args || !isObject(args)
      || Object.entries(args).some(([key, value]) => !Object.hasOwn(read.args, key) || !read.args[key](value))
      || (read.accepts && !read.accepts(args))) return null;
  return { read, call, args };
}

// A switch that can't be read is off.
async function switchedOn(env, key) {
  try { return await env?.ENGINE_ROUTING?.get(key, { cacheTtl: 30 }) === 'on'; } catch { return false; }
}

async function engineResponse(request, env) {
  const url = new URL(request.url);
  const asked = await engineRead(request, url);
  if (!asked) return null;
  const { read, call, args, record } = asked;
  if (!await switchedOn(env, read.key)) return null;
  const origin = request.headers.get('origin');
  if (origin && origin !== url.origin) return json({ error: 'origin_mismatch' }, 403);
  const headers = new Headers();
  for (const key of ['cookie', 'origin']) {
    const value = request.headers.get(key);
    if (value !== null) headers.set(key, value);
  }
  const controller = new AbortController();
  let timer;
  let reader;
  try {
    if (call) {
      url.pathname = read.segment ? `${read.path}/${encodeURIComponent(args[read.segment])}` : read.path;
      url.search = read.search ?? '';
      // The engine takes the old tool's arguments as query text, an object as its JSON.
      for (const [key, value] of Object.entries(args)) {
        if (key !== read.segment) url.searchParams.set(key, typeof value === 'string' ? value : JSON.stringify(value));
      }
    } else url.pathname = read.path + record;
    return await Promise.race([
      (async () => {
        const response = await env.ENGINE.fetch(new Request(url, { headers, signal: controller.signal, redirect: 'manual' }));
        if (controller.signal.aborted) {
          void response.body?.cancel().catch(() => {});
          return null;
        }
        if ([401, 403, 429].includes(response.status)) return response;
        if (response.status >= 500 || (response.status !== 200 && response.status < 400)) {
          void response.body?.cancel().catch(() => {});
          return null;
        }
        reader = response.body?.getReader();
        const chunks = [];
        const decoder = new TextDecoder();
        if (reader) {
          // eslint-disable-next-line no-restricted-syntax -- Engine body reads stop after the two-second request deadline cancels this reader.
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            chunks.push(decoder.decode(value, { stream: true }));
          }
        }
        chunks.push(decoder.decode());
        let text = chunks.join('');
        if (!call) return copySessionCookies(response, new Response(text, { status: response.status, headers: JSON_HEADERS }));
        if (call.params.name === 'deal-room-board' && response.ok) {
          const board = JSON.parse(text);
          if (board?.schema_version === 'local-deals-board.v2' && await switchedOn(env, NEXT_DEAL_SAVES)) {
            text = JSON.stringify({ ...board, next_deal_saves: true });
          }
        }
        if (call.params.name === 'read-home-inbox-v5' && response.ok) {
          const inbox = JSON.parse(text);
          if (inbox?.schema_version === 'home-inbox.v5') text = JSON.stringify({ ...inbox, engine_marks: true });
        }
        return mcpReply(call, response, text, response.status >= 400);
      })(),
      new Promise(resolve => {
        // eslint-disable-next-line no-restricted-syntax -- One engine deadline fires after two seconds and is cleared when the response settles.
        timer = setTimeout(() => {
        controller.abort();
        void reader?.cancel().catch(() => {});
        resolve(null);
      }, 2000); }),
    ]);
  } catch { return null; }
  finally { clearTimeout(timer); reader?.releaseLock(); }
}

// New-schema receipts are separate from the legacy tool receipts.
const CUTOVER_SAVES = new Set([
  'patch-deal-field', 'update-deal', 'set-next-step', 'complete-deal-item', 'record-deal-item',
  'add-deal-note', 'new-deal', 'set-market-agent', 'add-critical-date',
  'remove-deal-participant', 'confirm-critical-date', 'resolve-critical-date',
  'instruct-deal-item', 'revert-deal-field', 'resolve-conflict',
]);
const isUuid = value => isString(value) && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value);

function nextDealSave(verb, args) {
  const { deal, idempotency_key, seen_change_id, field, value } = args;
  if (!isUuid(idempotency_key)) return null;
  const post = (path, body) => ({ path: '/api/engine' + path, body: { idempotency_key, ...body } });
  if (verb === 'new-deal') {
    const { name, client_id, owner, phase, kind, reason, market_id, renews_lease_id } = args;
    return isUuid(client_id) ? post('/deals', { name, client_id, owner, phase, kind, reason, market_id, renews_lease_id }) : null;
  }
  if (!isUuid(deal)) return null;
  const changes = patch => post(`/deals/${deal}/changes`, { seen_change_id, ...patch });
  switch (verb) {
    case 'set-market-agent':
    case 'remove-deal-participant': {
      const party_id = verb === 'set-market-agent' ? args.agent_party_id : args.party_id;
      const role = verb === 'set-market-agent' ? 'market_agent' : args.role;
      if (!isUuid(party_id)) return null;
      const suffix = verb === 'remove-deal-participant' ? '/remove' : '';
      return post(`/deals/${deal}/parties${suffix}`, { party_id, role });
    }
    case 'add-critical-date': {
      const { kind, due_on, source, note } = args;
      const phaseDate = kind === 'phase_effective_date';
      return post(`/deals/${deal}/critical-dates`, {
        kind: phaseDate ? 'other' : kind, due_on, source,
        note: phaseDate ? 'Phase effective date' : note,
      });
    }
    case 'confirm-critical-date':
    case 'resolve-critical-date': {
      const { critical_date_id, resolution, reason } = args;
      if (!isUuid(critical_date_id)) return null;
      return verb === 'confirm-critical-date'
        ? post(`/critical-dates/${critical_date_id}/confirm`, {})
        : post(`/critical-dates/${critical_date_id}/resolve`, { resolution, reason });
    }
    case 'update-deal': {
      const { outcome, closed_on, won_value, lost_reason } = args.fields || {};
      const from = args.phase_from;
      if (from !== null && !isString(from)) return null;
      if (outcome === 'won') return changes({
        phase: { from, to: 'closed', on: closed_on },
        ...(won_value != null && { fields: { closed_value: won_value } }),
      });
      if (outcome === 'lost') return changes({ phase: { from, to: 'dead', on: closed_on, reason: lost_reason } });
      return null;
    }
    case 'patch-deal-field':
      if (field === 'phase' && value !== 'closed' && (args.phase_from === null || isString(args.phase_from))) {
        const reason = [args.change_reason, args.human_quote].filter(isString).join('\n\n') || undefined;
        return changes({ phase: { from: args.phase_from, to: value, reason } });
      }
      if (field === 'owner' && isString(value) && value) return changes({ fields: { owner: value } });
      if (field === 'market' && (value === null || isUuid(value))) return changes({ fields: { market_id: value } });
      if (field === 'attention') return changes({ fields: { needs_attention: value } });
      if (field === 'operating_state' && value?.state === 'parked') {
        return changes({ fields: { parking_reason: value.reason, parking_note: value.note || null } });
      }
      if (field === 'operating_state' && value?.state === 'active') {
        return changes({ fields: { parking_reason: null, parking_note: null } });
      }
      return null;
    case 'set-next-step':
      return post('/next-steps', { deal_id: deal, what: args.text, due_on: args.next_date ?? undefined, replaces: 'current' });
    case 'complete-deal-item':
      return isUuid(args.item_id) ? post(`/next-steps/${args.item_id}/end`, { resolution: 'done' }) : null;
    case 'record-deal-item':
      return post('/next-steps', { deal_id: deal, what: args.title, due_on: args.due_on ?? undefined,
        item: { title: args.title, bullets: args.bullets, source_ref: args.source_ref } });
    case 'add-deal-note':
      return post('/activities', { kind: 'note', happened_at: args.happened_at, about: [{ deal_id: deal }], summary: args.text });
    default:
      return null;
  }
}

function saveRefusal(call, error, hint) {
  return mcpReply(call, new Response(null), JSON.stringify({ error, hint }), true);
}

const DEAL_CREATE_REFUSALS = new Map([
  ['deal_party_party_id_fkey', 'Choose an existing client.'],
  ['deal_party_client_is_a_client', 'Choose an existing client.'],
  ['deal_market_id_fkey', 'Choose an existing market.'],
  ['deal_renewal_names_lease', 'Renewals need an existing lease. The Add deal form cannot link a lease yet.'],
  ['deal_name_exists', 'A deal with this name already exists.'],
]);

function dealPeopleAndDateHint(name, body) {
  const rule = body.error === 'database_refused_the_statement' ? body.rule : body.error;
  switch (rule) {
    case 'deal_party_pkey': return 'This person or company already has that role on the deal.';
    case 'deal_party_party_id_fkey': return 'Choose an existing person or company.';
    case 'deal_party_role_fkey': return 'Choose a role for this person or company.';
    case 'critical_date_status_moves': return 'This date cannot be marked that way.';
    case 'invalid_field_value':
    case 'missing_required':
      if (name === 'add-critical-date') return 'Enter a valid date and where it came from.';
      if (name === 'resolve-critical-date') return 'Choose how to mark this date and enter a reason.';
      break;
    case 'not_found':
      if (name === 'remove-deal-participant') return 'That person or company is no longer in that role on the deal.';
      if (name.endsWith('-critical-date') && name !== 'add-critical-date') return 'That date is no longer on the deal.';
      break;
    case 'version_conflict':
      if (name === 'confirm-critical-date' || name === 'resolve-critical-date') return 'Reload the deal to see the current state of this date.';
      return 'Reload the deal before saving again.';
  }
  return null;
}

async function cutoverSave(request, env, call) {
  const { name, arguments: args } = call.params;
  const on = await switchedOn(env, NEXT_DEAL_SAVES);
  const creating = name === 'new-deal';
  const fromNext = creating ? args.next_deal_save === true
    : Number.isSafeInteger(args.seen_change_id) && args.seen_change_id >= 0;
  if (!on && !fromNext) return null;
  if (creating && (!on || !fromNext)) return saveRefusal(call, 'reload_deals', 'Reload Deals before adding a deal.');
  if (on && !await switchedOn(env, DEALS)) return saveRefusal(call, 'version_conflict', 'Reload the deal before saving.');
  const save = nextDealSave(name, args);
  if (on && !save) return saveRefusal(call, 'deal_save_unavailable', name === 'set-market-agent' && fromNext
    ? 'Choose an existing person as the market agent.' : 'This change is temporarily unavailable.');
  // A retained request may outlive a switch change. Its snapshot pins the destination.
  if (!on || !fromNext) return saveRefusal(call, 'version_conflict', 'Reload the deal before saving.');
  const response = await sendEngineSave(request, env, save.path, save.body);
  if (!response || response.status >= 500) return unavailable(false);
  if ([401, 403, 429].includes(response.status)) return response;
  const body = await response.json().catch(() => null);
  if (!isObject(body)) return unavailable(false);
  if (!response.ok) {
    const peopleOrDate = name === 'set-market-agent' || name === 'remove-deal-participant' || name.endsWith('-critical-date');
    const invalidClosingDate = name === 'update-deal' && body.error === 'invalid_field_value'
      && Array.isArray(body.fields) && body.fields.length === 1 && body.fields[0] === 'phase';
    const hint = creating
      ? DEAL_CREATE_REFUSALS.get(body.error === 'database_refused_the_statement' ? body.rule : body.error)
        ?? 'Check the deal details and try again.'
      : invalidClosingDate ? 'Choose a closing date between the day the deal reached its current phase and today.'
      : peopleOrDate ? dealPeopleAndDateHint(name, body) ?? 'Review the deal and try saving again.'
      : body.error === 'version_conflict' ? 'This deal changed. Reload the deal before saving.'
      : body.error === 'step_ended' ? 'This step was already closed. Reload the deal to see its current steps.'
      : 'The change could not be saved. Review the deal and try again.';
    return mcpReply(call, response, JSON.stringify({ ...body, hint }), true);
  }
  const saved = creating ? isUuid(body.deal_id) && Number.isSafeInteger(body.change_id) && body.change_id >= 0
    : save.path.endsWith('/changes') ? body.deal_id === args.deal
    : save.body.party_id ? body.deal_id === args.deal && body.party_id === save.body.party_id && body.role === save.body.role
    : name.endsWith('-critical-date') ? isUuid(body.critical_date_id)
      && (name === 'add-critical-date' || body.critical_date_id === args.critical_date_id)
      && body.status === (name === 'resolve-critical-date' ? args.resolution : 'open')
    : save.path.endsWith('/activities') ? isUuid(body.activity_id) : isUuid(body.next_step_id);
  if (!saved || body.error) return unavailable(false);
  return mcpReply(call, response, JSON.stringify({ ...body, ok: true }), false);
}

const DEAL_SAVES = 'deal-saves-to-engine';
// Each old save the engine can answer, by tool name: its switch key and engine path.
const ENGINE_SAVES = new Map([
  ['patch-deal-field', { key: DEAL_SAVES, path: '/api/engine/patch-deal-field' }],
  ['update-deal', { key: DEAL_SAVES, path: '/api/engine/update-deal' }],
]);

// Engine refusals that wrote nothing and leave the answer to the old system: a
// save it cannot make, or a key the old system's receipt holds.
const OLD_SYSTEM_ANSWERS = new Map([[501, 'old_system_required'], [409, 'key_reuse']]);

// The switch picks which system takes a save first. Each replays only its own
// receipt and refuses the other's as key_reuse, so a retry that crossed the
// switch goes on to the other one. Both read the key's receipt before writing,
// and tool_call's primary key refuses a second one, so the second replays or
// refuses and never writes.
async function engineSave(request, env) {
  const url = new URL(request.url);
  const call = await mcpCall(request, url);
  if (call?.method !== 'tools/call' || !isObject(call.params?.arguments)) return null;
  if (call.params.name === 'save-engine-home-mark') {
    if (!await switchedOn(env, HOME)) return saveRefusal(call, 'home_routing_changed', 'Refresh Home and try again.');
    return engineAnswer(request, env, call, { path: '/api/engine/home/marks' }, { allowHandoff: false });
  }
  if (LEGACY_HOME_MARKS.has(call.params.name)) {
    const { items, undo_of } = call.params.arguments;
    const reviewSnooze = call.params.name !== 'settle-home-inbox' && Array.isArray(items) && items.length > 0 &&
      items.every(item => typeof item?.item_id === 'string' && item.item_id.startsWith('next_step_done:'));
    if (!reviewSnooze && (Array.isArray(items) || undo_of) && await switchedOn(env, HOME))
      return saveRefusal(call, 'home_routing_changed', 'Refresh Home and try again.');
  }
  if (call.params.name === 'record-commission-receipt') {
    if (!await switchedOn(env, INVOICES)) return null;
    return engineAnswer(request, env, call, { path: '/api/engine/invoices/mark-paid' }, { allowHandoff: false });
  }
  if (CUTOVER_SAVES.has(call.params.name)) {
    const result = await cutoverSave(request, env, call);
    if (result) return result;
  }
  const save = ENGINE_SAVES.get(call.params.name);
  if (!save) return null;
  if (await switchedOn(env, save.key)) return await engineAnswer(request, env, call, save) ?? carrResponse(request, env);
  const old = await carrResponse(request, env);
  if (await oldRefusal(old.clone()) !== 'key_reuse') return old;
  return await engineAnswer(request, env, call, save) ?? old;
}

async function sendEngineSave(request, env, path, body) {
  const headers = new Headers({ 'content-type': 'application/json' });
  for (const key of ['cookie', 'origin', 'sec-fetch-site', 'x-carr-csrf']) {
    const value = request.headers.get(key);
    if (value !== null) headers.set(key, value);
  }
  try {
    return await env.ENGINE.fetch(new Request(new URL(path, request.url), { method: 'POST', headers, body: JSON.stringify(body), redirect: 'manual' }));
  } catch { return null; }
}

// Only the legacy-schema saves share a receipt with CARR.
async function engineAnswer(request, env, call, save, { allowHandoff = true } = {}) {
  const response = await sendEngineSave(request, env, save.path, call.params.arguments);
  if (!response) return unavailable(false);
  let text;
  try {
    if ([401, 403, 429].includes(response.status)) return response;
    text = await response.text();
  } catch { return unavailable(false); }
  const handoff = OLD_SYSTEM_ANSWERS.get(response.status);
  if (allowHandoff && handoff && handoff === parsedError(text)) return null;
  return mcpReply(call, response, text, response.status !== 200);
}

async function oldRefusal(response) {
  try {
    return parsedError((await response.json()).result?.content?.[0]?.text);
  } catch { return undefined; }
}

function parsedError(text) {
  try { return JSON.parse(text)?.error; } catch { return undefined; }
}

function release(env) {
  const sourceCommit = /^[0-9a-f]{40}$/.test(env?.GIT_SHA || "") ? env.GIT_SHA : null;
  const provider = env?.CF_VERSION_METADATA || {};
  return json({
    service: "doctorcre-app",
    environment: env?.APP_ENV || "unknown",
    source_commit: sourceCommit,
    provider_version_id: provider.id || null,
    provider_version_tag: provider.tag || null,
    provider_version_created_at: provider.timestamp || null,
    carr_contract: { schema: carrSchema, version: carrVersion },
    route_contract: { schema: routeContract.schema, version: routeContract.version },
  });
}

async function handleRequest(request, env) {
  const url = new URL(request.url);
  const pathname = url.pathname;
  const staging = env?.APP_ENV === 'staging' && url.origin === STAGING_ORIGIN;
  const boardDestination = legacyBoardDestination(url);
  if (boardDestination) {
    if (!['GET', 'HEAD'].includes(request.method)) return json({ error: 'method_not_allowed' }, 405);
    const gate = await carrResponse(gateRequestFor(request, BOARD_ROUTE), env, true);
    if (gate.status !== 200) return restoreOriginalReturnTo(gate, request);
    return copySessionCookies(gate, Response.redirect(boardDestination, 308));
  }
  if (pathname === "/app-release") return request.method === "GET" ? release(env) : json({ error: "method_not_allowed" }, 405);
  if (pathname === '/share' && staging) {
    if (!['GET', 'HEAD'].includes(request.method)) return json({ error: 'method_not_allowed' }, 405);
    const gateUrl = new URL(url); gateUrl.pathname = '/control-room'; gateUrl.search = '';
    const gate = await carrResponse(new Request(gateUrl, request), env, true);
    if (gate.status !== 200) return restoreOriginalReturnTo(gate, request);
    return copySessionCookies(gate, await assetResponse(request, env, '/reports/share.html'));
  }
  if (staging && STAGING_REPORT_ASSETS.has(pathname)) return assetResponse(request, env, `/reports${pathname}`);
  if (staging && pathname.startsWith('/api/share/')) return carrResponse(request, env);
  if (pathname === "/share") return Response.redirect(`https://reports.doctorcre.com/share${url.search}`, 302);
  if (REDIRECTS.has(pathname)) {
    if (request.method !== "GET" && request.method !== "HEAD") return json({ error: "method_not_allowed" }, 405);
    const target = pathname === "/business" && url.searchParams.has("q") ? "/search"
      : pathname === "/business" && url.searchParams.get("charts") === "1" ? "/?view=charts"
      : REDIRECTS.get(pathname);
    const destination = new URL(target, url.origin);
    for (const [key, value] of url.searchParams) if (!destination.searchParams.has(key)) destination.searchParams.append(key, value);
    destination.hash = url.hash;
    return Response.redirect(destination, 308);
  }

  if (UNGATED_PAGES.has(pathname)) {
    if (request.method !== "GET" && request.method !== "HEAD") return json({ error: "method_not_allowed" }, 405);
    return assetResponse(request, env, `/${APP_ROUTES.get(pathname)}`);
  }

  const routeAsset = pathname === "/deals" && url.searchParams.get("view") === "national" ? "index.html"
    : pathname === "/" && url.searchParams.get("view") === "charts" ? "charts.html"
    : APP_ROUTES.get(boardIdFromPath(pathname) ? BOARD_ROUTE : routeKey(actionLinkRoute(pathname)));
  if (routeAsset) {
    if (request.method !== "GET" && request.method !== "HEAD") return json({ error: "method_not_allowed" }, 405);
    const gateRequest = gateRequestFor(request, pathname);
    const gate = await carrResponse(gateRequest, env, true);
    if (gate.status !== 200) return gateRequest === request ? gate : restoreOriginalReturnTo(gate, request);
    return copySessionCookies(gate, await assetResponse(request, env, `/${routeAsset}`));
  }

  const staticAsset = assetPath(pathname);
  if (staticAsset) {
    if (request.method !== "GET" && request.method !== "HEAD") return json({ error: "method_not_allowed" }, 405);
    return assetResponse(request, env, staticAsset);
  }

  if (pathname.startsWith('/api/engine/')) {
    if (request.method !== 'GET' && request.method !== 'HEAD' && request.method !== 'POST') {
      const response = json({ error: 'method_not_allowed' }, 405);
      response.headers.set('allow', 'GET, HEAD, POST');
      return response;
    }
    if (!env?.ENGINE?.fetch) return json({ error: 'engine_unavailable' }, 503);
    try {
      return await env.ENGINE.fetch(new Request(request, { redirect: 'manual' }));
    } catch {
      return json({ error: 'engine_unavailable' }, 503);
    }
  }

  if (PROXY_EXACT.has(pathname) || PROXY_PREFIXES.some((prefix) => pathname.startsWith(prefix))) {
    const engine = await engineSave(request, env) ?? await engineResponse(request, env);
    if (engine) return engine;
    return carrResponse(request, env);
  }
  return json({ error: "not_found" }, 404);
}

export async function handleDoctorcreRequest(request, env) {
  try { return await handleRequest(request, env); }
  catch { return json({ error: 'internal_error' }, 500); }
}

export default { fetch: handleDoctorcreRequest };
