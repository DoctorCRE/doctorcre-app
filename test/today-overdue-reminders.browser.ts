import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";

const { mountAppLayout }: { mountAppLayout: (root: Document, host: Element | null, pathname: string) => void } =
  await import("../js/" + "app-layout.js");
const { businessDay }: { businessDay: () => string } = await import("../js/" + "business-date.js");
const {
  addDays,
  shortDay,
}: { addDays: (day: string, count: number) => string; shortDay: (day: string, today: string) => string } = await import(
  "../js/" + "calendar-model.js"
);

const today = businessDay();
const deals = ["d1", "d2", "d3", "d4"].map((id) => ({
  id,
  name: `Demo deal ${id}`,
  owner: null,
  phase: "legal",
  operating_state: "active",
  next_step: null,
  next_date: null,
}));
const reminder = (id: string, subject_id: string, due_on: string, owner: "joe" | "dell" | null, what: string) => ({
  id,
  item_kind: id.startsWith("date") ? "critical_date" : "next_action",
  subject_type: "deal",
  subject_id,
  subject_name: `Demo deal ${subject_id}`,
  owner,
  owner_partner: owner,
  what,
  due_on,
});
const items = [
  reminder("action-past", "d1", addDays(today, -18), "joe", "Send demo terms"),
  reminder("date-past", "d2", addDays(today, -89), null, "Demo notice deadline"),
  reminder("date-today", "d3", today, "dell", "Demo option date"),
  reminder("action-future", "d4", addDays(today, 2), "joe", "Call demo vendor"),
];
const brief = {
  sponsor: "joe",
  sections: {
    today: { state: "ready", items },
    deals: { state: "ready", items: deals },
    loops: { state: "empty", items: [] },
  },
};

for (const path of ["/", "/example"])
  test(`Today on ${path} lists past reminders as overdue and keeps today and later as dated`, async (t) => {
    const dom = new JSDOM('<nav id="host"></nav><main><h1>Example</h1></main>', {
      url: "http://localhost/?mode=live",
      pretendToBeVisual: true,
    });
    const win = dom.window,
      root = win.document;
    Object.defineProperty(win, "matchMedia", {
      value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
    });
    const previousFetch = globalThis.fetch,
      previousLocation = globalThis.location;
    globalThis.location = win.location;
    globalThis.fetch = async (_path, init) => {
      const name: string = typeof init?.body === "string" ? JSON.parse(init.body).params.name : "";
      const value =
        name === "deal-room-board"
          ? { actor: "joe", deals }
          : name === "morning-brief"
            ? brief
            : name === "calendar-meeting-prep"
              ? { state: "empty", items: [], notes: [] }
              : { events: [], cursor: "end" };
      return new Response(
        JSON.stringify(init?.body ? { result: { content: [{ type: "text", text: JSON.stringify(value) }] } } : value),
      );
    };
    t.after(() => {
      win.dispatchEvent(new win.Event("pagehide"));
      win.close();
      globalThis.fetch = previousFetch;
      globalThis.location = previousLocation;
    });
    mountAppLayout(root, root.getElementById("host"), path);
    for (let i = 0; i < 200 && !root.querySelector("#appTodayNext [data-layout-deal]"); i++)
      await new Promise((resolve) => setTimeout(resolve, 5));
    const cards = (list: string) =>
      [...root.querySelectorAll<HTMLElement>(`${list} [data-layout-deal]`)].map((card) => ({
        deal: card.dataset.layoutDeal,
        whose: card.querySelector(".morning-owner")?.textContent,
        name: card.querySelector("strong")?.textContent,
        detail: card.querySelector("span")?.textContent,
      }));
    assert.equal(root.querySelector("#appTodayNeeds")?.closest("section")?.hidden, false);
    assert.deepEqual(cards("#appTodayNeeds"), [
      { deal: "d2", whose: "Shared", name: "Demo deal d2", detail: "Demo notice deadline 89 days overdue" },
      { deal: "d1", whose: "Joe", name: "Demo deal d1", detail: "Send demo terms 18 days overdue" },
    ]);
    assert.deepEqual(cards("#appTodayNext"), [
      { deal: "d3", whose: "Dell", name: "Demo deal d3", detail: `Demo option date · ${shortDay(today, today)}` },
      {
        deal: "d4",
        whose: "Joe",
        name: "Demo deal d4",
        detail: `Call demo vendor · ${shortDay(addDays(today, 2), today)}`,
      },
    ]);
  });
