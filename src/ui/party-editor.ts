// Add, edit and link clients and vendors through the engine's party doors.

type Dataset = "clients" | "vendors";
type Facet = { slug: string; label: string };
type Candidate = { id: string; name: string; city: string | null };
type Problem = { error?: string; fields: string[]; candidates: Candidate[]; current?: Record<string, unknown> };
// What a field holds: text, a list of slugs, or nothing.
type Value = string | string[] | null;
type Refused = { ok: false; problem?: unknown; pending?: boolean };
type SaveResult = { ok: true; data: Record<string, unknown> } | Refused;
type Saver = {
  savePartnerRecord(path: string, key: string, receipt: string, args: Record<string, unknown>): Promise<SaveResult>;
};
type Options = {
  document: Document;
  client: () => Promise<Saver>;
  dataset: () => Dataset;
  facets: () => Record<string, Facet[] | undefined>;
  saved: (partyId: string) => void;
  // The page's own phone format, so a number reads the same in the record and the editor.
  phoneLabel: (phone: string) => string;
};

const STATUSES = [
  ["roster", "Roster"],
  ["cold", "Cold"],
  ["engaged", "Engaged"],
  ["paused", "Paused"],
];
const LINKS = [
  ["knows", "Knows"],
  ["can_introduce", "Can introduce us to"],
];
// No engine read lists these yet, so this copies the engine's how_found list; Not recorded is only for copied records.
export const HOW_FOUND = [
  ["referral", "Referral"],
  ["vendor", "Vendor"],
  ["marketing_post", "Marketing post"],
  ["public_records", "Public records"],
  ["cold_outreach", "Cold outreach"],
  ["own_research", "Own research"],
  ["inbound", "Inbound"],
  ["national_account", "National account or corporate lead"],
  ["existing_relationship", "Existing relationship"],
  ["event", "Event"],
];
type ContactField = "name" | "email" | "phone" | "city";
const CONTACT: ContactField[] = ["name", "email", "phone", "city"];
const ROLE: Record<Dataset, string[]> = {
  clients: ["how_found", "status", "client_type", "vertical"],
  vendors: ["categories", "stage", "offers"],
};
const LABELS: Record<string, string> = {
  name: "Name",
  email: "Email",
  phone: "Phone",
  city: "City",
  how_found: "How found",
  status: "Status",
  client_type: "Client type",
  vertical: "Practice type",
  categories: "Categories",
  stage: "Stage",
  offers: "What they offer",
};
const REFUSALS: Record<string, string> = {
  party_exists: "A record like this already exists.",
  already_client: "This record is already a client.",
  already_vendor: "This record is already a vendor.",
  already_linked: "These two are already linked.",
  invalid_field_value: "Check the highlighted fields.",
  missing_required: "Fill in the highlighted fields.",
};

const escapeHtml = (value: unknown) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char] ?? char,
  );
const options = (pairs: string[][], selected: unknown) =>
  pairs
    .map(
      ([value = "", label]) =>
        `<option value="${escapeHtml(value)}"${String(selected ?? "") === value ? " selected" : ""}>${escapeHtml(label)}</option>`,
    )
    .join("");
const facetPairs = (list: Facet[] | undefined) =>
  (list ?? []).filter((item) => item.slug !== "national_account").map((item) => [item.slug, item.label]);
const humanized = (slug: string) => slug.replaceAll("_", " ").replace(/^./, (first) => first.toUpperCase());
// A held slug the list does not name yet (its read is still loading) stays a choice, so saving never drops it.
const withHeld = (pairs: string[][], held: unknown) => {
  const slugs = (Array.isArray(held) ? held : [held]).filter(
    (slug): slug is string => typeof slug === "string" && slug !== "" && !pairs.some(([value]) => value === slug),
  );
  return [...pairs, ...slugs.map((slug) => [slug, humanized(slug)])];
};
// A label points at its control, so a select's name is its label and not its chosen option.
const field = (label: string, name: string, control: string) =>
  `<div class="party-field"><label for="party-${name}">${label}</label>${control}</div>`;
const input = (name: string, value: unknown = "", attrs = "") =>
  `<input id="party-${name}" name="${name}" value="${escapeHtml(value)}" ${attrs}>`;
const select = (name: string, pairs: string[][], selected: unknown, attrs = "") =>
  `<select id="party-${name}" name="${name}" ${attrs}>${options(pairs, selected)}</select>`;
const textarea = (name: string, value: unknown = "") =>
  `<textarea id="party-${name}" name="${name}" rows="2">${escapeHtml(value)}</textarea>`;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const textOrNull = (value: unknown) => (typeof value === "string" ? value : null);
