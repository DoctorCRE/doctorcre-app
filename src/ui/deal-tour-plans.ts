import { z } from "zod";

const place = z.object({ address: z.string(), name: z.string().nullable() });
const plans = z.object({ tours: z.array(z.object({ id: z.uuid(), planned_on: z.iso.date() })) });
const planReceipt = z.object({ id: z.uuid(), revision: z.int().positive() });
const tour = planReceipt.extend({
  planned_on: z.iso.date(),
  notes: z.string().nullable(),
  stops: z.array(place.extend({ property_id: z.uuid() })),
  completed_activity_id: z.uuid().nullable(),
  cancelled_at: z.string().nullable(),
});
const propertyList = z.array(place.extend({ id: z.uuid() }));
const matches = z.object({ properties: propertyList });
const meetingReceipt = z.object({ id: z.uuid(), activity_id: z.uuid() });
const cancellationReceipt = planReceipt.extend({ cancelled_at: z.string() });
const stopList = z.object({ text: z.string() });
const refusal = z.object({
  error: z.string().optional(),
  rule: z.string().nullable().optional(),
  fields: z.array(z.string()).optional(),
});
const date = new Intl.DateTimeFormat("en-US", { dateStyle: "long", timeZone: "UTC" });

type Tour = z.infer<typeof tour>;
type Editor = { mode: "plan" } | { mode: "edit" | "complete"; saved: Tour };
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
  const search = control<HTMLButtonElement>(form, "[data-search]");
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
    if (!term || query.readOnly) return;
    query.readOnly = true;
    clear();
    try {
      const { properties } = await findProperties(read, term);
      for (const property of properties)
        results.append(action(label(property), () => pick(property, { property_id: property.id })));
      noMatch.hidden = properties.length > 0;
      status.textContent = properties.length ? "" : "No properties match your search.";
    } catch {
      status.textContent = "Could not search properties. Try again.";
    } finally {
      query.readOnly = false;
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
  search.onclick = () => void lookup();
  control(noMatch, "button").onclick = addProperty;
  query.oninput = clear;
  control(form, "[data-property-search]").onkeydown = (event) => {
    if (event.key !== "Enter" || !(event.target instanceof HTMLInputElement)) return;
    event.preventDefault();
    if (event.target === query) void lookup();
    else addProperty();
  };
}

function send<T>(read: Read, schema: z.ZodType<T>, path: string, body: object, idempotency_key: string) {
  return read(schema, path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...body, idempotency_key }),
  });
}

