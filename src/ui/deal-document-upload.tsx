import { createRef, type FormEvent, type RefObject, useId, useRef, useState } from "react";
import { createRoot } from "react-dom/client";

// The engine seeds these document_kind slugs in schema/copy-deal-files.sql.
const documentTypes = [
  ["loi", "LOI"],
  ["counter", "Counter"],
  ["lease", "Lease"],
  ["amendment", "Amendment"],
  ["invoice", "Invoice"],
  ["other", "Other"],
] as const;
type DocumentKind = (typeof documentTypes)[number][0];
type DealDocument = { id: string; name: string; kind: string | null; version: number };
type Selection = { file: File; kind: DocumentKind; replaces: string };
type Attempt = Selection & { key: string };
type Props = {
  dealId: string;
  documents: DealDocument[];
  request(path: string, init: RequestInit): Promise<Response>;
  refreshDocuments(): Promise<DealDocument[]>;
};

const sizeLimit = 25 * 1024 * 1024;
const fileExtensions = [".pdf", ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx"];
const unknownOutcome = "Could not confirm the upload. Try again.";
const refusalMessages = new Map([
  ["key_reuse", "The upload changed before it could be confirmed. Try again."],
  [
    "predecessor_not_found",
    "The document you chose to replace is no longer on this deal. Refresh the deal and choose again.",
  ],
  ["predecessor_kind_differs", "Choose a document of the same type to replace."],
  ["predecessor_replaced", "That version already has a replacement. Refresh the deal and choose a newer version."],
  ["file_not_uploaded", "The file upload did not finish. Try again."],
  ["not_found", "This deal could not be found. Return to Deals and open it again."],
  ["invalid_field_value", "Check the file name and document type, then try again."],
  ["unsupported_file", "Choose a PDF, Word, Excel or PowerPoint file."],
  ["too_large", "Choose a file no larger than 25 MB."],
  ["length_required", "Choose a file that is not empty."],
  ["sha256_mismatch", "The file changed during upload. Choose it again."],
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object";
}

async function sendDocument({ dealId, request }: Props, attempt: Attempt, signal: AbortSignal) {
  const { file, kind, replaces, key } = attempt;
  const bytes = await file.arrayBuffer();
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  const sha256 = Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join("");
  signal.throwIfAborted();
  const upload = await request(`/api/engine/files/${sha256}`, {
    method: "PUT",
    body: bytes,
    headers: { "content-type": "application/octet-stream" },
    signal: AbortSignal.any([signal, AbortSignal.timeout(60_000)]),
  });
  if (!upload.ok) return { response: upload, filing: false };
  signal.throwIfAborted();
  const response = await request(`/api/engine/deals/${encodeURIComponent(dealId)}/documents`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      idempotency_key: key,
      sha256,
      name: file.name.trim(),
      kind,
      ...(replaces ? { supersedes_id: replaces } : {}),
    }),
    signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
  });
  return { response, filing: true };
}

function fileRefusal(file: File) {
  if (!file.size) return refusalMessages.get("length_required");
  if (file.size > sizeLimit) return refusalMessages.get("too_large");
  const name = file.name.trim().toLowerCase();
  if (!name) return "Choose a file with a name.";
  if (!fileExtensions.some((extension) => name.endsWith(extension))) return refusalMessages.get("unsupported_file");
}

