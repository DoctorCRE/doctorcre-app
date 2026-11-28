import { type ReactNode, useLayoutEffect, useRef, useState } from "react";

/** Rows that fold to one counted line on a short computer screen; the line opens them in place. */
export function Fold({ label, line, children }: { label: string; line: ReactNode; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const disclosure = useRef<HTMLButtonElement>(null);
  useLayoutEffect(() => {
    const button = disclosure.current;
    if (!open || !button) return;
    const tile = button.closest<HTMLElement>(".home-slice");
    const firstRow = button.parentElement?.querySelector(":scope > ul > li:first-child > a");
    if (!tile || !firstRow) return;

    const margin = Number.parseFloat(getComputedStyle(firstRow).scrollMarginBlockStart);
    const contentHeight = firstRow.getBoundingClientRect().bottom - button.getBoundingClientRect().top;
    tile.style.setProperty("--home-open-fold-size", `${Math.ceil(margin + contentHeight)}px`);

    const { top, bottom } = tile.getBoundingClientRect();
    const first = firstRow.getBoundingClientRect();
    const buttonTop = button.getBoundingClientRect().top;
    const visibleTop = top + margin;
    const visibleHeight = bottom - visibleTop;
    const targetTop = first.bottom - buttonTop <= visibleHeight ? buttonTop : first.top;
    let scroll = Math.ceil(Math.max(0, first.bottom - bottom));
    if (targetTop < visibleTop || first.height > visibleHeight) scroll = Math.floor(targetTop - visibleTop);
    if (scroll !== 0) tile.scrollBy({ top: scroll, behavior: "instant" });
    return () => {
      tile.style.removeProperty("--home-open-fold-size");
    };
  }, [open]);
  return (
    <section className="home-short-fold" aria-label={label} data-open={open || undefined}>
      <button
        ref={disclosure}
        type="button"
        className="home-short-fold-line"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        {line}
      </button>
      {children}
    </section>
  );
}

export const counted = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;
