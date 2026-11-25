import assert from "node:assert/strict";
import test from "node:test";
import { build } from "esbuild";

const bundle = await build({
  stdin: {
    contents:
      "export {destinations} from './src/ui/quick-switcher'; export {fixtureInboxRpc} from './src/ui/home/fixture';",
    resolveDir: process.cwd(),
  },
  bundle: true,
  write: false,
  platform: "node",
  format: "esm",
});
assert.ok(bundle.outputFiles[0]);
type Sources = { board?: unknown; network?: unknown; inbox?: unknown };
const {
  destinations,
  fixtureInboxRpc,
}: {
  destinations: (sources: Sources) => { items: { kind: string; label: string }[] };
  fixtureInboxRpc: () => (name: string, args: unknown) => Promise<unknown>;
} = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].contents).toString("base64")}`);

const labels = (sources: Sources, kind: string) =>
  destinations(sources)
    .items.filter((item) => item.kind === kind)
    .map((item) => item.label);

test("a board task reads what to do and its deal, never the name twice", () => {
  const board = {
    deals: [
      {
        id: "deal-1",
        name: "Example Clinic Move",
        open_actions: [
          { id: "a1", item_id: "next_action:a1", description: "Send the floor plan" },
          { id: "a2", item_id: "next_action:a2", description: "example clinic move" },
        ],
      },
    ],
  };
  assert.deepEqual(labels({ board }, "Task"), ["Send the floor plan · Example Clinic Move", "example clinic move"]);
});

test("a Home task whose title is its record name shows the name once", async () => {
  const inbox: unknown = await fixtureInboxRpc()("read-home-inbox-v5", {});
  assert.ok(typeof inbox === "object" && inbox !== null && "items" in inbox && Array.isArray(inbox.items));
  const [first, second] = inbox.items;
  inbox.items = [
    { ...first, title: "Dr. Example Person", context_label: "Dr. Example Person" },
    { ...second, title: "Call the office", context_label: "Dr. Example Person" },
  ];
  assert.deepEqual(labels({ inbox }, "Task"), ["Dr. Example Person", "Call the office · Dr. Example Person"]);
});

test("contacts that share a name each say their role and city", () => {
  const node = (id: string, name: string, kind: string, territory: string | null) => ({
    id: `party:${id}`,
    record_id: id,
    name,
    kind,
    territory,
    contact_state: "active",
  });
  const network = {
    nodes: [
      node("p1", "Dr. Example Person", "client", "Springfield"),
      node("p2", "dr. example person", "lead", null),
      node("p3", "Example Vendor Co", "vendor", "Shelbyville"),
      node("p4", "Dr. Example Person", "contact", "Capital City"),
      { ...node("p5", "Dr. Example Person", "contact", "Ogdenville"), contact_state: "retired" },
    ],
  };
  assert.deepEqual(labels({ network }, "Contact"), [
    "Dr. Example Person · Client, Springfield",
    "dr. example person · Lead",
    "Example Vendor Co",
    "Dr. Example Person · Contact, Capital City",
  ]);
});
