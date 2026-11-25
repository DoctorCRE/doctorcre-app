// Phones, and touch tablets narrower than a landscape iPad, use the touch
// layout. Every stylesheet's touch-layout media query spells this exactly.
export const TOUCH_LAYOUT = "(max-width:760px),(hover:none) and (pointer:coarse) and (max-width:1023px)";

// Off the touch layout the page never scrolls; the shell's main region does.
export function pageScroller(root = document) {
  const main = root.getElementById("appMainSlot");
  return main && root.defaultView.getComputedStyle(main).overflowY === "auto" ? main : root.scrollingElement;
}

// A drag within `edge` px of the scroller's top or bottom scrolls it, faster nearer the edge.
export function scrollAtEdge(root, y, { edge = 72, speed = 18 } = {}) {
  const scroller = pageScroller(root);
  const { top, bottom } = scroller === root.scrollingElement ? { top: 0, bottom: root.defaultView.innerHeight } : scroller.getBoundingClientRect();
  const depth = y < top + edge ? (y - top - edge) / edge : y > bottom - edge ? (y - bottom + edge) / edge : 0;
  const delta = speed * Math.max(-1, Math.min(1, depth));
  if (delta) scroller.scrollBy({ top: delta, behavior: "instant" });
  return delta !== 0;
}
