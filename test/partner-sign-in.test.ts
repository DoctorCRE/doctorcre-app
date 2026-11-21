import assert from "node:assert/strict";
import test from "node:test";
import worker from "../src/worker.js";

const staging = "https://doctorcre-app-staging.joe-bookout-carr-us.workers.dev";
const production = "https://app.doctorcre.com";
const cookie = "__Host-doctorcre_session=synthetic";
const request = (path: string, init?: RequestInit, origin = staging) => new Request(origin + path, init);
const cookies = [
  cookie + "; Path=/; Secure; HttpOnly; SameSite=Lax",
  "__Host-state=; Path=/; Secure; Expires=Thu, 01 Jan 1970 00:00:00 GMT",
];
const session = { actor: { slug: "partner", display: "Fixture Partner" }, csrf_token: "synthetic-csrf" };
const proofs = { cookie, origin: staging, "sec-fetch-site": "same-origin", "x-carr-csrf": session.csrf_token };

type FetchResponse = (input: Request) => Response | Promise<Response>;

function fixture(fetch: FetchResponse | null, extra: Record<string, unknown> = {}) {
  const calls: { partner: Request[]; carr: Request[]; engine: Request[]; assets: string[] } = {
    partner: [],
    carr: [],
    engine: [],
    assets: [],
  };
  const env = {
    APP_ENV: "staging",
    GIT_SHA: "0".repeat(40),
    PARTNER_SIGN_IN: "engine",
    WORKSPACE_COMMAND_CENTER_READ_ENABLED: "true",
    PARTNER_APP: {
      fetch: async (input: Request) => {
        calls.partner.push(input);
        assert.ok(fetch);
        return fetch(input);
      },
    },
    CARR: {
      fetch: async (input: Request) => {
        calls.carr.push(input);
        throw Error("CARR unavailable");
      },
    },
    ENGINE: {
      fetch: async (input: Request) => {
        calls.engine.push(input);
        return Response.json({ legacy: true });
      },
    },
    ASSETS: {
      fetch: async (input: Request) => {
        const path = new URL(input.url).pathname;
        calls.assets.push(path);
        return new Response(input.method === "HEAD" ? null : path);
      },
    },
    ...extra,
  };
  return {
    calls,
    send: (path: string, init?: RequestInit, origin?: string) => worker.fetch(request(path, init, origin), env),
  };
}

const status = async (input: Request) =>
  input.headers.get("cookie") === cookie && new URL(input.url).origin === staging
    ? Response.json(session)
    : Response.json({ error: "unauthorized" }, { status: 401 });

test("engine sign-in preserves deep links, gates redirects, and protects GET and HEAD responses", async () => {
  const { send, calls } = fixture(status);
  const pages: [string, string, number][] = [
    ["/?view=charts", "/charts.html", 200],
    ["/leads?owner=partner", "/leads.html", 200],
    ["/a/synthetic", "/action-link.html", 200],
    ["/inbox/card/synthetic?show=mail", "/inbox.html", 200],
    ["/control-room/progress/board/carr-v5", "/progress-board.html", 200],
    ["/share?view=map", "/reports/share.html", 200],
    ["/pipeline?filter=open", "/deals?view=board&filter=open", 308],
    ["/progress-board.html?board=old", "/control-room/progress/board/carr-v5", 308],
    ["/deals?view=review&filter=open", "/deals?filter=open", 302],
  ];
  for (const [path, destination, expected] of pages) {
    const denied = await send(path, { headers: { "Engine-For-User": "partner", "X-Forwarded-User": "partner" } });
    assert.equal(denied.status, 302, path);
    const location = denied.headers.get("location");
    assert.ok(location);
    const login = new URL(location, staging);
    assert.equal(login.pathname, "/auth/login");
    assert.equal(login.searchParams.get("return_to"), path);
    assert.equal(denied.headers.get("cache-control"), "no-store");
    for (const method of ["GET", "HEAD"]) {
      const admitted = await send(path, { method, headers: { cookie } });
      assert.equal(admitted.status, expected, path);
      assert.equal(admitted.headers.get("cache-control"), "no-store");
      if (method === "HEAD") assert.equal(admitted.body, null);
      if (expected === 200 && method === "GET") assert.equal(await admitted.text(), destination);
      if (expected !== 200)
        assert.equal(new URL(admitted.headers.get("location") ?? "", staging).href, staging + destination);
    }
  }
  assert.equal(calls.carr.length, 0);
  assert.ok(calls.partner.every((input) => input.url === staging + "/auth/session" && input.method === "GET"));
  const publicCount = calls.partner.length;
  for (const path of ["/status", "/css/tokens.css", "/offline.html"]) assert.equal((await send(path)).status, 200);
  assert.equal(calls.partner.length, publicCount);
});

