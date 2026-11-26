import { type ReactNode, useState } from "react";

/** Rows that fold to one counted line on a short computer screen; the line opens them in place. */
export function Fold({ label, line, children }: { label: string; line: ReactNode; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <section className="home-short-fold" aria-label={label} data-open={open || undefined}>
      <button type="button" className="home-short-fold-line" aria-expanded={open} onClick={() => setOpen(!open)}>
        {line}
      </button>
      {children}
    </section>
  );
}

export const counted = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;
