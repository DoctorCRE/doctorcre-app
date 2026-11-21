// A second return to view during a read queues one more read.
export function mountReadOnResume({ document, refresh }) {
  let hidden = document.visibilityState === "hidden";
  let reading = false;
  let queued = false;

  const read = () => {
    if (reading) { queued = true; return; }
    reading = true;
    Promise.resolve().then(refresh).catch(() => {
      // The page's read path renders its own failure. A rejected callback must
      // not prevent the next return from retrying it.
    }).finally(() => {
      reading = false;
      if (queued && document.visibilityState === "visible") {
        queued = false;
        read();
      } else {
        queued = false;
      }
    });
  };

  const visibility = () => {
    if (document.visibilityState === "hidden") {
      hidden = true;
    } else if (hidden) {
      hidden = false;
      read();
    }
  };

  // eslint-disable-next-line no-restricted-syntax -- Refresh once after a hidden-to-visible transition and cap queued reads at one.
  document.addEventListener("visibilitychange", visibility);
  return { dispose() { document.removeEventListener?.("visibilitychange", visibility); } };
}