test("the workspace release flag still refuses its feature pages in engine mode", async () => {
  const { send } = fixture(status, { WORKSPACE_COMMAND_CENTER_READ_ENABLED: "false" });
  assert.equal((await send("/clients", { headers: { cookie } })).status, 404);
  assert.equal((await send("/leads", { headers: { cookie } })).status, 200);
});

test("auth forwards the app URL and preserves Google redirects and individual cookies", async () => {
  const { send, calls } = fixture((input) => {
    const headers = new Headers({ location: "/leads?owner=partner", "cache-control": "public" });
    for (const value of cookies) headers.append("set-cookie", value);
    return new Response(null, { status: new URL(input.url).pathname === "/auth/signout" ? 303 : 302, headers });
  });
  for (const path of [
    "/auth/login?return_to=%2Fleads",
    "/auth/callback/google?state=fixture&code=fixture",
    "/auth/reauth?return_to=%2Fdeals",
    "/auth/signout",
  ]) {
    const init = { method: path === "/auth/signout" ? "POST" : "GET", headers: proofs };
    const response = await send(path, init);
    assert.equal(response.status, init.method === "POST" ? 303 : 302);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(response.headers.get("location"), "/leads?owner=partner");
    assert.deepEqual(response.headers.getSetCookie(), cookies);
    const forwarded = calls.partner.at(-1);
    assert.ok(forwarded);
    assert.equal(forwarded.url, staging + path);
    assert.equal(forwarded.method, init.method);
    assert.equal(forwarded.redirect, "manual");
    for (const [name, value] of Object.entries(proofs)) assert.equal(forwarded.headers.get(name), value);
  }
  assert.equal(calls.carr.length, 0);
});

test("Google callback refusal preserves cookie clears and JSON clients can still read the error", async () => {
  const expiredCookies = ["__Host-state=; Path=/; Secure; Max-Age=0", "__Host-reauth=; Path=/; Secure; Max-Age=0"];
  const { send } = fixture(() => {
    const headers = new Headers();
    for (const value of expiredCookies) headers.append("set-cookie", value);
    return Response.json({ error: "sign_in_required" }, { status: 401, headers });
  });
  const path = "/auth/callback/google?state=fixture";
  const page = await send(path, { headers: { accept: "text/html" } });
  assert.equal(page.status, 401);
  assert.match(page.headers.get("content-type") ?? "", /^text\/html\b/);
  assert.equal(page.headers.get("cache-control"), "no-store");
  assert.deepEqual(page.headers.getSetCookie(), expiredCookies);
  const api = await send(path, { headers: { accept: "application/json" } });
  assert.equal(api.status, 401);
  assert.deepEqual(await api.json(), { error: "sign_in_required" });
});

test("engine session stays bound to its app origin and forwarded identity carries no authority", async () => {
  const { send, calls } = fixture(status);
  const identity = {
    "engine-for-user": "partner",
    "engine-job": "fixture",
    "x-forwarded-user": "partner",
    "x-forwarded-host": new URL(staging).host,
    forwarded: `host=${new URL(staging).host}`,
  };
  assert.equal((await send("/api/engine/leads", { headers: identity })).status, 401);
  assert.equal((await send("/auth/session", { headers: { ...identity, cookie } }, production)).status, 401);
  const forwarded = calls.partner.at(-1);
  assert.ok(forwarded);
  assert.equal(forwarded.url, production + "/auth/session");
  for (const name of Object.keys(identity)) assert.equal(forwarded.headers.has(name), false, name);
  assert.deepEqual(await (await send("/auth/session", { headers: { cookie } })).json(), session);
  assert.equal(calls.carr.length, 0);
});

test("engine auth outages fail closed for docs, auth and direct or adapted API calls", async () => {
  for (const fetch of [
    () => new Response("Unavailable", { status: 503 }),
    () => {
      throw Error("unavailable");
    },
    null,
  ]) {
    const { send, calls } = fixture(fetch, {
      ENGINE_ROUTING: { get: async (key: string) => (key !== "deals-saves-from-engine" ? "on" : null) },
      ...(fetch === null && { PARTNER_APP: undefined }),
    });
    for (const path of ["/deals?view=board", "/pipeline?owner=partner", "/auth/login?return_to=%2Fdeals"]) {
      const response = await send(path);
      assert.equal(response.status, 503, path);
      assert.match(response.headers.get("content-type") ?? "", /text\/html/);
      assert.match(await response.text(), /DoctorCRE is temporarily unavailable/);
    }
    for (const path of ["/auth/session", "/api/engine/leads", "/api/v1/business/clients"]) {
      const response = await send(path);
      assert.equal(response.status, 503, path);
      assert.equal(response.headers.get("cache-control"), "no-store");
    }
    const save = await send("/mcp", toolsCall("patch-deal-field", { deal: "fixture" }));
    assert.equal(save.status, 503);
    assert.equal(save.headers.get("cache-control"), "no-store");
    assert.equal(calls.assets.length, 0);
    assert.equal(calls.engine.length + calls.carr.length, 0);
  }
});

