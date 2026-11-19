import assert from "node:assert/strict";
import test from "node:test";
import worker from "../src/worker.js";

const origin = "https://app.example.test";
const dealsReadOn = new Map([["deals-from-engine", "on"]]);
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
  const send = (body = call(), headers: HeadersInit = { origin, cookie: "session=synthetic" }) =>
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

test("a filed deal document streams from the engine only with Deals reads on", async () => {
  const url = `${origin}/api/engine/documents/00000000-0000-4000-8000-000000000001`;
  const request = () => new Request(url, { headers: { cookie: "session=synthetic" } });
  const disabled = fixture(new Map([["deals-saves-from-engine", "on"]]));
  assert.equal((await worker.fetch(request(), disabled.env)).status, 404);
  assert.equal(disabled.engine.length, 0);
  assert.deepEqual(disabled.carr, []);

  const enabled = fixture(
    new Map([["deals-from-engine", "on"]]),
    async () =>
      new Response(new Uint8Array([0, 128, 255]), {
        headers: { "content-disposition": 'attachment; filename="Example.pdf"', "content-type": "application/pdf" },
      }),
  );
  const response = await worker.fetch(request(), enabled.env);
  assert.equal(enabled.engine[0]?.url, url);
  assert.equal(enabled.engine[0]?.headers.get("cookie"), "session=synthetic");
  assert.equal(response.headers.get("content-disposition"), 'attachment; filename="Example.pdf"');
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), new Uint8Array([0, 128, 255]));
});

test("deal email decisions use the engine only with both Deals switches on", async () => {
  const id = "00000000-0000-4000-8000-000000000001";
  const key = "00000000-0000-4000-8000-000000000002";
  const decision = call("decide-engine-deal-email", { proposal_id: id, decision: "accept", idempotency_key: key });
  for (const switchKey of ["deals-from-engine", "deals-saves-from-engine"]) {
    const disabled = fixture(new Map([[switchKey, "on"]]));
    const response = await disabled.send(decision);
    assert.equal(disabled.engine.length, 0);
    assert.equal(disabled.carr.length, 0);
    assert.equal((await response.json()).result.isError, true);
  }
  const enabled = fixture("on", async () => Response.json({ proposal_id: id, status: "accepted" }));
  const response = await enabled.send(decision, { origin, cookie: "session=synthetic", "x-carr-csrf": "synthetic" });
  const request = enabled.engine[0];
  assert.ok(request);
  assert.equal(request.url, `${origin}/api/engine/proposals/${id}/decision`);
  assert.equal(request.headers.get("x-carr-csrf"), "synthetic");
  assert.deepEqual(await request.json(), { decision: "accept", idempotency_key: key });
  assert.deepEqual(JSON.parse((await response.json()).result.content[0].text), {
    ok: true,
    proposal_id: id,
    status: "accepted",
  });
  assert.deepEqual(enabled.carr, []);

  const settled = fixture("on", async () => Response.json({ error: "already_decided" }, { status: 409 }));
  const conflict = await (await settled.send(decision)).json();
  assert.equal(conflict.result.isError, true);
  assert.equal(JSON.parse(conflict.result.content[0].text).error, "already_decided");
  assert.deepEqual(settled.carr, []);

  const openStep = fixture("on", async () => Response.json({ error: "open_step_exists" }, { status: 409 }));
  const refusal = await (await openStep.send(decision)).json();
  assert.equal(
    JSON.parse(refusal.result.content[0].text).hint,
    "You already have an open step on this deal. Finish or change it first, or dismiss this suggestion.",
  );

  const unconfirmed = fixture("on", async () => Response.json({ proposal_id: id, status: "dismissed" }));
  assert.equal((await unconfirmed.send(decision)).status, 503);
  assert.deepEqual(unconfirmed.carr, []);
});

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

test("the Deal Room people picker searches engine people before the result limit", async () => {
  const args = { query: "Example & Co" };
  const body = call("search-parties-v1", args);
  const parties = JSON.stringify({
    ok: true,
    schema_version: "party-search.v1",
    parties: [{ id: "synthetic-person", display_name: "Example Person", kind: "person" }],
  });
  const enabled = fixture(new Map([["deals-from-engine", "on"]]), async () => new Response(parties));
  const response = await enabled.send(body);
  assert.equal(enabled.engine[0]?.url, `${origin}/api/engine/parties/search?kind=person&query=Example+%26+Co`);
  assert.equal((await response.json()).result.content[0].text, parties);
  assert.deepEqual(enabled.carr, []);

  const disabled = fixture(new Map([["deals-saves-from-engine", "on"]]));
  assert.equal(await (await disabled.send(body)).text(), "old");
  assert.deepEqual(disabled.carr, [JSON.stringify(body)]);
  assert.deepEqual(disabled.engine, []);
});

