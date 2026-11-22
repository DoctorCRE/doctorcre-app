import type { ExactCard } from "./exact-action-card.ts";

export function ExactActionCardView({ card }: { card: ExactCard }) {
  return (
    <article data-exact-card-id={card.id} data-exact-card-kind={card.kind} data-source-version={card.source_version}>
      <h2>Reply draft</h2>
      <p role="status">
        {card.state === "retired"
          ? "This source is no longer available."
          : card.state === "stale"
            ? "This card changed. Open its current version before acting."
            : "Resolved"}
      </p>
      <p>Reference: {card.id}</p>
      {card.state === "stale" && (
        <>
          <h3>{card.subject}</h3>
          <div className="action-link-message">{card.body}</div>
        </>
      )}
    </article>
  );
}
