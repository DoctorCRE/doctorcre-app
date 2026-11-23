// Browser boot authority is the reviewed deployment hostname, not query input.
// Production and staging both use the cookie-authenticated same-origin client.
// Unknown preview hosts remain fixtures even if a caller asks for `mode=live`.
const REVIEWED_DEALROOM_HOSTS = Object.freeze([
  "app.doctorcre.com",
  "carr-mcp-staging.joe-bookout-carr-us.workers.dev",
  "doctorcre-app-staging.joe-bookout-carr-us.workers.dev",
]);
const LIVE_HOSTS = new Set(REVIEWED_DEALROOM_HOSTS);
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1"]);

export function deploymentIdentity(mode) {
  if (mode === "live") return {
    label: "LIVE · DoctorCRE",
    detail: "Connected to the live DoctorCRE Deal Room",
    mode: "live",
  };
  return {
    label: "LOCAL FIXTURE · Demo",
    detail: "Local fixture data only — changes are not production records",
    mode: "fixture",
  };
}

export function resolveDealroomBoot(locationLike) {
  const hostname = String(locationLike?.hostname || "").toLowerCase();
  const params = new URLSearchParams(locationLike?.search || "");
  const requested = params.get("mode");
  const reviewedDeployment = LIVE_HOSTS.has(hostname);
  const explicitLocalLive = LOCAL_HOSTS.has(hostname) && requested === "live";

  // A reviewed deployment is authoritative: request input cannot make real
  // CARR work look like a fixture or supply an actor. Local/unreviewed hosts
  // retain fixture controls, and only an exact local host may opt into live.
  if (reviewedDeployment || explicitLocalLive) return { mode: "live", options: {} };
  const selfActor = params.get("actor") || undefined;
  return { mode: "fixture", options: selfActor ? { selfActor } : {} };
}

export function dealsSaveToEngine(root = document) {
  return root.documentElement?.hasAttribute('data-deals-saves-from-engine') === true;
}

export function dealToursFromEngine(root = document) {
  return root.documentElement?.hasAttribute('data-deal-tours-from-engine') === true;
}

export function updatesFromEngine(root = document) {
  return root.documentElement?.hasAttribute('data-updates-from-engine') || dealsSaveToEngine(root);
}

export const AWAITING_INVOICE_PREFIX = 'awaiting:';
const INVOICE_ID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
export const invoiceHref = key => `/invoices?invoice=${encodeURIComponent(key)}`;
export function invoiceReturnPath(searchParams) {
  const keys = searchParams.getAll('invoice');
  if (keys.length === 0) return null;
  if (keys.length !== 1) return '/invoices';
  const [key] = keys;
  const id = key.startsWith(AWAITING_INVOICE_PREFIX) ? key.slice(AWAITING_INVOICE_PREFIX.length) : key;
  return INVOICE_ID.test(id) ? invoiceHref(key) : '/invoices';
}

export function sessionReturnPath(destination) {
  const base = 'https://session-return.invalid';
  let url;
  try { url = new URL(destination, base); }
  catch { return null; }
  if (url.origin !== base) return null;

  let path;
  if (url.pathname === '/invoices') path = invoiceReturnPath(url.searchParams) ?? '/invoices';
  else if (/^\/a\/al1_[A-Za-z0-9_-]{1,120}$/.test(url.pathname)) path = url.pathname;
  // Accept only the spelling produced by an allowed route, before URL normalization.
  return destination === path ? path : null;
}