test("an engine read timeout leaves the legacy data path untouched", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const started = Promise.withResolvers<Request>();
  const next = Promise.withResolvers<Response>();
  const { send, calls } = fixture(
    (input) => {
      started.resolve(input);
      return next.promise;
    },
    { ENGINE_ROUTING: { get: async (key: string) => (key === "clients-vendors-from-engine" ? "on" : null) } },
  );
  const pending = send("/api/v1/business/clients", { headers: { cookie } });
  await started.promise;
  t.mock.timers.tick(2000);
  assert.equal((await pending).status, 503);
  assert.equal(calls.carr.length, 0);
  next.resolve(Response.json({ count: 0 }));
});

const toolsCall = (name: string, args: Record<string, unknown>) => ({
  method: "POST",
  headers: proofs,
  body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
});

test("Search returns versioned results through PartnerApp with only the engine cookie", async () => {
  const results = { schema_version: "search.v1", parties: [], deals: [] };
  const { send, calls } = fixture(
    (input) => {
      assert.equal(input.headers.get("cookie"), cookie);
      const url = new URL(input.url);
      assert.equal(url.pathname, "/api/engine/find");
      assert.equal(url.searchParams.get("query"), " Example & Clinic ");
      return Response.json(input.headers.get("x-doctorcre-search") === "search.v1" ? results : { clients: [] });
    },
    { ENGINE_ROUTING: { get: async (key: string) => (key === "search-from-engine" ? "on" : null) } },
  );
  const call = toolsCall("find", { query: " Example & Clinic " });
  const response = await send("/mcp", { ...call, headers: { ...proofs, "x-doctorcre-search": "search.v1" } });
  assert.equal(response.status, 200);
  assert.deepEqual(JSON.parse((await response.json()).result.content[0].text), results);
  assert.deepEqual(calls.carr, []);
  assert.deepEqual(calls.engine, []);
});

test("PartnerApp receives the Search version header only for supported Search requests", async (t) => {
  const header = "x-doctorcre-search";
  const cases = [
    { path: "/api/engine/find?query=clinic", value: "search.v1", expected: "search.v1" },
    { path: "/api/engine/find?query=clinic", value: "search.v2", expected: null },
    { path: "/api/engine/find?query=clinic", method: "POST", value: "search.v1", expected: null },
    { path: "/auth/session", value: "search.v1", expected: null },
    { path: "/auth/session", value: "search.v2", expected: null },
  ];
  for (const { path, method = "GET", value, expected } of cases) {
    await t.test(`${method} ${path} with ${value}`, async () => {
      const { send, calls } = fixture(status);
      assert.equal((await send(path, { method, headers: { cookie, [header]: value } })).status, 200);
      assert.equal(calls.partner.length, 1);
      assert.equal(calls.partner[0]?.headers.get(header), expected);
    });
  }
});

test("engine browser reads and writes stay on PartnerApp with CARR down", async () => {
  const { send, calls } = fixture(
    async (input: Request) => {
      if ((await status(input)).status === 401) return new Response(null, { status: 401 });
      if (input.method === "POST") {
        for (const [name, value] of Object.entries(proofs)) assert.equal(input.headers.get(name), value);
        assert.deepEqual(await input.json(), { deal: "fixture" });
      }
      return Response.json({ synthetic: true });
    },
    {
      ENGINE_ROUTING: {
        get: async (key: string) => (["deals-from-engine", "deal-saves-to-engine"].includes(key) ? "on" : null),
      },
    },
  );
  assert.deepEqual(await (await send("/api/engine/leads?owner=partner", { headers: proofs })).json(), {
    synthetic: true,
  });
  const read = await send("/mcp", toolsCall("deal-room-board", {}));
  assert.deepEqual(JSON.parse((await read.json()).result.content[0].text), { synthetic: true });
  const save = await send("/mcp", toolsCall("patch-deal-field", { deal: "fixture" }));
  assert.deepEqual(JSON.parse((await save.json()).result.content[0].text), { synthetic: true });
  assert.equal(calls.engine.length + calls.carr.length, 0);
});

