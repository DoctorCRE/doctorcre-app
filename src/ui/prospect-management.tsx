import { type FormEvent, useEffect, useState } from "react";
import { type ProspectClient, ProspectSaveFeedback, prospectsPath, useProspectSave } from "./prospect-saves";

type Partner = "joe" | "dell";
type Match = { id: string; display_name: string; kind: "person" | "company" };
type Client = { id: string; name: string };
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const isId = (value: unknown): value is string => typeof value === "string" && uuid.test(value);
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object";
function isMatch(value: unknown): value is Match {
  return (
    object(value) &&
    isId(value.id) &&
    typeof value.display_name === "string" &&
    (value.kind === "person" || value.kind === "company")
  );
}

export function AddProspect({
  client,
  sources,
  refresh,
  addDeal,
}: {
  client: ProspectClient;
  sources: Record<string, string>;
  refresh: () => void;
  addDeal: (client: Client) => void;
}) {
  const [name, setName] = useState("");
  const [note, setNote] = useState("");
  const [kind, setKind] = useState("");
  const [found, setFound] = useState("");
  const [picked, pick] = useState<Match>();
  const [matches, setMatches] = useState<Match[]>([]);
  const [message, setMessage] = useState("");
  const save = useProspectSave(client, prospectsPath, "add", "party_id", () => {
    setName("");
    setNote("");
    setKind("");
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
    void client
      .prospectRequest(`${prospectsPath}/search?query=${encodeURIComponent(query)}`, { signal: controller.signal })
      .then(async (response) => {
        const data: unknown = await response.json();
        if (response.ok && object(data) && Array.isArray(data.parties) && !controller.signal.aborted)
          setMatches(data.parties.filter(isMatch));
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
    setMessage("");
    const party = picked ? { party_id: picked.id } : { name: name.trim(), kind };
    void save.send({ ...party, ...(found && { how_found: found }), ...(note.trim() && { note: note.trim() }) });
  }

  return (
    <form className="prospect-add field" onSubmit={submit}>
      <div className="prospect-add-line">
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
        <input
          aria-label="Optional first note"
          placeholder="Note"
          value={note}
          disabled={save.blocked}
          onChange={(event) => setNote(event.currentTarget.value)}
        />
      </div>
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
      {choosingKind && (
        <select
          aria-label="Person or company"
          required
          disabled={save.blocked}
          value={kind}
          onChange={(event) => setKind(event.currentTarget.value)}
        >
          <option value="">Person / company</option>
          <option value="person">Person</option>
          <option value="company">Company</option>
        </select>
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
export function ManageProspect({
  row,
  actor,
  client,
  saved,
  reload,
  drop,
}: {
  row: VersionedProspect;
  actor: Partner;
  client: ProspectClient;
  saved: () => void;
  reload: () => void;
  drop: () => void;
}) {
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
  return (
    <div className="prospect-management">
      <div>
        <button
          type="button"
          className="btn"
          disabled={blocked}
          onClick={() => change({ owner: row.owner === actor ? other : actor })}
        >
          {row.owner === null
            ? "Claim"
            : row.owner !== actor
              ? "Take ownership"
              : `Hand off to ${other === "joe" ? "Joe" : "Dell"}`}
        </button>
        {row.owner && (
          <button type="button" className="btn" disabled={blocked} onClick={() => change({ owner: null })}>
            Unclaim
          </button>
        )}
        <button
          type="button"
          className="btn"
          disabled={blocked}
          onClick={() => change({ needs_attention: !row.needs_attention })}
        >
          {row.needs_attention ? "Clear needs attention" : "Mark needs attention"}
        </button>
      </div>
      <ProspectSaveFeedback save={changes} reload={reload} />
      <details>
        <summary>Drop prospect</summary>
        <form className="field" onSubmit={dropProspect}>
          <label>
            Reason
            <input name="reason" required disabled={blocked} />
          </label>
          <button type="submit" className="btn" disabled={blocked}>
            Confirm drop
          </button>
        </form>
        <ProspectSaveFeedback save={archive} />
      </details>
    </div>
  );
}
