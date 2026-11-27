import { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { fixtureInboxRpc } from "./home/fixture";
import { createInboxClient, parseSnapshot } from "./home/inbox";
import { recordRoutes } from "./home/routes";
import { isTextEntry } from "./keyboard-input";
import { clearRecents, recentIds, rememberDestination as remember } from "./switcher-history";

type RecordKind = "Deal" | "Contact" | "Task" | "Page";
type RecordDestination = { id: string; label: string; kind: RecordKind; href: string };
type ActionDestination = { id: string; label: string; kind: "Action"; run: () => void };
type Destination = RecordDestination | ActionDestination;
type Availability = "full" | "board" | "contacts" | "none";
type ReadState =
  | { kind: "loading" }
  | { kind: "ready"; items: RecordDestination[]; availability: Availability; inboxNotice: string }
  | { kind: "error" };
type Sources = { board: unknown; network: unknown; inbox: unknown };
type Options = {
  opener: HTMLElement;
  pages: { label: string; href: string }[];
  read: (publish: (sources: Sources) => void) => Promise<Sources>;
};
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;
const recordPages: Record<string, (id: string) => string> = {
  lead: (id) => `/leads?lead=${encodeURIComponent(id)}`,
  client: (id) => `/clients?record=${encodeURIComponent(id)}`,
  vendor: (id) => `/vendors?record=${encodeURIComponent(id)}`,
};
const resultCount = (count: number) => `${count} ${count === 1 ? "result" : "results"}`;
const nameKey = (name: string) => name.trim().toLocaleLowerCase();
const taskLabel = (what: string, record: unknown) =>
  text(record) && nameKey(record) !== nameKey(what) ? `${what} · ${record}` : what;
const roleLabels: Record<string, string> = { vendor: "Vendor", client: "Client", lead: "Lead", contact: "Contact" };

function boardDestinations(board: unknown): RecordDestination[] {
  if (!record(board) || !Array.isArray(board.deals)) throw Error("Invalid board");
  const result: RecordDestination[] = [];
  const seen = new Set<string>();
  const deals = [...board.deals];
  for (const key of ["closed_deals", "lost_deals"]) {
    if (board[key] === undefined) continue;
    if (!Array.isArray(board[key])) throw Error("Invalid deals");
    deals.push(...board[key]);
  }
  for (const deal of deals) {
    if (!record(deal) || !text(deal.id) || !text(deal.name)) throw Error("Invalid deal");
    if (
      deal.open_actions !== undefined &&
      (!Array.isArray(deal.open_actions) ||
        deal.open_actions.some(
          (action) => !record(action) || !text(action.id) || !text(action.item_id) || !text(action.description),
        ))
    )
      throw Error("Invalid tasks");
    if (seen.has(deal.id)) continue;
    seen.add(deal.id);
    const href = `/deals?deal=${encodeURIComponent(deal.id)}`;
    result.push({ id: `deal:${deal.id}`, label: deal.name, kind: "Deal", href });
    if (Array.isArray(deal.open_actions))
      for (const action of deal.open_actions) {
        if (record(action) && text(action.item_id) && text(action.description))
          result.push({
            id: `task:${action.item_id}`,
            label: taskLabel(action.description, deal.name),
            kind: "Task",
            href: recordRoutes.card(action.item_id),
          });
      }
  }
  return result;
}

function contactDestinations(network: unknown): RecordDestination[] {
  if (!record(network) || !Array.isArray(network.nodes)) throw Error("Invalid contacts");
  const contacts: { id: string; name: string; detail: string; href: string }[] = [];
  for (const node of network.nodes) {
    if (
      !record(node) ||
      !text(node.id) ||
      !text(node.name) ||
      !["vendor", "client", "lead", "contact", "deal"].includes(String(node.kind))
    )
      throw Error("Invalid contact");
    if (node.kind === "deal" || node.contact_state === "retired") continue;
    const page = recordPages[String(node.kind)];
    contacts.push({
      id: node.id,
      name: node.name,
      detail: [roleLabels[String(node.kind)], node.territory].filter(text).join(", "),
      href: page && text(node.record_id) ? page(node.record_id) : `/relationships?node=${encodeURIComponent(node.id)}`,
    });
  }
  const named = new Map<string, number>();
  for (const { name } of contacts) named.set(nameKey(name), (named.get(nameKey(name)) ?? 0) + 1);
  // Ruling 35(6): people who share a name say which one they are.
  return contacts.map(({ name, detail, ...contact }) => ({
    ...contact,
    kind: "Contact",
    label: (named.get(nameKey(name)) ?? 0) > 1 ? `${name} · ${detail}` : name,
  }));
}

function admittedSection(parse: () => RecordDestination[]): RecordDestination[] | null {
  try {
    return parse();
  } catch {
    return null;
  }
}

export function destinations({
  board,
  network,
  inbox,
}: {
  board: unknown;
  network: unknown;
  inbox: unknown;
}): Extract<ReadState, { kind: "ready" }> {
  const deals = admittedSection(() => boardDestinations(board));
  const contacts = admittedSection(() => contactDestinations(network));
  let inboxNotice = "";
  const tasks = admittedSection(() => {
    const snapshot = parseSnapshot(inbox);
    if (snapshot.truncated) inboxNotice = "Some Home tasks are not shown.";
    return snapshot.items
      .filter((item) => item.source_type === "next_action" || item.source_type === "capture_post_call_action")
      .map((item) => ({
        id: `task:${item.item_id}`,
        label: taskLabel(item.title, item.context_label),
        kind: "Task" as const,
        href: recordRoutes.card(item.item_id),
      }));
  });
  if (inbox !== undefined && tasks === null)
    inboxNotice = "Home tasks unavailable. Deals, contacts and pages are still available.";
  const items = new Map([...(deals ?? []), ...(contacts ?? []), ...(tasks ?? [])].map((item) => [item.id, item]));
  return {
    kind: "ready",
    inboxNotice,
    items: [...items.values()],
    availability:
      deals !== null || board === undefined
        ? contacts !== null || network === undefined
          ? "full"
          : "board"
        : contacts !== null || network === undefined
          ? "contacts"
          : "none",
  };
}

const unavailableMessage = {
  full: "",
  board: "Contacts unavailable. Deals, tasks and pages are still available.",
  contacts: "Deals unavailable. Contacts and pages are still available.",
  none: "Deals and contacts unavailable. Pages are still available.",
};

export async function readQuickSwitcherSources(
  readBoard: () => Promise<unknown>,
  readNetwork: () => Promise<unknown>,
  readInbox: () => Promise<unknown>,
  publish?: (sources: Sources) => void,
): Promise<Sources> {
  const sources: Sources = { board: undefined, network: undefined, inbox: undefined };
  await Promise.all(
    (
      [
        ["board", readBoard],
        ["network", readNetwork],
        ["inbox", readInbox],
      ] as const
    ).map(async ([source, read]) => {
      try {
        sources[source] = await Promise.resolve().then(read);
      } catch {
        sources[source] = null;
      }
      publish?.({ ...sources });
    }),
  );
  return sources;
}

export function switcherInboxReader(
  request: (
    name: string,
    args: unknown,
    options: { timeoutMs: number },
  ) => Promise<{ kind: string; isError?: boolean; payload?: unknown }>,
  fixture: boolean,
) {
  return createInboxClient(
    fixture
      ? fixtureInboxRpc()
      : async (name, args) => {
          const result = await request(name, args, { timeoutMs: 10000 });
          if (result.kind !== "payload") throw Error("Inbox transport unavailable");
          if (result.isError) throw Object.assign(Error("Inbox refused"), { payload: result.payload });
          return result.payload;
        },
  ).read;
}

const ADD_DEAL_FLAG = "doctorcre.quick-switcher.open-add-deal";

function themeActionLabel() {
  return document.documentElement.getAttribute("data-theme") === "dark" ? "Light mode" : "Dark mode";
}

function openNewDeal() {
  const add = document.getElementById("addDealOpen");
  if (add instanceof HTMLElement && location.pathname === "/deals") {
    add.click();
    return;
  }
  try {
    sessionStorage.setItem(ADD_DEAL_FLAG, "1");
  } catch {
    /* going to Deals still works if this browser blocks storage */
  }
  location.assign("/deals");
}

function clearAddDealFlag() {
  try {
    sessionStorage.removeItem(ADD_DEAL_FLAG);
  } catch {
    /* nothing stored if this browser blocks storage */
  }
}

function flipTheme() {
  document.querySelector<HTMLButtonElement>('[data-pref="theme"]')?.click();
}

function switcherActions(): ActionDestination[] {
  return [
    { id: "action:new-deal", label: "New deal", kind: "Action", run: openNewDeal },
    { id: "action:ask-doc", label: "Ask Doc", kind: "Action", run: () => location.assign("/doc-chats") },
    { id: "action:theme", label: themeActionLabel(), kind: "Action", run: flipTheme },
  ];
}

const isAction = (item: Destination): item is ActionDestination => item.kind === "Action";

export function openQuickSwitcher({ opener, pages, read }: Options) {
  if (document.querySelector("[data-quick-switcher]")) return;
  const dialog = document.createElement("dialog");
  dialog.dataset.quickSwitcher = "";
  dialog.className = "quick-switcher";
  dialog.setAttribute("aria-label", "Quick switcher");
  document.body.append(dialog);
  const root = createRoot(dialog);
  let retired = false;
  const close = () => {
    if (retired) return;
    retired = true;
    dialog.close();
    root.unmount();
    dialog.remove();
    window.removeEventListener("doctorcre-session-invalidated", revoke);
    opener.focus();
  };
  const revoke = () => {
    clearRecents();
    clearAddDealFlag();
    close();
  };
  window.addEventListener("doctorcre-session-invalidated", revoke, { once: true });
  dialog.addEventListener("cancel", (event) => {
    event.preventDefault();
    close();
  });
  dialog.addEventListener("click", (event) => {
    if (event.target === dialog) {
      const bounds = dialog.getBoundingClientRect();
      if (
        event.clientX < bounds.left ||
        event.clientX > bounds.right ||
        event.clientY < bounds.top ||
        event.clientY > bounds.bottom
      )
        close();
    }
  });
  root.render(<Switcher pages={pages} read={read} close={close} />);
  dialog.showModal();
}

function Switcher({ pages, read, close }: Omit<Options, "opener"> & { close: () => void }) {
  const [state, setState] = useState<ReadState>({ kind: "loading" });
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState<RecordKind | "All">("All");
  const [active, setActive] = useState(0);
  const [request, setRequest] = useState({ read });
  const input = useRef<HTMLInputElement>(null);
  const pageItems = useMemo<RecordDestination[]>(
    () => pages.map((page) => ({ ...page, id: `page:${page.href}`, kind: "Page" as const })),
    [pages],
  );
  const all = [...(state.kind === "ready" ? state.items : []), ...pageItems];
  const normalized = query.trim().toLocaleLowerCase();
  const recents = recentIds().flatMap((id) => all.find((item) => item.id === id) || []);
  const candidates =
    normalized || kind !== "All"
      ? all
      : [...recents, ...pageItems.filter((page) => !recents.some((item) => item.id === page.id))];
  const recordResults = candidates.filter(
    (item) =>
      (kind === "All" || item.kind === kind) &&
      (!normalized || `${item.label} ${item.kind}`.toLocaleLowerCase().includes(normalized)),
  );
  const actionResults =
    kind === "All"
      ? switcherActions().filter((action) => !normalized || action.label.toLocaleLowerCase().includes(normalized))
      : [];
  const results: Destination[] = [...recordResults, ...actionResults];
  const activeIndex = Math.min(active, Math.max(0, results.length - 1));
  const selected = results[activeIndex];
  const unavailable =
    state.kind === "error"
      ? unavailableMessage.none
      : state.kind === "ready"
        ? unavailableMessage[state.availability]
        : "";
  const inboxNotice = state.kind === "ready" ? state.inboxNotice : "";
  useEffect(() => {
    input.current?.focus();
  }, []);
  useEffect(() => {
    let current = true;
    setState({ kind: "loading" });
    setActive(0);
    const publish = (payload: Sources) => {
      if (current) {
        const admitted = destinations(payload);
        const items = admitted.items;
        const path = `${location.pathname}${location.search}`;
        const opened = [...items, ...pageItems].find((item) => item.href === path);
        if (opened) remember(opened.id);
        setState(admitted);
      }
    };
    void request
      .read(publish)
      .then(publish)
      .catch(() => {
        if (current) setState({ kind: "error" });
      });
    return () => {
      current = false;
    };
  }, [request, pageItems]);
  useEffect(() => {
    document.getElementById(`quick-option-${activeIndex}`)?.scrollIntoView({ block: "nearest" });
  }, [activeIndex]);
  const actionStart = results.findIndex(isAction);
  const option = (item: Destination, index: number) => (
    <div
      key={item.id}
      id={`quick-option-${index}`}
      role="option"
      tabIndex={-1}
      onKeyDown={(event) => {
        if (event.key === "Enter" && !isTextEntry(event.nativeEvent)) choose(item);
      }}
      aria-selected={index === activeIndex}
      onPointerMove={() => setActive(index)}
      onMouseDown={(event) => event.preventDefault()}
      onClick={() => choose(item)}
    >
      <span>{item.label}</span>
      {isAction(item) ? null : <small>{item.kind}</small>}
    </div>
  );
  const choose = (item: Destination) => {
    if (isAction(item)) {
      close();
      item.run();
      return;
    }
    remember(item.id);
    close();
    location.assign(item.href);
  };
  return (
    <div className="quick-switcher-content">
      <header>
        <h2>Jump to</h2>
        <button type="button" aria-label="Close quick switcher" onClick={close}>
          Close
        </button>
      </header>
      <input
        ref={input}
        id="quick-input"
        role="combobox"
        aria-label="Jump to"
        autoComplete="off"
        placeholder="Deals, contacts, tasks and pages"
        aria-expanded="true"
        aria-autocomplete="list"
        aria-controls="quick-results"
        aria-activedescendant={selected ? `quick-option-${activeIndex}` : undefined}
        value={query}
        onChange={(event) => {
          setQuery(event.target.value);
          setActive(0);
        }}
        onKeyDown={(event) => {
          if (isTextEntry(event.nativeEvent)) return;
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            if (results.length)
              setActive((index) => (index + (event.key === "ArrowDown" ? 1 : -1) + results.length) % results.length);
          } else if (event.key === "Enter" && selected) {
            event.preventDefault();
            choose(selected);
          }
        }}
      />
      <fieldset
        aria-label="Destination kind"
        style={{ display: "flex", flexWrap: "wrap", gap: "0.25rem", border: 0, padding: 0, margin: 0 }}
      >
        {(["All", "Deal", "Contact", "Task", "Page"] satisfies ("All" | RecordKind)[]).map((value) => (
          <button
            key={value}
            type="button"
            aria-pressed={kind === value}
            onClick={() => {
              setKind(value);
              setActive(0);
            }}
          >
            {value === "All" ? "All" : `${value}s`}
          </button>
        ))}
      </fieldset>
      <p role="status">{state.kind === "loading" ? "Loading…" : unavailable || resultCount(results.length)}</p>
      {inboxNotice && <p role="status">{inboxNotice}</p>}
      {unavailable && <p>{resultCount(results.length)}</p>}
      {state.kind !== "loading" && results.length === 0 && <p>No matches. Try a deal, contact or page name.</p>}
      {(unavailable || inboxNotice) && (
        <button type="button" onClick={() => setRequest({ read })}>
          Retry
        </button>
      )}
      {!normalized && kind === "All" && <h3>{recents.length ? "Recent" : "Pages"}</h3>}
      <div id="quick-results" role="listbox" aria-label="Destinations">
        {results.map((item, index) => !isAction(item) && option(item, index))}
        {actionStart >= 0 && (
          <fieldset>
            <legend>Actions</legend>
            {results.map((item, index) => isAction(item) && option(item, index))}
          </fieldset>
        )}
      </div>
      <a href={query.trim() ? `/search?q=${encodeURIComponent(query.trim())}` : "/search"}>Search all records</a>
      <footer>↑ ↓ to move · Enter to open · Esc to close</footer>
    </div>
  );
}
