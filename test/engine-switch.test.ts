import assert from "node:assert/strict";
import test from "node:test";
import worker from "../src/worker.js";

const origin = "https://app.example.test";
const payload = '{ "amount": "100.00", "synthetic": true }';
function call(name = "deal-room-board", args: unknown = {}, extra = {}) {
  return { jsonrpc: "2.0", id: "synthetic-request", method: "tools/call", params: { name, arguments: args }, ...extra };
}
function fixture(value: unknown = "on", answer: () => Promise<Response> = async () => new Response(payload)) {
  const engine: Request[] = [];
  const carr: string[] = [];
  const kv: unknown[] = [];
  const env = {
    GIT_SHA: "0".repeat(40),
    APP_ENV: "staging",
    ENGINE_ROUTING: {
      get: async (...args: unknown[]) => {
        kv.push(args);
        if (value instanceof Error) throw value;
        return value instanceof Map ? (value.get(args[0]) ?? null) : value;
      },
    },
    ENGINE: {
      fetch: async (request: Request) => {
        engine.push(request);
        return answer();
      },
    },
    CARR: {
      fetch: async (request: Request) => {
        carr.push(await request.text());
        return new Response("old");
      },
    },
  };
  const send = (body = call(), headers = { origin, cookie: "session=synthetic" }) =>
    worker.fetch(
      new Request(`${origin}/mcp`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      }),
      env,
    );
  return { env, send, engine, carr, kv };
}

for (const value of [null, "off", "ON", "", new Error("KV failed")]) {
  test(`off or unavailable switch preserves CARR request (${String(value)})`, async () => {
    const f = fixture(value);
    const body = call();
    assert.equal(await (await f.send(body)).text(), "old");
    assert.deepEqual(f.carr, [JSON.stringify(body)]);
    assert.equal(f.engine.length, 0);
  });
}

test("on routes declared board arguments on app host and wraps verbatim body", async () => {
  const f = fixture();
  const response = await f.send(call("deal-room-board", { workspace: "all deals", account_client_id: "demo&id" }));
  assert.equal(f.engine.length, 1);
  assert.equal(f.carr.length, 0);
  const request = f.engine[0];
  assert.ok(request);
  assert.equal(request.url, `${origin}/api/engine/deals?workspace=all+deals&account_client_id=demo%26id`);
  assert.equal(request.method, "GET");
  assert.equal(request.headers.get("cookie"), "session=synthetic");
  assert.equal(request.headers.get("origin"), origin);
  assert.deepEqual(f.kv, [["deals-from-engine", { cacheTtl: 30 }]]);
  assert.deepEqual(await response.json(), {
    jsonrpc: "2.0",
    id: "synthetic-request",
    result: { content: [{ type: "text", text: payload }] },
  });
});

test("one deal encodes its reference and optional board arguments are absent", async () => {
  const f = fixture();
  await f.send(call("get-deal-room", { deal: "demo/a?b#c" }));
  assert.equal(f.engine[0]?.url, `${origin}/api/engine/deals/demo%2Fa%3Fb%23c`);
  await f.send();
  assert.equal(f.engine[1]?.url, `${origin}/api/engine/deals`);
});

for (const deal of ["\ud800", "\udc00"]) {
  test(`unpaired surrogate ${JSON.stringify(deal)} falls back with original body`, async () => {
    const f = fixture();
    const body = call("get-deal-room", { deal });
    const response = await f.send(body);
    assert.equal(response.status, 200);
    assert.equal(await response.text(), "old");
    assert.deepEqual(f.carr, [JSON.stringify(body)]);
    assert.equal(f.engine.length, 0);
    assert.deepEqual(f.kv, [["deals-from-engine", { cacheTtl: 30 }]]);
  });
}

for (const body of [
  call("other"),
  call("deal-room-board", { workspace: 5 }),
  call("deal-room-board", { extra: "x" }),
  call("get-deal-room", {}),
  call("get-deal-room", { deal: null }),
  call("get-deal-room", { deal: ".." }),
  call("deal-room-board", []),
  call("deal-room-board", null),
  call("deal-room-board", {}, { method: "initialize" }),
]) {
  test(`ineligible call stays on CARR ${JSON.stringify(body)}`, async () => {
    const f = fixture();
    assert.equal(await (await f.send(body)).text(), "old");
    assert.equal(f.engine.length, 0);
    assert.equal(f.kv.length, 0);
  });
}

