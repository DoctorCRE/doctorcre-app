// Add and edit clients and vendors through the engine's party doors.

import { showToast } from "../../js/toast.js";

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
  // Opens the saved record in the list that holds it.
  saved: (partyId: string, list: Dataset) => void;
  // The party the open record names, or null when none is open.
  recordParty: () => string | null;
  // The page's own phone format, so a number reads the same in the record and the editor.
  phoneLabel: (phone: string) => string;
};

const STATUSES = [
  ["roster", "Roster"],
  ["cold", "Cold"],
  ["engaged", "Engaged"],
  ["paused", "Paused"],
];
// No engine read lists these yet, so this copies the engine's how_found list; Not recorded is only for copied records.
const HOW_FOUND = [
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
const PROFILE = { clients: "client", vendors: "vendor" } as const;
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

// One open Edit: seen is each field as the engine holds it, shown is how the form shows it, and a change is a
// touched field whose value differs from shown. A save sends seen as from, so the engine can spot a conflict.
function editSession(phoneLabel: (phone: string) => string) {
  const seen: Record<string, Value> = {};
  const shown: Record<string, Value> = {};
  const touched = new Set<string>();
  return {
    shown,
    hold(name: string, raw: unknown) {
      seen[name] = name === "categories" ? valueFrom(raw) : typeof raw === "string" ? raw : null;
      const held = valueFrom(raw);
      shown[name] =
        name === "phone" && typeof held === "string"
          ? phoneLabel(held)
          : name === "how_found" && held === "not_recorded"
            ? null
            : held;
    },
    touch(name: string) {
      touched.add(name);
    },
    changes(names: string[], current: (name: string) => Value) {
      return Object.fromEntries(
        names
          .filter((name) => touched.has(name) && !same(current(name), shown[name] ?? null))
          .map((name) => [name, { from: seen[name] ?? null, to: current(name) }]),
      );
    },
  };
}

export function mountPartyEditor({ document, client, dataset, facets, saved, recordParty, phoneLabel }: Options) {
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
  const editButton = () => document.querySelector<HTMLButtonElement>("[data-party-edit]");
  const editLabel = () => (opening ? "Opening…" : "Edit");
  // The record panel redraws on its own while Edit opens, so the button on the page now follows opening.
  function setOpening(next: boolean) {
    opening = next;
    const button = editButton();
    if (!button) return;
    button.disabled = opening;
    button.textContent = editLabel();
  }
  // A record panel that re-rendered while the dialog was open has a new Edit button, so focus goes there.
  dialog.addEventListener("close", () => {
    const back = trigger?.isConnected
      ? trigger
      : trigger?.matches("[data-party-edit]")
        ? document.querySelector("[data-party-edit]")
        : null;
    if (back instanceof HTMLElement) back.focus();
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

  function show(
    title: string,
    body: string,
    submit: string,
    onSubmit: (form: HTMLFormElement) => Promise<void>,
    from = document.activeElement,
  ) {
    trigger = from;
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
      for (const element of form.querySelectorAll("[aria-invalid]")) {
        element.removeAttribute("aria-invalid");
        element.removeAttribute("aria-describedby");
      }
      for (const message of form.querySelectorAll(".party-problem")) message.remove();
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
    const note = problem.error === "missing_required" ? "Fill this in." : "Check this value.";
    for (const name of problem.fields) {
      const control = form.querySelector(`#party-${CSS.escape(name)}`);
      if (!control) continue;
      const message = document.createElement("p");
      message.className = "party-problem";
      message.id = `party-${name}-problem`;
      message.textContent = note;
      control.after(message);
      control.setAttribute("aria-invalid", "true");
      control.setAttribute("aria-describedby", message.id);
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

  function done(partyId: string, message?: string, list = dataset()) {
    dialog.close();
    saved(partyId, list);
    if (message) showToast(message);
  }

  // Likely matches the engine found; choose gets the picked record, or null to keep this one separate.
  function offer(
    form: HTMLFormElement,
    found: Candidate[],
    text: { status: string; intro: string; use: string; separate: string },
    choose: (partyId: string | null) => void,
  ) {
    status(text.status);
    const box = form.querySelector<HTMLElement>("[data-candidates]");
    if (!box) return;
    box.innerHTML = `${text.intro}<ul class="party-candidates">${found
      .map(
        (candidate) =>
          `<li><button type="button" data-use="${escapeHtml(candidate.id)}">${text.use} ${escapeHtml(candidate.name)}${candidate.city ? ` · ${escapeHtml(candidate.city)}` : ""}</button></li>`,
      )
      .join("")}<li><button type="button" data-use="">${text.separate}</button></li></ul>`;
    // On a phone the choices fall below the fold, so the first one takes focus and scrolls into view.
    box.querySelector("button")?.focus();
    box.onclick = (event) => {
      const choice = event.target instanceof Element ? event.target.closest<HTMLElement>("[data-use]") : null;
      if (!choice) return;
      box.innerHTML = "";
      choose(choice.dataset.use || null);
    };
  }

  const contactFields = (shown: Record<string, Value> = {}) =>
    `${field("Name", "name", input("name", shown.name, 'required maxlength="200" autocomplete="off"'))}${field("Email", "email", input("email", shown.email, 'type="email" autocomplete="off"'))}${field("Phone", "phone", input("phone", shown.phone, 'type="tel" autocomplete="off"'))}${field("City", "city", input("city", shown.city, 'autocomplete="off"'))}`;

  // An edited record keeps a how found copied as Not recorded until a partner picks one; a partner never picks Not recorded.
  function clientFields(shown: Record<string, Value> = {}, editing = false) {
    const types = [["", "Not set"], ...withHeld(facetPairs(facets().types), shown.client_type)];
    const blank = !editing
      ? [["", "Choose how they were found"]]
      : shown.how_found === null
        ? [["", "Not recorded"]]
        : [];
    const howFound = [...blank, ...HOW_FOUND];
    const subtype = editing ? '<p class="party-hint">Changing the practice type clears the subtype.</p>' : "";
    return `${field("How found", "how_found", select("how_found", howFound, shown.how_found, editing ? "" : "required"))}${field("Status", "status", select("status", STATUSES, shown.status ?? "roster"))}${field("Client type", "client_type", select("client_type", types, shown.client_type))}${field("Practice type", "vertical", input("vertical", shown.vertical, 'autocomplete="off"'))}${subtype}`;
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

  const choiceLists = (): Record<string, string[][]> => ({
    status: STATUSES,
    how_found: HOW_FOUND,
    client_type: facetPairs(facets().types),
    stage: facetPairs(facets().stages),
    categories: facetPairs(facets().categories),
  });

  function openNew() {
    const kind = dataset();
    const noun = kind === "clients" ? "client" : "vendor";
    const body = `<fieldset class="party-kind"><legend>Person or company</legend><label class="party-check"><input type="radio" name="kind" value="company" checked>Company</label><label class="party-check"><input type="radio" name="kind" value="person">Person</label></fieldset>${contactFields()}${kind === "clients" ? clientFields() : vendorFields()}`;
    let partyId: string | null = null;
    let forceNew = false;
    show(`New ${noun}`, body, `Save ${noun}`, async (form) => {
      // How found is checked before the record exists, so a refused client save never leaves a record with no role.
      const missing = ["name", ...(kind === "clients" ? ["how_found"] : [])].filter((name) => !value(form, name));
      if (missing.length) return refuse(form, { ok: false, problem: { error: "missing_required", fields: missing } });
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
          if (problem.error !== "party_exists" || party.pending) return refuse(form, party);
          const left = Object.keys(contact).length
            ? "<p>An existing record keeps its own email, phone and city, not the ones typed here.</p>"
            : "";
          return offer(
            form,
            problem.candidates,
            {
              status: "A record like this already exists.",
              intro: `<p>Use an existing record, or keep this one separate.</p>${left}`,
              use: "Use",
              separate: "Save as a separate record",
            },
            (chosen) => {
              if (chosen) partyId = chosen;
              else forceNew = true;
              form.requestSubmit();
            },
          );
        }
        partyId = String(party.data.party_id);
      }
      const values = Object.fromEntries(
        ROLE[kind]
          .map((name) => [name, formValue(form, name)] as const)
          .filter(([, item]) => item !== null && !(Array.isArray(item) && !item.length)),
      );
      const role = await save(kind, "role", "party_id", { party_id: partyId, ...values });
      if (role.ok) return done(partyId);
      // The chosen record, or the one an unconfirmed save already made, holds the role, so open it.
      if (!role.pending && problemOf(role.problem).error === `already_${noun}`)
        return done(partyId, `This record is already a ${noun}, so it is open now.`);
      refuse(form, role);
    });
  }

  async function read(partyId: string): Promise<unknown> {
    const response = await fetch(`/api/engine/parties/${encodeURIComponent(partyId)}`, {
      headers: { accept: "application/json" },
      cache: "no-store",
      credentials: "same-origin",
    }).catch(() => null);
    return response?.ok ? response.json().catch(() => null) : null;
  }

  // Another record opens in the list that holds it, this one first.
  async function openOther(form: HTMLFormElement, partyId: string) {
    const payload = await read(partyId);
    const lists: Dataset[] = dataset() === "clients" ? ["clients", "vendors"] : ["vendors", "clients"];
    const list = lists.find((name) => isRecord(payload) && isRecord(payload[PROFILE[name]]));
    if (list) return done(partyId, undefined, list);
    if (dialog.open && form.isConnected) status("That record is not a client or vendor, so it cannot open here.");
  }

  async function openEdit(partyId: string) {
    const kind = dataset();
    setOpening(true);
    const payload = await read(partyId);
    setOpening(false);
    // The partner moved to another record while this one was opening.
    if (recordParty() !== partyId) return;
    const button = editButton();
    const contact = contactOf(payload);
    const profile = isRecord(payload) ? payload[PROFILE[kind]] : null;
    if (!contact || !isRecord(profile)) {
      show(
        "Edit",
        "<p>This record could not be opened for editing. Refresh and try again.</p>",
        "Close",
        async () => dialog.close(),
        button,
      );
      return;
    }
    const edit = editSession(phoneLabel);
    const { shown } = edit;
    for (const name of CONTACT) edit.hold(name, contact[name]);
    for (const name of ROLE[kind]) edit.hold(name, profile[name]);
    const changes = (form: HTMLFormElement, names: string[]) => edit.changes(names, (name) => formValue(form, name));
    const lists = choiceLists();
    const choice = (name: string, held: string) => {
      const list = lists[name];
      return list ? (list.find(([slug]) => slug === held)?.[1] ?? humanized(held)) : held;
    };
    const blank = (name: string) => (name === "how_found" ? "Not recorded" : "blank");
    const label = (name: string, held: Value) =>
      `${LABELS[name] ?? name} ${held === null ? blank(name) : Array.isArray(held) ? held.map((slug) => choice(name, slug)).join(", ") || "none" : choice(name, held)}`;
    // A conflict answers what the record holds now, so the next save replaces it on purpose.
    function conflict(form: HTMLFormElement, result: Refused) {
      const problem = problemOf(result.problem);
      if (problem.error !== "version_conflict" || !problem.current) return refuse(form, result);
      const current = problem.current;
      for (const name of problem.fields)
        edit.hold(name, name === "phone" && isRecord(current.phone) ? current.phone.shown : current[name]);
      refuse(form, result);
      status(
        `Someone changed this since you opened it. Now: ${problem.fields.map((name) => label(name, shown[name] ?? null)).join("; ")}. Save again to replace it with what you entered.`,
      );
    }
    const body = `${contactFields(shown)}${kind === "clients" ? clientFields(shown, true) : vendorFields(shown)}`;
    let keepEmail = false;
    let contactSaved = false;
    const editForm = show(
      `Edit ${contact.name.trim() || "record"}`,
      body,
      "Save changes",
      async (form) => {
        const contactChanges = changes(form, CONTACT);
        if (contactChanges.name && !formValue(form, "name"))
          return refuse(form, { ok: false, problem: { error: "missing_required", fields: ["name"] } });
        if (Object.keys(contactChanges).length) {
          const answer = await save(`parties/${partyId}`, "contact", "party_id", {
            ...contactChanges,
            ...(keepEmail && { force_new: true }),
          });
          if (!answer.ok) {
            const problem = problemOf(answer.problem);
            if (problem.error !== "party_exists" || answer.pending) return conflict(form, answer);
            return offer(
              form,
              problem.candidates,
              {
                status: "Another record has this email.",
                intro: "<p>Open that record, or keep this email here too.</p>",
                use: "Open",
                separate: "Keep this email",
              },
              (chosen) => {
                if (chosen) return void openOther(form, chosen);
                keepEmail = true;
                form.requestSubmit();
              },
            );
          }
          contactSaved = true;
          // The saved contact shows as the engine wrote it, so a retry of the profile alone does not resend it.
          const written = contactOf(answer.data);
          for (const name of written ? CONTACT : []) {
            edit.hold(name, written?.[name]);
            const control = form.elements.namedItem(name);
            if (control instanceof HTMLInputElement) control.value = String(shown[name] ?? "");
          }
        }
        const roleChanges = changes(form, ROLE[kind]);
        if (Object.keys(roleChanges).length) {
          const answer = await save(`${kind}/${partyId}`, "role", "party_id", roleChanges);
          if (!answer.ok) {
            // The contact already landed, so the record behind the dialog shows it.
            if (contactSaved) saved(partyId, kind);
            return conflict(form, answer);
          }
        }
        done(partyId);
      },
      button,
    );
    editForm.addEventListener("input", (event) => {
      const target = event.target;
      if (
        target instanceof HTMLInputElement ||
        target instanceof HTMLSelectElement ||
        target instanceof HTMLTextAreaElement
      ) {
        edit.touch(target.name);
        if (target.name === "email") keepEmail = false;
      }
    });
  }

  return {
    setDataset(kind: Dataset) {
      newButton.textContent = kind === "clients" ? "New client" : "New vendor";
    },
    actionsHtml() {
      return `<div class="party-record-actions"><button type="button" class="action secondary-action" data-party-edit${opening ? " disabled" : ""}>${editLabel()}</button></div>`;
    },
    edit() {
      const partyId = recordParty();
      if (partyId && !opening && !dialog.open) void openEdit(partyId);
    },
  };
}