function planForm(
  read: Read,
  path: string,
  editor: Editor,
  properties: z.infer<typeof propertyList>,
  finish: (id?: string) => void,
  dirty: () => void,
) {
  const saved = editor.mode === "plan" ? undefined : editor.saved;
  const complete = editor.mode === "complete";
  const visitTime = '<label>Local time<input type="time" name="time" required></label>';
  const notesField = '<label>Tour notes (optional)<textarea name="notes" rows="2"></textarea></label>';
  const form = element("form");
  form.innerHTML = `<fieldset class="tour-editor">
    <div data-linked-properties></div>
    <div class="tour-fields">
      <label>${complete ? "Visit date" : "Tour date"}<input type="date" name="date" required></label>
      ${complete ? visitTime : notesField}
    </div>
    <ol class="tour-stops" aria-label="${complete ? "Visited properties" : "Tour stops"}"></ol>
    <div class="tour-editor-dock">
      <fieldset class="tour-fields" aria-label="${complete ? "Add a visited property" : "Add a stop"}" data-property-search>
        <div class="tour-search-row">
          <label>Property name or address<input data-query maxlength="100"></label>
          <button type="button" class="btn" data-search>Search properties</button>
        </div>
        <p role="status" data-search-status></p>
        <div data-results class="deal-tour-actions"></div>
        <div data-new-property hidden><div class="tour-fields">
          <label>New property address<input data-address></label>
          <label>Property name (optional)<input data-name></label>
          <button type="button" class="btn">Add property</button>
        </div></div>
      </fieldset>
      <p role="alert"></p>
      <div class="deal-tour-actions"><button class="btn btn-primary" type="submit">${complete ? "Save meeting" : "Save tour"}</button>
        <button class="btn btn-quiet" type="button" data-back>Back to tours</button></div>
    </div>
  </fieldset>`;
  const fields = control<HTMLFieldSetElement>(form, "fieldset");
  const list = control(form, "ol");
  const error = control(form, "[role=alert]");
  const stops = new Map<Element, DraftStop>();
  const attempts = new Map<string, string>();
  const submit = control<HTMLButtonElement>(form, "[type=submit]");
  control<HTMLInputElement>(form, "[name=date]").value = saved?.planned_on ?? "";
  if (!complete) control<HTMLTextAreaElement>(form, "[name=notes]").value = saved?.notes ?? "";
  function addStop(property: Place, stop: Stop) {
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
    row.append(
      Object.assign(element("div", ...(complete ? [remove] : [up, down, remove])), { className: "deal-tour-actions" }),
    );
    stops.set(row, { property, stop });
    list.append(row);
  }
  for (const stop of saved?.stops ?? []) addStop(stop, { property_id: stop.property_id });
  function addDraftStop(property: Place, stop: Stop) {
    addStop(property, stop);
    dirty();
  }
  if (properties.length) {
    const linked = element("ul");
    linked.className = "tour-linked-properties";
    linked.setAttribute("aria-label", "Deal properties");
    for (const property of properties) {
      const button = action(`Add ${label(property)}`, () => addDraftStop(property, { property_id: property.id }));
      button.classList.add("btn-quiet");
      linked.append(element("li", button));
    }
    control(form, "[data-linked-properties]").append(element("h3", "Deal properties"), linked);
  }
  searchProperties(form, read, addDraftStop);

  async function save() {
    if (fields.disabled || submit.disabled) return;
    if (!stops.size) {
      error.textContent = "Add at least one property.";
      return;
    }
    const values = new FormData(form);
    const notes = String(values.get("notes") ?? "");
    const ordered = Array.from(list.children, (row) => stops.get(row)).filter((stop) => stop !== undefined);
    const planned_on = values.get("date");
    const selected = ordered.map(({ stop }) => stop);
    let happened_at: string | undefined;
    if (complete) {
      const [hours, minutes] = String(values.get("time")).split(":").map(Number);
      const visit = new Date(`${planned_on}T${values.get("time")}`);
      if (visit.getHours() !== hours || visit.getMinutes() !== minutes) {
        error.textContent = "Check the local visit date and time.";
        return;
      }
      happened_at = visit.toISOString();
    }
    const revision = saved?.revision;
    const body = complete
      ? { revision, happened_at, visited_stops: selected }
      : { revision, planned_on, notes: notes.trim() ? notes : null, stops: selected };
    const key = JSON.stringify(body);
    const idempotency_key = attempts.get(key) ?? crypto.randomUUID();
    attempts.set(key, idempotency_key);
    fields.disabled = true;
    error.textContent = "";
    try {
      const { id } = complete
        ? await send(read, meetingReceipt, `${path}/complete`, body, idempotency_key)
        : await send(read, planReceipt, path, body, idempotency_key);
      finish(id);
    } catch (reason) {
      const failure = refusal.safeParse(reason).data;
      const invalid = failure?.fields;
      if (saved && failure?.error === "version_conflict") {
        submit.disabled = true;
        error.replaceChildren(
          "This tour has changed. Reload it before editing again. ",
          action("Reload tour", () => finish()),
        );
      } else if (failure?.rule === (complete ? "activity_about_property_id_fkey" : "tour_stop_property_id_fkey"))
        error.textContent = await unavailableStopMessage(read, ordered);
      else if (invalid?.includes("visited_stops")) error.textContent = "Check the visited properties.";
      else if (invalid?.includes("happened_at")) error.textContent = "Check the local visit date and time.";
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

function tourRow(
  read: Read,
  path: string,
  heading: string,
  open: (editor: Editor) => void,
  reconcile: (reopen?: string) => void,
) {
  const body = element("div", "Loading tour…");
  const title = element("summary", heading);
  const row = element("details", title, body);
  row.className = "tour-plan";
  row.ontoggle = () => {
    if (row.open) void load();
  };
  let busy = false;
  const cancellationKeys = new Map<number, string>();
  async function load() {
    if (busy) return;
    busy = true;
    body.textContent = "Loading tour…";
    try {
      const saved = await read(tour, path);
      if (!row.isConnected) return;
      title.textContent = date.format(new Date(saved.planned_on));
      if (saved.completed_activity_id || saved.cancelled_at) return reconcile();
      const { stops, notes } = saved;
      const list = element("ol", ...stops.map((stop) => element("li", label(stop))));
      list.setAttribute("aria-label", "Tour stops");
      body.replaceChildren(list);
      if (notes) body.append(Object.assign(element("p", notes), { className: "note-original" }));
      previewButton(body, read, path);
      const controls = [
        action("Edit tour", () => open({ mode: "edit", saved })),
        action("Mark done", () => open({ mode: "complete", saved })),
        action("Cancel tour", () => void cancel()),
      ];
      const status = element("p");
      status.setAttribute("role", "alert");
      async function cancel() {
        if (!window.confirm("Cancel this tour?")) return;
        const key = cancellationKeys.get(saved.revision) ?? crypto.randomUUID();
        cancellationKeys.set(saved.revision, key);
        busy = true;
        for (const button of controls) button.disabled = true;
        status.textContent = "";
        try {
          await send(read, cancellationReceipt, `${path}/cancel`, { revision: saved.revision }, key);
          reconcile();
        } catch (reason) {
          if (refusal.safeParse(reason).data?.error === "version_conflict") {
            status.replaceChildren(
              "This tour has changed. ",
              action("Reload tour", () => reconcile(saved.id)),
            );
            return;
          }
          status.textContent = "Could not confirm the cancellation. Try again.";
          for (const button of controls) button.disabled = false;
        } finally {
          busy = false;
        }
      }
      body.append(Object.assign(element("div", ...controls), { className: "deal-tour-actions" }), status);
    } catch {
      body.replaceChildren(
        "Could not load the tour. ",
        action("Reload tour", () => void load()),
      );
    } finally {
      busy = false;
    }
  }
  return row;
}

type Request = (path: string, init?: RequestInit) => Promise<Response>;
export function mountDealTourPlans(
  host: Element,
  options: { dealId: string; properties?: unknown; request: Request; tourSaved: () => void },
) {
  const lifetime = new AbortController();
  const path = `/api/engine/deals/${encodeURIComponent(options.dealId)}/tours`;
  const heading = element("h2", "Planned tours");
  heading.tabIndex = -1;
  const body = element("div");
  const panel = Object.assign(element("section", heading, body), { className: "deal-tours" });
  host.replaceChildren(panel);
  let dirty = false;
  let editorForm: HTMLFormElement | undefined;
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
  function open(editor: Editor) {
    const saved = editor.mode === "plan" ? undefined : editor.saved;
    heading.textContent = editor.mode === "complete" ? "Mark tour done" : saved ? "Edit tour" : "Plan tour";
    const endpoint = saved ? `${path}/${saved.id}` : path;
    function finish(id?: string) {
      if (editorForm === form) {
        if (!id && !confirmLeave()) return;
        dirty = false;
        editorForm = undefined;
        if (!id) return void load(saved?.id);
      }
      if (id) reconcile(editor.mode === "complete" ? undefined : id);
    }
    function markDirty() {
      dirty = true;
    }
    const properties = editor.mode === "plan" ? (propertyList.safeParse(options.properties).data ?? []) : [];
    const form = planForm(read, endpoint, editor, properties, finish, markDirty);
    editorForm = form;
    body.replaceChildren(form);
    if (editor.mode === "plan") {
      heading.focus({ preventScroll: true });
      heading.scrollIntoView({ block: "center", behavior: "instant" });
    } else control(form, "input").focus();
  }
  function reconcile(reopen?: string) {
    if (lifetime.signal.aborted) return;
    // Leaving the editor reloads the list without interrupting a draft.
    if (!editorForm) void load(reopen, true);
    options.tourSaved();
  }
  async function load(saved?: string, changed = false) {
    heading.textContent = "Planned tours";
    const loading = element("p", "Loading tours…");
    body.replaceChildren(loading);
    try {
      const { tours } = await read(plans, path);
      if (!loading.isConnected) return;
      body.replaceChildren(action("Plan tour", () => open({ mode: "plan" })));
      for (const { id, planned_on } of tours) {
        const title = date.format(new Date(planned_on));
        const row = tourRow(read, `${path}/${id}`, title, open, reconcile);
        body.append(row);
        row.open = id === saved;
      }
      if (!tours.length) body.append(element("p", "No planned tours."));
    } catch {
      if (!loading.isConnected) return;
      const message = changed ? "Tour updated. Reload tours to see the change." : "Could not load tours.";
      body.replaceChildren(
        element("p", message),
        action("Reload tours", () => void load(saved, changed)),
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