for (const status of [400, 404, 409, 422]) {
  test(`domain refusal ${status} wraps raw text and renews cookies`, async () => {
    const f = fixture(
      "on",
      async () =>
        new Response('{"error":"synthetic_refusal"}', {
          status,
          headers: [
            ["set-cookie", "session=fresh"],
            ["set-cookie", "other=fresh"],
          ],
        }),
    );
    const response = await f.send();
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      jsonrpc: "2.0",
      id: "synthetic-request",
      result: { content: [{ type: "text", text: '{"error":"synthetic_refusal"}' }], isError: true },
    });
    assert.deepEqual(response.headers.getSetCookie(), ["session=fresh", "other=fresh"]);
    assert.equal(f.carr.length, 0);
  });
}
for (const status of [401, 403, 429]) {
  test(`refusal ${status} passes through without fallback`, async () => {
    const f = fixture(
      "on",
      async () => new Response(payload, { status, headers: { "retry-after": "5", "set-cookie": "session=fresh" } }),
    );
    const response = await f.send();
    assert.equal(response.status, status);
    assert.equal(await response.text(), payload);
    assert.equal(response.headers.get("retry-after"), "5");
    assert.equal(response.headers.get("set-cookie"), "session=fresh");
    assert.equal(f.carr.length, 0);
  });
}
for (const status of [500, 502, 503]) {
  test(`engine ${status} falls back with original body`, async () => {
    const f = fixture("on", async () => new Response("down", { status }));
    assert.equal(await (await f.send()).text(), "old");
    assert.deepEqual(f.carr, [JSON.stringify(call())]);
  });
}
test("binding error falls back", async () => {
  const f = fixture("on", async () => {
    throw new Error("unavailable");
  });
  assert.equal(await (await f.send()).text(), "old");
});
test("engine deadline falls back even when binding ignores cancellation", async () => {
  const f = fixture("on", () => new Promise(() => {}));
  assert.equal(await (await f.send()).text(), "old");
  assert.equal(f.carr.length, 1);
});
test("engine body deadline falls back", async () => {
  const f = fixture("on", async () => new Response(new ReadableStream({ start() {} })));
  assert.equal(await (await f.send()).text(), "old");
});
test("foreign origin refuses before engine GET can bypass CSRF", async () => {
  const f = fixture();
  const response = await f.send(call(), { origin: "https://foreign.example.test", cookie: "session=synthetic" });
  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), { error: "origin_mismatch" });
  assert.equal(f.engine.length, 0);
  assert.equal(f.carr.length, 0);
});
test("switch is read for every request", async () => {
  const f = fixture("off");
  await f.send();
  f.env.ENGINE_ROUTING.get = async () => "on";
  await f.send();
  assert.equal(f.engine.length, 1);
  assert.equal(f.carr.length, 1);
});

test("successful engine answer renews all session cookies", async () => {
  const f = fixture(
    "on",
    async () =>
      new Response(payload, {
        headers: [
          ["set-cookie", "session=fresh"],
          ["set-cookie", "other=fresh"],
        ],
      }),
  );
  assert.deepEqual((await f.send()).headers.getSetCookie(), ["session=fresh", "other=fresh"]);
});
test("timed out response body is cancelled", async () => {
  let cancelled = false;
  const f = fixture(
    "on",
    async () =>
      new Response(
        new ReadableStream({
          cancel() {
            cancelled = true;
          },
        }),
      ),
  );
  assert.equal(await (await f.send()).text(), "old");
  assert.equal(cancelled, true);
});
test("binding response arriving after timeout is disposed without reading", async () => {
  let complete: (response: Response) => void = () => {};
  let cancelled = false;
  const f = fixture(
    "on",
    () =>
      new Promise((resolve) => {
        complete = resolve;
      }),
  );
  assert.equal(await (await f.send()).text(), "old");
  complete(
    new Response(
      new ReadableStream({
        cancel() {
          cancelled = true;
        },
      }),
    ),
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(cancelled, true);
});
test("missing bindings and malformed JSON preserve original proxy behavior", async () => {
  const f = fixture();
  const response = await worker.fetch(new Request(`${origin}/mcp`, { method: "POST", body: "malformed" }), f.env);
  assert.equal(await response.text(), "old");
  const { ENGINE, ENGINE_ROUTING, ...withoutBindings } = f.env;
  assert.ok(ENGINE);
  assert.ok(ENGINE_ROUTING);
  const second = await worker.fetch(
    new Request(`${origin}/mcp`, { method: "POST", body: JSON.stringify(call()) }),
    withoutBindings,
  );
  assert.equal(await second.text(), "old");
  assert.equal(f.engine.length, 0);
});

test("engine failure followed by CARR failure returns server error without signing out", async () => {
  const f = fixture("on", async () => {
    throw new Error("synthetic engine failure");
  });
  f.env.CARR.fetch = async () => {
    throw new Error("synthetic CARR failure");
  };
  const response = await f.send();
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: "carr_unavailable" });
});
const leadsOn = new Map([["leads-from-engine", "on"]]);
const cursor = { occurred_at: "2026-01-02T03:04:05.123+00:00", id: "00000000-0000-4000-8000-000000000002" };
for (const [name, args, path] of [
  ["lead-board", { workspace: "leads" }, "/api/engine/leads?workspace=leads"],
  [
    "lead-board",
    {
      workspace: "leads",
      lead_id: "00000000-0000-4000-8000-000000000001",
      correspondence_cursor: cursor,
      stage_history_cursor: "12",
    },
    `/api/engine/leads?workspace=leads&lead_id=00000000-0000-4000-8000-000000000001&correspondence_cursor=${encodeURIComponent(JSON.stringify(cursor))}&stage_history_cursor=12`,
  ],
  ["quiet-follow-ups", {}, "/api/engine/quiet-follow-ups"],
  [
    "quiet-follow-ups",
    { lead_days: 45, vendor_days: 90, owner_slug: "example-partner" },
    "/api/engine/quiet-follow-ups?lead_days=45&vendor_days=90&owner_slug=example-partner",
  ],
  ["list-practice-origination", { limit: 25, before_id: "7" }, "/api/engine/reasons-to-reach-out?limit=25&before_id=7"],
  [
    "territory-state-board",
    { vertical: "dental", city: "Example City", state: "EX" },
    "/api/engine/territory-state-board?vertical=dental&city=Example+City&state=EX",
  ],
] as const) {
  test(`leads switch routes ${name} ${JSON.stringify(args)} to its engine read`, async () => {
    const f = fixture(leadsOn);
    const response = await f.send(call(name, args));
    assert.equal(f.engine[0]?.url, `${origin}${path}`);
    assert.equal(f.engine[0]?.headers.get("cookie"), "session=synthetic");
    assert.deepEqual(f.kv, [["leads-from-engine", { cacheTtl: 30 }]]);
    assert.equal(f.carr.length, 0);
    assert.deepEqual((await response.json()).result, { content: [{ type: "text", text: payload }] });
  });
}

