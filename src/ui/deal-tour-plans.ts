import { z } from "zod";

const summary = z.object({ id: z.uuid(), planned_on: z.iso.date() });
const place = z.object({ address: z.string(), name: z.string().nullable() });
const tours = z.object({ tours: z.array(summary) });
const tour = summary.extend({ notes: z.string().nullable(), stops: z.array(place) });
const search = z.object({ properties: z.array(place.extend({ id: z.uuid() })) });
const receipt = z.object({ id: z.uuid() });
const stopList = z.object({ text: z.string() });
const refusal = z.object({ fields: z.array(z.string()) });
const date = new Intl.DateTimeFormat("en-US", { dateStyle: "long", timeZone: "UTC" });
const dateWords = (day: string) => date.format(new Date(day));
type Place = z.infer<typeof place>;
type Stop = Place & { propertyId?: string };
type Read = <T>(schema: z.ZodType<T>, path: string, init?: RequestInit) => Promise<T>;
const label = ({ name, address }: Place) => (name ? `${name}, ${address}` : address);

function element<K extends keyof HTMLElementTagNameMap>(tag: K, ...children: (Node | string)[]) {
  const node = document.createElement(tag);
  node.append(...children);
  return node;
}
function button(text: string, click?: () => void, quiet = false) {
  const node = element("button", text);
  node.type = click ? "button" : "submit";
  node.className = quiet ? "btn btn-quiet" : "btn";
  if (click) node.onclick = click;
  return node;
}
function actions(...buttons: HTMLButtonElement[]) {
  return Object.assign(element("div", ...buttons), { className: "deal-tour-actions" });
}
function find<T extends HTMLElement>(host: ParentNode, selector: string) {
  const node = host.querySelector<T>(selector);
  if (!node) throw Error(`Missing tour control ${selector}`);
  return node;
}