function problemOf(value: unknown): Problem {
  if (!isRecord(value)) return { fields: [], candidates: [] };
  const fields = Array.isArray(value.fields) ? value.fields.filter((item) => typeof item === "string") : [];
  const candidates = Array.isArray(value.candidates)
    ? value.candidates.flatMap((item) =>
        isRecord(item) && typeof item.id === "string" && typeof item.name === "string"
          ? [{ id: item.id, name: item.name, city: textOrNull(item.city) }]
          : [],
      )
    : [];
  return {
    ...(typeof value.error === "string" && { error: value.error }),
    fields,
    candidates,
    ...(isRecord(value.current) && { current: value.current }),
  };
}
const valueFrom = (raw: unknown): Value =>
  Array.isArray(raw)
    ? raw.filter((item) => typeof item === "string").sort()
    : typeof raw === "string" && raw.trim()
      ? raw.trim()
      : null;
const same = (left: Value, right: Value) => JSON.stringify(left) === JSON.stringify(right);
function contactOf(value: unknown): ({ name: string } & Record<ContactField, string | null>) | null {
  if (!isRecord(value) || typeof value.name !== "string") return null;
  const phone = isRecord(value.phone) && typeof value.phone.shown === "string" ? value.phone.shown : null;
  return { name: value.name, email: textOrNull(value.email), phone, city: textOrNull(value.city) };
}