for (const [name, args] of [
  ["get-deal-room", { deal: "demo" }],
  ["deal-room-board", {}],
] as const) {
  test(`leads switch alone leaves ${name} on CARR`, async () => {
    const f = fixture(leadsOn);
    assert.equal(await (await f.send(call(name, args))).text(), "old");
    assert.deepEqual(f.kv, [["deals-from-engine", { cacheTtl: 30 }]]);
    assert.equal(f.engine.length, 0);
  });
}

for (const value of [null, "off", "ON", new Error("KV failed"), new Map([["deals-from-engine", "on"]])]) {
  test(`leads stay on CARR while their own switch is not on (${String(value)})`, async () => {
    const f = fixture(value);
    const body = call("lead-board", { workspace: "leads" });
    assert.equal(await (await f.send(body)).text(), "old");
    assert.deepEqual(f.carr, [JSON.stringify(body)]);
    assert.equal(f.engine.length, 0);
  });
}

for (const body of [
  call("lead-board", {}),
  call("lead-board", { workspace: "other" }),
  call("lead-board", { workspace: "leads", correspondence_cursor: "text" }),
  call("lead-board", { workspace: "leads", correspondence_cursor: [] }),
  call("lead-board", { workspace: "leads", correspondence_cursor: null }),
  call("list-practice-origination", { limit: "25" }),
  call("list-practice-origination", { limit: 25, extra: "x" }),
  call("quiet-follow-ups", { lead_days: "45" }),
  call("territory-state-board", { state: 5 }),
  call("quiet-follow-ups", { constructor: "x" }),
  call("quiet-follow-ups", JSON.parse('{"__proto__": "x"}')),
]) {
  test(`ineligible leads call stays on CARR without reading the switch ${JSON.stringify(body.params)}`, async () => {
    const f = fixture(leadsOn);
    assert.equal(await (await f.send(body)).text(), "old");
    assert.equal(f.engine.length, 0);
    assert.equal(f.kv.length, 0);
  });
}

const frameOn = new Map([["frame-from-engine", "on"]]);
for (const [name, path] of [
  ["today-triage", "/api/engine/today-triage"],
  ["calendar-meeting-prep", "/api/engine/calendar-meeting-prep"],
] as const) {
  test(`frame switch routes ${name} to its engine read`, async () => {
    const f = fixture(frameOn);
    const response = await f.send(call(name));
    assert.equal(f.engine[0]?.url, `${origin}${path}`);
    assert.equal(f.engine[0]?.headers.get("cookie"), "session=synthetic");
    assert.deepEqual(f.kv, [["frame-from-engine", { cacheTtl: 30 }]]);
    assert.equal(f.carr.length, 0);
    assert.deepEqual((await response.json()).result, { content: [{ type: "text", text: payload }] });
  });

  test(`frame read ${name} falls back when the engine answers 500`, async () => {
    const f = fixture(frameOn, async () => new Response("down", { status: 500 }));
    const body = call(name);
    assert.equal(await (await f.send(body)).text(), "old");
    assert.equal(f.engine.length, 1);
    assert.deepEqual(f.carr, [JSON.stringify(body)]);
  });

  for (const value of [
    null,
    "off",
    "ON",
    new Error("KV failed"),
    new Map([
      ["deals-from-engine", "on"],
      ["leads-from-engine", "on"],
    ]),
  ]) {
    test(`${name} stays on CARR while the frame switch is not on (${String(value)})`, async () => {
      const f = fixture(value);
      const body = call(name);
      assert.equal(await (await f.send(body)).text(), "old");
      assert.deepEqual(f.carr, [JSON.stringify(body)]);
      assert.equal(f.engine.length, 0);
    });
  }

  for (const args of [{ limit: 5 }, { owners: "all" }, { cursor: "x" }]) {
    test(`${name} with arguments ${JSON.stringify(args)} stays on CARR without reading the switch`, async () => {
      const f = fixture(frameOn);
      assert.equal(await (await f.send(call(name, args))).text(), "old");
      assert.equal(f.engine.length, 0);
      assert.equal(f.kv.length, 0);
    });
  }
}

