import { type FormEvent, useEffect, useRef, useState } from "react";
import {
  type Partner,
  type ProspectClient,
  ProspectSaveFeedback,
  partners,
  prospectsPath,
  useProspectSave,
  uuid,
} from "./prospect-saves";

const kinds = [
  { value: "person", label: "Person" },
  { value: "company", label: "Company" },
] as const;
type PartyKind = (typeof kinds)[number]["value"];
type Match = { id: string; display_name: string; kind: PartyKind };
const isId = (value: unknown): value is string => typeof value === "string" && uuid.test(value);
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object";
function isMatch(value: unknown): value is Match {
  return (
    object(value) &&
    isId(value.id) &&
    typeof value.display_name === "string" &&
    kinds.some((kind) => kind.value === value.kind)
  );
}

type PartyRequest = ProspectClient["prospectRequest"];

async function searchParties(request: PartyRequest, query: string, signal: AbortSignal, clientsOnly = false) {
  const params = new URLSearchParams({ query });
  if (clientsOnly) params.set("role", "client");
  const path = clientsOnly ? "/api/engine/parties/search" : `${prospectsPath}/search`;
  const response = await request(`${path}?${params}`, { signal });
  if (!response.ok) throw new Error("Party search unavailable");
  const data: unknown = await response.json();
  return object(data) && Array.isArray(data.parties) ? data.parties.filter(isMatch) : [];
}

type PickedClient = { id: string; name: string };
type LeaseDate = (date: string | null) => string | null;
type DealClientPickerProps = { request: PartyRequest; onPick: () => void; leaseDate: LeaseDate } & (
  | { prospect: { party_id: string; name: string }; client?: never }
  | { prospect?: never; client?: PickedClient }
);

export function DealClientPicker({ prospect, client, request, leaseDate, onPick }: DealClientPickerProps) {
  const [name, setName] = useState(client?.name ?? "");
  const [picked, setPicked] = useState(client);
  const [matches, setMatches] = useState<Match[]>();
  const [unavailable, setUnavailable] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const query = name.trim();
    if (!query || picked) return;
    const controller = new AbortController();
    void searchParties(request, query, controller.signal, !prospect).then(
      (found) => {
        if (!controller.signal.aborted) setMatches(found);
      },
      () => {
        if (!controller.signal.aborted) setUnavailable(true);
      },
    );
    return () => controller.abort();
  }, [name, picked, prospect, request]);

  function select(id: string, name: string) {
    setPicked({ id, name });
    setName(name);
    setMatches(undefined);
    setUnavailable(false);
    onPick();
    input.current?.focus();
  }

  return (
    <div className="field">
      <label htmlFor="prospectDealClient">Client</label>
      <input
        ref={input}
        id="prospectDealClient"
        name="client"
        aria-describedby="prospectDealClientHint"
        maxLength={100}
        required
        value={name}
        onChange={(event) => {
          setName(event.currentTarget.value);
          setPicked(undefined);
          setMatches(undefined);
          setUnavailable(false);
        }}
      />
      <input type="hidden" name="client_id" value={picked?.id ?? ""} />
      <small id="prospectDealClientHint">
        {prospect ? "Search for a person or company, or use the prospect." : "Search for an existing client by name."}
      </small>
      {prospect && (
        <button type="button" className="btn" onClick={() => select(prospect.party_id, prospect.name)}>
          Use {prospect.name} as client
        </button>
      )}
      {matches && matches.length > 0 && (
        <ul className="prospect-client-matches" aria-label="Matching people and companies">
          {matches.map((match) => {
            const sameName = matches.filter(
              (other) =>
                other.display_name.toLowerCase() === match.display_name.toLowerCase() && other.kind === match.kind,
            );
            return (
              <li key={match.id}>
                <button type="button" className="btn" onClick={() => select(match.id, match.display_name)}>
                  {match.display_name} · {match.kind === "person" ? "Person" : "Company"}
                  {sameName.length > 1 && (prospect ? ` · ${match.id}` : ` · Match ${sameName.indexOf(match) + 1}`)}
                </button>
              </li>
            );
          })}
        </ul>
      )}
      {matches?.length === 0 && (
        <small role="status">{prospect ? "No matching people or companies." : "No matching clients."}</small>
      )}
      {unavailable && <small role="status">Search is unavailable. Try again.</small>}
      <DealTerms client={picked} request={request} leaseDate={leaseDate} />
    </div>
  );
}

