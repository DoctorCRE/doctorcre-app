import { useEffect, useState } from "react";

type DealOption = { id: string; name: string };

export function DealPicker({
  readBoard,
  suggested = [],
  initialDeal = "",
  onSelect,
  onReadError,
}: {
  readBoard(signal: AbortSignal): Promise<unknown>;
  suggested?: readonly DealOption[];
  initialDeal?: string;
  onSelect(deal: DealOption | null): void;
  onReadError?(error: unknown): void;
}) {
  const [board, setBoard] = useState<DealOption[] | "unavailable" | null>(null);
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState(initialDeal);

  const loading = board === null;
  useEffect(() => {
    if (!loading) return;
    const controller = new AbortController();
    void readBoard(controller.signal)
      .then((value) => {
        if (controller.signal.aborted) return;
        if (!value || typeof value !== "object" || !("deals" in value) || !Array.isArray(value.deals))
          throw Error("Deal records unavailable.");
        setBoard(
          value.deals.filter(
            (deal: unknown): deal is DealOption =>
              !!deal &&
              typeof deal === "object" &&
              "id" in deal &&
              typeof deal.id === "string" &&
              "name" in deal &&
              typeof deal.name === "string",
          ),
        );
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setBoard("unavailable");
        onReadError?.(error);
      });
    return () => controller.abort();
  }, [loading, readBoard, onReadError]);

  const deals = new Map<string, DealOption>();
  if (Array.isArray(board)) {
    for (const deal of [...suggested, ...board]) if (!deals.has(deal.id)) deals.set(deal.id, deal);
  }
  const query = search.trim().toLowerCase();
  return (
    <>
      <label>
        Search existing deals
        <input type="search" value={search} onChange={(event) => setSearch(event.currentTarget.value)} />
      </label>
      {board === null && <p role="status">Loading deals…</p>}
      {board === "unavailable" && (
        <p role="status">
          Could not load deals.{" "}
          <button type="button" onClick={() => setBoard(null)}>
            Retry
          </button>
        </p>
      )}
      <label>
        Selected deal
        <select
          aria-label="Selected deal"
          value={deals.has(selected) ? selected : ""}
          disabled={!Array.isArray(board)}
          onChange={(event) => {
            const id = event.currentTarget.value;
            setSelected(id);
            onSelect(deals.get(id) ?? null);
          }}
        >
          <option value="">Choose a deal</option>
          {[...deals.values()]
            .filter((deal) => deal.id === selected || deal.name.toLowerCase().includes(query))
            .map(({ id, name }) => (
              <option key={id} value={id}>
                {name}
              </option>
            ))}
        </select>
      </label>
    </>
  );
}