test("frame switch alone leaves the Deals board on CARR", async () => {
  const f = fixture(frameOn);
  assert.equal(await (await f.send(call("deal-room-board", { workspace: "all" }))).text(), "old");
  assert.deepEqual(f.kv, [["deals-from-engine", { cacheTtl: 30 }]]);
  assert.equal(f.engine.length, 0);
});

test("numeric MCP request id survives engine wrapping", async () => {
  const f = fixture();
  const response = await f.send(call("deal-room-board", {}, { id: 0 }));
  assert.equal((await response.json()).id, 0);
});

for (const method of ["GET", "HEAD"]) {
  test(`direct engine ${method} preserves the request without reading KV`, async () => {
    const f = fixture(new Error("KV must not be read"), async () => new Response(method === "HEAD" ? null : payload));
    const url = `${origin}/api/engine/deals/demo%2Fa?workspace=all%20deals&workspace=mine`;
    const response = await worker.fetch(
      new Request(url, {
        method,
        headers: { cookie: "session=synthetic", origin, accept: "application/json" },
      }),
      f.env,
    );
    assert.equal(response.status, 200);
    assert.equal(await response.text(), method === "HEAD" ? "" : payload);
    assert.equal(f.engine.length, 1);
    const request = f.engine[0];
    assert.ok(request);
    assert.equal(request.url, url);
    assert.equal(request.method, method);
    assert.equal(request.headers.get("cookie"), "session=synthetic");
    assert.equal(request.headers.get("origin"), origin);
    assert.equal(request.headers.get("accept"), "application/json");
    assert.equal(request.redirect, "manual");
    assert.deepEqual(f.kv, []);
    assert.deepEqual(f.carr, []);
  });
}

for (const status of [200, 302, 401, 403, 429, 503]) {
  test(`direct engine response ${status} preserves body, headers and separate cookies`, async () => {
    const upstream = new Response(payload, {
      status,
      statusText: "Synthetic",
      headers: [
        ["content-type", "application/json"],
        ["location", "/auth/login"],
        ["retry-after", "5"],
        ["set-cookie", "session=fresh; Expires=Wed, 21 Oct 2037 07:28:00 GMT; HttpOnly"],
        ["set-cookie", "other=fresh; Secure"],
      ],
    });
    const f = fixture("off", async () => upstream);
    const response = await worker.fetch(new Request(`${origin}/api/engine/deals?workspace=mine`), f.env);
    assert.equal(response.status, status);
    assert.equal(response.statusText, upstream.statusText);
    assert.deepEqual([...response.headers], [...upstream.headers]);
    assert.deepEqual(response.headers.getSetCookie(), upstream.headers.getSetCookie());
    assert.equal(await response.text(), payload);
    assert.deepEqual(f.kv, []);
    assert.deepEqual(f.carr, []);
  });
}

for (const appEnv of ["staging", "production"]) {
  test(`direct engine POST forwards unchanged bytes and security headers in ${appEnv}`, async () => {
    const upstream = new Response(payload, { status: 503, headers: { "retry-after": "5" } });
    const f = fixture(new Error("KV must not be read"), async () => upstream);
    const url = `${origin}/api/engine/presence?field=phase%20name&field=other`;
    const body = new Uint8Array([0, 255, 13, 10, 32, 123, 125]);
    const headers = {
      cookie: "session=synthetic",
      origin,
      "sec-fetch-site": "same-origin",
      "x-carr-csrf": "synthetic-csrf",
      "content-type": "application/octet-stream",
    };
    const response = await worker.fetch(new Request(url, { method: "POST", headers, body }), {
      ...f.env,
      APP_ENV: appEnv,
    });
    assert.equal(response, upstream);
    assert.equal(response.status, 503);
    assert.equal(response.headers.get("retry-after"), "5");
    assert.equal(await response.text(), payload);
    assert.equal(f.engine.length, 1);
    const request = f.engine[0];
    assert.ok(request);
    assert.equal(request.method, "POST");
    assert.equal(request.url, url);
    assert.deepEqual(new Uint8Array(await request.arrayBuffer()), body);
    for (const [name, value] of Object.entries(headers)) assert.equal(request.headers.get(name), value);
    assert.equal(request.redirect, "manual");
    assert.deepEqual(f.kv, []);
    assert.deepEqual(f.carr, []);
  });
}

