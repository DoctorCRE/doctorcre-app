import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { carrContractIdentity } from "./carr-contract.mjs";
import { FixtureHtmlRewriter } from "./fixtures/worker-html.ts";

Object.defineProperty(globalThis, "HTMLRewriter", { configurable: true, value: FixtureHtmlRewriter });

test('only the tour editor allows same-origin workspace framing', async () => {
  for (const path of ['/tours/route-editor.html','/tours','/deals']) {
    const response = await handleDoctorcreRequest(request(path,{headers:{cookie:'__Host-dealroom_session=opaque'}}),environment({
      carr:{fetch:async () => new Response('ok')},assets:{fetch:async () => new Response('asset')},
    }));
    assert.equal(response.headers.get('x-frame-options'),path === '/tours/route-editor.html' ? 'SAMEORIGIN' : 'DENY');
    assert.ok(response.headers.get('content-security-policy').includes(`frame-ancestors '${path === '/tours/route-editor.html' ? 'self' : 'none'}'`));
  }
});

test('blocking 1: shared map modules, CSS and derived worker URLs pass through deployed asset routing',async()=>{
 const css='/tours/vendor/maplibre-gl-6.4.1/maplibre-gl.css';
 const module=new URL('/tours/vendor/maplibre-gl-6.4.1/maplibre-gl.mjs','https://example.test');
 for(const path of ['/js/leads-territory-map.js','/js/market-map-shell.js',new URL(css,'https://example.test/').pathname,module.pathname,new URL('maplibre-gl-shared.mjs',module).pathname,new URL('maplibre-gl-worker.mjs',module).pathname]){
 let calls=0;const response=await handleDoctorcreRequest(request(path),environment({assets:{fetch:async()=>{calls++;return new Response('asset')}}}));
 assert.equal(response.status,200,path);assert.equal(calls,1,path);
 }
});

import { handleDoctorcreRequest } from "../src/worker.js";
import { routeContract } from "../js/routes.js";

const HOST = "doctorcre-app-staging.joe-bookout-carr-us.workers.dev";
const request = (path, init) => new Request(`https://${HOST}${path}`, init);

test('Invoices use an admitted gate and restore the original sign-in deep link', async () => {
  for (const outcome of [200, 302, 403]) {
    let forwarded, assets = 0;
    const response = await handleDoctorcreRequest(request('/invoices?invoice=demo', {headers:{cookie:'session=opaque'}}), environment({
      carr:{fetch:async value=>{forwarded=value;return new Response(null,{status:new URL(value.url).pathname==='/business'?outcome:404,headers:outcome===302?{location:request('/auth/login?return_to=%2Fbusiness').url}:{}});}},
      assets:{fetch:async value=>{assets++;return new Response(`asset:${new URL(value.url).pathname}`);}}
    }));
    assert.equal(response.status,outcome); assert.equal(new URL(forwarded.url).pathname,'/business');
    assert.equal(forwarded.headers.get('cookie'),'session=opaque'); assert.equal(assets,outcome===200?1:0);
    if(outcome===200)assert.equal(await response.text(),'asset:/invoices.html');
    if(outcome===302)assert.equal(new URL(response.headers.get('location')).searchParams.get('return_to'),'/invoices?invoice=demo');
  }
});

function environment({ carr, assets } = {}) {
  return {
    APP_ENV: "staging",
    GIT_SHA: "1".repeat(40),
    CF_VERSION_METADATA: { id: "version-one", tag: "staging-one", timestamp: "2026-09-14T00:00:00Z" },
    CARR: carr,
    ASSETS: assets || { fetch: async (assetRequest) => new Response(`asset:${new URL(assetRequest.url).pathname}`) },
  };
}