export function mountPartyEditor({ document, client, dataset, facets, saved, phoneLabel }: Options) {
  const dialog = document.createElement("dialog");
  dialog.className = "party-editor";
  dialog.setAttribute("aria-labelledby", "partyEditorTitle");
  // The record panel's own Tab and Escape handling stays out of this dialog.
  dialog.addEventListener("keydown", (event) => event.stopPropagation());
  document.body.append(dialog);

  const newButton = document.createElement("button");
  newButton.type = "button";
  newButton.className = "action primary-action party-new";
  newButton.onclick = () => openNew();
  document.querySelector(".result-heading")?.append(newButton);

  let trigger: Element | null = null;
  let session = "";
  let unconfirmed = false;
  let opening = false;
  dialog.addEventListener("close", () => {
    if (trigger instanceof HTMLElement && trigger.isConnected) trigger.focus();
  });

  const status = (message: string) => {
    const region = dialog.querySelector("[data-status]");
    if (region) region.textContent = message;
  };
  const value = (form: HTMLFormElement, name: string) => {
    const control = form.elements.namedItem(name);
    return control instanceof HTMLInputElement ||
      control instanceof HTMLSelectElement ||
      control instanceof HTMLTextAreaElement
      ? control.value.trim()
      : "";
  };

  function show(title: string, body: string, submit: string, onSubmit: (form: HTMLFormElement) => Promise<void>) {
    trigger = document.activeElement;
    session = crypto.randomUUID();
    unconfirmed = false;
    dialog.innerHTML = `<form novalidate><header><h2 id="partyEditorTitle" tabindex="-1">${escapeHtml(title)}</h2><button type="button" class="party-close" data-close aria-label="Close">×</button></header>${body}<div data-candidates></div><p class="party-status" role="status" data-status></p><div class="party-actions"><button type="submit" class="party-submit">${escapeHtml(submit)}</button></div></form>`;
    const form = dialog.querySelector("form");
    if (!form) throw Error("Editor form unavailable");
    dialog.querySelector("[data-close]")?.addEventListener("click", () => dialog.close());
    // An edit after an unanswered save is a new change, so it goes under a new key.
    form.addEventListener("input", () => {
      if (!unconfirmed) return;
      unconfirmed = false;
      session = crypto.randomUUID();
      status("");
    });
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      for (const element of form.querySelectorAll("[aria-invalid]")) element.removeAttribute("aria-invalid");
      const button = form.querySelector<HTMLButtonElement>(".party-submit");
      if (button) button.disabled = true;
      status("Saving…");
      try {
        await onSubmit(form);
      } finally {
        if (button) button.disabled = false;
      }
    });
    if (!dialog.open) dialog.showModal();
    dialog.querySelector("h2")?.focus();
    return form;
  }

  function refuse(form: HTMLFormElement, result: Refused) {
    const problem = problemOf(result.problem);
    for (const name of problem.fields) {
      const control = form.elements.namedItem(name);
      if (control instanceof Element) control.setAttribute("aria-invalid", "true");
    }
    unconfirmed = Boolean(result.pending);
    status(
      result.pending
        ? "Not confirmed yet. Save again to check the same change."
        : (REFUSALS[problem.error ?? ""] ?? "This was not saved. Try again."),
    );
  }

  async function save(path: string, step: string, receipt: string, args: Record<string, unknown>) {
    return (await client()).savePartnerRecord(`/api/engine/${path}`, `party-editor:${session}:${step}`, receipt, args);
  }

  function done(partyId: string) {
    dialog.close();
    saved(partyId);
  }

  const contactFields = (shown: Record<string, Value> = {}) =>
    `${field("Name", "name", input("name", shown.name, 'required maxlength="200" autocomplete="off"'))}${field("Email", "email", input("email", shown.email, 'type="email" autocomplete="off"'))}${field("Phone", "phone", input("phone", shown.phone, 'type="tel" autocomplete="off"'))}${field("City", "city", input("city", shown.city, 'autocomplete="off"'))}`;

  // An edited record keeps a how found copied as Not recorded until a partner picks one.
  function clientFields(shown: Record<string, Value> = {}, editing = false) {
    const types = [["", "Not set"], ...withHeld(facetPairs(facets().types), shown.client_type)];
    const howFound = [["", editing ? "Not recorded" : "Choose how they were found"], ...HOW_FOUND];
    return `${field("How found", "how_found", select("how_found", howFound, shown.how_found, editing ? "" : "required"))}${field("Status", "status", select("status", STATUSES, shown.status ?? "roster"))}${field("Client type", "client_type", select("client_type", types, shown.client_type))}${field("Practice type", "vertical", input("vertical", shown.vertical, 'autocomplete="off"'))}`;
  }

  function vendorFields(shown: Record<string, Value> = {}) {
    const stages = [["", "No stage"], ...withHeld(facetPairs(facets().stages), shown.stage)];
    const held = new Set(Array.isArray(shown.categories) ? shown.categories : []);
    const categories = withHeld(facetPairs(facets().categories), shown.categories)
      .map(
        ([slug = "", label]) =>
          `<label class="party-check"><input type="checkbox" name="categories" value="${escapeHtml(slug)}"${held.has(slug) ? " checked" : ""}>${escapeHtml(label)}</label>`,
      )
      .join("");
    return `<fieldset class="party-categories"><legend>Categories</legend>${categories || "<p>No categories yet.</p>"}</fieldset>${field("Stage", "stage", select("stage", stages, shown.stage))}${field("What they offer", "offers", textarea("offers", shown.offers))}`;
  }

  const formValue = (form: HTMLFormElement, name: string): Value =>
    name === "categories"
      ? valueFrom([...form.querySelectorAll<HTMLInputElement>('[name="categories"]:checked')].map((box) => box.value))
      : valueFrom(value(form, name));

  const roleValues = (form: HTMLFormElement, kind: Dataset): Record<string, unknown> =>
    kind === "clients"
      ? {
          how_found: value(form, "how_found") || null,
          status: value(form, "status"),
          client_type: value(form, "client_type") || null,
          vertical: value(form, "vertical") || null,
        }
      : {
          categories: [...form.querySelectorAll<HTMLInputElement>('[name="categories"]:checked')].map(
            (box) => box.value,
          ),
          stage: value(form, "stage") || null,
          offers: value(form, "offers") || null,
        };

  function openNew() {
    const kind = dataset();
    const noun = kind === "clients" ? "client" : "vendor";
    const body = `<fieldset class="party-kind"><legend>Person or company</legend><label class="party-check"><input type="radio" name="kind" value="company" checked>Company</label><label class="party-check"><input type="radio" name="kind" value="person">Person</label></fieldset>${contactFields()}${kind === "clients" ? clientFields() : vendorFields()}`;
    let partyId: string | null = null;
    let forceNew = false;
    const form = show(`New ${noun}`, body, `Save ${noun}`, async (form) => {
      if (!value(form, "name"))
        return refuse(form, { ok: false, problem: { error: "missing_required", fields: ["name"] } });
      if (!partyId) {
        const contact = Object.fromEntries(
          ["email", "phone", "city"].map((name) => [name, value(form, name)]).filter(([, text]) => text),
        );
        const party = await save("parties", "party", "party_id", {
          kind: form.querySelector<HTMLInputElement>('[name="kind"]:checked')?.value ?? "company",
          name: value(form, "name"),
          ...contact,
          ...(forceNew && { force_new: true }),
        });
        if (!party.ok) {
          const problem = problemOf(party.problem);
          return problem.error === "party_exists" && !party.pending ? offer(problem.candidates) : refuse(form, party);
        }
        partyId = String(party.data.party_id);
      }
      const values = Object.fromEntries(
        Object.entries(roleValues(form, kind)).filter(
          ([, item]) => item !== null && !(Array.isArray(item) && !item.length),
        ),
      );
      const role = await save(kind, "role", "party_id", { party_id: partyId, ...values });
      if (!role.ok) return refuse(form, role);
      done(partyId);
    });
    const candidates = form.querySelector<HTMLElement>("[data-candidates]");
    candidates?.addEventListener("click", (event) => {
      const choice = event.target instanceof Element ? event.target.closest<HTMLElement>("[data-use]") : null;
      if (!choice) return;
      if (choice.dataset.use === "new") forceNew = true;
      else partyId = choice.dataset.use ?? null;
      candidates.innerHTML = "";
      form.requestSubmit();
    });

    function offer(found: Candidate[]) {
      status(REFUSALS.party_exists ?? "");
      if (!candidates) return;
      candidates.innerHTML = `<p>Use an existing record, or keep this one separate.</p><ul class="party-candidates">${found
        .map(
          (candidate) =>
            `<li><button type="button" data-use="${escapeHtml(candidate.id)}">Use ${escapeHtml(candidate.name)}${candidate.city ? ` · ${escapeHtml(candidate.city)}` : ""}</button></li>`,
        )
        .join("")}<li><button type="button" data-use="new">Save as a separate record</button></li></ul>`;
    }
  }

  async function read(partyId: string) {
    const response = await fetch(`/api/engine/parties/${encodeURIComponent(partyId)}`, {
      headers: { accept: "application/json" },
      cache: "no-store",
      credentials: "same-origin",
    }).catch(() => null);
    const payload: unknown = response?.ok ? await response.json().catch(() => null) : null;
    return payload;
  }

  async function openEdit(partyId: string, button: HTMLButtonElement) {
    const kind = dataset();
    const idle = button.textContent;
    opening = true;
    button.disabled = true;
    button.textContent = "Opening…";
    const payload = await read(partyId);
    opening = false;
    button.disabled = false;
    button.textContent = idle;
    const contact = contactOf(payload);
    const profile = isRecord(payload) ? payload[kind === "clients" ? "client" : "vendor"] : null;
    if (!contact || !isRecord(profile)) {
      show("Edit", "<p>This record could not be opened for editing. Refresh and try again.</p>", "Close", async () =>
        dialog.close(),
      );
      return;
    }
    const fields = [...CONTACT, ...ROLE[kind]];
    // seen is each field as the engine holds it; shown is how the form shows it. A save sends seen as from.
    const seen: Record<string, Value> = {};
    const shown: Record<string, Value> = {};
    const hold = (name: string, raw: unknown) => {
      seen[name] = name === "categories" ? valueFrom(raw) : typeof raw === "string" ? raw : null;
      const held = valueFrom(raw);
      shown[name] =
        name === "phone" && typeof held === "string"
          ? phoneLabel(held)
          : name === "how_found" && held === "not_recorded"
            ? null
            : held;
    };
    for (const name of CONTACT) hold(name, contact[name]);
    for (const name of ROLE[kind]) hold(name, profile[name]);
    const touched = new Set<string>();
    const changes = (form: HTMLFormElement, names: string[]) =>
      Object.fromEntries(
        names
          .filter((name) => touched.has(name) && !same(formValue(form, name), shown[name] ?? null))
          .map((name) => [name, { from: seen[name] ?? null, to: formValue(form, name) }]),
      );
    const choices = [...STATUSES, ...HOW_FOUND, ...Object.values(facets()).flatMap(facetPairs)];
    const choice = (name: string, held: string) =>
      ["status", "how_found", "client_type", "stage", "categories"].includes(name)
        ? (choices.find(([slug]) => slug === held)?.[1] ?? humanized(held))
        : held;
    const label = (name: string, held: Value) =>
      `${LABELS[name] ?? name} ${held === null ? "blank" : Array.isArray(held) ? held.map((slug) => choice(name, slug)).join(", ") || "none" : choice(name, held)}`;
    // A conflict answers what the record holds now, so the next save replaces it on purpose.
    function conflict(form: HTMLFormElement, result: Refused) {
      const problem = problemOf(result.problem);
      if (problem.error !== "version_conflict" || !problem.current) return refuse(form, result);
      const current = problem.current;
      for (const name of problem.fields)
        hold(name, name === "phone" && isRecord(current.phone) ? current.phone.shown : current[name]);
      refuse(form, result);
      status(
        `Someone changed this since you opened it. Now: ${problem.fields.map((name) => label(name, shown[name] ?? null)).join("; ")}. Save again to replace it with what you entered.`,
      );
    }
    const body = `${contactFields(shown)}${kind === "clients" ? clientFields(shown, true) : vendorFields(shown)}`;
    const form = show(`Edit ${contact.name.trim() || "record"}`, body, "Save changes", async (form) => {
      const contactChanges = changes(form, CONTACT);
      if (contactChanges.name && !formValue(form, "name"))
        return refuse(form, { ok: false, problem: { error: "missing_required", fields: ["name"] } });
      if (Object.keys(contactChanges).length) {
        const answer = await save(`parties/${partyId}`, "contact", "party_id", contactChanges);
        if (!answer.ok) return conflict(form, answer);
        // The saved contact shows as the engine wrote it, so a retry of the profile alone does not resend it.
        const saved = contactOf(answer.data);
        for (const name of saved ? CONTACT : []) {
          hold(name, saved?.[name]);
          const control = form.elements.namedItem(name);
          if (control instanceof HTMLInputElement) control.value = String(shown[name] ?? "");
        }
      }
      const roleChanges = changes(form, ROLE[kind]);
      if (Object.keys(roleChanges).length) {
        const answer = await save(`${kind}/${partyId}`, "role", "party_id", roleChanges);
        if (!answer.ok) return conflict(form, answer);
      }
      done(partyId);
    });
    form.addEventListener("input", (event) => {
      const target = event.target;
      if (
        target instanceof HTMLInputElement ||
        target instanceof HTMLSelectElement ||
        target instanceof HTMLTextAreaElement
      )
        if (fields.includes(target.name)) touched.add(target.name);
    });
  }

  function openLink(partyId: string, name: string) {
    const body = `${field("Link", "kind", select("kind", LINKS, "knows"))}${field("Find a person or company", "query", input("query", "", 'type="search" autocomplete="off" maxlength="100"'))}<ul class="party-results" data-results></ul>${field("Since", "started_on", input("started_on", "", 'type="date"'))}${field("Note", "note", textarea("note"))}`;
    let other: string | null = null;
    let searchTimer = 0;
    const form = show(`Link ${name.trim() || "this record"} to someone`, body, "Save link", async (form) => {
      if (!other) return refuse(form, { ok: false, problem: { error: "missing_required", fields: ["query"] } });
      const answer = await save("party-links", "link", "link_id", {
        kind: value(form, "kind"),
        party_id: partyId,
        other_party_id: other,
        ...(value(form, "started_on") && { started_on: value(form, "started_on") }),
        ...(value(form, "note") && { note: value(form, "note") }),
      });
      if (!answer.ok) return refuse(form, answer);
      done(partyId);
    });
    const results = form.querySelector<HTMLElement>("[data-results]");
    form.querySelector('[name="query"]')?.addEventListener("input", () => {
      other = null;
      clearTimeout(searchTimer);
      const query = value(form, "query");
      // eslint-disable-next-line no-restricted-syntax -- One search after each 250 ms pause in typing.
      searchTimer = window.setTimeout(async () => {
        if (!results) return;
        if (!query) {
          results.innerHTML = "";
          return;
        }
        const response = await fetch(`/api/engine/parties/search?${new URLSearchParams({ query })}`, {
          headers: { accept: "application/json" },
          credentials: "same-origin",
        }).catch(() => null);
        const payload: unknown = response?.ok ? await response.json().catch(() => null) : null;
        if (value(form, "query") !== query) return;
        const parties = isRecord(payload) && Array.isArray(payload.parties) ? payload.parties.filter(isRecord) : null;
        results.innerHTML =
          parties === null
            ? "<li>Search is unavailable. Try again.</li>"
            : parties
                .filter((party) => typeof party.id === "string" && party.id !== partyId)
                .map(
                  (party) =>
                    `<li><label class="party-check"><input type="radio" name="other" value="${escapeHtml(party.id)}">${escapeHtml(party.display_name)}${party.city ? ` · ${escapeHtml(party.city)}` : ""}</label></li>`,
                )
                .join("") || "<li>No matches.</li>";
      }, 250);
    });
    results?.addEventListener("change", (event) => {
      if (event.target instanceof HTMLInputElement) other = event.target.value;
    });
  }

  return {
    setDataset(kind: Dataset) {
      newButton.textContent = kind === "clients" ? "New client" : "New vendor";
    },
    actionsHtml() {
      return '<div class="party-record-actions"><button type="button" class="action secondary-action" data-party-edit>Edit</button><button type="button" class="action secondary-action" data-party-link>Link to someone</button></div>';
    },
    edit(partyId: string, button: HTMLButtonElement) {
      if (!opening && !dialog.open) void openEdit(partyId, button);
    },
    link(partyId: string, name: string) {
      if (!dialog.open) openLink(partyId, name);
    },
  };
}
