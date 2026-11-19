export function refreshWhileVisible(refresh: (signal: AbortSignal) => Promise<void>, { immediate = true } = {}) {
  let controller: AbortController | undefined;
  let timer: number | undefined;

  function stop() {
    window.clearTimeout(timer);
    controller?.abort();
    controller = undefined;
  }

  function syncVisibility() {
    if (document.visibilityState !== "visible") {
      stop();
      return;
    }
    if (controller) return;
    controller = new AbortController();
    const { signal } = controller;
    async function read() {
      if (signal.aborted || document.visibilityState !== "visible") return;
      await refresh(signal);
      if (!signal.aborted) schedule();
    }
    function schedule() {
      // eslint-disable-next-line no-restricted-syntax -- One pending timeout per visible view, cleared on hide or unmount.
      timer = window.setTimeout(read, 5000);
    }
    if (immediate) void read();
    else schedule();
  }

  // eslint-disable-next-line no-restricted-syntax -- Visible view owns one read at a time, aborted on hide or unmount.
  document.addEventListener("visibilitychange", syncVisibility);
  syncVisibility();
  return () => {
    document.removeEventListener("visibilitychange", syncVisibility);
    stop();
  };
}