for (const method of ["PUT", "PATCH", "DELETE", "OPTIONS"]) {
  test(`direct engine ${method} refuses with Allow before accessing bindings`, async () => {
    const response = await worker.fetch(new Request(`${origin}/api/engine/deals`, { method }), {
      GIT_SHA: "0".repeat(40),
      APP_ENV: "staging",
    });
    assert.equal(response.status, 405);
    assert.equal(response.headers.get("allow"), "GET, HEAD, POST");
    assert.deepEqual(await response.json(), { error: "method_not_allowed" });
  });
}

test("direct engine missing binding returns fixed unavailable response", async () => {
  const f = fixture();
  const { ENGINE, ...env } = f.env;
  assert.ok(ENGINE);
  const response = await worker.fetch(new Request(`${origin}/api/engine/deals`), env);
  assert.equal(response.status, 503);
  assert.equal(await response.text(), '{"error":"engine_unavailable"}');
  assert.deepEqual(f.kv, []);
  assert.deepEqual(f.carr, []);
});

test("direct engine throwing binding returns fixed unavailable response without details", async () => {
  const f = fixture("on", async () => {
    throw new Error("sensitive synthetic details");
  });
  const response = await worker.fetch(new Request(`${origin}/api/engine/deals`), f.env);
  assert.equal(response.status, 503);
  assert.equal(await response.text(), '{"error":"engine_unavailable"}');
  assert.deepEqual(f.kv, []);
  assert.deepEqual(f.carr, []);
});

for (const path of ["/api/engine", "/api/engine-other/deals"]) {
  test(`direct engine prefix excludes ${path}`, async () => {
    const f = fixture();
    const response = await worker.fetch(new Request(`${origin}${path}`), f.env);
    assert.equal(response.status, 404);
    assert.deepEqual(f.engine, []);
    assert.deepEqual(f.kv, []);
  });
}

const remainingScreens = [
  ["invoices-from-engine", "read-invoice-tracker", "/api/engine/invoices"],
  ["charts-from-engine", "ideal-client-profile", "/api/engine/client-fit"],
  ["national-deals-from-engine", "capture-queue", "/api/engine/capture-queue"],
] as const;

for (const [key, name, path] of remainingScreens) {
  test(`${key} routes ${name} to its engine read`, async () => {
    const f = fixture(new Map([[key, "on"]]));
    const response = await f.send(call(name));
    assert.equal(f.engine[0]?.url, `${origin}${path}`);
    assert.equal(f.engine[0]?.method, "GET");
    assert.equal(f.engine[0]?.headers.get("cookie"), "session=synthetic");
    assert.deepEqual(f.kv, [[key, { cacheTtl: 30 }]]);
    assert.equal(f.carr.length, 0);
    assert.deepEqual((await response.json()).result, { content: [{ type: "text", text: payload }] });
  });

  for (const value of [null, "off", "ON", "", new Error("KV failed")]) {
    test(`${name} keeps the original CARR body when its switch is ${String(value)}`, async () => {
      const f = fixture(value);
      const body = call(name);
      assert.equal(await (await f.send(body)).text(), "old");
      assert.deepEqual(f.carr, [JSON.stringify(body)]);
      assert.equal(f.engine.length, 0);
    });
  }

  for (const enabled of [
    "deals-from-engine",
    "leads-from-engine",
    "clients-vendors-from-engine",
    "relationships-from-engine",
    ...remainingScreens.map(([screenKey]) => screenKey).filter((screenKey) => screenKey !== key),
  ]) {
    test(`${enabled} alone leaves ${name} on CARR`, async () => {
      const f = fixture(new Map([[enabled, "on"]]));
      const body = call(name);
      assert.equal(await (await f.send(body)).text(), "old");
      assert.deepEqual(f.carr, [JSON.stringify(body)]);
      assert.equal(f.engine.length, 0);
      assert.deepEqual(f.kv, [[key, { cacheTtl: 30 }]]);
    });
  }

  for (const body of [call(name, { extra: "x" }), call(name, { workspace: "all" })]) {
    test(`${name} rejects unsupported arguments before KV ${JSON.stringify(body.params)}`, async () => {
      const f = fixture(new Map([[key, "on"]]));
      assert.equal(await (await f.send(body)).text(), "old");
      assert.deepEqual(f.carr, [JSON.stringify(body)]);
      assert.deepEqual(f.engine, []);
      assert.deepEqual(f.kv, []);
    });
  }

  test(`${key} alone leaves existing reads and writes on CARR`, async () => {
    const f = fixture(new Map([[key, "on"]]));
    for (const body of [
      call("deal-room-board"),
      call("lead-board", { workspace: "leads" }),
      call("read-vendor-markets-v1"),
      call("find", { query: "Example Clinic" }),
      call("record-commission-receipt", { commission_id: recordId }),
      call("set-next-step", { deal: "example-deal", next_step: "Example step" }),
      call("create-national-account", { name: "Example account" }),
    ]) {
      assert.equal(await (await f.send(body)).text(), "old");
      assert.equal(f.carr.at(-1), JSON.stringify(body));
    }
    assert.equal(
      await (await getRead(f, "/api/v1/business/relationships?contract=relationship-network.v1")).text(),
      "old",
    );
    assert.equal(await (await getRead(f, "/pipeline/changes")).text(), "old");
    assert.equal(f.engine.length, 0);
  });
}