test("Deals actions carry only the engine session to PartnerApp", async (t) => {
  const deal = "11111111-1111-4111-8111-111111111111";
  const step = "22222222-2222-4222-8222-222222222222";
  const key = "33333333-3333-4333-8333-333333333333";
  const browserHeaders = { ...proofs, cookie: `__Host-dealroom_session=stale; ${cookie}; __Host-dealroom_oauth=stale` };
  const command = { deal, seen_change_id: 7, idempotency_key: key };
  const actions = [
    {
      name: "board move",
      requestPath: "/mcp",
      init: toolsCall("patch-deal-field", {
        ...command,
        field: "phase",
        phase_from: "pending",
        value: "research",
        change_reason: "Review complete",
      }),
      enginePath: `/api/engine/deals/${deal}/changes`,
      payload: {
        idempotency_key: key,
        seen_change_id: 7,
        phase: { from: "pending", to: "research", reason: "Review complete" },
      },
      receipt: { deal_id: deal, change_id: 8 },
    },
    {
      name: "deal page note",
      requestPath: "/mcp",
      init: toolsCall("add-deal-note", { ...command, text: "Confirm the site visit" }),
      enginePath: "/api/engine/activities",
      payload: { idempotency_key: key, kind: "note", about: [{ deal_id: deal }], summary: "Confirm the site visit" },
      receipt: { activity_id: key },
    },
    {
      name: "step done",
      requestPath: `/api/engine/next-steps/${step}/end`,
      init: { method: "POST", body: JSON.stringify({ resolution: "done", base_version: 7, idempotency_key: key }) },
      enginePath: `/api/engine/next-steps/${step}/end`,
      payload: { resolution: "done", base_version: 7, idempotency_key: key },
      receipt: { next_step_id: step, status: "done", change_id: 8 },
    },
    {
      name: "deal Updates load",
      requestPath: "/mcp",
      init: toolsCall("get-deal-room", { deal }),
      enginePath: `/api/engine/deals/${deal}`,
      payload: null,
      receipt: { deal_id: deal, activities: [{ id: key, summary: "Confirm the site visit" }] },
    },
  ];
  for (const { name, requestPath, init, enginePath, payload, receipt } of actions) {
    await t.test(name, async () => {
      const { send, calls } = fixture(
        (input) => {
          if (input.headers.get("cookie") !== cookie) return new Response(null, { status: 401 });
          return Response.json(receipt);
        },
        {
          ENGINE_ROUTING: {
            get: async (switchKey: string) =>
              ["deals-from-engine", "deals-saves-from-engine"].includes(switchKey) ? "on" : null,
          },
        },
      );
      const response = await send(requestPath, { ...init, headers: browserHeaders });
      assert.equal(response.status, 200);
      const answer = await response.json();
      assert.deepEqual(
        requestPath === "/mcp" ? JSON.parse(answer.result.content[0].text) : answer,
        requestPath === "/mcp" && payload ? { ...receipt, ok: true } : receipt,
      );
      assert.equal(calls.partner.length, 1);
      const [forwarded] = calls.partner;
      assert.ok(forwarded);
      assert.equal(forwarded.url, staging + enginePath);
      assert.equal(forwarded.method, payload ? "POST" : "GET");
      assert.equal(forwarded.headers.get("cookie"), cookie);
      if (payload) {
        for (const name of ["origin", "sec-fetch-site", "x-carr-csrf"]) {
          assert.equal(forwarded.headers.get(name), new Headers(proofs).get(name), name);
        }
        assert.deepEqual(await forwarded.json(), payload);
      }
      assert.equal(calls.carr.length + calls.engine.length, 0);
    });
  }
});

test("the board polling feed uses the engine session until the switched board retires the feed", async () => {
  for (const boardSwitch of [null, "off", "on"]) {
    const path = "/pipeline/changes?cursor=example";
    const feed = { events: [], cursor: "example" };
    const { send, calls } = fixture(() => Response.json(feed), {
      ENGINE_ROUTING: { get: async (key: string) => (key === "deals-from-engine" ? boardSwitch : null) },
    });
    const response = await send(path, { headers: { cookie: `__Host-dealroom_session=stale; ${cookie}` } });
    assert.equal(response.headers.get("cache-control"), "no-store");
    if (boardSwitch === "on") {
      assert.equal(response.status, 204);
      assert.equal(calls.partner.length, 0);
    } else {
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), feed);
      assert.equal(calls.partner.length, 1);
      assert.equal(calls.partner[0]?.url, staging + "/api/engine" + path);
      assert.equal(calls.partner[0]?.headers.get("cookie"), cookie);
    }
    assert.equal(calls.carr.length + calls.engine.length, 0);
  }
});

