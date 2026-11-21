export function refreshWhileVisible(
  refresh: (signal: AbortSignal) => Promise<void> | Promise<"stop" | undefined>,
  { immediate = true, delay = () => 5000 }: { immediate?: boolean; delay?: (visibleMs: number) => number } = {},
) {
  let controller: AbortController | undefined;
  let timer: number | undefined;

  function stop() {
    window.clearTimeout(timer);
    controller?.abort();
    controller = undefined;
  }

  const visible = () =>
    document.visibilityState === "visible" && document.documentElement.style.visibility !== "hidden";

  function syncVisibility(event?: Event) {
    const isVisible = visible();
    if (!isVisible || event?.type === "doctorcre-session-ready") stop();
    if (!isVisible || controller) return;
    controller = new AbortController();
    const { signal } = controller;
    const visibleSince = performance.now();
    async function read() {
      if (signal.aborted) return;
      if (!visible()) return stop();
      const result = await refresh(signal);
      if (!signal.aborted && result !== "stop") schedule();
    }
    function schedule() {
      // eslint-disable-next-line no-restricted-syntax -- One pending timeout per visible view, cleared on hide or unmount.
      timer = window.setTimeout(read, delay(performance.now() - visibleSince));
    }
    if (immediate) void read();
    else schedule();
  }

  // eslint-disable-next-line no-restricted-syntax -- Visible view owns one read at a time, aborted on hide or unmount.
  document.addEventListener("visibilitychange", syncVisibility);
  window.addEventListener("doctorcre-session-ready", syncVisibility);
  syncVisibility();
  return () => {
    window.removeEventListener("doctorcre-session-ready", syncVisibility);
    document.removeEventListener("visibilitychange", syncVisibility);
    stop();
  };
}