test("charts switch encodes every client fit filter as query text", async () => {
  const f = fixture(new Map([["charts-from-engine", "on"]]));
  await f.send(call("ideal-client-profile", { vertical: "example & practice", city: "Example City", state: "EX" }));
  assert.equal(
    f.engine[0]?.url,
    `${origin}/api/engine/client-fit?vertical=example+%26+practice&city=Example+City&state=EX`,
  );
  assert.equal(f.carr.length, 0);
});

for (const args of [{ vertical: 1 }, { city: null }, { state: ["EX"] }]) {
  test(`invalid client fit filter stays on CARR without KV ${JSON.stringify(args)}`, async () => {
    const f = fixture(new Map([["charts-from-engine", "on"]]));
    const body = call("ideal-client-profile", args);
    assert.equal(await (await f.send(body)).text(), "old");
    assert.deepEqual(f.carr, [JSON.stringify(body)]);
    assert.deepEqual(f.kv, []);
    assert.deepEqual(f.engine, []);
  });
}

const searchOn = new Map([["search-from-engine", "on"]]);
const find = call("find", { query: " Example & Clinic " });

test("search switch routes find with its untrimmed query as query text", async () => {
  const f = fixture(searchOn);
  const response = await f.send(find);
  assert.equal(f.engine[0]?.url, `${origin}/api/engine/find?query=+Example+%26+Clinic+`);
  assert.equal(f.engine[0]?.method, "GET");
  assert.equal(f.engine[0]?.headers.get("cookie"), "session=synthetic");
  assert.deepEqual(f.kv, [["search-from-engine", { cacheTtl: 30 }]]);
  assert.equal(f.carr.length, 0);
  assert.deepEqual((await response.json()).result, { content: [{ type: "text", text: payload }] });
});

for (const value of [
  null,
  "off",
  "ON",
  "",
  new Error("KV failed"),
  ...[
    "deals-from-engine",
    "leads-from-engine",
    "invoices-from-engine",
    "charts-from-engine",
    "national-deals-from-engine",
    "clients-vendors-from-engine",
    "relationships-from-engine",
    "frame-from-engine",
  ].map((key) => new Map([[key, "on"]])),
]) {
  test(`find keeps the original CARR body unless its own switch is on (${value instanceof Map ? [...value.keys()] : String(value)})`, async () => {
    const f = fixture(value);
    assert.equal(await (await f.send(find)).text(), "old");
    assert.deepEqual(f.carr, [JSON.stringify(find)]);
    assert.equal(f.engine.length, 0);
    assert.deepEqual(f.kv, [["search-from-engine", { cacheTtl: 30 }]]);
  });
}

// Search's second read, find-and-catch-up, follows the Clients and Vendors switch.
for (const [keys, engineReads] of [
  [["search-from-engine"], ["find"]],
  [["clients-vendors-from-engine"], ["find-and-catch-up"]],
  [
    ["search-from-engine", "clients-vendors-from-engine"],
    ["find", "find-and-catch-up"],
  ],
] as const) {
  test(`with ${keys.join(" and ")} on, Search reads ${engineReads.join(" and ")} from the engine`, async () => {
    const f = fixture(new Map(keys.map((key) => [key, "on"])));
    await f.send(find);
    await f.send(call("find-and-catch-up", { query: " Example & Clinic ", limit: 20 }));
    assert.deepEqual(
      f.engine.map((request) => new URL(request.url).pathname),
      engineReads.map((name) => (name === "find" ? "/api/engine/find" : "/api/engine/recent-activity")),
    );
    assert.equal(f.carr.length, 2 - engineReads.length);
  });
}

for (const args of [{}, { query: "" }, { query: 5 }, { query: null }, { query: "x", limit: 20 }]) {
  test(`ineligible find stays on CARR without reading the switch ${JSON.stringify(args)}`, async () => {
    const f = fixture(searchOn);
    const body = call("find", args);
    assert.equal(await (await f.send(body)).text(), "old");
    assert.deepEqual(f.carr, [JSON.stringify(body)]);
    assert.deepEqual(f.engine, []);
    assert.deepEqual(f.kv, []);
  });
}