test("an expired engine session returns to an old deal link after sign-in", async () => {
  const { send, calls } = fixture(status);
  const oldLink = "/pipeline?deal=11111111-1111-4111-8111-111111111111&tab=timeline";
  const denied = await send(oldLink, { headers: { cookie: "__Host-doctorcre_session=expired" } });
  assert.equal(denied.status, 302);
  const login = new URL(denied.headers.get("location") ?? "", staging);
  assert.equal(login.pathname, "/auth/login");
  assert.equal(login.searchParams.get("return_to"), oldLink);
  assert.deepEqual(calls.assets, []);
  const redirect = await send(oldLink, { headers: { cookie } });
  assert.equal(redirect.status, 308);
  const deal = new URL(redirect.headers.get("location") ?? "", staging);
  assert.equal(deal.pathname, "/deals");
  assert.equal(deal.searchParams.get("deal"), "11111111-1111-4111-8111-111111111111");
  assert.equal(deal.searchParams.get("tab"), "timeline");
  assert.equal(await (await send(deal.pathname + deal.search, { headers: { cookie } })).text(), "/pipeline.html");
  assert.equal(calls.carr.length + calls.engine.length, 0);
});

test("engine partner saves refuse an old-system handoff", async () => {
  const { send, calls } = fixture(() => Response.json({ error: "old_system_required" }, { status: 501 }), {
    ENGINE_ROUTING: {
      get: async (key: string) => (["deals-from-engine", "deal-saves-to-engine"].includes(key) ? "on" : null),
    },
  });
  const response = await send("/mcp", toolsCall("patch-deal-field", { deal: "fixture" }));
  const body = await response.json();
  assert.equal(body.result.isError, true);
  assert.equal(JSON.parse(body.result.content[0].text).error, "old_system_required");
  assert.equal(calls.engine.length + calls.carr.length, 0);
});

test("CARR mode keeps its existing auth, page and API destinations", async () => {
  const { send, calls } = fixture(status, {
    PARTNER_SIGN_IN: "carr",
    CARR: { fetch: async (input: Request) => Response.json({ source: new URL(input.url).pathname }) },
  });
  assert.deepEqual(await (await send("/auth/session")).json(), { source: "/auth/session" });
  assert.equal(await (await send("/leads")).text(), "/leads.html");
  assert.deepEqual(await (await send("/api/engine/leads")).json(), { legacy: true });
  assert.equal(calls.partner.length, 0);
});

test("missing, off and carr sign-in settings keep CARR's board feed", async () => {
  const legacyCookie = "__Host-dealroom_session=synthetic";
  for (const setting of [undefined, "off", "carr"]) {
    const { send, calls } = fixture(null, {
      PARTNER_SIGN_IN: setting,
      CARR: { fetch: async (input: Request) => Response.json({ events: [], session: input.headers.get("cookie") }) },
    });
    const response = await send("/pipeline/changes", { headers: { cookie: legacyCookie } });
    assert.deepEqual(await response.json(), { events: [], session: legacyCookie });
    assert.equal(calls.partner.length + calls.engine.length, 0);
  }
});

test("Ask Doc uses the engine page gate and forwards writes only to PartnerApp", async () => {
  const path = "/doc-chats?id=synthetic";
  const ask = "/api/engine/doc/turns";
  const { send, calls } = fixture(status, { WORKSPACE_COMMAND_CENTER_READ_ENABLED: "false" });
  const denied = await send(path);
  assert.equal(denied.status, 302);
  assert.equal(new URL(denied.headers.get("location") ?? "").searchParams.get("return_to"), path);
  const admitted = await send(path, { headers: proofs });
  assert.equal(admitted.status, 200);
  assert.equal(await admitted.text(), "/doc-chats.html");
  assert.equal(admitted.headers.get("cache-control"), "no-store");
  assert.equal((await send(ask, { method: "POST", headers: proofs })).status, 200);
  assert.equal(calls.partner.at(-1)?.headers.get("x-carr-csrf"), session.csrf_token);
  assert.equal(calls.engine.length + calls.carr.length, 0);

  const legacy = fixture(status, { PARTNER_SIGN_IN: "carr" });
  assert.equal((await legacy.send(ask, { method: "POST", headers: proofs })).status, 404);
  assert.equal(legacy.calls.engine.length + legacy.calls.partner.length, 0);
});