function findProperty(form: HTMLFormElement, read: Read, add: (stop: Stop) => void) {
  const query = find<HTMLInputElement>(form, "[data-query]");
  const results = find(form, "[data-results]");
  const status = find(form, "[data-search-status]");
  const newProperty = find(form, "[data-new-property]");
  const address = find<HTMLInputElement>(newProperty, "input");
  const name = find<HTMLInputElement>(newProperty, "[data-property-name]");
  function clearResults() {
    results.replaceChildren();
    newProperty.hidden = true;
    status.textContent = "";
  }
  function pick(stop: Stop) {
    add(stop);
    query.value = "";
    clearResults();
    query.focus();
  }
  async function lookup() {
    const term = query.value.trim();
    if (!term || query.disabled) return;
    query.disabled = true;
    clearResults();
    status.textContent = "Searching properties…";
    try {
      const found = (await read(search, `/api/engine/properties/search?${new URLSearchParams({ query: term })}`))
        .properties;
      for (const { id, ...property } of found)
        results.append(button(label(property), () => pick({ ...property, propertyId: id }), true));
      status.textContent = found.length ? "" : "No properties found.";
      newProperty.hidden = found.length > 0;
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
    pick({ address: value, name: name.value.trim() || null });
    address.value = name.value = "";
  }
  find(newProperty, "button").onclick = addProperty;
  find(form, "[data-property-search]").onkeydown = (event) => {
    if (event.key !== "Enter" || !(event.target instanceof HTMLInputElement)) return;
    event.preventDefault();
    if (event.target === query) void lookup();
    else addProperty();
  };
  query.oninput = clearResults;
  find(form, "[data-search]").onclick = () => void lookup();
}

function planTour(read: Read, path: string, saved: (id: string) => void, back: () => void, dirty: () => void) {
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
        <label>New property address<input></label>
        <label>Property name (optional)<input data-property-name></label>
        <button type="button" class="btn">Add property</button>
      </div></div>
    </fieldset>
    <p role="alert"></p>
  </fieldset>`;
  const fields = find<HTMLFieldSetElement>(form, "fieldset");
  const list = find(form, "ol");
  const error = find(form, "[role=alert]");
  const stops = new Map<Element, Stop>();
  const attempts = new Map<string, string>();
  form.oninput = (event) => {
    if (event.target instanceof HTMLElement && event.target.matches("[name=date], [name=notes]")) dirty();
  };
  function addStop(stop: Stop) {
    const row = element("li", label(stop));
    const up = button("Move up", () => {
      const previous = row.previousElementSibling;
      if (previous) {
        row.after(previous);
        dirty();
      }
      if (!row.previousElementSibling) down.focus();
    });
    const down = button("Move down", () => {
      const next = row.nextElementSibling;
      if (next) {
        row.before(next);
        dirty();
      }
      if (!row.nextElementSibling) up.focus();
    });
    up.dataset.up = "";
    down.dataset.down = "";
    const remove = button(
      "Remove",
      () => {
        stops.delete(row);
        row.remove();
        dirty();
      },
      true,
    );
    row.append(actions(up, down, remove));
    stops.set(row, stop);
    list.append(row);
    dirty();
  }
  async function save() {
    if (fields.disabled) return;
    if (!stops.size) {
      error.textContent = "Add at least one property.";
      return;
    }
    const ordered = Array.from(list.children, (row) => stops.get(row)).filter((stop) => stop !== undefined);
    const values = new FormData(form);
    const notes = String(values.get("notes") ?? "");
    const body = {
      planned_on: values.get("date"),
      notes: notes.trim() ? notes : null,
      stops: ordered.map(({ propertyId, address, name }) =>
        propertyId ? { property_id: propertyId } : { address, name },
      ),
    };
    const key = JSON.stringify(body);
    const idempotency_key = attempts.get(key) ?? crypto.randomUUID();
    attempts.set(key, idempotency_key);
    fields.disabled = true;
    error.textContent = "";
    try {
      const { id } = await read(receipt, path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...body, idempotency_key }),
      });
      if (form.isConnected) saved(id);
    } catch (reason) {
      const invalid = refusal.safeParse(reason).data?.fields;
      if (invalid?.includes("stops")) error.textContent = "Check the properties in the stop list.";
      else if (invalid?.includes("planned_on")) error.textContent = "Check the tour date.";
      else error.textContent = "Could not confirm the save. Try saving again.";
    } finally {
      fields.disabled = false;
    }
  }
  findProperty(form, read, addStop);
  fields.append(actions(button("Save tour"), button("Back to tours", back, true)));
  form.onsubmit = (event) => {
    event.preventDefault();
    void save();
  };
  return form;
}

export function mountDealTourPlans(
  host: Element,
  {
    dealId,
    request,
  }: {
    dealId: string;
    request(path: string, init?: RequestInit): Promise<Response>;
  },
) {
  const lifetime = new AbortController();
  const path = `/api/engine/deals/${encodeURIComponent(dealId)}/tours`;
  const heading = element("h2");
  const body = element("div");
  const status = element("p");
  status.setAttribute("role", "status");
  const section = element("section", heading, body, status);
  section.className = "deal-tours";
  section.setAttribute("aria-label", "Deal tours");
  host.replaceChildren(section);
  let dirty = false;
  function confirmLeave() {
    if (dirty && !host.ownerDocument.defaultView?.confirm("Leave this tour and discard the unsaved edits?"))
      return false;
    dirty = false;
    return true;
  }
  const read: Read = async (schema, endpoint, init) => {
    const response = await request(endpoint, {
      ...init,
      signal: AbortSignal.any([lifetime.signal, AbortSignal.timeout(15000)]),
    });
    const payload: unknown = await response.json();
    if (!response.ok) throw payload;
    return schema.parse(payload);
  };
  async function load<T>(schema: z.ZodType<T>, endpoint: string, show: (data: T) => void, saved = false) {
    status.textContent = "Loading tours…";
    body.replaceChildren();
    try {
      const data = await read(schema, endpoint);
      if (lifetime.signal.aborted) return;
      status.textContent = "";
      show(data);
    } catch {
      status.textContent = saved ? "Tour saved. Reload tours to see it." : "Could not load tours. Try again.";
      body.append(button("Reload tours", showList));
    }
  }
  function showList() {
    heading.textContent = "Planned tours";
    void load(tours, path, ({ tours }) => {
      const list = element(
        "ul",
        ...tours.map((row) =>
          element(
            "li",
            button(dateWords(row.planned_on), () => showTour(row.id), true),
          ),
        ),
      );
      list.className = "deal-tour-list";
      body.append(
        tours.length ? list : element("p", "No planned tours."),
        button("Plan tour", () => {
          heading.textContent = "Plan tour";
          body.replaceChildren(
            planTour(
              read,
              path,
              (id) => {
                dirty = false;
                showTour(id, true);
              },
              () => {
                if (confirmLeave()) showList();
              },
              () => {
                dirty = true;
              },
            ),
          );
        }),
      );
    });
  }
  function showTour(id: string, saved = false) {
    const endpoint = `${path}/${id}`;
    void load(
      tour,
      endpoint,
      (data) => {
        heading.textContent = dateWords(data.planned_on);
        const list = element("ol", ...data.stops.map((stop) => element("li", label(stop))));
        list.className = "tour-stops";
        list.setAttribute("aria-label", "Tour stops");
        body.append(list);
        if (data.notes) body.append(Object.assign(element("p", data.notes), { className: "note-original" }));
        const preview = button("Preview stop list", () => void showPreview());
        body.append(actions(preview, button("Back to tours", showList, true)));
        async function showPreview() {
          preview.disabled = true;
          try {
            const { text } = await read(stopList, `${endpoint}/stop-list`);
            if (!preview.isConnected) return;
            const box = Object.assign(element("textarea"), {
              readOnly: true,
              rows: Math.min(12, text.split("\n").length + 1),
              value: text,
            });
            async function copy() {
              try {
                await navigator.clipboard.writeText(text);
                if (box.isConnected) status.textContent = "Stop list copied.";
              } catch {
                if (!box.isConnected) return;
                box.select();
                status.textContent = "Copy unavailable. Copy the selected stop list.";
              }
            }
            const share = element(
              "div",
              element("label", "Client stop list", box),
              button("Copy stop list", () => void copy()),
            );
            share.className = "tour-fields";
            body.append(share);
            preview.remove();
            status.textContent = "";
          } catch {
            if (preview.isConnected) {
              status.textContent = "Could not load the stop list. Try again.";
              preview.disabled = false;
            }
          }
        }
      },
      saved,
    );
  }
  showList();
  return {
    confirmLeave,
    hasUnsavedChanges: () => dirty,
    dispose() {
      lifetime.abort();
      section.remove();
    },
  };
}