const directoryOn = new Map([["clients-vendors-from-engine", "on"]]);
const recordId = "00000000-0000-4000-8000-0000000000aB";
const getRead = (f: ReturnType<typeof fixture>, path: string, method = "GET") =>
  worker.fetch(new Request(`${origin}${path}`, { method, headers: { cookie: "session=synthetic" } }), f.env);

for (const [name, args, path] of [
  [
    "find-and-catch-up",
    { query: "Example Clinic", limit: 10 },
    "/api/engine/recent-activity?query=Example+Clinic&limit=10",
  ],
  [
    "read-vendor-meetings",
    { view: "suggested", q: "", limit: 5 },
    "/api/engine/vendor-meetings?view=suggested&q=&limit=5",
  ],
  [
    "read-vendor-meetings",
    { view: "research", q: "lender", limit: 5, cursor: "c3ludGhldGlj" },
    "/api/engine/vendor-meetings?view=research&q=lender&limit=5&cursor=c3ludGhldGlj",
  ],
  ["read-vendor-markets-v1", {}, "/api/engine/vendor-markets"],
  ["read-vendor-markets-v1", { market: "Example Metro" }, "/api/engine/vendor-markets?market=Example+Metro"],
] as const) {
  test(`clients and vendors switch routes ${name} ${JSON.stringify(args)} to its engine read`, async () => {
    const f = fixture(directoryOn);
    const response = await f.send(call(name, args));
    assert.equal(f.engine[0]?.url, `${origin}${path}`);
    assert.deepEqual(f.kv, [["clients-vendors-from-engine", { cacheTtl: 30 }]]);
    assert.equal(f.carr.length, 0);
    assert.deepEqual((await response.json()).result, { content: [{ type: "text", text: payload }] });
  });
}

for (const [path, engine] of [
  ["/api/v1/business/clients", "/api/engine/clients"],
  [
    "/api/v1/business/clients?contract=vendor-directory.v1&q=a%20b&page=2",
    "/api/engine/clients?contract=vendor-directory.v1&q=a%20b&page=2",
  ],
  [`/api/v1/business/clients/${recordId}`, `/api/engine/clients/${recordId}`],
  [
    "/api/v1/business/vendors?contract=vendor-directory.v1&sort=territory",
    "/api/engine/vendors?contract=vendor-directory.v1&sort=territory",
  ],
  [
    `/api/v1/business/vendors/${recordId}?contract=vendor-directory.v2`,
    `/api/engine/vendors/${recordId}?contract=vendor-directory.v2`,
  ],
] as const) {
  test(`clients and vendors switch routes GET ${path} to the engine unchanged`, async () => {
    const f = fixture(directoryOn, async () => new Response(payload, { headers: { "set-cookie": "session=fresh" } }));
    const response = await getRead(f, path);
    assert.equal(f.engine[0]?.url, `${origin}${engine}`);
    assert.equal(f.engine[0]?.method, "GET");
    assert.equal(f.engine[0]?.headers.get("cookie"), "session=synthetic");
    assert.deepEqual(f.kv, [["clients-vendors-from-engine", { cacheTtl: 30 }]]);
    assert.equal(f.carr.length, 0);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "application/json; charset=utf-8");
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(response.headers.get("set-cookie"), "session=fresh");
    assert.equal(await response.text(), payload);
  });
}

for (const status of [400, 401, 403, 404, 409, 422, 429]) {
  test(`business GET refusal ${status} comes back as the engine answered it`, async () => {
    const f = fixture(directoryOn, async () => new Response('{"error":"QUERY_INVALID"}', { status }));
    const response = await getRead(f, "/api/v1/business/vendors?page=0");
    assert.equal(response.status, status);
    assert.equal(await response.text(), '{"error":"QUERY_INVALID"}');
    assert.equal(f.carr.length, 0);
  });
}

for (const answer of [
  async () => new Response("down", { status: 503 }),
  async () => {
    throw new Error("unavailable");
  },
  () => new Promise<Response>(() => {}),
]) {
  test(`business GET falls back to CARR when the engine fails (${String(answer)})`, async () => {
    const f = fixture(directoryOn, answer);
    const response = await getRead(f, `/api/v1/business/clients/${recordId}`);
    assert.equal(await response.text(), "old");
    assert.equal(f.carr.length, 1);
  });
}

for (const value of [null, "off", "ON", new Error("KV failed"), leadsOn, new Map([["deals-from-engine", "on"]])]) {
  test(`clients and vendors stay on CARR while their own switch is not on (${String(value)})`, async () => {
    const f = fixture(value);
    assert.equal(await (await getRead(f, "/api/v1/business/clients")).text(), "old");
    const body = call("read-vendor-markets-v1", {});
    assert.equal(await (await f.send(body)).text(), "old");
    assert.deepEqual(f.carr, ["", JSON.stringify(body)]);
    assert.equal(f.engine.length, 0);
  });
}

