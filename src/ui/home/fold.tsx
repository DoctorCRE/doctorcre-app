import { useId, useLayoutEffect, useRef, useState } from "react";

export function useHomeFold() {
  const [open, setOpen] = useState(false);
  const id = useId();
  const ref = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    if (!open) return;
    const options = { block: "nearest", container: "nearest", behavior: "instant" } as const;
    ref.current?.querySelector("li:first-child > a")?.scrollIntoView(options);
  }, [open]);

  return {
    disclosure: {
      type: "button" as const,
      className: "home-fold-disclosure",
      "aria-controls": id,
      "aria-expanded": open,
      onClick: () => setOpen(!open),
    },
    list: { id, ref, className: "home-short-fold", "data-open": open || undefined },
  };
}

export const counted = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;
