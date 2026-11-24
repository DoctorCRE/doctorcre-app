// Phones, and touch tablets narrower than a landscape iPad, use the touch
// layout. Every stylesheet's touch-layout media query spells this exactly.
export const TOUCH_LAYOUT = "(max-width:760px),(hover:none) and (pointer:coarse) and (max-width:1023px)";

// Off the touch layout the page never scrolls; the shell's main region does.
export function pageScroller(root = document) {
  const main = root.getElementById("appMainSlot");
  return main && getComputedStyle(main).overflowY === "auto" ? main : root.scrollingElement;
}
