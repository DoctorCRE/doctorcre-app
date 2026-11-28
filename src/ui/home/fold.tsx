import { type ReactNode, useLayoutEffect, useRef, useState } from "react";

/** Rows that fold to one counted line on a short computer screen; the line opens them in place. */
export function Fold({
  label,
  line,
  children,
  keepCollapsedVisible,
}: {
  label: string;
  line: ReactNode;
  children: ReactNode;
  keepCollapsedVisible?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const section = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    const fold = section.current;
    if (open && keepCollapsedVisible && fold?.querySelector("button")?.offsetHeight) {
      fold.querySelector("li a")?.scrollIntoView({ block: "nearest", behavior: "instant" });
    }
  }, [open, keepCollapsedVisible]);
  return (
    <section
      ref={section}
      className="home-short-fold"
      aria-label={label}
      data-open={open || undefined}
      data-home-footer={!open && keepCollapsedVisible ? "" : undefined}
    >
      <button
        type="button"
        className="home-short-fold-line"
        data-home-preview={open ? undefined : ""}
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