function DealTerms({
  client,
  request,
  leaseDate,
}: {
  client: PickedClient | undefined;
  request: PartyRequest;
  leaseDate: LeaseDate;
}) {
  const [reason, setReason] = useState("");
  return (
    <>
      <div className="field-grid">
        <div className="field">
          <label htmlFor="addDealKind">Deal kind</label>
          <select id="addDealKind" name="kind">
            <option value="">Unknown</option>
            <option value="lease">Lease</option>
            <option value="purchase">Purchase</option>
            <option value="sale_leaseback">Sale-leaseback</option>
            <option value="build_to_suit">Build-to-suit</option>
            <option value="other">Other</option>
          </select>
        </div>
        <div className="field">
          <label htmlFor="addDealReason">Deal reason</label>
          <select
            id="addDealReason"
            name="reason"
            value={reason}
            onChange={(event) => setReason(event.currentTarget.value)}
          >
            <option value="">Unknown</option>
            <option value="start_up">Start-up</option>
            <option value="relocation">Relocation</option>
            <option value="expansion">Expansion</option>
            <option value="renewal">Renewal</option>
            <option value="additional_office">Additional office</option>
          </select>
        </div>
      </div>
      {reason === "renewal" &&
        (client ? (
          <RenewalLease key={client.id} clientId={client.id} request={request} leaseDate={leaseDate} />
        ) : (
          <small role="status">Choose a client to see their leases.</small>
        ))}
    </>
  );
}

type Lease = { lease_id: string; address: string; expiration_on: string | null };
type LeaseChoices = { kind: "loading" | "unavailable" } | { kind: "ready"; leases: Lease[] };
function isLease(value: unknown): value is Lease {
  return (
    object(value) &&
    isId(value.lease_id) &&
    typeof value.address === "string" &&
    (value.expiration_on === null || typeof value.expiration_on === "string")
  );
}

function RenewalLease({
  clientId,
  request,
  leaseDate,
}: {
  clientId: string;
  request: PartyRequest;
  leaseDate: LeaseDate;
}) {
  const [choices, setChoices] = useState<LeaseChoices>({ kind: "loading" });
  useEffect(() => {
    if (choices.kind !== "loading") return;
    const controller = new AbortController();
    async function read() {
      try {
        const response = await request(`/api/engine/clients/${encodeURIComponent(clientId)}/leases`, {
          signal: controller.signal,
        });
        const data: unknown = response.ok ? await response.json() : null;
        if (!Array.isArray(data) || !data.every(isLease)) throw new Error("Lease list unavailable");
        if (!controller.signal.aborted) setChoices({ kind: "ready", leases: data });
      } catch {
        if (!controller.signal.aborted) setChoices({ kind: "unavailable" });
      }
    }
    void read();
    return () => controller.abort();
  }, [choices.kind, clientId, request]);

  return (
    <div className="field">
      <label htmlFor="renewalLease">Lease to renew</label>
      <select id="renewalLease" name="renews_lease_id" required defaultValue="">
        <option value="">Choose a lease</option>
        {choices.kind === "ready" &&
          choices.leases.map((lease) => {
            const expires = leaseDate(lease.expiration_on);
            return (
              <option key={lease.lease_id} value={lease.lease_id}>
                {lease.address} · {expires ? `Expires ${expires}` : "Expiration not recorded"}
              </option>
            );
          })}
      </select>
      {choices.kind === "loading" && <small role="status">Finding leases…</small>}
      {choices.kind === "ready" && choices.leases.length === 0 && (
        <small role="status">No leases found for this client.</small>
      )}
      {choices.kind === "unavailable" && (
        <>
          <small role="status">Could not load leases.</small>
          <button type="button" className="btn" onClick={() => setChoices({ kind: "loading" })}>
            Retry
          </button>
        </>
      )}
    </div>
  );
}

