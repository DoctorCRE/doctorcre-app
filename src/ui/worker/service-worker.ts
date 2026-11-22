export {};

declare const self: ServiceWorkerGlobalScope;
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object";
const SHELL_CACHE = "dealroom-shell-v8";
const SHELL = [
  "/offline.html",
  "/public-shell/session-ended.html",
  "/public-shell/shell.css",
  "/manifest.webmanifest",
  "/icons/dealroom-192.png",
  "/icons/dealroom-512.png",
];
const staticAsset = (path: string) => SHELL.includes(path) || /^\/(?:js|css)\/.+\.(?:m?js|css)$/.test(path);
const cacheable = (response: Response) =>
  response.ok && !/\b(?:no-store|private)\b/i.test(response.headers.get("cache-control") || "");
self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(SHELL_CACHE).then((cache) => cache.addAll(SHELL)));
  self.skipWaiting();
});
self.addEventListener("activate", (event) =>
  event.waitUntil(
    caches
      .keys()
      .then((names) =>
        Promise.all(
          names
            .filter((name) => name.startsWith("dealroom-shell-") && name !== SHELL_CACHE)
            .map((name) => caches.delete(name)),
        ),
      )
      .then(() => self.clients.claim()),
  ),
);
self.addEventListener("message", (event) => {
  if (event.data?.type !== "doctorcre-session-revoked") return;
  event.waitUntil(
    Promise.all([
      caches.keys().then((names) => Promise.all(names.map((name) => caches.delete(name)))),
      self.registration?.pushManager?.getSubscription().then((subscription) => subscription?.unsubscribe()),
    ]),
  );
});
async function networkOnly(request: Request) {
  try {
    return await fetch(request);
  } catch {
    const path = new URL(request.url).pathname;
    if (request.mode === "navigate" && !/^\/(?:auth|api)\//.test(path) && path !== "/mcp")
      return (await caches.match("/offline.html")) || new Response("Offline", { status: 503 });
    return new Response(JSON.stringify({ error: "offline", state: "reconnecting", live: false }), {
      status: 503,
      headers: { "content-type": "application/json", "cache-control": "no-store" },
    });
  }
}
async function shell(request: Request) {
  try {
    const response = await fetch(request);
    if (cacheable(response)) await (await caches.open(SHELL_CACHE)).put(request, response.clone());
    return response;
  } catch {
    return (await caches.match(request)) || new Response("Offline", { status: 503 });
  }
}
self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;
  // Auth, APIs, MCP and unknown paths never consult CacheStorage. Only the
  // explicit static shell may be cached, regardless of HTTP success.
  if (event.request.method !== "GET" || !staticAsset(url.pathname)) event.respondWith(networkOnly(event.request));
  else event.respondWith(shell(event.request));
});

self.addEventListener("push", (event) => {
  event.waitUntil(
    (async () => {
      let destination = "/notifications.html";
      try {
        const value: unknown = event.data?.json();
        if (
          object(value) &&
          value.schema_version === "web-push.v1" &&
          typeof value.target_ref === "string" &&
          /^al1_[A-Za-z0-9_-]{1,120}$/.test(value.target_ref)
        )
          destination = `/a/${value.target_ref}`;
      } catch {
        /* Invalid payloads still produce a generic visible notification. */
      }
      await self.registration.showNotification("DoctorCRE", {
        body: "Open DoctorCRE to review.",
        data: { destination },
      });
    })(),
  );
});
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(
    (async () => {
      const data: unknown = event.notification.data;
      const path =
        object(data) && typeof data.destination === "string" && /^\/a\/al1_[A-Za-z0-9_-]{1,120}$/.test(data.destination)
          ? data.destination
          : "/notifications.html";
      const url = new URL(path, self.location.origin).href;
      const clients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      const exact = clients.find((client) => client.url === url);
      if (exact) await exact.focus();
      else await self.clients.openWindow(url);
    })(),
  );
});
