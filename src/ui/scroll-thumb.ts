const thumbs = new WeakMap<HTMLElement, { thumb: HTMLElement; fade?: Animation }>();

/** Scrollers under root that match selector show a faint thumb only while they scroll; CSS hides their own bar. */
export function showScrollThumbs(root: HTMLElement, selector: string): void {
  root.addEventListener(
    "scroll",
    ({ target }) => {
      if (target instanceof HTMLElement && target.matches(selector)) showThumb(target);
    },
    { capture: true, passive: true },
  );
}

function showThumb(scroller: HTMLElement): void {
  const range = scroller.scrollHeight - scroller.clientHeight;
  if (range <= 0) return;
  const entry = thumbs.get(scroller) ?? { thumb: newThumb(scroller.ownerDocument) };
  thumbs.set(scroller, entry);
  const { thumb } = entry;
  const box = scroller.getBoundingClientRect();
  const height = Math.max(32, scroller.clientHeight ** 2 / scroller.scrollHeight);
  const top = box.top + scroller.clientTop + (scroller.scrollTop / range) * (scroller.clientHeight - height);
  const left = box.left + scroller.clientLeft + scroller.clientWidth - 4;
  Object.assign(thumb.style, { top: `${top}px`, left: `${left}px`, height: `${height}px` });
  if (!thumb.isConnected) scroller.ownerDocument.body.append(thumb);
  // Each scroll restarts the hold-then-fade; the thumb leaves the page once it has faded.
  entry.fade?.cancel();
  entry.fade = thumb.animate([{ opacity: 1, offset: 0.7 }, { opacity: 0 }], { duration: 1000, easing: "ease-out" });
  entry.fade.onfinish = () => thumb.remove();
}

function newThumb(document: Document): HTMLElement {
  const thumb = document.createElement("div");
  thumb.className = "scroll-thumb";
  return thumb;
}
