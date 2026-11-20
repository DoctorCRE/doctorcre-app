import { dealCutover } from "./deal-cutover.ts";
import { mountMarketTerms as mountComparison } from "./market-terms.tsx";

export function mountMarketTerms(root: HTMLElement, options: Parameters<typeof mountComparison>[1]) {
  const document = root.ownerDocument;
  const cutover = dealCutover(document);
  const coverage = document.createElement("p");
  coverage.textContent = `Recorded through ${cutover?.label ?? "the switch"}.`;
  const comparison = document.createElement("div");
  root.replaceChildren(coverage, comparison);

  const panel = mountComparison(comparison, options);
  const date = comparison.querySelector<HTMLInputElement>('input[name="as_of"]');
  if (date) {
    if (cutover?.date) date.max = cutover.date;
    else date.disabled = true;
  }
  return {
    refresh: panel.refresh,
    dispose() {
      panel.dispose();
      root.replaceChildren();
    },
  };
}
