import { useState } from "react";

export function DropReason({
  title,
  cancel,
  confirm,
}: {
  title: string;
  cancel(): void;
  confirm(reason: string): void;
}) {
  const [reason, setReason] = useState("");
  return (
    <dialog
      className="inbox-snooze"
      aria-label="Drop with a reason"
      ref={(node) => {
        if (node && !node.open) node.showModal();
      }}
      onClose={(event) => {
        if (event.currentTarget.returnValue === "drop" && reason.trim()) confirm(reason.trim());
        else cancel();
      }}
    >
      <h2>Drop this card?</h2>
      <p>{title}</p>
      <form method="dialog">
        <label>
          Reason for dropping
          <textarea autoFocus maxLength={500} value={reason} onChange={(event) => setReason(event.target.value)} />
        </label>
        <button type="submit" value="drop" disabled={!reason.trim()}>
          Drop
        </button>
        <button type="submit" value="cancel">
          Cancel
        </button>
      </form>
    </dialog>
  );
}
