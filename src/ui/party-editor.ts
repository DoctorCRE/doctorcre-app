// Add, edit and link people, clients and vendors through the engine's party doors.

type Dataset = "clients" | "vendors";
type Facet = { slug: string; label: string };
type Problem = { error?: string; fields?: string[]; candidates?: Candidate[] };
type Candidate = { id: string; name: string; city: string | null };
type SaveResult =
  | { ok: true; data: Record<string, unknown> }
  | { ok: false; problem?: Problem | null; pending?: boolean };
type Saver = {
  savePartnerRecord(path: string, key: string, receipt: string, args: Record<string, unknown>): Promise<SaveResult>;
};
type Phone = { shown: string } | null;
type Contact = { name: string; email: string | null; phone: Phone; city: string | null };
type Profile = Record<string, unknown>;
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
const LEVELS = [
  ["", "Not judged"],
  ["0", "Prospective"],
  ["1", "Building"],
  ["2", "Established"],
  ["3", "Core"],
];
const LINKS = [
  ["knows", "Knows"],
  ["can_introduce", "Can introduce us to"],
];
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
const CONTACT: ("name" | "email" | "phone" | "city")[] = ["name", "email", "phone", "city"];
const REFUSALS: Record<string, string> = {
  party_exists: "A record like this already exists.",
  already_client: "This record is already a client.",
  already_vendor: "This record is already a vendor.",
  already_linked: "These two are already linked.",
  version_conflict: "Someone changed this record since you opened it. Reopen it to see the latest.",
  invalid_field_value: "Check the highlighted fields.",
  missing_required: "Fill in the highlighted fields.",
  database_refused_the_statement:
    "This change breaks a rule for the record. A parked or avoided vendor needs a reason, and an avoided vendor cannot be a target.",
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
function contactOf(value: unknown): Contact | null {
  if (!isRecord(value) || typeof value.name !== "string") return null;
  const phone = isRecord(value.phone) && typeof value.phone.shown === "string" ? { shown: value.phone.shown } : null;
  return { name: value.name, email: textOrNull(value.email), phone, city: textOrNull(value.city) };
}
function problemOf(value: unknown): Problem {
  if (!isRecord(value)) return {};
  const fields = Array.isArray(value.fields) ? value.fields.filter((item) => typeof item === "string") : [];
  const candidates = Array.isArray(value.candidates)
    ? value.candidates.flatMap((item) =>
        isRecord(item) && typeof item.id === "string" && typeof item.name === "string"
          ? [{ id: item.id, name: item.name, city: textOrNull(item.city) }]
          : [],
      )
    : [];
  return { ...(typeof value.error === "string" && { error: value.error }), fields, candidates };
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
    dialog.innerHTML = `<form novalidate><header><h2 id="partyEditorTitle" tabindex="-1">${escapeHtml(title)}</h2><button type="button" class="party-close" data-close aria-label="Close">×</button></header>${body}<div data-candidates></div><p class="party-status" role="status" data-status></p><div class="party-actions"><button type="submit" class="party-submit">${escapeHtml(submit)}</button></div></form>`;
    const form = dialog.querySelector("form");
    if (!form) throw Error("Editor form unavailable");
    dialog.querySelector("[data-close]")?.addEventListener("click", () => dialog.close());
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

  function refuse(form: HTMLFormElement, result: { problem?: Problem | null; pending?: boolean }) {
    const problem = problemOf(result.problem);
    for (const name of problem.fields ?? []) {
      const control = form.elements.namedItem(name);
      if (control instanceof Element) control.setAttribute("aria-invalid", "true");
    }
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

  const contactFields = (record?: Contact) =>
    `${field("Name", "name", input("name", record?.name, 'required maxlength="200" autocomplete="off"'))}${field("Email", "email", input("email", record?.email, 'type="email" autocomplete="off"'))}${field("Phone", "phone", input("phone", record?.phone ? phoneLabel(record.phone.shown) : "", 'type="tel" autocomplete="off"'))}${field("City", "city", input("city", record?.city, 'autocomplete="off"'))}`;

  function clientFields(profile: Profile = {}, needsHowFound = true) {
    const types = [["", "Not set"], ...facetPairs(facets().types)];
    const howFound = [["", needsHowFound ? "Choose how they were found" : "Not recorded"], ...HOW_FOUND];
    return `${field("How found", "how_found", select("how_found", howFound, profile.how_found, needsHowFound ? "required" : ""))}${field("Status", "status", select("status", STATUSES, profile.status ?? "roster"))}${field("Client type", "client_type", select("client_type", types, profile.client_type))}${field("Practice type", "vertical", input("vertical", profile.vertical, 'autocomplete="off"'))}`;
  }

  function vendorFields(profile: Profile = {}) {
    const stages = [["", "No stage"], ...facetPairs(facets().stages)];
    const held = new Set(Array.isArray(profile.categories) ? profile.categories : []);
    const categories = facetPairs(facets().categories)
      .map(
        ([slug, label]) =>
          `<label class="party-check"><input type="checkbox" name="categories" value="${escapeHtml(slug)}"${held.has(slug) ? " checked" : ""}>${escapeHtml(label)}</label>`,
      )
      .join("");
    return `<fieldset class="party-categories"><legend>Categories</legend>${categories || "<p>No categories yet.</p>"}</fieldset>${field("Stage", "stage", select("stage", stages, profile.stage))}${field("Relationship level", "relationship_level", select("relationship_level", LEVELS, profile.relationship_level ?? ""))}${field("What they offer", "offers", textarea("offers", profile.offers ?? ""))}`;
  }

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
          relationship_level:
            value(form, "relationship_level") === "" ? null : Number(value(form, "relationship_level")),
          offers: value(form, "offers") || null,
        };

  function openNew() {
    const kind = dataset();
    const noun = kind === "clients" ? "client" : "vendor";
    const body = `<fieldset class="party-kind"><legend>Person or company</legend><label class="party-check"><input type="radio" name="kind" value="company" checked>Company</label><label class="party-check"><input type="radio" name="kind" value="person">Person</label></fieldset>${contactFields()}${kind === "clients" ? clientFields() : vendorFields()}`;
    let partyId: string | null = null;
    let forceNew = false;
    const form = show(`New ${noun}`, body, `Save ${noun}`, async (form) => {
      if (!value(form, "name")) return refuse(form, { problem: { error: "missing_required", fields: ["name"] } });
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
          return problem.error === "party_exists" && !party.pending
            ? offer(problem.candidates ?? [])
            : refuse(form, party);
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

  async function openEdit(partyId: string) {
    const kind = dataset();
    const response = await fetch(`/api/engine/parties/${encodeURIComponent(partyId)}`, {
      headers: { accept: "application/json" },
      cache: "no-store",
      credentials: "same-origin",
    }).catch(() => null);
    const payload: unknown = response?.ok ? await response.json().catch(() => null) : null;
    const record = contactOf(payload);
    const profile = isRecord(payload) ? payload[kind === "clients" ? "client" : "vendor"] : null;
    if (!record || !isRecord(profile)) {
      show("Edit", "<p>This record could not be opened for editing. Refresh and try again.</p>", "Close", async () =>
        dialog.close(),
      );
      return;
    }
    let seen: Record<string, string | null> = {};
    let shown: Record<string, string | null> = {};
    const remember = (saved: Contact) => {
      seen = { name: saved.name, email: saved.email, phone: saved.phone?.shown ?? null, city: saved.city };
      shown = { ...seen, phone: saved.phone ? phoneLabel(saved.phone.shown) : null };
    };
    remember(record);
    const needsHowFound = !profile.how_found || profile.how_found === "not_recorded";
    const body = `${contactFields(record)}${kind === "clients" ? clientFields(profile, false) : vendorFields(profile)}`;
    show(`Edit ${record.name.trim() || "record"}`, body, "Save changes", async (form) => {
      const contact = Object.fromEntries(
        CONTACT.filter((name) => value(form, name) !== (shown[name] ?? "")).map((name) => [
          name,
          { from: seen[name] ?? null, to: value(form, name) || null },
        ]),
      );
      if (contact.name && !value(form, "name"))
        return refuse(form, { problem: { error: "missing_required", fields: ["name"] } });
      const values = roleValues(form, kind);
      if (needsHowFound && !values.how_found) delete values.how_found;
      const role = Object.fromEntries(
        Object.entries(values)
          .filter(
            ([name, item]) =>
              JSON.stringify(item) !== JSON.stringify(profile[name] ?? (name === "categories" ? [] : null)),
          )
          .map(([name, item]) => [name, { from: profile[name] ?? null, to: item }]),
      );
      if (Object.keys(contact).length) {
        const answer = await save(`parties/${partyId}`, "contact", "party_id", contact);
        if (!answer.ok) return refuse(form, answer);
        // A later retry of the profile alone must not resend the contact it already saved.
        remember(contactOf({ ...record, ...answer.data }) ?? record);
        for (const name of CONTACT) {
          const control = form.elements.namedItem(name);
          if (control instanceof HTMLInputElement) control.value = shown[name] ?? "";
        }
      }
      if (Object.keys(role).length) {
        const answer = await save(`${kind}/${partyId}`, "role", "party_id", role);
        if (!answer.ok) return refuse(form, answer);
      }
      done(partyId);
    });
  }

  function openLink(partyId: string, name: string) {
    const body = `${field("Link", "kind", select("kind", LINKS, "knows"))}${field("Find a person or company", "query", input("query", "", 'type="search" autocomplete="off" maxlength="100"'))}<ul class="party-results" data-results></ul>${field("Since", "started_on", input("started_on", "", 'type="date"'))}${field("Note", "note", textarea("note"))}`;
    let other: string | null = null;
    let searchTimer = 0;
    const form = show(`Link ${name.trim() || "this record"} to someone`, body, "Save link", async (form) => {
      if (!other) return refuse(form, { problem: { error: "missing_required", fields: ["query"] } });
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
    handle(event: Event, partyId: string, name: string) {
      const target = event.target instanceof Element ? event.target : null;
      if (target?.closest("[data-party-edit]")) {
        void openEdit(partyId);
        return true;
      }
      if (target?.closest("[data-party-link]")) {
        openLink(partyId, name);
        return true;
      }
      return false;
    },
  };
}