test("protected documents use CARR as the auth gate and serve DoctorCRE-owned assets", async () => {
  let forwarded;
  const env = environment({ carr: { fetch: async (value) => {
    forwarded = value;
    return new Response("transitional CARR asset", { headers: { "set-cookie": "__Host-dealroom_session=fresh; Path=/; Secure; HttpOnly; SameSite=Lax" } });
  } } });
  const response = await handleDoctorcreRequest(request("/leads?owner=joe", { headers: { cookie: "__Host-dealroom_session=opaque" } }), env);
  assert.equal(await response.text(), "asset:/leads.html");
  assert.equal(new URL(forwarded.url).pathname, "/leads");
  assert.equal(forwarded.redirect, "manual");
  assert.equal(forwarded.headers.get("cookie"), "__Host-dealroom_session=opaque");
  assert.match(response.headers.get("set-cookie"), /__Host-dealroom_session=fresh/);
  assert.match(response.headers.get("content-security-policy"), /default-src 'self'/);
});

test("auth redirects and API refusals pass through without exposing a second authority path", async () => {
  const redirect = await handleDoctorcreRequest(request("/"), environment({
    carr: { fetch: async () => new Response(null, { status: 302, headers: { location: `https://${HOST}/auth/login?return_to=%2F` } }) },
  }));
  assert.equal(redirect.status, 302);
  assert.equal(redirect.headers.get("location"), `https://${HOST}/auth/login?return_to=%2F`);

  let forwarded;
  const refusal = await handleDoctorcreRequest(request("/mcp", { method: "POST", body: "{}" }), environment({
    carr: { fetch: async (value) => { forwarded = value; return new Response('{"error":"unauthorized"}', { status: 401 }); } },
  }));
  assert.equal(refusal.status, 401);
  assert.equal(forwarded.method, "POST");
  assert.equal(await forwarded.text(), "{}");

  for (const path of ["/api/call-context", "/api/post-call?session=S-1"]) {
    const response = await handleDoctorcreRequest(request(path), environment({
      carr: { fetch: async () => new Response("proxied") },
    }));
    assert.equal(await response.text(), "proxied");
  }
});

test("CARR outages fail closed and never substitute cached business data", async () => {
  const env = environment({ carr: { fetch: async () => { throw new Error("offline"); } } });
  const document = await handleDoctorcreRequest(request("/deals"), env);
  assert.equal(document.status, 503);
  assert.match(await document.text(), /No cached business data/);
  const api = await handleDoctorcreRequest(request("/api/v1/command-center"), env);
  assert.equal(api.status, 503);
  assert.deepEqual(await api.json(), { error: "carr_unavailable" });
});

test("public assets bypass CARR, while unknown and mutation routes fail closed", async () => {
  let carrCalls = 0;
  const env = environment({ carr: { fetch: async () => { carrCalls += 1; return new Response(); } } });
  assert.equal(await (await handleDoctorcreRequest(request("/js/app.js"), env)).text(), "asset:/js/app.js");
  assert.equal(await (await handleDoctorcreRequest(request("/icons/dealroom.svg"), env)).text(), "asset:/public-shell/icons/dealroom.svg");
  assert.equal(await (await handleDoctorcreRequest(request("/favicon.ico"), env)).text(), "asset:/public-shell/icons/dealroom.svg");
  assert.equal(await (await handleDoctorcreRequest(request("/public-shell/shell.css"), env)).text(), "asset:/public-shell/shell.css");
  assert.equal(carrCalls, 0);
  assert.equal((await handleDoctorcreRequest(request("/unknown"), env)).status, 404);
  assert.equal((await handleDoctorcreRequest(request("/leads", { method: "POST" }), env)).status, 405);
});

test("the independent status page is served without a CARR call", async () => {
  let carrCalls = 0;
  const env = environment({ carr: { fetch: async () => { carrCalls += 1; return new Response(); } } });
  assert.equal(await (await handleDoctorcreRequest(request("/status"), env)).text(), "asset:/status.html");
  assert.equal(carrCalls, 0, "the status page must not consult CARR");
  assert.equal((await handleDoctorcreRequest(request("/status", { method: "POST" }), env)).status, 405);
  assert.equal(carrCalls, 0);
  assert.equal((await handleDoctorcreRequest(request("/leads", { method: "POST" }), env)).status, 405);
});

