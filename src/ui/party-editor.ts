// Add clients and vendors through the engine's party doors.

import { showToast } from "../../js/toast.js";

type Dataset = "clients" | "vendors";
type Facet = { slug: string; label: string };
type Candidate = { id: string; name: string; city: string | null };
type Problem = { error?: string; fields: string[]; candidates: Candidate[] };
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
const REFUSALS: Record<string, string> = {
  party_exists: "A record like this already exists.",
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
  return { ...(typeof value.error === "string" && { error: value.error }), fields, candidates };
}

export function mountPartyEditor({ document, client, dataset, facets, saved }: Options) {
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

  function done(partyId: string, message?: string) {
    dialog.close();
    saved(partyId);
    if (message) showToast(message);
  }

  const contactFields = () =>
    `${field("Name", "name", input("name", "", 'required maxlength="200" autocomplete="off"'))}${field("Email", "email", input("email", "", 'type="email" autocomplete="off"'))}${field("Phone", "phone", input("phone", "", 'type="tel" autocomplete="off"'))}${field("City", "city", input("city", "", 'autocomplete="off"'))}`;

  function clientFields() {
    const types = [["", "Not set"], ...facetPairs(facets().types)];
    const howFound = [["", "Choose how they were found"], ...HOW_FOUND];
    return `${field("How found", "how_found", select("how_found", howFound, "", "required"))}${field("Status", "status", select("status", STATUSES, "roster"))}${field("Client type", "client_type", select("client_type", types, ""))}${field("Practice type", "vertical", input("vertical", "", 'autocomplete="off"'))}`;
  }

  function vendorFields() {
    const stages = [["", "No stage"], ...facetPairs(facets().stages)];
    const categories = facetPairs(facets().categories)
      .map(
        ([slug, label]) =>
          `<label class="party-check"><input type="checkbox" name="categories" value="${escapeHtml(slug)}">${escapeHtml(label)}</label>`,
      )
      .join("");
    return `<fieldset class="party-categories"><legend>Categories</legend>${categories || "<p>No categories yet.</p>"}</fieldset>${field("Stage", "stage", select("stage", stages, ""))}${field("What they offer", "offers", textarea("offers"))}`;
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
          offers: value(form, "offers") || null,
        };

  function openNew() {
    const kind = dataset();
    const noun = kind === "clients" ? "client" : "vendor";
    const body = `<fieldset class="party-kind"><legend>Person or company</legend><label class="party-check"><input type="radio" name="kind" value="company" checked>Company</label><label class="party-check"><input type="radio" name="kind" value="person">Person</label></fieldset>${contactFields()}${kind === "clients" ? clientFields() : vendorFields()}`;
    let partyId: string | null = null;
    let forceNew = false;
    const form = show(`New ${noun}`, body, `Save ${noun}`, async (form) => {
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
          return problem.error === "party_exists" && !party.pending
            ? offer(problem.candidates, contact)
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
      if (role.ok) return done(partyId);
      // The chosen record, or the one an unconfirmed save already made, holds the role, so open it.
      if (!role.pending && problemOf(role.problem).error === `already_${noun}`)
        return done(partyId, `This record is already a ${noun}, so it is open now.`);
      refuse(form, role);
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

    function offer(found: Candidate[], contact: Record<string, string>) {
      status(REFUSALS.party_exists ?? "");
      if (!candidates) return;
      const left = Object.keys(contact).length
        ? "<p>An existing record keeps its own email, phone and city, not the ones typed here.</p>"
        : "";
      candidates.innerHTML = `<p>Use an existing record, or keep this one separate.</p>${left}<ul class="party-candidates">${found
        .map(
          (candidate) =>
            `<li><button type="button" data-use="${escapeHtml(candidate.id)}">Use ${escapeHtml(candidate.name)}${candidate.city ? ` · ${escapeHtml(candidate.city)}` : ""}</button></li>`,
        )
        .join("")}<li><button type="button" data-use="new">Save as a separate record</button></li></ul>`;
    }
  }

  return {
    setDataset(kind: Dataset) {
      newButton.textContent = kind === "clients" ? "New client" : "New vendor";
    },
  };
}
