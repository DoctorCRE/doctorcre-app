import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { type DropCategory, EMPTY_DROP_REASONS, readDropReasons } from "./drop-reasons.ts";

export function DropReason({
  title,
  heading = "Drop this card?",
  category = null,
  cancel,
  confirm,
}: {
  title: string;
  heading?: string;
  category?: DropCategory | null;
  cancel(): void;
  confirm(reason: string): void;
}) {
  const [reason, setReason] = useState("");
  const { data: reasons = EMPTY_DROP_REASONS } = useQuery({
    queryKey: ["home-drop-reasons", category],
    queryFn: () => (category ? readDropReasons(category) : Promise.resolve(EMPTY_DROP_REASONS)),
    enabled: category !== null,
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: Number.POSITIVE_INFINITY,
  });
  return (
    <dialog
      className="inbox-snooze drop-reason"
      aria-label="Drop with a reason"
      ref={(node) => {
        if (node && !node.open) node.showModal();
      }}
      onClose={(event) => {
        if (event.currentTarget.returnValue === "drop" && reason.trim()) confirm(reason.trim());
        else cancel();
      }}
    >
      <h2>{heading}</h2>
      <p className="drop-reason-title">{title}</p>
      {reasons.length > 0 && (
        <fieldset className="drop-chips">
          <legend className="sr-only">Common reasons</legend>
          {reasons.map((choice) => (
            <button key={choice} type="button" className="drop-chip" onClick={() => confirm(choice)}>
              {choice}
            </button>
          ))}
        </fieldset>
      )}
      <form method="dialog">
        <label>
          Reason for dropping
          <textarea autoFocus maxLength={500} value={reason} onChange={(event) => setReason(event.target.value)} />
        </label>
        <div className="drop-reason-actions">
          <button type="submit" value="drop" disabled={!reason.trim()}>
            Drop
          </button>
          <button type="submit" value="cancel">
            Cancel
          </button>
        </div>
      </form>
    </dialog>
  );
}
