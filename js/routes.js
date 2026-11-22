export const routeEntries = [
  ["/","workspace.html","/"],
  ["/a/:ref","action-link.html","/"],
  ["/calendar","calendar.html","/business"],
  ["/calls","calls.html","/business"],
  ["/client-portal","client-portal.html","/business"],
  ["/clients","business.html","/clients"],
  ["/deals","pipeline.html","/deals"],
  ["/doc-chats","conversations.html","/conversations"],
  ["/doc/conversations/:conversation_id/turns/:msg_id","conversations.html","/conversations"],
  ["/inbox","inbox.html","/"],
  ["/inbox/card/:item_id","inbox.html","/"],
  ["/invoices","invoices.html","/control-room"],
  ["/leads","leads.html","/leads"],
  ["/leases","lease-radar.html","/business"],
  ["/relationships","relationships.html","/business"],
  ["/review-workflows","review-workflows.html","/"],
  ["/search","search.html","/business"],
  ["/status","status.html","/status"],
  ["/tours","tours/index.html","/tours"],
  ["/updates","notifications.html","/notifications"],
  ["/vendors","business.html","/vendors"],
];
export const routeContract = {
  schema: "doctorcre-app-routes.v1",
  version: "1.26.0",
  routes: Object.fromEntries(routeEntries.map(([path, asset]) => [path, asset])),
  redirects: {
  "/workspace": "/",
  "/pipeline": "/deals?view=board",
  "/business": "/",
  "/notifications": "/updates",
  "/conversations": "/doc-chats",
},
  gatePaths: Object.fromEntries(routeEntries.map(([path, , gate]) => [path, gate])),
};
const retiredPages = new Set([
  "/activity.html", "/agent-room", "/all-work", "/automations.html", "/control-room", "/control-room.html",
  "/design", "/design.html", "/design-business.html", "/design-operations.html", "/design-lab",
  "/doc-activity", "/doc-chats/work", "/events", "/ideas", "/ideas-events", "/ideas.html",
  "/incidents", "/incidents.html", "/observatory.html", "/progress-board", "/progress-board.html",
  "/progress-work.html", "/queue.html", "/room.html", "/system-work.html", "/tasks", "/tasks.html",
  "/work", "/work-inventory", "/work-inventory.html", "/work-requests",
]);
export const isRetiredPage = (path) => retiredPages.has(path) || path.startsWith("/control-room/") || path.startsWith("/design/");

export const navigationItems = [
  { label: "Home", href: "/" },
  { label: "Deals", href: "/deals" },
  { label: "Leads", href: "/leads" },
  { label: "Vendors", href: "/vendors" },
  { label: "Clients", href: "/clients", secondary: true },
  { label: "Calendar", href: "/calendar", secondary: true },
  { label: "Phone capture", href: "/calls", secondary: true },
  { label: "Relationships", href: "/relationships", secondary: true },
  { label: "Invoices", href: "/invoices", secondary: true },
  { label: "Lease radar", href: "/leases", secondary: true },
  { label: "Updates", href: "/updates", secondary: true },
];

export const toursDestination = { label: "Tours", href: "/tours" };

export const switcherUtilityPages = [
  { label: "Inbox", href: "/inbox" },
  { label: "Review workflows", href: "/review-workflows" },
  { label: "Search", href: "/search" },
  toursDestination,
  { label: "Client portal", href: "/client-portal" },
];

export const sectionForRoute = {
  "/review-workflows": "/",
  "/doc/conversations/:conversation_id/turns/:msg_id": "/doc-chats",
  "/inbox": "/",
  "/inbox/card/:item_id": "/",
  "/a/:ref": "/leads",
  "/pipeline": "/deals",
  "/conversations": "/doc-chats",
  "/workspace": "/",
  "/business": "/",
  "/tours/day.html": "/tours",
  "/notifications": "/updates",
};

export function navigationFor(root) {
  const html = root.documentElement;
  if (html.getAttribute('data-partner-sign-in') !== 'engine' && !html.hasAttribute('data-deals-saves-from-engine'))
    return navigationItems;
  return navigationItems.map(item => item.href === '/leases' ? { ...item, label: 'Closing anniversaries' } : item);
}

export function docRequestTarget(pathname) {
  const uuid = '[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
  const match = new RegExp(`^/doc/conversations/(${uuid})/turns/(${uuid})$`, 'i').exec(pathname);
  return match ? { id: match[1].toLowerCase(), targetMsgId: match[2].toLowerCase() } : null;
}

export function routeKey(pathname) {
  if (docRequestTarget(pathname)) return '/doc/conversations/:conversation_id/turns/:msg_id';
  const card = '/inbox/card/';
  return pathname.startsWith(card) && pathname.length > card.length && !pathname.slice(card.length).includes('/') ? '/inbox/card/:item_id' : pathname;
}
export const actionLinkRoute = pathname => /^\/a\/[^/]+$/.test(pathname) ? "/a/:ref" : pathname;