for (const deal of ["\ud800", "\udc00"]) {
  test(`unpaired surrogate ${JSON.stringify(deal)} falls back with original body`, async () => {
    const f = fixture(dealsReadOn);
    const body = call("get-deal-room", { deal });
    const response = await f.send(body);
    assert.equal(response.status, 200);
    assert.equal(await response.text(), "old");
    assert.deepEqual(f.carr, [JSON.stringify(body)]);
    assert.equal(f.engine.length, 0);
    assert.deepEqual(f.kv, [
      ["deals-from-engine", { cacheTtl: 30 }],
      ["deals-saves-from-engine", { cacheTtl: 30 }],
    ]);
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
    const f = fixture(dealsReadOn, async () => new Response("down", { status }));
    assert.equal(await (await f.send()).text(), "old");
    assert.deepEqual(f.carr, [JSON.stringify(call())]);
  });
}
test("binding error falls back", async () => {
  const f = fixture(dealsReadOn, async () => {
    throw new Error("unavailable");
  });
  assert.equal(await (await f.send()).text(), "old");
});
test("engine deadline falls back even when binding ignores cancellation", async () => {
  const f = fixture(dealsReadOn, () => new Promise(() => {}));
  assert.equal(await (await f.send()).text(), "old");
  assert.equal(f.carr.length, 1);
});
test("engine body deadline falls back", async () => {
  const f = fixture(dealsReadOn, async () => new Response(new ReadableStream({ start() {} })));
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
    dealsReadOn,
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
    dealsReadOn,
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
  const f = fixture(dealsReadOn, async () => {
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
  ["home-from-engine", "read-home-inbox-v5", "/api/engine/home/inbox"],
  ["invoices-from-engine", "read-invoice-tracker", "/api/engine/invoices"],
  ["charts-from-engine", "ideal-client-profile", "/api/engine/client-fit"],
  ["national-deals-from-engine", "capture-queue", "/api/engine/capture-queue"],
] as const;

test("Home keeps legacy completion and review calls on CARR for their other callers", async () => {
  const f = fixture(new Map([["home-from-engine", "on"]]));
  const bodies = [
    "read-home-inbox-v4",
    "read-home-review",
    "complete-one-action",
    "reopen-one-action",
    "edit-email-draft",
  ].map((name) => call(name));
  for (const body of bodies) assert.equal(await (await f.send(body)).text(), "old");
  assert.deepEqual(
    f.carr,
    bodies.map((body) => JSON.stringify(body)),
  );
  assert.deepEqual(f.engine, []);
});

test("Home refuses old mark writes from a snapshot loaded before the switch", async () => {
  const f = fixture(new Map([["home-from-engine", "on"]]));
  const response = await f.send(
    call("settle-home-inbox", {
      idempotency_key: "4c719df9-2168-4b5a-a26b-95b20376a75f",
      items: [{ item_id: "next_action:00000000-0000-0000-0000-000000000001", base_version: "legacy" }],
    }),
  );
  assert.equal(JSON.parse((await response.json()).result.content[0].text).error, "home_routing_changed");
  assert.equal(f.engine.length + f.carr.length, 0);
});

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
      ...(key === "invoices-from-engine" ? [] : [markPaid]),
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

const markPaidArgs = {
  commission_id: "00000000-0000-4000-8000-000000000001",
  base_version: 0,
  received_on: "2026-10-02",
  idempotency_key: "00000000-0000-4000-8000-000000000002",
};
const markPaid = call("record-commission-receipt", markPaidArgs);
const invoicesOn = new Map([["invoices-from-engine", "on"]]);

test("Mark paid follows the invoice tracker switch", async () => {
  const receipt = { ok: true, id: markPaidArgs.commission_id, received_on: markPaidArgs.received_on, base_version: 1 };
  const f = fixture(invoicesOn, async () => Response.json(receipt));
  const response = await f.send(markPaid, {
    origin,
    cookie: "session=synthetic",
    "sec-fetch-site": "same-origin",
    "x-carr-csrf": "synthetic",
  });
  const request = f.engine[0];
  assert.ok(request, "Mark paid must reach the engine with the invoice switch on");
  assert.equal(request.url, `${origin}/api/engine/invoices/mark-paid`);
  assert.equal(request.method, "POST");
  assert.equal(request.headers.get("cookie"), "session=synthetic");
  assert.equal(request.headers.get("origin"), origin);
  assert.equal(request.headers.get("sec-fetch-site"), "same-origin");
  assert.equal(request.headers.get("x-carr-csrf"), "synthetic");
  assert.deepEqual(await request.json(), markPaidArgs);
  assert.deepEqual(f.kv, [["invoices-from-engine", { cacheTtl: 30 }]]);
  assert.deepEqual(f.carr, []);
  assert.deepEqual((await response.json()).result, { content: [{ type: "text", text: JSON.stringify(receipt) }] });
});

test("Mark paid keeps the original CARR call with the invoice switch off", async () => {
  const f = fixture(new Map([["invoices-from-engine", "off"]]));
  assert.equal(await (await f.send(markPaid)).text(), "old");
  assert.deepEqual(f.carr, [JSON.stringify(markPaid)]);
  assert.deepEqual(f.kv, [["invoices-from-engine", { cacheTtl: 30 }]]);
  assert.deepEqual(f.engine, []);
});

for (const [status, error] of [
  [400, "invalid_field_value"],
  [409, "version_conflict"],
  [409, "key_reuse"],
  [422, "invoice_not_unpaid"],
  [422, "payment_date_out_of_range"],
  [501, "old_system_required"],
  [503, "database_unavailable"],
] as const) {
  test(`Mark paid returns the engine's ${error} without trying CARR`, async () => {
    const refusal = { error };
    const f = fixture(invoicesOn, async () => Response.json(refusal, { status }));
    const response = await f.send(markPaid);
    assert.deepEqual(f.carr, []);
    assert.deepEqual((await response.json()).result, {
      isError: true,
      content: [{ type: "text", text: JSON.stringify(refusal) }],
    });
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

const saveKey = "deal-saves-to-engine";
const savesOn = new Map([[saveKey, "on"]]);
const phaseMove = call("patch-deal-field", {
  deal: "synthetic-deal",
  field: "phase",
  value: "negotiation",
  base_event_id: null,
  idempotency_key: "00000000-0000-4000-8000-000000000001",
});
const saveHeaders = {
  origin,
  cookie: "session=synthetic",
  "sec-fetch-site": "same-origin",
  "x-carr-csrf": "synthetic-token",
};
const answered =
  (text: string, status = 200) =>
  async () =>
    new Response(text, { status });

// The board's closing save, as runOutcomeWrite sends it.
const closing = call("update-deal", {
  deal: "synthetic-deal",
  fields: { outcome: "won", closed_on: "2026-09-30", won_value: 125000 },
  base_version: 7,
  idempotency_key: "00000000-0000-4000-8000-000000000002",
});

for (const save of [phaseMove, closing]) {
  const verb = save.params.name;
  for (const value of [null, "off", new Error("KV failed"), new Map([["deals-from-engine", "on"]])]) {
    test(`save switch off sends ${verb} to the old system (${String(value)})`, async () => {
      const f = fixture(value);
      assert.equal(await (await f.send(save, saveHeaders)).text(), "old");
      assert.deepEqual(f.carr, [JSON.stringify(save)]);
      assert.deepEqual(f.kv, [
        ["deals-saves-from-engine", { cacheTtl: 30 }],
        [saveKey, { cacheTtl: 30 }],
      ]);
      assert.equal(f.engine.length, 0);
    });
  }

  test(`save switch on sends ${verb} with the same arguments and key to the engine with the session headers`, async () => {
    const f = fixture(savesOn, answered('{"ok":true,"updated":["outcome"]}'));
    const response = await f.send(save, saveHeaders);
    assert.equal(f.carr.length, 0);
    const request = f.engine[0];
    assert.ok(request);
    assert.equal(request.url, `${origin}/api/engine/${verb}`);
    assert.equal(request.method, "POST");
    assert.equal(await request.text(), JSON.stringify(save.params.arguments));
    assert.equal(request.headers.get("content-type"), "application/json");
    for (const [key, value] of Object.entries(saveHeaders)) assert.equal(request.headers.get(key), value);
    assert.deepEqual(await response.json(), {
      jsonrpc: "2.0",
      id: "synthetic-request",
      result: { content: [{ type: "text", text: '{"ok":true,"updated":["outcome"]}' }] },
    });
  });

  test(`engine 501 old_system_required sends the original ${verb} to the old system`, async () => {
    const f = fixture(savesOn, answered('{"error":"old_system_required","correlation_id":"c"}', 501));
    assert.equal(await (await f.send(save, saveHeaders)).text(), "old");
    assert.equal(f.engine.length, 1);
    assert.deepEqual(f.carr, [JSON.stringify(save)]);
  });
}

for (const [status, text] of [
  [500, '{"error":"unhandled_verb_failure","verb":"patch-deal-field"}'],
  [503, '{"error":"internal_error"}'],
  [501, '{"error":"not_implemented"}'],
  [409, '{"error":"version_conflict"}'],
  [422, '{"error":"actor_not_provisioned"}'],
  [202, "{}"],
] as const) {
  test(`engine ${status} save answer is surfaced as an old-system refusal and never resent`, async () => {
    const f = fixture(savesOn, answered(text, status));
    const response = await f.send(phaseMove, saveHeaders);
    assert.equal(response.status, 200);
    assert.equal(
      await response.text(),
      JSON.stringify({
        jsonrpc: "2.0",
        id: "synthetic-request",
        result: { isError: true, content: [{ type: "text", text }] },
      }),
    );
    assert.equal(f.carr.length, 0);
  });
}

test("a lost engine save answers like a lost old-system save and is not resent", async () => {
  const lost = fixture(savesOn, async () => {
    throw new Error("connection reset");
  });
  const engineAnswer = await lost.send(phaseMove, saveHeaders);
  assert.equal(lost.carr.length, 0);
  const old = fixture("off");
  old.env.CARR.fetch = async () => {
    throw new Error("connection reset");
  };
  const oldAnswer = await old.send(phaseMove, saveHeaders);
  assert.equal(engineAnswer.status, 503);
  assert.deepEqual([engineAnswer.status, await engineAnswer.text()], [oldAnswer.status, await oldAnswer.text()]);
});

test("a retried save sends the same key to the engine again", async () => {
  const f = fixture(savesOn, answered('{"replayed":true,"ok":true}'));
  await f.send(phaseMove, saveHeaders);
  await f.send(phaseMove, saveHeaders);
  assert.deepEqual(await Promise.all(f.engine.map((request) => request.text())), [
    JSON.stringify(phaseMove.params.arguments),
    JSON.stringify(phaseMove.params.arguments),
  ]);
});

for (const status of [401, 403, 429]) {
  test(`engine ${status} save answer passes through without resending`, async () => {
    const f = fixture(
      savesOn,
      async () => new Response(payload, { status, headers: { "set-cookie": "session=fresh" } }),
    );
    const response = await f.send(phaseMove, saveHeaders);
    assert.equal(response.status, status);
    assert.equal(await response.text(), payload);
    assert.equal(response.headers.get("set-cookie"), "session=fresh");
    assert.equal(f.carr.length, 0);
  });
}

for (const [text, status] of [
  ['{"ok":true,"deal_id":"synthetic-deal","event_id":"e1"}', 200],
  ['{"error":"unhandled_verb_failure","verb":"patch-deal-field"}', 500],
] as const) {
  test(`the screen gets the old system's envelope for the same answer (${status})`, async () => {
    const f = fixture(savesOn, answered(text, status));
    const engineAnswer = await (await f.send(phaseMove, saveHeaders)).text();
    const old = fixture("off");
    // The old system's tools/call reply, as its record layer writes it.
    const result =
      status === 200 ? { content: [{ type: "text", text }] } : { isError: true, content: [{ type: "text", text }] };
    old.env.CARR.fetch = async () => new Response(JSON.stringify({ jsonrpc: "2.0", id: "synthetic-request", result }));
    assert.equal(engineAnswer, await (await old.send(phaseMove, saveHeaders)).text());
  });
}

test("the engine save sets renewed session cookies on the wrapped answer", async () => {
  const f = fixture(savesOn, async () => new Response("{}", { headers: [["set-cookie", "session=fresh"]] }));
  assert.deepEqual((await f.send(phaseMove, saveHeaders)).headers.getSetCookie(), ["session=fresh"]);
});

for (const body of [
  call("patch-deal-field", null),
  call("patch-deal-field", []),
  call("patch-deal-field", {}, { method: "initialize" }),
]) {
  test(`save the engine does not take stays on the old system ${JSON.stringify(body)}`, async () => {
    const f = fixture(savesOn);
    assert.equal(await (await f.send(body, saveHeaders)).text(), "old");
    assert.equal(f.engine.length, 0);
    assert.equal(f.kv.length, 0);
  });
}

const oldReply = (text: string) =>
  JSON.stringify({
    jsonrpc: "2.0",
    id: "synthetic-request",
    result: { isError: true, content: [{ type: "text", text }] },
  });
const oldKeyReuse = oldReply('{"error":"key_reuse","hint":"Use a fresh idempotency_key for changed arguments."}');

test("switch off: an old-system key_reuse goes to the engine, whose replay answers it", async () => {
  const f = fixture("off", answered('{"replayed":true,"ok":true}'));
  f.env.CARR.fetch = async () => new Response(oldKeyReuse);
  const response = await f.send(phaseMove, saveHeaders);
  assert.equal(await f.engine[0]?.text(), JSON.stringify(phaseMove.params.arguments));
  assert.deepEqual(await response.json(), {
    jsonrpc: "2.0",
    id: "synthetic-request",
    result: { content: [{ type: "text", text: '{"replayed":true,"ok":true}' }] },
  });
});

test("switch off: when the engine refuses the key too, the screen gets the old system's refusal", async () => {
  const f = fixture("off", answered('{"error":"key_reuse"}', 409));
  f.env.CARR.fetch = async () => new Response(oldKeyReuse);
  assert.equal(await (await f.send(phaseMove, saveHeaders)).text(), oldKeyReuse);
  assert.equal(f.engine.length, 1);
});

test("switch off: an old-system key_reuse the engine can't answer stays uncertain", async () => {
  const f = fixture("off", async () => {
    throw new Error("connection reset");
  });
  f.env.CARR.fetch = async () => new Response(oldKeyReuse);
  const response = await f.send(phaseMove, saveHeaders);
  assert.deepEqual([response.status, await response.json()], [503, { error: "carr_unavailable" }]);
});

test("switch off: any other old-system refusal never reaches the engine", async () => {
  const refusal = oldReply('{"error":"version_conflict"}');
  const f = fixture("off");
  f.env.CARR.fetch = async () => new Response(refusal);
  assert.equal(await (await f.send(phaseMove, saveHeaders)).text(), refusal);
  assert.equal(f.engine.length, 0);
});

const nextDealsOn = new Map([
  ["deals-from-engine", "on"],
  ["deals-saves-from-engine", "on"],
]);
const dealId = "00000000-0000-4000-8000-000000000030";
const stepId = "00000000-0000-4000-8000-000000000031";
const operationId = "00000000-0000-4000-8000-000000000032";
const marketId = "00000000-0000-4000-8000-000000000033";
const invoiceId = "00000000-0000-4000-8000-000000000034";

test("switching Deals saves on keeps failed board and detail reads away from the old database", async () => {
  const f = fixture(nextDealsOn, async () => new Response("down", { status: 503 }));
  for (const body of [call("deal-room-board"), call("get-deal-room", { deal: dealId })]) {
    const response = await f.send(body);
    assert.equal(response.status, 503);
  }
  assert.equal(f.engine.length, 2);
  assert.equal(f.carr.length, 0);
});

test("invoice Undo sends the reviewed receipt to the signed-in engine", async () => {
  const args = { deal: dealId, invoice_id: invoiceId, seen_change_id: 24, idempotency_key: operationId };
  const f = fixture(nextDealsOn, async () => Response.json({ invoice_id: invoiceId, status: "undone" }));
  const response = await f.send(call("undo-invoice-close", args), saveHeaders);
  assert.equal(f.carr.length, 0);
  assert.equal(f.engine[0]?.url, `${origin}/api/engine/invoice-emails/${invoiceId}/undo`);
  assert.equal(f.engine[0]?.headers.get("x-carr-csrf"), new Headers(saveHeaders).get("x-carr-csrf"));
  assert.deepEqual(await f.engine[0]?.json(), { idempotency_key: operationId });
  assert.equal(JSON.parse((await response.json()).result.content[0].text).ok, true);

  const off = fixture("off");
  const stale = await off.send(call("undo-invoice-close", args), saveHeaders);
  assert.equal(JSON.parse((await stale.json()).result.content[0].text).error, "version_conflict");
  assert.equal(off.engine.length + off.carr.length, 0);

  const moved = fixture(nextDealsOn, async () =>
    Response.json({ error: "database_refused_the_statement", rule: "invoice_email_undo_current" }, { status: 422 }),
  );
  const refusal = await moved.send(call("undo-invoice-close", args), saveHeaders);
  assert.equal(JSON.parse((await refusal.json()).result.content[0].text).error, "version_conflict");
});

test("automatic phase Undo never leaves the app when either Deals switch is off", async () => {
  const args = { deal: dealId, event_id: invoiceId, idempotency_key: operationId };
  for (const switches of [new Map(), dealsReadOn, new Map([["deals-saves-from-engine", "on"]])]) {
    const f = fixture(switches);
    for (const undoArgs of [args, { ...args, seen_change_id: 0 }]) {
      const response = await f.send(call("undo-automatic-phase-move", undoArgs), saveHeaders);
      assert.equal(f.engine.length + f.carr.length, 0);
      const { result } = await response.json();
      assert.equal(result.isError, true);
    }
    const read = await f.send(call());
    if (switches.has("deals-from-engine")) {
      assert.equal((await read.json()).result.content[0].text, payload);
      assert.equal(f.engine.length, 1);
      assert.equal(f.carr.length, 0);
    } else {
      assert.equal(await read.text(), "old");
      assert.equal(f.carr.length, 1);
      assert.equal(f.engine.length, 0);
    }
  }
});

const changesPath = `/deals/${dealId}/changes`;
const creation = {
  next_deal_save: true,
  idempotency_key: operationId,
  name: "Example Lease",
  client_id: stepId,
  owner: "dell",
  phase: "research",
  kind: "lease",
  market_id: marketId,
};

test("Add deal keeps its key, owner and client when the engine replays it", async () => {
  const receipt = { deal_id: dealId, change_id: 24, phase_changed_at: "2026-11-18T12:00:00Z" };
  const switches = new Map(nextDealsOn);
  const f = fixture(switches, answered(JSON.stringify(receipt), 201));
  for (let attempt = 0; attempt < 2; attempt++) {
    const { result } = await (await f.send(call("new-deal", creation), saveHeaders)).json();
    assert.deepEqual(JSON.parse(result.content[0].text), { ...receipt, ok: true });
  }
  const { next_deal_save, ...expected } = creation;
  assert.equal(next_deal_save, true);
  assert.equal(f.engine.length, 2);
  for (const request of f.engine) {
    assert.equal(request.url, `${origin}/api/engine/deals`);
    assert.deepEqual(await request.json(), expected);
  }
  switches.delete("deals-saves-from-engine");
  const { result } = await (await f.send(call("new-deal", creation), saveHeaders)).json();
  assert.equal(result.isError, true);
  assert.deepEqual(f.carr, []);
});

for (const [error, rule, hint] of [
  ["database_refused_the_statement", "deal_party_party_id_fkey", "Choose an existing client."],
  ["database_refused_the_statement", "deal_market_id_fkey", "Choose an existing market."],
  ["deal_name_exists", null, "A deal with this name already exists."],
]) {
  test(`Add deal explains ${rule || error} and leaves the save in the engine`, async () => {
    const f = fixture(nextDealsOn, answered(JSON.stringify({ error, rule }), 422));
    const { result } = await (await f.send(call("new-deal", creation), saveHeaders)).json();
    assert.equal(result.isError, true);
    assert.deepEqual(JSON.parse(result.content[0].text), { error, rule, hint });
    assert.equal(f.engine.length, 1);
    assert.deepEqual(f.carr, []);
  });
}

const movedToEngine = [
  [
    "set-market-agent",
    { agent_party_id: marketId },
    `/deals/${dealId}/parties`,
    { party_id: marketId, role: "market_agent" },
    { deal_id: dealId, party_id: marketId, role: "market_agent" },
    201,
  ],
  [
    "remove-deal-participant",
    { party_id: marketId, role: "market_agent" },
    `/deals/${dealId}/parties/remove`,
    { party_id: marketId, role: "market_agent" },
    { deal_id: dealId, party_id: marketId, role: "market_agent" },
    200,
  ],
  [
    "add-critical-date",
    { kind: "phase_effective_date", due_on: "2027-01-02", source: "Sample agreement", note: "Signed" },
    `/deals/${dealId}/critical-dates`,
    { kind: "phase_effective_date", due_on: "2027-01-02", source: "Sample agreement", note: "Signed" },
    { critical_date_id: stepId, status: "open" },
    201,
  ],
  [
    "confirm-critical-date",
    { critical_date_id: stepId },
    `/critical-dates/${stepId}/confirm`,
    {},
    { critical_date_id: stepId, status: "open" },
    200,
  ],
  ...["done", "dropped", "passed"].map(
    (resolution) =>
      [
        "resolve-critical-date",
        { critical_date_id: stepId, resolution, reason: "Sample decision" },
        `/critical-dates/${stepId}/resolve`,
        { resolution, reason: "Sample decision" },
        { critical_date_id: stepId, status: resolution },
        200,
      ] as const,
  ),
  ...[
    [
      { outcome: "won", closed_on: "2026-11-18", won_value: 125000 },
      { phase: { from: "closing", to: "closed", on: "2026-11-18" }, fields: { closed_value: 125000 } },
    ],
    [{ outcome: "won", closed_on: "2026-11-18" }, { phase: { from: "closing", to: "closed", on: "2026-11-18" } }],
    [
      { outcome: "lost", closed_on: "2026-11-18", lost_reason: "The client chose another site" },
      { phase: { from: "closing", to: "dead", on: "2026-11-18", reason: "The client chose another site" } },
    ],
  ].map(
    ([fields, expected]) =>
      [
        "update-deal",
        { fields, phase_from: "closing" },
        changesPath,
        { seen_change_id: 23, ...expected },
        { deal_id: dealId, change_id: 24 },
        200,
      ] as const,
  ),
  [
    "patch-deal-field",
    { field: "phase", value: "negotiation", phase_from: "research" },
    changesPath,
    { seen_change_id: 23, phase: { from: "research", to: "negotiation" } },
    { deal_id: dealId, change_id: 23 },
    200,
  ],
  [
    "patch-deal-field",
    { field: "owner", value: "dell" },
    changesPath,
    { seen_change_id: 23, fields: { owner: "dell" } },
    { deal_id: dealId, change_id: 24 },
    200,
  ],
  ...[marketId, null].map(
    (value) =>
      [
        "patch-deal-field",
        { field: "market", value },
        changesPath,
        { seen_change_id: 23, fields: { market_id: value } },
        { deal_id: dealId, change_id: 24 },
        200,
      ] as const,
  ),
  [
    "set-next-step",
    { text: "Review sample plan", next_date: "2027-01-02" },
    "/next-steps",
    { deal_id: dealId, what: "Review sample plan", due_on: "2027-01-02", replaces: "current" },
    { next_step_id: stepId, change_id: 25 },
    201,
  ],
  [
    "complete-deal-item",
    { item_id: stepId, base_version: 0 },
    `/next-steps/${stepId}/end`,
    { resolution: "done", base_version: 0 },
    { next_step_id: stepId, status: "done" },
    200,
  ],
  [
    "patch-deal-field",
    { field: "operating_state", value: { state: "parked", reason: "other", note: "Sample pause" } },
    changesPath,
    { seen_change_id: 23, fields: { parking_reason: "other", parking_note: "Sample pause" } },
    { deal_id: dealId, change_id: 24 },
    200,
  ],
  [
    "add-deal-note",
    { text: "A sample update", happened_at: "2026-11-18T12:00:00Z" },
    "/activities",
    { kind: "note", summary: "A sample update", happened_at: "2026-11-18T12:00:00Z", about: [{ deal_id: dealId }] },
    { activity_id: stepId },
    201,
  ],
  [
    "record-deal-item",
    { title: "Review plan", bullets: [], source_ref: "app:example" },
    "/next-steps",
    { deal_id: dealId, what: "Review plan", item: { title: "Review plan", bullets: [], source_ref: "app:example" } },
    { next_step_id: stepId, change_id: 25 },
    201,
  ],
] as const;

for (const [verb, args, path, expected, receipt, status] of movedToEngine) {
  test(`Deals cutover routes ${verb} ${path} once per attempt and keeps its key on retry`, async () => {
    const { phase_from, base_version, ...legacy } = { phase_from: undefined, base_version: undefined, ...args };
    const base = { deal: dealId, idempotency_key: operationId, ...legacy };
    const before = call(verb, base);
    const off = fixture(null);
    await off.send(before, saveHeaders);
    assert.deepEqual(off.carr, [JSON.stringify(before)]);
    assert.equal(off.engine.length, 0);
    const on = fixture(nextDealsOn, answered(JSON.stringify(receipt), status));
    const save = call(verb, { ...base, seen_change_id: 23, ...(phase_from && { phase_from }), base_version });
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = (await (await on.send(save, saveHeaders)).json()).result;
      assert.deepEqual(JSON.parse(result.content[0].text), { ...receipt, ok: true });
    }
    assert.deepEqual(on.carr, []);
    assert.equal(on.engine.length, 2);
    for (const request of on.engine) {
      assert.equal(request.url, `${origin}/api/engine${path}`);
      assert.equal(request.method, "POST");
      assert.deepEqual(await request.json(), { idempotency_key: operationId, ...expected });
      for (const [key, value] of Object.entries(saveHeaders)) assert.equal(request.headers.get(key), value);
    }
  });
}

test("Deals cutover refuses to complete an item without a valid step version", async () => {
  const f = fixture(nextDealsOn);
  for (const base_version of [undefined, null, -1, 3.5, "7", Number.MAX_SAFE_INTEGER + 1]) {
    const save = call("complete-deal-item", {
      deal: dealId,
      item_id: stepId,
      seen_change_id: 23,
      idempotency_key: operationId,
      base_version,
    });
    const { result } = await (await f.send(save, saveHeaders)).json();
    assert.equal(result.isError, true);
    assert.equal(JSON.parse(result.content[0].text).error, "version_conflict");
  }
  assert.deepEqual(f.engine, []);
  assert.deepEqual(f.carr, []);
});

test("Deals cutover refuses a bare market agent name before sending a write", async () => {
  const f = fixture(nextDealsOn);
  const save = call("set-market-agent", {
    deal: dealId,
    seen_change_id: 23,
    idempotency_key: operationId,
    agent_name: "Sample Agent",
  });
  const { result } = await (await f.send(save, saveHeaders)).json();
  assert.equal(result.isError, true);
  assert.equal(JSON.parse(result.content[0].text).hint, "Choose an existing person as the market agent.");
  assert.deepEqual(f.engine, []);
  assert.deepEqual(f.carr, []);
});

test("a successful HTTP response with the wrong date status leaves the outcome unknown", async () => {
  const f = fixture(nextDealsOn, answered(JSON.stringify({ critical_date_id: stepId, status: "open" })));
  const save = call("resolve-critical-date", {
    deal: dealId,
    seen_change_id: 23,
    idempotency_key: operationId,
    critical_date_id: stepId,
    resolution: "done",
    reason: "Sample decision",
  });
  const response = await f.send(save, saveHeaders);
  assert.deepEqual([response.status, await response.json()], [503, { error: "carr_unavailable" }]);
  assert.deepEqual(f.carr, []);
});

for (const [verb, args] of [
  ["set-lead", { new_lead: "dell" }],
  ["add-deal-participant", { party_id: marketId, role: "listing_side" }],
] as const) {
  test(`Deals cutover does not route ${verb} to the engine`, async () => {
    const f = fixture(nextDealsOn);
    const save = call(verb, { ...args, deal: dealId, seen_change_id: 23, idempotency_key: operationId });
    assert.equal(await (await f.send(save, saveHeaders)).text(), "old");
    assert.deepEqual(f.engine, []);
  });
}

test("Deals cutover explains a refused critical date decision", async () => {
  const f = fixture(
    nextDealsOn,
    answered('{"error":"database_refused_the_statement","rule":"critical_date_status_moves"}', 422),
  );
  const save = call("resolve-critical-date", {
    deal: dealId,
    seen_change_id: 23,
    idempotency_key: operationId,
    critical_date_id: stepId,
    resolution: "passed",
    reason: "Sample decision",
  });
  const { result } = await (await f.send(save, saveHeaders)).json();
  assert.equal(result.isError, true);
  assert.equal(JSON.parse(result.content[0].text).hint, "This date cannot be marked that way.");
  assert.deepEqual(f.carr, []);
});

test("Deals cutover forwards a stale phase refusal and never tries CARR", async () => {
  const f = fixture(nextDealsOn, answered('{"error":"version_conflict","current_phase":"legal"}', 409));
  const save = call("patch-deal-field", {
    deal: dealId,
    field: "phase",
    value: "negotiation",
    phase_from: "research",
    seen_change_id: 23,
    idempotency_key: operationId,
  });
  const { result } = await (await f.send(save, saveHeaders)).json();
  assert.equal(result.isError, true);
  assert.deepEqual(JSON.parse(result.content[0].text), {
    error: "version_conflict",
    current_phase: "legal",
    hint: "This deal changed. Reload the deal before saving.",
  });
  assert.equal(f.engine.length, 1);
  assert.deepEqual(f.carr, []);
});

for (const verb of ["new-deal", "set-market-agent", "update-deal"]) {
  test(`Deals cutover refuses ${verb} while the signed-in save is unavailable`, async () => {
    const f = fixture(nextDealsOn);
    const { result } = await (
      await f.send(call(verb, { deal: dealId, idempotency_key: operationId }), saveHeaders)
    ).json();
    assert.equal(result.isError, true);
    assert.deepEqual(f.carr, []);
    assert.deepEqual(f.engine, []);
  });
}

test("an unanswered next-schema save never retries in CARR after the switch turns off", async () => {
  const switches = new Map(nextDealsOn);
  const f = fixture(switches, answered('{"error":"database_unavailable"}', 503));
  const save = call("set-next-step", {
    deal: dealId,
    seen_change_id: 23,
    idempotency_key: operationId,
    text: "Review sample plan",
  });
  assert.equal((await f.send(save, saveHeaders)).status, 503);
  switches.delete("deals-saves-from-engine");
  const { result } = await (await f.send(save, saveHeaders)).json();
  assert.equal(result.isError, true);
  assert.equal(f.engine.length, 1);
  assert.deepEqual(f.carr, []);
});

test("the new save switch refuses saves loaded before the read cutover", async () => {
  const f = fixture(nextDealsOn);
  const save = call("set-next-step", {
    deal: dealId,
    base_version: 2,
    idempotency_key: operationId,
    text: "Review sample plan",
  });
  const { result } = await (await f.send(save, saveHeaders)).json();
  assert.equal(result.isError, true);
  assert.equal(JSON.parse(result.content[0].text).error, "version_conflict");
  assert.deepEqual(f.engine, []);
  assert.deepEqual(f.carr, []);
});

test("the Home switch gates the single-card engine marks door", async () => {
  const args = {
    idempotency_key: "4c719df9-2168-4b5a-a26b-95b20376a75f",
    item_id: "next_action:00000000-0000-0000-0000-000000000001",
    base_version: "2147483648:0:inbox",
    action: "snooze",
    until: "2099-01-01T00:00:00Z",
  };
  const refused = { error: "version_conflict", current_version: "2147483649:0:inbox" };
  const f = fixture(new Map([["home-from-engine", "on"]]), async () => Response.json(refused, { status: 409 }));
  const response = await f.send(call("save-engine-home-mark", args));
  assert.equal(f.carr.length, 0);
  const [request] = f.engine;
  assert.ok(request);
  assert.equal(new URL(request.url).pathname, "/api/engine/home/marks");
  assert.deepEqual(await request.json(), args);
  assert.equal(request.headers.get("cookie"), "session=synthetic");
  assert.deepEqual((await response.json()).result, {
    isError: true,
    content: [{ type: "text", text: JSON.stringify(refused) }],
  });
  const off = fixture(null);
  const offReply = await off.send(call("save-engine-home-mark", args));
  assert.equal((await offReply.json()).result.isError, true);
  assert.equal(off.engine.length + off.carr.length, 0);
});

test("Home identifies a successful engine snapshot for the app's save routing", async () => {
  const f = fixture(new Map([["home-from-engine", "on"]]), async () =>
    Response.json({ ok: true, schema_version: "home-inbox.v5", items: [] }),
  );
  const reply = await (await f.send(call("read-home-inbox-v5"))).json();
  assert.equal(JSON.parse(reply.result.content[0].text).engine_marks, true);
});

test("the Home switch routes guarded step and review actions through signed-in engine doors", async () => {
  const id = "00000000-0000-0000-0000-000000000001";
  const f = fixture(new Map([["home-from-engine", "on"]]), async () => Response.json({ success: true }));
  const step = { idempotency_key: id, base_version: 2147483648, resolution: "done" };
  await f.send(call("end-engine-home-step", { id, ...step }));
  await f.send(call("read-engine-home-proposal", { id }));
  await f.send(call("decide-engine-home-proposal", { id, idempotency_key: id, decision: "accept" }));
  await f.send(call("read-engine-home-draft", { id }));
  await f.send(
    call("edit-engine-home-draft", { id, idempotency_key: id, version: 2, subject: "Example", body: "Example reply" }),
  );
  assert.deepEqual(
    f.engine.map((request) => [request.method, new URL(request.url).pathname]),
    [
      ["POST", `/api/engine/next-steps/${id}/end`],
      ["GET", `/api/engine/proposals/${id}`],
      ["POST", `/api/engine/proposals/${id}/decision`],
      ["GET", `/api/engine/reply-drafts/${id}`],
      ["POST", `/api/engine/reply-drafts/${id}/edit`],
    ],
  );
  assert.deepEqual(await f.engine[0]?.json(), step);
  assert.deepEqual(f.carr, []);
});

test("switched Mail priorities use the engine's unfiltered read", async () => {
  const result = { ok: true, schema_version: "home-mail-priorities.v1", items: [], more: false };
  const f = fixture(new Map([["home-from-engine", "on"]]), async () => Response.json(result));
  const request = new Request(`${origin}/api/v1/intelligence/mail-needs-partner?limit=25`, {
    headers: { cookie: "session=synthetic" },
  });
  assert.deepEqual(await (await worker.fetch(request, f.env)).json(), result);
  assert.equal(f.engine[0]?.url, `${origin}/api/engine/home/mail-priorities`);
  assert.equal(f.engine[0]?.headers.get("cookie"), "session=synthetic");
  assert.deepEqual(f.carr, []);
  const off = fixture(null);
  assert.equal(await (await worker.fetch(request, off.env)).text(), "old");
  assert.equal(off.engine.length, 0);
});

test("client website setup and opening use their Deals switches without changing the legacy save", async () => {
  const deal = "00000000-0000-4000-8000-000000000001";
  const path = `/api/engine/deals/${deal}/client-website`;
  const args = { slug: "example-website", password: "synthetic-password", idempotency_key: deal };
  for (const [reads, saves] of [
    [false, false],
    [false, true],
    [true, false],
    [true, true],
  ]) {
    const f = fixture(
      new Map([
        ["deals-from-engine", reads ? "on" : "off"],
        ["deals-saves-from-engine", saves ? "on" : "off"],
      ]),
    );
    const headers = {
      origin,
      cookie: "session=synthetic",
      "x-carr-csrf": "synthetic",
      "content-type": "application/json",
    };
    const setup = await worker.fetch(
      new Request(origin + path, { method: "POST", headers, body: JSON.stringify(args) }),
      f.env,
    );
    const open = await worker.fetch(
      new Request(origin + path + "/open", { method: "POST", headers, body: "{}" }),
      f.env,
    );
    assert.equal(setup.status, reads && saves ? 200 : 404);
    assert.equal(open.status, reads ? 200 : 404);
    assert.deepEqual(
      f.engine.map((request) => new URL(request.url).pathname),
      [...(reads && saves ? [path] : []), ...(reads ? [path + "/open"] : [])],
    );
    if (reads && saves) assert.deepEqual(await f.engine[0]?.json(), args);
    if (reads) {
      assert.deepEqual(await f.engine.at(-1)?.json(), {});
      assert.equal(f.engine.at(-1)?.headers.get("x-carr-csrf"), "synthetic");
    }
    assert.deepEqual(f.carr, []);
    if (!reads && !saves) {
      const legacy = call("register-client-portal", { deal, ...args });
      assert.equal(await (await f.send(legacy, headers)).text(), "old");
      assert.deepEqual(f.carr, [JSON.stringify(legacy)]);
    }
  }
});

test("national account creation and owner changes follow the Deals switches", async () => {
  const account = "00000000-0000-4000-8000-000000000011";
  const key = "00000000-0000-4000-8000-000000000012";
  for (const [name, oldArgs, path, body] of [
    [
      "create-national-account",
      { name: "Demo Separate Company", owner: "dell" },
      "/national-accounts",
      { name: "Demo Separate Company", owner: "dell", force_new: true },
    ],
    [
      "create-national-account",
      { name: "Demo Matching Company", owner: "dell" },
      "/national-accounts",
      { name: "Demo Matching Company", owner: "dell", company_id: account },
    ],
    [
      "set-national-account-owner",
      { account_client_id: account, owner: "dell", base_version: 0 },
      `/national-accounts/${account}/owner`,
      { owner: "dell", base_version: 0 },
    ],
  ] as const) {
    const legacy = call(name, { ...oldArgs, idempotency_key: key });
    const off = fixture(new Map());
    assert.equal(await (await off.send(legacy)).text(), "old");
    assert.deepEqual(
      off.carr.map((text) => JSON.parse(text)),
      [legacy],
    );
    assert.equal(off.engine.length, 0);

    const next = call(name, { ...oldArgs, ...body, idempotency_key: key, next_deal_save: true });
    for (const routing of [new Map(), dealsReadOn, new Map([["deals-saves-from-engine", "on"]])]) {
      const partial = fixture(routing);
      assert.equal((await (await partial.send(next)).json()).result.isError, true);
      assert.equal(partial.engine.length, 0);
      assert.deepEqual(partial.carr, []);
    }

    const on = fixture("on", async () => Response.json({ account_client_id: account, owner: "dell" }));
    const response = await on.send(next, { origin, cookie: "session=synthetic", "x-carr-csrf": "synthetic" });
    assert.deepEqual(on.carr, []);
    assert.equal(on.engine[0]?.url, `${origin}/api/engine${path}`);
    assert.equal(on.engine[0]?.headers.get("x-carr-csrf"), "synthetic");
    assert.deepEqual(await on.engine[0]?.json(), { ...body, idempotency_key: key });
    assert.deepEqual(JSON.parse((await response.json()).result.content[0].text), {
      ok: true,
      account_client_id: account,
      owner: "dell",
    });
  }
});

test("an existing company name asks for separate-company confirmation", async () => {
  const candidates = [{ id: "00000000-0000-4000-8000-000000000013", name: "Demo Matching Company" }];
  const on = fixture("on", async () => Response.json({ error: "account_name_exists", candidates }, { status: 409 }));
  const response = await on.send(
    call("create-national-account", {
      next_deal_save: true,
      idempotency_key: "00000000-0000-4000-8000-000000000012",
      name: candidates[0]?.name,
      owner: "joe",
    }),
  );
  const result = (await response.json()).result;
  assert.equal(result.isError, undefined);
  assert.deepEqual(JSON.parse(result.content[0].text).candidates, candidates);
  assert.equal(JSON.parse(result.content[0].text).needs_confirm, true);
});

test("market-deal choices and saves use the new engine behind the Deals switches", async () => {
  const [account, market, location, deal, key] = [1, 2, 3, 4, 5].map(
    (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
  );
  const oldArgs = {
    account_client_id: account,
    client_name: "Demo Existing Location",
    deal_name: "Demo Metro Office",
    market: "Demo Metro",
    idempotency_key: key,
  };
  const name = "create-national-market-deal";
  const next = {
    next_deal_save: true,
    account_client_id: account,
    name: "Demo Metro Office",
    market_id: market,
    client_id: location,
    owner: "joe",
    phase: "pending",
    reason: "start_up",
    idempotency_key: key,
  };
  const paths = ["/api/engine/markets", `/api/engine/national-accounts/${account}/locations`];
  for (const path of paths) {
    const request = () => new Request(origin + path, { headers: { cookie: "session=synthetic" } });
    const off = fixture(new Map());
    assert.equal((await worker.fetch(request(), off.env)).status, 404);
    assert.deepEqual(off.engine, []);
    const on = fixture(dealsReadOn);
    assert.equal((await worker.fetch(request(), on.env)).status, 200);
    assert.equal(on.engine[0]?.url, origin + path);
    assert.equal(on.engine[0]?.headers.get("cookie"), "session=synthetic");
  }
  const off = fixture(new Map());
  assert.equal(await (await off.send(call(name, oldArgs))).text(), "old");
  assert.deepEqual(
    off.carr.map((text) => JSON.parse(text)),
    [call(name, oldArgs)],
  );
  assert.deepEqual(off.engine, []);
  const readsOnly = fixture(dealsReadOn);
  assert.equal((await (await readsOnly.send(call(name, next))).json()).result.isError, true);
  assert.deepEqual(readsOnly.carr, []);
  assert.deepEqual(readsOnly.engine, []);
  const on = fixture("on", async () => Response.json({ deal_id: deal, change_id: 0 }, { status: 201 }));
  const reply = await (await on.send(call(name, next))).json();
  assert.equal(reply.result.isError, undefined);
  assert.equal(JSON.parse(reply.result.content[0].text).deal_id, deal);
  assert.equal(on.engine[0]?.url, origin + "/api/engine/deals");
  assert.deepEqual(await on.engine[0]?.json(), {
    national_account_id: account,
    name: next.name,
    market_id: market,
    client_id: location,
    owner: "joe",
    phase: "pending",
    reason: "start_up",
    idempotency_key: key,
  });
});
