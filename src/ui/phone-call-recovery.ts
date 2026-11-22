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
type CallAudio = { list(): Promise<{ audio?: unknown }[]>; store: { close(): Promise<void> } };

async function showSavedRecordings(status: HTMLElement, list: HTMLElement) {
  const urls: string[] = [];
  let closed = false;
  function clearDownloads() {
    closed = true;
    for (const url of urls.splice(0)) URL.revokeObjectURL(url);
    list.replaceChildren();
  }
  window.addEventListener("pagehide", clearDownloads, { once: true });
  window.addEventListener("doctorcre-session-invalidated", clearDownloads, { once: true });

  try {
    const [{ privateSession }, { openPhoneCallAudio }]: [
      { privateSession(): Session | null },
      { openPhoneCallAudio(actor: string): CallAudio },
    ] = await Promise.all([
      import(new URL("./private-session.js", import.meta.url).href),
      import(new URL("../tours/day-store.js", import.meta.url).href),
    ]);
    if (closed) return;
    const session = privateSession();
    if (!session) {
      status.textContent = "Sign in to check for saved recordings.";
      return;
    }
    const { actor } = await session.verify({ fresh: true });
    if (closed) return;
    const { list: readRecordings, store } = openPhoneCallAudio(actor.slug);
    const notes = await readRecordings().finally(() => store.close().catch(() => {}));
    if (closed) return;

    const recordings = notes
      .map((note) => note.audio)
      .filter((audio): audio is Blob => audio instanceof Blob && audio.size > 0);
    list.replaceChildren(
      ...recordings.map((audio, index) => {
        const url = URL.createObjectURL(audio);
        urls.push(url);
        const extension = extensions.get(audio.type.split(";", 1)[0] ?? "") ?? "audio";
        const link = document.createElement("a");
        link.href = url;
        link.download = `phone-recording-${index + 1}.${extension}`;
        link.textContent = `Download recording ${index + 1}`;
        const item = document.createElement("li");
        item.append(link);
        return item;
      }),
    );
    status.textContent = recordings.length ? "" : "No saved recordings were found for this account in this browser.";
  } catch {
    if (!closed) status.textContent = "Saved recordings could not be opened. Reload this page to try again.";
  }
}

const status = document.getElementById("recordingStatus");
const list = document.getElementById("recordingDownloads");
if (status && list) void showSavedRecordings(status, list);
