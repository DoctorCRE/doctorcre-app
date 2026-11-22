import { z } from "zod";

const place = z.object({ address: z.string(), name: z.string().nullable() });
const plans = z.object({ tours: z.array(z.object({ id: z.uuid(), planned_on: z.iso.date() })) });
const tour = z.object({ notes: z.string().nullable(), stops: z.array(place) });
const matches = z.object({ properties: z.array(place.extend({ id: z.uuid() })) });
const receipt = z.object({ id: z.uuid() });
const stopList = z.object({ text: z.string() });
const refusal = z.object({
  error: z.string().optional(),
  rule: z.string().nullable().optional(),
  fields: z.array(z.string()).optional(),
});
const date = new Intl.DateTimeFormat("en-US", { dateStyle: "long", timeZone: "UTC" });

type Place = z.infer<typeof place>;
type Stop = { property_id: string } | Place;
type DraftStop = { property: Place; stop: Stop };
type Read = <T>(schema: z.ZodType<T>, path: string, init?: RequestInit) => Promise<T>;
const label = ({ name, address }: Place) => (name ? `${name}, ${address}` : address);

function element<K extends keyof HTMLElementTagNameMap>(tag: K, ...children: (Node | string)[]) {
  const node = document.createElement(tag);
  node.append(...children);
  return node;
}
function action(text: string, run: () => void, data?: "up" | "down") {
  const button = element("button", text);
  button.type = "button";
  button.className = "btn";
  button.onclick = run;
  if (data) button.dataset[data] = "";
  return button;
}
function control<T extends HTMLElement>(host: ParentNode, selector: string) {
  const node = host.querySelector<T>(selector);
  if (!node) throw Error(`Missing tour control ${selector}`);
  return node;
}

function findProperties(read: Read, query: string, init?: RequestInit) {
  const params = new URLSearchParams({ query });
  return read(matches, `/api/engine/properties/search?${params}`, init);
}

async function unavailableStopMessage(read: Read, draft: DraftStop[]) {
  const selected = draft.flatMap(({ property, stop }) =>
    "property_id" in stop ? [{ ...property, id: stop.property_id }] : [],
  );
  const checked =
    selected.length < 2
      ? selected
      : await Promise.all(
          selected.map(async (property) => {
            try {
              const query = [...property.address.trim()].slice(0, 100).join("");
              const { properties } = await findProperties(read, query, { cache: "no-store" });
              return properties.some(({ id }) => id === property.id) ? null : property;
            } catch {
              return property;
            }
          }),
        );
  const unconfirmed = checked.filter((property) => property !== null);
  const [only] = unconfirmed;
  if (only && unconfirmed.length === 1) return `${label(only)} is no longer available. Remove or reselect this stop.`;

  const candidates = unconfirmed.length ? unconfirmed : selected;
  const names = candidates.map(label).join(" · ");
  return `A selected property is no longer available. Remove or reselect the unavailable stop.${names ? ` Check these stops. ${names}` : ""}`;
}

function searchProperties(form: HTMLFormElement, read: Read, add: (property: Place, stop: Stop) => void) {
  const query = control<HTMLInputElement>(form, "[data-query]");
  const results = control(form, "[data-results]");
  const noMatch = control(form, "[data-new-property]");
  const status = control(form, "[data-search-status]");
  const address = control<HTMLInputElement>(noMatch, "[data-address]");
  const name = control<HTMLInputElement>(noMatch, "[data-name]");
  function clear() {
    results.replaceChildren();
    noMatch.hidden = true;
    status.textContent = "";
  }
  function pick(property: Place, stop: Stop) {
    add(property, stop);
    clear();
    query.value = address.value = name.value = "";
    query.focus();
  }
  async function lookup() {
    const term = query.value.trim();
    if (!term || query.disabled) return;
    query.disabled = true;
    clear();
    try {
      const { properties } = await findProperties(read, term);
      for (const property of properties)
        results.append(action(label(property), () => pick(property, { property_id: property.id })));
      noMatch.hidden = properties.length > 0;
      status.textContent = properties.length ? "" : "No properties found.";
    } catch {
      status.textContent = "Could not search properties. Try again.";
    } finally {
      query.disabled = false;
    }
  }
  function addProperty() {
    const value = address.value.trim();
    if (!value) {
      status.textContent = "Enter the new property address.";
      address.focus();
      return;
    }
    const property = { address: value, name: name.value.trim() || null };
    pick(property, property);
  }
  control(form, "[data-search]").onclick = () => void lookup();
  control(noMatch, "button").onclick = addProperty;
  query.oninput = clear;
  control(form, "[data-property-search]").onkeydown = (event) => {
    if (event.key !== "Enter" || !(event.target instanceof HTMLInputElement)) return;
    event.preventDefault();
    if (event.target === query) void lookup();
    else addProperty();
  };
}