type AddProps = {
  client: ProspectClient;
  sources: Record<string, string>;
  refresh: () => void;
  addDeal: (client: { id: string; name: string }) => void;
};
export function AddProspect({ client, sources, refresh, addDeal }: AddProps) {
  const [name, setName] = useState("");
  const [kind, setKind] = useState<PartyKind>();
  const [found, setFound] = useState("");
  const [picked, pick] = useState<Match>();
  const [matches, setMatches] = useState<Match[]>([]);
  const [message, setMessage] = useState("");
  const form = useRef<HTMLFormElement>(null);
  const save = useProspectSave(client, prospectsPath, "add", "party_id", () => {
    form.current?.reset();
    setName("");
    setKind(undefined);
    setFound("");
    pick(undefined);
    setMatches([]);
    setMessage("Prospect saved");
    refresh();
  });
  useEffect(() => {
    const query = name.trim();
    if (picked || !query) return;
    const controller = new AbortController();
    void searchParties(client.prospectRequest, query, controller.signal)
      .then((found) => {
        if (!controller.signal.aborted) setMatches(found);
      })
      .catch(() => {
        if (!controller.signal.aborted) setMatches([]);
      });
    return () => controller.abort();
  }, [name, picked, client]);
  const choosingKind = !picked && Boolean(name.trim());
  const problem = save.state.kind === "refused" ? save.state.problem : null;
  const missingFound =
    problem?.error === "missing_required" && Array.isArray(problem.fields) && problem.fields.includes("how_found");
  const dealIds =
    problem?.error === "not_a_prospect" && Array.isArray(problem.deal_ids) ? problem.deal_ids.filter(isId) : [];
  const clientId = problem?.error === "already_client" && isId(problem.party_id) ? problem.party_id : null;

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!name.trim()) {
      setMessage("Enter a prospect name.");
      return;
    }
    if (!picked && !kind) {
      setMessage("Choose Person or Company.");
      return;
    }
    setMessage("");
    const party = picked ? { party_id: picked.id } : { name: name.trim(), kind };
    const note = String(new FormData(event.currentTarget).get("note") ?? "").trim();
    void save.send({ ...party, ...(found && { how_found: found }), ...(note && { note }) });
  }

  return (
    <form ref={form} className="prospect-add field" onSubmit={submit} onFocus={() => setMessage("")}>
      <input
        aria-label="Prospect name"
        placeholder="Name"
        maxLength={100}
        value={name}
        disabled={save.blocked}
        onChange={(event) => {
          setName(event.currentTarget.value);
          if (picked) setFound("");
          pick(undefined);
          setMatches([]);
          setMessage("");
          save.clear();
        }}
        required
      />
      <input name="note" aria-label="Optional first note" placeholder="Note" disabled={save.blocked} />
      {choosingKind && (
        <fieldset className="prospect-kind" aria-label="Person or company" disabled={save.blocked}>
          {kinds.map(({ value, label }) => (
            <button
              key={value}
              className="btn"
              type="button"
              aria-pressed={kind === value}
              onClick={() => setKind(value)}
            >
              {label}
            </button>
          ))}
        </fieldset>
      )}
      {(choosingKind || found || missingFound) && (
        <select
          aria-label="How found"
          value={found}
          required
          disabled={save.blocked}
          onChange={(event) => setFound(event.currentTarget.value)}
        >
          <option value="">How found</option>
          {Object.entries(sources)
            .filter(([value]) => value !== "not_recorded")
            .map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
        </select>
      )}
      <button className="btn" type="submit" disabled={save.blocked}>
        Add prospect
      </button>
      {!picked && matches.length > 0 && (
        <ul aria-label="Matching people and companies">
          {matches.map((match) => (
            <li key={match.id}>
              <button
                type="button"
                className="btn"
                disabled={save.blocked}
                onClick={() => {
                  pick(match);
                  setName(match.display_name);
                  setFound("");
                  save.clear();
                }}
              >
                {match.display_name} · {match.kind}
              </button>
            </li>
          ))}
        </ul>
      )}
      {message && <p role="status">{message}</p>}
      {dealIds.length > 0 ? (
        <p role="alert">
          Already on a deal.{" "}
          {dealIds.map((id, index) => (
            <a key={id} href={`/deals?deal=${id}`}>
              {dealIds.length === 1 ? "Open deal" : `Open deal ${index + 1}`}
            </a>
          ))}
        </p>
      ) : clientId ? (
        <p role="alert">
          Already a client.{" "}
          <button type="button" className="btn" onClick={() => addDeal({ id: clientId, name })}>
            Add deal
          </button>
        </p>
      ) : missingFound ? (
        <p role="alert">Choose how you found this prospect.</p>
      ) : (
        <ProspectSaveFeedback save={save} />
      )}
    </form>
  );
}