test("Closing anniversaries uses the admitted Business gate and preserves the sign-in return path", async () => {
  let forwarded;
  const response = await handleDoctorcreRequest(request("/leases?quarter=2027-Q1", {
    headers: { cookie: "__Host-dealroom_session=opaque" },
  }), environment({ carr: { fetch: async value => { forwarded = value; return new Response(); } } }));
  assert.equal(await response.text(), "asset:/lease-anniversaries.html");
  assert.equal(new URL(forwarded.url).pathname, "/business");
  assert.equal(new URL(forwarded.url).search, "");
  assert.equal(forwarded.headers.get("cookie"), "__Host-dealroom_session=opaque");
  const signedOut = await handleDoctorcreRequest(request("/leases?quarter=2027-Q1"), environment({
    carr: { fetch: async () => new Response(null, { status: 302, headers: {
      location: `https://${HOST}/auth/login?return_to=%2Fbusiness`,
    } }) },
  }));
  assert.equal(new URL(signedOut.headers.get("location")).searchParams.get("return_to"), "/leases?quarter=2027-Q1");
});

test("the retired lease radar API returns 404 without reaching CARR", async () => {
  const forwarded = [];
  const response = await handleDoctorcreRequest(request("/api/v1/business/leases?scope=team", {
    headers: { cookie: "__Host-dealroom_session=opaque" },
  }), environment({ carr: { fetch: async value => {
    forwarded.push(value.url);
    return new Response("old lease radar");
  } } }));
  assert.equal(response.status, 404);
  assert.deepEqual(forwarded, []);
});

test('retired tour report routes stay closed with CARR sign-in and engine deal saves', async () => {
  const env = {
    ...environment({
      carr: { fetch: async () => new Response('legacy tour response') },
    }),
    PARTNER_SIGN_IN: 'carr',
    ENGINE_ROUTING: { get: async () => 'on' },
  };
  for (const path of ['/api/tours/projection', '/api/tours/projection/candidates',
    '/api/tours/pdf/preview', '/api/tours/pdf/download', '/api/tours/feedback',
    '/share', '/api/share/report']) {
    assert.equal((await handleDoctorcreRequest(request(path), env)).status, 404, path);
  }
  for (const path of ['/api/tours/projection', '/api/tours/projection/seal', '/api/tours/pdf/render',
    '/api/tours/pdf/review', '/api/tours/share/issue', '/api/tours/share/rotate', '/api/tours/share/revoke']) {
    assert.equal((await handleDoctorcreRequest(request(path, { method: 'POST' }), env)).status, 409, path);
  }
  env.ENGINE_ROUTING = { get: async () => null };
  const oldSave = await handleDoctorcreRequest(request('/api/tours/projection', { method: 'POST' }), env);
  assert.equal(oldSave.status, 404);
  for (const path of ['/api/tours/library', '/api/tours/detail', '/api/tours/property-evidence/v1']) {
    assert.equal(await (await handleDoctorcreRequest(request(path), env)).text(), 'legacy tour response');
  }
});

test("release identity is explicit", async () => {
  const release = await (await handleDoctorcreRequest(request("/app-release"), environment())).json();
  assert.deepEqual(release, {
    service: "doctorcre-app", environment: "staging", source_commit: "1".repeat(40),
    provider_version_id: "version-one", provider_version_tag: "staging-one",
    provider_version_created_at: "2026-09-14T00:00:00Z",
    carr_contract: carrContractIdentity,
    route_contract: { schema: routeContract.schema, version: routeContract.version },
  });
});


test("app failures retain the generic response without invoking an unsupported sink", async () => {
  let captures = 0;
  const env = environment({ assets: { fetch: async () => { throw new Error("synthetic private detail"); } } });
  env.CARR_ERRORS = { capture: async () => { captures++; } };
  const response = await handleDoctorcreRequest(request("/js/app.js"), env);
  assert.equal(response.status, 500);
  assert.deepEqual(await response.json(), { error: "internal_error" });
  assert.equal(captures, 0);
});

