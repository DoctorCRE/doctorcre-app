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

async function searchParties(request: ProspectClient["prospectRequest"], query: string, signal: AbortSignal) {
  const response = await request(`${prospectsPath}/search?query=${encodeURIComponent(query)}`, { signal });
  if (!response.ok) throw new Error("Party search unavailable");
  const data: unknown = await response.json();
  return object(data) && Array.isArray(data.parties) ? data.parties.filter(isMatch) : [];
}

export function DealClientPicker({
  prospect,
  request,
}: {
  prospect: { party_id: string; name: string };
  request: ProspectClient["prospectRequest"];
}) {
  const [name, setName] = useState("");
  const [clientId, setClientId] = useState("");
  const [matches, setMatches] = useState<Match[]>();
  const [unavailable, setUnavailable] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const query = name.trim();
    if (!query || clientId) return;
    const controller = new AbortController();
    void searchParties(request, query, controller.signal).then(
      (found) => {
        if (!controller.signal.aborted) setMatches(found);
      },
      () => {
        if (!controller.signal.aborted) setUnavailable(true);
      },
    );
    return () => controller.abort();
  }, [name, clientId, request]);

  function select(id: string, name: string) {
    setClientId(id);
    setName(name);
    setMatches(undefined);
    setUnavailable(false);
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
          setClientId("");
          setMatches(undefined);
          setUnavailable(false);
        }}
      />
      <input type="hidden" name="client_id" value={clientId} />
      <small id="prospectDealClientHint">Search for a person or company, or use the prospect.</small>
      <button type="button" className="btn" onClick={() => select(prospect.party_id, prospect.name)}>
        Use {prospect.name} as client
      </button>
      {matches && matches.length > 0 && (
        <ul className="prospect-client-matches" aria-label="Matching people and companies">
          {matches.map((match) => {
            const duplicate = matches.some(
              (other) =>
                other.id !== match.id &&
                other.display_name.toLowerCase() === match.display_name.toLowerCase() &&
                other.kind === match.kind,
            );
            return (
              <li key={match.id}>
                <button type="button" className="btn" onClick={() => select(match.id, match.display_name)}>
                  {match.display_name} · {match.kind === "person" ? "Person" : "Company"}
                  {duplicate && ` · ${match.id}`}
                </button>
              </li>
            );
          })}
        </ul>
      )}
      {matches?.length === 0 && <small role="status">No matching people or companies.</small>}
      {unavailable && <small role="status">Search is unavailable. Try again.</small>}
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