type VersionedProspect = { party_id: string; owner: Partner | null; needs_attention: boolean; change_id: number };
type ManageProps = {
  row: VersionedProspect;
  actor: Partner;
  client: ProspectClient;
  saved: () => void;
  reload: () => void;
  drop: () => void;
  turnIntoDeal: () => void;
};
export function ManageProspect({ row, actor, client, saved, reload, drop, turnIntoDeal }: ManageProps) {
  const [dropping, setDropping] = useState(false);
  const id = row.party_id;
  const changes = useProspectSave(client, `${prospectsPath}/${id}/changes`, `${id}:changes`, "party_id", saved);
  const archive = useProspectSave(client, `${prospectsPath}/${id}/drop`, `${id}:drop`, "party_id", drop);
  const blocked = changes.blocked || archive.blocked;
  const other = actor === "joe" ? "dell" : "joe";
  const change = (fields: { owner: Partner | null } | { needs_attention: boolean }) =>
    void changes.send({ seen_change_id: row.change_id, fields });
  function dropProspect(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const reason = String(new FormData(event.currentTarget).get("reason") ?? "").trim();
    if (reason) void archive.send({ reason });
  }
  const claim = !row.owner ? "Claim" : row.owner === actor ? `Hand off to ${partners[other]}` : "Take ownership";
  const attention = row.needs_attention ? "Clear needs attention" : "Mark needs attention";
  function action(label: string, onClick: () => void, expanded?: boolean) {
    return (
      <button type="button" className="btn" disabled={blocked} onClick={onClick} aria-expanded={expanded}>
        {label}
      </button>
    );
  }
  return (
    <>
      <div className="prospect-management">
        {action(claim, () => change({ owner: row.owner === actor ? other : actor }))}
        {row.owner && action("Unclaim", () => change({ owner: null }))}
        {action(attention, () => change({ needs_attention: !row.needs_attention }))}
        {action("Turn into deal", turnIntoDeal)}
        {action("Drop prospect", () => setDropping(!dropping), dropping)}
      </div>
      <ProspectSaveFeedback save={changes} reload={reload} />
      {dropping && (
        <form className="field" onSubmit={dropProspect}>
          <label>
            Reason
            <input name="reason" required disabled={blocked} />
          </label>
          <button type="submit" className="btn" disabled={blocked}>
            Confirm drop
          </button>
        </form>
      )}
      <ProspectSaveFeedback save={archive} />
    </>
  );
}
