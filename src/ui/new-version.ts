// The worker names its deployed version in each response's Server-Timing header,
// so the tab notices a release from responses it already fetches.
const versionOf = (entry: PerformanceEntry): string | null =>
  entry instanceof PerformanceResourceTiming
    ? entry.serverTiming.find((timing) => timing.name === "version")?.description || null
    : null;

export function mountNewVersionNotice(root: Document, after: Element): void {
  const win = root.defaultView;
  const navigation = win?.performance.getEntriesByType("navigation")[0];
  const loaded = navigation && versionOf(navigation);
  if (!win || !loaded) return;
  let closed: string | undefined;
  const notice = createNotice(
    root,
    () => win.location.reload(),
    () => {
      closed = notice.dataset.version;
      notice.hidden = true;
    },
  );
  const show = (version: string) => {
    if (version === loaded || version === closed) return;
    if (!notice.isConnected) after.after(notice);
    notice.dataset.version = version;
    notice.hidden = false;
  };
  new win.PerformanceObserver((list) => {
    for (const entry of list.getEntries()) {
      const version = versionOf(entry);
      if (version) show(version);
    }
  }).observe({ type: "resource", buffered: true });
}

function createNotice(root: Document, reload: () => void, close: () => void): HTMLElement {
  const notice = root.createElement("p");
  notice.className = "app-new-version";
  notice.setAttribute("role", "status");
  const reloadButton = root.createElement("button");
  reloadButton.type = "button";
  reloadButton.textContent = "Reload";
  reloadButton.addEventListener("click", reload);
  const closeButton = root.createElement("button");
  closeButton.type = "button";
  closeButton.textContent = "×";
  closeButton.setAttribute("aria-label", "Close new version notice");
  closeButton.addEventListener("click", close);
  notice.append("A new version is ready · ", reloadButton, closeButton);
  return notice;
}