test('client portal uses the existing authenticated business gate and restores its own sign-in return', async () => {
  for (const status of [200, 302, 403]) {
    let forwarded, assets = 0;
    const response = await handleDoctorcreRequest(request('/client-portal'), environment({
      carr: { fetch: async value => {
        forwarded = value;
        return new Response(null, { status, headers: status === 302 ? { location: request('/auth/login?return_to=%2Fbusiness').url } : {} });
      } },
      assets: { fetch: async value => { assets++; return new Response(new URL(value.url).pathname); } },
    }));
    assert.equal(new URL(forwarded.url).pathname, '/business');
    assert.equal(response.status, status);
    assert.equal(assets, status === 200 ? 1 : 0);
    if (status === 200) assert.equal(await response.text(), '/client-portal.html');
    if (status === 302) assert.equal(new URL(response.headers.get('location')).searchParams.get('return_to'), '/client-portal');
  }
});

test('phone capture ships behind the existing partner gate with narrowly scoped microphone permission', async () => {
  const env = environment({ carr: { fetch: async value => new Response(null, { status: new URL(value.url).pathname === '/business' ? 200 : 404 }) } });
  const response = await handleDoctorcreRequest(request('/calls?session=synthetic'), env);
  assert.equal(response.status, 200);
  assert.equal(await response.text(), 'asset:/calls.html');
  assert.match(response.headers.get('permissions-policy'), /microphone=\(self\)/);
  assert.match(response.headers.get('content-security-policy'), /media-src 'self' blob:/);
  const home = await handleDoctorcreRequest(request('/css/app-shell.css'), env);
  assert.match(home.headers.get('permissions-policy'), /microphone=\(\)/);
});

test('switched linked routes serve guidance through their existing auth gates', async () => {
  for (const [path, key, oldAsset, newAsset, links] of [
    ['/review-workflows?email=example#homeEmailFollowups', null, 'review-workflows', 'review-workflows-moved', ['/', '/deals', '/calendar']],
    ['/leases?lease=example', 'deals-saves-from-engine', 'lease-anniversaries', 'lease-anniversaries', []],
    ['/client-portal?slug=example', 'deals-saves-from-engine', 'client-portal', 'client-website-moved', ['/deals']],
  ]) {
    for (const on of [false, true]) {
      const env = {
        ...environment({ carr: { fetch: async () => new Response(null) } }),
        ...(key === null && { APP_ENV: on ? 'production' : 'fixture' }),
        ENGINE_ROUTING: { get: async name => name === key ? (on ? 'on' : 'off') : null },
      };
      const response = await handleDoctorcreRequest(request(path, { method: 'HEAD' }), env);
      assert.equal(response.status, 200, path);
      assert.equal(await response.text(), `asset:/${on ? newAsset : oldAsset}.html`, path);
    }
    const html = await readFile(new URL(`../${newAsset}.html`, import.meta.url), 'utf8');
    const main = html.match(/<main\b[\s\S]*?<\/main>/)?.[0];
    assert.ok(main);
    assert.deepEqual([...main.matchAll(/<a href="([^"]+)"/g)].map(match => match[1]), links);
  }
});

test('the switched client portal takes a signed-in partner with a deal link to Client view', async () => {
  const path = '/client-portal?deal=example&slug=old-website';
  for (const status of [200, 302]) {
    const env = {
      ...environment({ carr: { fetch: async () => new Response(null, {
        status, headers: status === 302 ? { location: '/auth/login?return_to=%2Fbusiness' } : {},
      }) } }),
      ENGINE_ROUTING: { get: async name => name === 'deals-saves-from-engine' ? 'on' : null },
    };
    const response = await handleDoctorcreRequest(request(path), env);
    assert.equal(response.status, 302);
    const target = new URL(response.headers.get('location'), request(path).url);
    if (status === 200) {
      assert.equal(target.pathname + target.search, '/deals?deal=example&tab=client-view');
      assert.equal(response.headers.get('cache-control'), 'no-store');
    } else {
      assert.equal(target.pathname, '/auth/login');
      assert.equal(target.searchParams.get('return_to'), path);
    }
  }
});
