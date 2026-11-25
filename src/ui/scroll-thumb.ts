const thumbs = new WeakMap<HTMLElement, { thumb: HTMLElement; scrollTop: number; fade?: Animation }>();

const holdThenFade: Keyframe[] = [{ opacity: 1, offset: 0.7 }, { opacity: 0 }];
const holdOnly: Keyframe[] = [{ opacity: 1 }, { opacity: 1 }];

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
  const document = scroller.ownerDocument;
  const entry = thumbs.get(scroller) ?? { thumb: newThumb(document), scrollTop: 0 };
  thumbs.set(scroller, entry);
  // A sideways scroll of the board must not flash its up-and-down thumb.
  if (scroller.scrollTop === entry.scrollTop) return;
  entry.scrollTop = scroller.scrollTop;
  const { thumb } = entry;
  const box = scroller.getBoundingClientRect();
  const height = Math.max(32, scroller.clientHeight ** 2 / scroller.scrollHeight);
  const top = box.top + scroller.clientTop + (scroller.scrollTop / range) * (scroller.clientHeight - height);
  const left = box.left + scroller.clientLeft + scroller.clientWidth - 4;
  Object.assign(thumb.style, { top: `${top}px`, left: `${left}px`, height: `${height}px` });
  if (!thumb.isConnected) document.body.append(thumb);
  // Each scroll restarts the hold-then-fade; the thumb leaves the page once it ends.
  entry.fade?.cancel();
  entry.fade = motionReduced(document)
    ? thumb.animate(holdOnly, { duration: 700 })
    : thumb.animate(holdThenFade, { duration: 1000, easing: "ease-out" });
  entry.fade.onfinish = () => thumb.remove();
}

/** The OS setting or the in-app toggle; either one stops the fade. */
function motionReduced(document: Document): boolean {
  return (
    document.documentElement.dataset.motion === "reduced" ||
    document.defaultView?.matchMedia("(prefers-reduced-motion: reduce)").matches === true
  );
}

function newThumb(document: Document): HTMLElement {
  const thumb = document.createElement("div");
  thumb.className = "scroll-thumb";
  return thumb;
}
