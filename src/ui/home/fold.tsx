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

    const { top, bottom } = tile.getBoundingClientRect();
    const stickyBottom = tile.querySelector(":scope > header")?.getBoundingClientRect().bottom ?? top;
    const spaceAboveButton = Math.floor(button.getBoundingClientRect().top - stickyBottom);
    const rowOverflow = Math.ceil(firstRow.getBoundingClientRect().bottom - bottom);
    const scroll = Math.min(Math.max(0, rowOverflow), spaceAboveButton);
    if (scroll !== 0) tile.scrollBy({ top: scroll, behavior: "instant" });
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