function planForm(read: Read, path: string, finish: (id?: string) => void, dirty: () => void) {
  const form = element("form");
  form.innerHTML = `<fieldset class="tour-fields">
    <label>Tour date<input type="date" name="date" required></label>
    <label>Tour notes (optional)<textarea name="notes" rows="3"></textarea></label>
    <ol class="tour-stops" aria-label="Tour stops"></ol>
    <fieldset class="tour-fields" data-property-search>
      <legend>Add a stop</legend>
      <label>Property name or address<input data-query maxlength="100"></label>
      <button type="button" class="btn" data-search>Search properties</button>
      <p role="status" data-search-status></p><div data-results class="deal-tour-actions"></div>
      <div data-new-property hidden><div class="tour-fields">
        <label>New property address<input data-address></label>
        <label>Property name (optional)<input data-name></label>
        <button type="button" class="btn">Add property</button>
      </div></div>
    </fieldset>
    <div class="deal-tour-actions"><button class="btn" type="submit">Save tour</button>
      <button class="btn btn-quiet" type="button" data-back>Back to tours</button></div>
    <p role="alert"></p>
  </fieldset>`;
  const fields = control<HTMLFieldSetElement>(form, "fieldset");
  const list = control(form, "ol");
  const error = control(form, "[role=alert]");
  const stops = new Map<Element, DraftStop>();
  const attempts = new Map<string, string>();
  searchProperties(form, read, (property, stop) => {
    const row = element("li", label(property));
    const up = action("Move up", () => move("up"), "up");
    const down = action("Move down", () => move("down"), "down");
    function move(direction: "up" | "down") {
      const other = direction === "up" ? row.previousElementSibling : row.nextElementSibling;
      if (!other) return;
      if (direction === "up") row.after(other);
      else row.before(other);
      if (!row.previousElementSibling) down.focus();
      if (!row.nextElementSibling) up.focus();
      dirty();
    }
    const remove = action("Remove", () => {
      stops.delete(row);
      row.remove();
      dirty();
    });
    row.append(Object.assign(element("div", up, down, remove), { className: "deal-tour-actions" }));
    stops.set(row, { property, stop });
    list.append(row);
    dirty();
  });

  async function save() {
    if (fields.disabled) return;
    if (!stops.size) {
      error.textContent = "Add at least one property.";
      return;
    }
    const values = new FormData(form);
    const notes = String(values.get("notes") ?? "");
    const ordered = Array.from(list.children, (row) => stops.get(row)).filter((stop) => stop !== undefined);
    const body = {
      planned_on: values.get("date"),
      notes: notes.trim() ? notes : null,
      stops: ordered.map(({ stop }) => stop),
    };
    const key = JSON.stringify(body);
    const idempotency_key = attempts.get(key) ?? crypto.randomUUID();
    attempts.set(key, idempotency_key);
    fields.disabled = true;
    error.textContent = "";
    try {
      const headers = { "content-type": "application/json" };
      const { id } = await read(receipt, path, {
        method: "POST",
        headers,
        body: JSON.stringify({ ...body, idempotency_key }),
      });
      if (form.isConnected) finish(id);
    } catch (reason) {
      const failure = refusal.safeParse(reason).data;
      const invalid = failure?.fields;
      if (failure?.error === "database_refused_the_statement" && failure.rule === "tour_stop_property_id_fkey")
        error.textContent = await unavailableStopMessage(read, ordered);
      else if (invalid?.includes("stops")) error.textContent = "Check the properties in the stop list.";
      else if (invalid?.includes("planned_on")) error.textContent = "Check the tour date.";
      else if (invalid?.includes("notes")) error.textContent = "Check the tour notes.";
      else error.textContent = "Could not confirm the save. Try saving again.";
    } finally {
      fields.disabled = false;
    }
  }
  form.oninput = (event) => {
    if (event.target instanceof HTMLElement && event.target.matches("[name]")) dirty();
  };
  form.onsubmit = (event) => {
    event.preventDefault();
    void save();
  };
  control(form, "[data-back]").onclick = () => finish();
  return form;
}