for (const [name, args] of [
  ["deal-room-board", {}],
  ["lead-board", { workspace: "leads" }],
  ["quiet-follow-ups", {}],
] as const) {
  test(`clients and vendors switch alone leaves ${name} on CARR`, async () => {
    const f = fixture(directoryOn);
    assert.equal(await (await f.send(call(name, args))).text(), "old");
    assert.equal(f.engine.length, 0);
  });
}

for (const [method, path] of [
  ["HEAD", "/api/v1/business/clients"],
  ["POST", "/api/v1/business/clients"],
  ["GET", "/api/v1/business/clients/"],
  ["GET", "/api/v1/business/clients/not-a-record-id"],
  ["GET", `/api/v1/business/clients/${recordId}/extra`],
  ["GET", "/api/v1/business/leases"],
  ["GET", "/api/v1/business/clientsx"],
] as const) {
  test(`${method} ${path} stays on CARR without reading the switch`, async () => {
    const f = fixture(directoryOn);
    assert.equal(await (await getRead(f, path, method)).text(), "old");
    assert.equal(f.engine.length, 0);
    assert.equal(f.kv.length, 0);
  });
}

for (const body of [
  call("find-and-catch-up", { query: 5, limit: 10 }),
  call("find-and-catch-up", { query: "x", limit: "10" }),
  call("find-and-catch-up", { query: "x", extra: "y" }),
  call("read-vendor-meetings", { cursor: {} }),
  call("read-vendor-markets-v1", { market: null }),
  call("/api/v1/business/clients", {}),
]) {
  test(`ineligible clients and vendors call stays on CARR without reading the switch ${JSON.stringify(body.params)}`, async () => {
    const f = fixture(directoryOn);
    assert.equal(await (await f.send(body)).text(), "old");
    assert.equal(f.engine.length, 0);
    assert.equal(f.kv.length, 0);
  });
}

for (const path of ["/api/post-call", "/api/v1/business/clients"]) {
  test(`a tool call posted to ${path} stays on CARR without reading the switch`, async () => {
    const f = fixture("on");
    const body = JSON.stringify(call("deal-room-board", {}));
    const response = await worker.fetch(new Request(`${origin}${path}`, { method: "POST", body }), f.env);
    assert.equal(await response.text(), "old");
    assert.deepEqual(f.carr, [body]);
    assert.equal(f.kv.length, 0);
  });
}

const relationshipsOn = new Map([["relationships-from-engine", "on"]]);
const relationshipRead = "/api/v1/business/relationships?contract=relationship-network.v1";

test("relationships switch routes the network GET with unchanged query and response", async () => {
  const f = fixture(relationshipsOn);
  const response = await getRead(f, relationshipRead);
  assert.equal(f.engine[0]?.url, `${origin}/api/engine/relationships?contract=relationship-network.v1`);
  assert.equal(f.engine[0]?.method, "GET");
  assert.equal(f.engine[0]?.headers.get("cookie"), "session=synthetic");
  assert.deepEqual(f.kv, [["relationships-from-engine", { cacheTtl: 30 }]]);
  assert.equal(f.carr.length, 0);
  assert.equal(response.status, 200);
  assert.equal(await response.text(), payload);
});

for (const value of [
  null,
  "off",
  "ON",
  new Error("KV failed"),
  directoryOn,
  leadsOn,
  new Map([["deals-from-engine", "on"]]),
]) {
  test(`relationships stay on CARR unless their own switch is on (${String(value)})`, async () => {
    const f = fixture(value);
    assert.equal(await (await getRead(f, relationshipRead)).text(), "old");
    assert.deepEqual(f.carr, [""]);
    assert.equal(f.engine.length, 0);
  });
}

for (const path of ["/api/v1/business/clients", "/api/v1/business/vendors"]) {
  test(`relationships switch alone leaves GET ${path} on CARR`, async () => {
    const f = fixture(relationshipsOn);
    assert.equal(await (await getRead(f, path)).text(), "old");
    assert.equal(f.engine.length, 0);
  });
}

for (const [name, args] of [
  ["deal-room-board", {}],
  ["lead-board", { workspace: "leads" }],
] as const) {
  test(`relationships switch alone leaves ${name} on CARR`, async () => {
    const f = fixture(relationshipsOn);
    const body = call(name, args);
    assert.equal(await (await f.send(body)).text(), "old");
    assert.deepEqual(f.carr, [JSON.stringify(body)]);
    assert.equal(f.engine.length, 0);
  });
}

for (const [method, path] of [
  ["GET", `/api/v1/business/relationships/${recordId}?contract=relationship-network.v1`],
  ["HEAD", relationshipRead],
] as const) {
  test(`relationships ${method} ${path} stays on CARR without reading KV`, async () => {
    const f = fixture(relationshipsOn);
    assert.equal(await (await getRead(f, path, method)).text(), "old");
    assert.equal(f.engine.length, 0);
    assert.deepEqual(f.kv, []);
  });
}
