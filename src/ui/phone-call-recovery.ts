const extensions = new Map([
  ["audio/wav", "wav"],
  ["audio/x-wav", "wav"],
  ["audio/mp4", "m4a"],
  ["audio/m4a", "m4a"],
  ["audio/x-m4a", "m4a"],
  ["audio/mpeg", "mp3"],
  ["audio/webm", "webm"],
  ["audio/ogg", "ogg"],
]);

type Session = { verify(options: { fresh: true }): Promise<{ actor: { slug: string } }> };
type SavedNote = { id?: unknown; audio?: unknown };
type Recording = { id: string; audio: Blob };
type CallAudio = { list(): Promise<SavedNote[]>; store: { close(): Promise<void> } };

function hasRecording(note: SavedNote): note is Recording {
  return typeof note.id === "string" && note.audio instanceof Blob && note.audio.size > 0;
}

function downloadRecording(audio: Blob, number: number) {
  const extension = extensions.get(audio.type.split(";", 1)[0] ?? "") ?? "audio";
  const link = document.createElement("a");
  const url = URL.createObjectURL(audio);
  try {
    link.href = url;
    link.download = `phone-recording-${number}.${extension}`;
    link.hidden = true;
    document.body.append(link);
    link.click();
  } finally {
    link.remove();
    URL.revokeObjectURL(url);
  }
}

async function showSavedRecordings(status: HTMLElement, list: HTMLElement) {
  const lifetime = new AbortController();
  const { signal } = lifetime;
  function close() {
    lifetime.abort();
    list.replaceChildren();
  }
  window.addEventListener("pagehide", close, { signal });
  window.addEventListener("doctorcre-session-invalidated", close, { signal });

  try {
    const [{ privateSession }, { openPhoneCallAudio }, { mountReadOnResume }]: [
      { privateSession(): Session | null },
      { openPhoneCallAudio(actor: string): CallAudio },
      { mountReadOnResume(options: { document: Document; refresh(): Promise<unknown> }): { dispose(): void } },
    ] = await Promise.all([
      import(new URL("./private-session.js", import.meta.url).href),
      import(new URL("../tours/day-store.js", import.meta.url).href),
      import(new URL("./read-on-resume.mjs", import.meta.url).href),
    ]);
    if (signal.aborted) return;
    const session = privateSession();
    if (!session) {
      status.textContent = "Sign in to check for saved recordings.";
      return;
    }
    const verify = () => {
      signal.throwIfAborted();
      return session.verify({ fresh: true });
    };
    const resume = mountReadOnResume({ document, refresh: verify });
    signal.addEventListener("abort", () => resume.dispose(), { once: true });

    async function readRecordings() {
      const { actor } = await verify();
      if (signal.aborted) return [];
      const { list: read, store } = openPhoneCallAudio(actor.slug);
      const notes = await read().finally(() => store.close().catch(() => {}));
      return notes.filter(hasRecording);
    }

    const ids = (await readRecordings()).map((recording) => recording.id);
    if (signal.aborted) return;
    list.replaceChildren(
      ...ids.map((id, index) => {
        const number = index + 1;
        const button = document.createElement("button");
        button.type = "button";
        button.textContent = `Download recording ${number}`;
        async function recover() {
          button.disabled = true;
          status.textContent = "";
          try {
            const recording = (await readRecordings()).find((note) => note.id === id);
            if (signal.aborted) return;
            if (!recording) {
              status.textContent = "This recording is no longer available in this browser.";
              return;
            }
            await verify();
            if (!signal.aborted) downloadRecording(recording.audio, number);
          } catch {
            if (!signal.aborted) status.textContent = "Could not download the recording. Try again.";
          } finally {
            button.disabled = false;
          }
        }
        button.addEventListener("click", () => void recover(), { signal });
        const item = document.createElement("li");
        item.append(button);
        return item;
      }),
    );
    status.textContent = ids.length ? "" : "No saved recordings were found for this account in this browser.";
  } catch {
    if (!signal.aborted) status.textContent = "Saved recordings could not be opened. Reload this page to try again.";
  }
}

const status = document.getElementById("recordingStatus");
const list = document.getElementById("recordingDownloads");
if (status && list) void showSavedRecordings(status, list);