function previewButton(content: HTMLElement, read: Read, path: string) {
  const status = element("p");
  status.setAttribute("role", "status");
  const button = action("Preview stop list", () => void preview());
  async function preview() {
    button.disabled = true;
    try {
      const { text } = await read(stopList, `${path}/stop-list`);
      const box = Object.assign(element("textarea"), {
        readOnly: true,
        rows: Math.min(12, text.split("\n").length + 1),
        value: text,
      });
      const copy = action("Copy stop list", () => void write());
      async function write() {
        try {
          await navigator.clipboard.writeText(text);
          status.textContent = "Stop list copied.";
        } catch {
          box.select();
          status.textContent = "Copy unavailable. Copy the selected stop list.";
        }
      }
      button.replaceWith(
        Object.assign(element("div", element("label", "Client stop list", box), copy), { className: "tour-fields" }),
      );
    } catch {
      status.textContent = "Could not load the stop list. Try again.";
    } finally {
      button.disabled = false;
    }
  }
  content.append(button, status);
}

function tourRow(read: Read, path: string, heading: string) {
  const body = element("div", "Loading tour…");
  const row = element("details", element("summary", heading), body);
  row.className = "tour-plan";
  row.ontoggle = () => {
    if (row.open) void load();
  };
  async function load() {
    row.ontoggle = null;
    try {
      const { stops, notes } = await read(tour, path);
      const list = element("ol", ...stops.map((stop) => element("li", label(stop))));
      list.setAttribute("aria-label", "Tour stops");
      body.replaceChildren(list);
      if (notes) body.append(Object.assign(element("p", notes), { className: "note-original" }));
      previewButton(body, read, path);
    } catch {
      body.replaceChildren(
        "Could not load the tour. ",
        action("Reload tour", () => void load()),
      );
    }
  }
  return row;
}

type Request = (path: string, init?: RequestInit) => Promise<Response>;
export function mountDealTourPlans(host: Element, options: { dealId: string; request: Request }) {
  const lifetime = new AbortController();
  const path = `/api/engine/deals/${encodeURIComponent(options.dealId)}/tours`;
  const heading = element("h2", "Planned tours");
  const body = element("div");
  const panel = Object.assign(element("section", heading, body), { className: "deal-tours" });
  host.replaceChildren(panel);
  let dirty = false;
  function confirmLeave() {
    if (dirty && !host.ownerDocument.defaultView?.confirm("Leave this tour and discard the unsaved edits?"))
      return false;
    dirty = false;
    return true;
  }
  const read: Read = async (schema, endpoint, init) => {
    lifetime.signal.throwIfAborted();
    const signal = AbortSignal.any([lifetime.signal, AbortSignal.timeout(15000)]);
    const response = await options.request(endpoint, { ...init, signal });
    const payload: unknown = await response.json();
    if (!response.ok) throw payload;
    return schema.parse(payload);
  };
  function plan() {
    heading.textContent = "Plan tour";
    body.replaceChildren(
      planForm(read, path, finish, () => {
        dirty = true;
      }),
    );
  }
  function finish(id?: string) {
    if (!id && !confirmLeave()) return;
    dirty = false;
    void load(id);
  }
  async function load(saved?: string) {
    heading.textContent = "Planned tours";
    body.replaceChildren(element("p", "Loading tours…"));
    try {
      const { tours } = await read(plans, path);
      body.replaceChildren(action("Plan tour", plan));
      for (const { id, planned_on } of tours) {
        const row = tourRow(read, `${path}/${id}`, date.format(new Date(planned_on)));
        body.append(row);
        row.open = id === saved;
      }
      if (!tours.length) body.append(element("p", "No planned tours."));
    } catch {
      const message = saved ? "Tour saved. Reload tours to see it." : "Could not load tours.";
      body.replaceChildren(
        element("p", message),
        action("Reload tours", () => void load(saved)),
      );
    }
  }
  void load();
  return {
    confirmLeave,
    hasUnsavedChanges: () => dirty,
    dispose() {
      lifetime.abort();
      panel.remove();
    },
  };
}