function DealDocumentUpload(props: Props & { signal: AbortSignal; fileInput: RefObject<HTMLInputElement | null> }) {
  const [kind, setKind] = useState<DocumentKind | "">("");
  const [replaces, setReplaces] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [fileName, setFileName] = useState("");
  const [dragging, setDragging] = useState(false);
  const attempt = useRef<Attempt | null>(null);
  const { fileInput } = props;
  const fileHint = useId();
  const candidates = props.documents.filter((document) => document.kind === kind);
  function choose() {
    setFileName(fileInput.current?.files?.[0]?.name ?? "");
    setMessage("");
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const file = fileInput.current?.files?.[0];
    if (busy || !file || !kind) return;
    const refusal = fileRefusal(file);
    if (refusal) {
      setMessage(refusal);
      return;
    }
    const previous = attempt.current;
    attempt.current =
      previous?.file === file && previous.kind === kind && previous.replaces === replaces
        ? previous
        : { file, kind, replaces, key: crypto.randomUUID() };
    setBusy(true);
    setMessage("Uploading…");
    try {
      const { response, filing } = await sendDocument(props, attempt.current, props.signal);
      const body: unknown = await response.json().catch(() => null);
      if (props.signal.aborted) return;
      if (
        filing &&
        response.ok &&
        isRecord(body) &&
        typeof body.document_id === "string" &&
        body.deal_id === props.dealId
      ) {
        attempt.current = null;
        if (fileInput.current) fileInput.current.value = "";
        setFileName("");
        setKind("");
        setReplaces("");
        const documents = await props.refreshDocuments();
        if (!props.signal.aborted)
          setMessage(
            documents.some((document) => document.id === body.document_id)
              ? "Document added."
              : "Document added. Refresh the deal to see it.",
          );
      } else {
        const error = isRecord(body) && typeof body.error === "string" ? body.error : "";
        if (error === "key_reuse") attempt.current = null;
        if (error === "already_filed" && isRecord(body)) {
          const match = (documents: DealDocument[]) => documents.find((document) => document.id === body.document_id);
          const existing = match(props.documents) ?? match(await props.refreshDocuments());
          if (!props.signal.aborted)
            setMessage(
              existing
                ? `This file is already on this deal as ${existing.name}.`
                : "This file is already on this deal.",
            );
        } else {
          setMessage(
            !filing && error === "not_found" ? unknownOutcome : (refusalMessages.get(error) ?? unknownOutcome),
          );
        }
      }
    } catch {
      if (!props.signal.aborted) setMessage(unknownOutcome);
    } finally {
      if (!props.signal.aborted) setBusy(false);
    }
  }

  return (
    <form className="deal-update-form deal-document-upload" onSubmit={(event) => void submit(event)}>
      <label
        className="deal-file-drop"
        data-dragging={dragging || undefined}
        onDragOver={(event) => {
          event.preventDefault();
          if (!busy) setDragging(true);
        }}
        onDragLeave={(event) => {
          if (!(event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)))
            setDragging(false);
        }}
        onDrop={(event) => {
          event.preventDefault();
          setDragging(false);
          const input = fileInput.current;
          if (busy || !input || !event.dataTransfer.files.length) return;
          input.files = event.dataTransfer.files;
          choose();
        }}
      >
        <input
          ref={fileInput}
          className="sr-only"
          type="file"
          accept={fileExtensions.join(",")}
          aria-describedby={fileHint}
          onChange={choose}
          required
          disabled={busy}
        />
        <strong>{fileName || "Drop a file here or choose one"}</strong>
        <small id={fileHint}>
          {fileName ? "Choose another file · " : ""}PDF, Word, Excel or PowerPoint · Up to 25 MB
        </small>
      </label>
      <label>
        Document type
        <select
          required
          value={kind}
          disabled={busy}
          onChange={(event) => {
            setKind(documentTypes.find(([slug]) => slug === event.target.value)?.[0] ?? "");
            setReplaces("");
          }}
        >
          <option value="">Choose a type</option>
          {documentTypes.map(([slug, label]) => (
            <option key={slug} value={slug}>
              {label}
            </option>
          ))}
        </select>
      </label>
      {candidates.length > 0 && (
        <label>
          Replaces
          <select value={replaces} disabled={busy} onChange={(event) => setReplaces(event.target.value)}>
            <option value="">None</option>
            {candidates.map((document) => (
              <option key={document.id} value={document.id}>
                {document.name} · Version {document.version}
              </option>
            ))}
          </select>
        </label>
      )}
      <button className="btn btn-primary" type="submit" disabled={busy}>
        Upload to this deal
      </button>
      <p role="status">{message}</p>
    </form>
  );
}

export function mountDealDocumentUpload(element: HTMLElement, props: Props) {
  const root = createRoot(element);
  const controller = new AbortController();
  const fileInput = createRef<HTMLInputElement>();
  const hasUnsavedChanges = () => Boolean(fileInput.current?.files?.length);
  function update(documents: DealDocument[]) {
    root.render(
      <DealDocumentUpload {...props} documents={documents} signal={controller.signal} fileInput={fileInput} />,
    );
  }
  update(props.documents);
  return {
    update,
    hasUnsavedChanges,
    confirmLeave() {
      const input = fileInput.current;
      if (!input || !hasUnsavedChanges()) return true;
      if (!element.ownerDocument.defaultView?.confirm("Leave this deal and discard the selected file?")) return false;
      // Browser Back retries the navigation after the partner confirms.
      input.value = "";
      return true;
    },
    dispose() {
      controller.abort();
      root.unmount();
    },
  };
}
