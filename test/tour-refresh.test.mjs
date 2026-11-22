import { buildToursAppScript } from "./tours-app-loader.ts";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { openDom } from "./jsdom-harness.mjs";

const tourHtml = readFileSync(new URL("../tours/route-editor.html", import.meta.url), "utf8");
const tourScript = await buildToursAppScript();
const settle = () => new Promise(resolve => setTimeout(resolve, 0));
const tourIds = ["11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222"];
async function openTour(detailRead) {
  const dom = openDom(tourHtml, { url: "https://app.doctorcre.com/tours", runScripts: "outside-only" });
  dom.window.TextEncoder = TextEncoder;
  const reads = [];
  dom.window.fetch = async path => {
    const url = new URL(path, dom.window.location.href);
    reads.push(url.pathname);
    let data;
    if (url.pathname === "/api/tours/library") data = { tours: tourIds.map((id, i) => ({ id, name: `Demo Tour ${i ? "B" : "A"}` })) };
    else if (url.pathname === "/api/tours/detail") {
      const i = tourIds.indexOf(url.searchParams.get("tour_id"));
      data = { id: tourIds[i], name: `Demo Tour ${i ? "B" : "A"}`, stops: [] };
      data = detailRead(data);
    } else if (url.pathname === "/api/tours/selection-cart") {
      return { ok: false, json: async () => ({ error: "not_found" }) };
    } else throw new Error(`Unexpected Tour request: ${path}`);
    return { ok: true, json: async () => ({ data }) };
  };
  dom.window.eval(tourScript);
  await settle();
  return { dom, doc: dom.window.document, reads };
}

test("automatic refresh updates selected Tour details and preserves unsaved notes", async t => {
  let revision = 1;
  const app = await openTour(data => ({ ...data, name: `Demo Tour revision ${revision}` }));
  t.after(() => app.dom.window.close());
  app.doc.querySelector(".tour-button").click(); await settle();
  revision = 2;
  app.dom.window.dispatchEvent(new app.dom.window.Event("online")); await settle(); await settle();
  assert.equal(app.doc.querySelector("#tour-name").textContent, "Demo Tour revision 2");
  const notes = app.doc.querySelector("#cheat-content"); notes.value = "Synthetic unsaved note";
  notes.dispatchEvent(new app.dom.window.Event("input", { bubbles: true }));
  const before = app.reads.filter(path => path === "/api/tours/detail").length;
  revision = 3;
  app.dom.window.dispatchEvent(new app.dom.window.Event("online")); await settle(); await settle();
  assert.equal(app.reads.filter(path => path === "/api/tours/detail").length, before);
  assert.equal(notes.value, "Synthetic unsaved note");
});
