export const routeEntries = [
  ["/","workspace.html","/"],
  ["/a/:ref","action-link.html","/"],
  ["/all-work","work-inventory.html","/work-inventory"],
  ["/calendar","calendar.html","/business"],
  ["/calls","calls.html","/business"],
  ["/client-portal","client-portal.html","/business"],
  ["/clients","business.html","/clients"],
  ["/control-room","control-room.html","/control-room"],
  ["/control-room/progress","progress-board.html","/control-room"],
  ["/control-room/progress/board/:boardId","progress-board.html","/control-room"],
  ["/control-room/progress/work","progress-work.html","/control-room"],
  ["/deals","pipeline.html","/deals"],
  ["/design-lab","design.html","/control-room"],
  ["/doc-activity","activity.html","/control-room"],
  ["/doc-chats","conversations.html","/conversations"],
  ["/doc-chats/work","tasks.html","/tasks"],
  ["/doc/conversations/:conversation_id/turns/:msg_id","conversations.html","/conversations"],
  ["/ideas-events","ideas.html","/control-room"],
  ["/inbox","inbox.html","/"],
  ["/inbox/card/:item_id","inbox.html","/"],
  ["/incidents","incidents.html","/incidents"],
  ["/invoices","invoices.html","/control-room"],
  ["/leads","leads.html","/leads"],
  ["/leases","lease-radar.html","/business"],
  ["/relationships","relationships.html","/business"],
  ["/review-workflows","review-workflows.html","/"],
  ["/search","search.html","/business"],
  ["/status","status.html","/control-room"],
  ["/tours","tours/index.html","/tours"],
  ["/updates","notifications.html","/notifications"],
  ["/vendors","business.html","/vendors"],
  ["/work-requests","system-work.html","/system-work.html"],
];
export const routeContract = {
  schema: "doctorcre-app-routes.v1",
  version: "1.25.0",
  routes: Object.fromEntries(routeEntries.map(([path, asset]) => [path, asset])),
  redirects: {
  "/control-room/observatory": "/",
  "/observatory.html": "/",
  "/control-room/automations": "/control-room?tab=automations",
  "/automations.html": "/control-room?tab=automations",
  "/progress-board": "/control-room/progress/board/carr-v5",
  "/workspace": "/",
  "/queue.html": "/control-room/progress/work?view=tasks",
  "/control-room/agents/queue": "/control-room/progress/work?view=tasks",
  "/pipeline": "/deals?view=board",
  "/business": "/",
  "/system-work.html": "/work-requests",
  "/room.html": "/control-room/progress/work?view=wire",
  "/agent-room": "/control-room/progress/work?view=wire",
  "/design": "/design-lab",
  "/design/business": "/design-lab?reference=business",
  "/design/operations": "/design-lab?reference=operations",
  "/work-inventory": "/all-work",
  "/notifications": "/updates",
  "/conversations": "/doc-chats",
  "/ideas": "/ideas-events",
  "/tasks": "/",
  "/work": "/",
  "/tasks.html": "/"
},
  gatePaths: Object.fromEntries(routeEntries.map(([path, , gate]) => [path, gate])),
};
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
  { label: "Events", href: "/ideas-events?tab=events", secondary: true },
  { label: "Updates", href: "/updates", secondary: true },
];

export const toursDestination = { label: "Tours", href: "/tours" };

export const switcherUtilityPages = [
  { label: "Inbox", href: "/inbox" },
  { label: "Review workflows", href: "/review-workflows" },
  { label: "Search", href: "/search" },
  toursDestination,
  { label: "Doc Activity", href: "/doc-activity" },
  { label: "Client portal", href: "/client-portal" },
];

export const sectionForRoute = {
  "/review-workflows": "/",
  "/doc/conversations/:conversation_id/turns/:msg_id": "/doc-chats",
  "/inbox": "/",
  "/inbox/card/:item_id": "/",
  "/a/:ref": "/leads",
  "/work-inventory": "/all-work",
  "/control-room/progress": "/control-room",
  "/control-room/automations": "/control-room",
  "/pipeline": "/deals",
  "/design": "/design-lab",
  "/design/business": "/design-lab",
  "/design/operations": "/design-lab",
  "/doc-chats/work": "/doc-chats",
  "/conversations": "/doc-chats",
  "/tasks": "/",
  "/work": "/",
  "/workspace": "/",
  "/business": "/",
  "/ideas": "/ideas-events?tab=ideas",
  "/queue.html": "/control-room/progress/work",
  "/control-room/agents/queue": "/control-room/progress/work",
  "/agent-room": "/control-room/progress/work",
  "/room.html": "/control-room/progress/work",
  "/progress-board": "/control-room/progress/board/carr-v5",
  "/tours/day.html": "/tours",
  "/notifications": "/updates",
  "/system-work.html": "/work-requests"
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
