import { Fragment } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";

type Caption = { text: string; date: string; when: string | null; overdue?: boolean; owner?: string };
type Item = {
  item: { id: string; title: string; due_on: string | null };
  href: string;
  date: string | null;
  overdue: boolean;
};
type PhaseReceipt = {
  move: {
    day: string;
    date: string;
    label: string;
    callTime: string;
    action: { eventId: string; version: number; busy: boolean } | null;
  } | null;
  message?: string;
};
type Row = {
  id: string;
  name: string;
  classes: string;
  meta: [key: string, value: string][];
  title: string;
  parked: boolean;
  attention: boolean;
  icon: string;
  phase: string;
  due: string;
  dueClass: string;
  phaseMove: PhaseReceipt | null;
  retries: { cell: string; label: string }[];
  step:
    | { kind: "local"; text: string; empty: boolean; owner: string }
    | { kind: "national"; next: Caption | null; last: Caption | null; items: Item[]; agent: string };
};
type Props = { rows: Row[]; phases: { value: string; label: string }[]; nationalAccountRows: boolean };

function StepCaption({ label, caption }: { label: "Next: " | "Last: "; caption: Caption }) {
  return (
    <span className={label === "Last: " ? "deal-summary-line deal-summary-last" : "deal-summary-line"}>
      <span className="deal-summary-label">{label}</span>
      <span className="deal-summary-text">{caption.text}</span>
      <span className="deal-summary-facts">
        {caption.date && (
          <>
            {" · "}
            <time data-overdue={caption.overdue} dateTime={caption.when ?? undefined}>
              {caption.date}
            </time>
          </>
        )}
        {caption.owner}
      </span>
    </span>
  );
}

function PhaseMove({ receipt, deal }: { receipt: PhaseReceipt; deal: string }) {
  const { move, message } = receipt;
  return (
    <>
      {move && (
        <div className="auto-move">
          <span>{move.label}</span> <time dateTime={move.day}>{move.date}</time>
          {move.callTime && <div>Call on {move.callTime}</div>}
          {move.action && (
            <button
              type="button"
              data-undo-phase={deal}
              data-event-id={move.action.eventId}
              data-base-version={move.action.version}
              aria-disabled={move.action.busy || undefined}
            >
              Undo
            </button>
          )}
        </div>
      )}
      {message && <p className="auto-move">{message}</p>}
    </>
  );
}

// Native document handlers must read the selected value before the next snapshot.
// Ref assignments update snapshots without React restoring an old controlled value.
function DealRoomBoard({ rows, phases, nationalAccountRows }: Props) {
  return (
    <>
      {rows.map((row) => (
        <tr
          key={row.id}
          className={nationalAccountRows ? `account-deal-row ${row.classes}` : row.classes}
          data-deal-id={row.id}
          title={row.title}
        >
          <td>
            <div className="deal-cell">
              {!nationalAccountRows && (
                <button
                  type="button"
                  className="attention-button"
                  data-attention={row.id}
                  aria-pressed={row.attention}
                  aria-label={`${row.attention ? "Clear attention flag" : "Flag for attention"} on ${row.name}`}
                  disabled={row.parked}
                >
                  {row.icon}
                </button>
              )}
              <div>
                <button type="button" className="deal-link" data-open-deal={row.id}>
                  {row.name}
                </button>
                <div className="deal-meta">
                  {row.meta.map(([key, value], index) => (
                    <Fragment key={key}>
                      {index > 0 && <span>·</span>}
                      <span>{value}</span>
                    </Fragment>
                  ))}
                </div>
                {row.phaseMove && <PhaseMove receipt={row.phaseMove} deal={row.id} />}
              </div>
            </div>
          </td>
          <td>
            <select
              className="cell-select"
              data-phase={row.id}
              aria-label={`Phase for ${row.name}`}
              disabled={row.parked}
              defaultValue={row.phase}
              ref={(node) => {
                if (node) node.value = row.phase;
              }}
            >
              {phases.map((phase) => (
                <option key={phase.value} value={phase.value}>
                  {phase.label}
                </option>
              ))}
            </select>
          </td>
          <td>
            {row.step.kind === "national" ? (
              <>
                <button type="button" className="step-button" data-next-step={row.id} disabled={row.parked}>
                  {row.step.next ? (
                    <StepCaption label="Next: " caption={row.step.next} />
                  ) : (
                    <span className="deal-summary-line">No next step set</span>
                  )}
                  {row.step.last && <StepCaption label="Last: " caption={row.step.last} />}
                </button>
                {row.step.items.length > 0 && (
                  <div>
                    <p className="deal-items-label">Still needed:</p>
                    <ol className="deal-items">
                      {row.step.items.map(({ item, href, date, overdue }) => (
                        <li key={item.id} data-overdue={overdue}>
                          <a data-home-key={`deal:${row.id}:${item.id}`} href={href}>
                            {item.title}
                          </a>
                          {date && (
                            <time className="deal-item-due" dateTime={item.due_on ?? undefined}>
                              {date}
                            </time>
                          )}
                        </li>
                      ))}
                    </ol>
                  </div>
                )}
              </>
            ) : (
              <button
                type="button"
                className={`step-button ${row.step.empty ? "empty" : ""}`}
                data-next-step={row.id}
                disabled={row.parked}
              >
                {row.step.text}
              </button>
            )}
          </td>
          <td>
            <span className={`due ${row.dueClass}`}>{row.due}</span>
          </td>
          <td>
            {row.step.kind === "national" ? (
              <button type="button" className="agent-button" data-market-agent={row.id} disabled={row.parked}>
                {row.step.agent}
              </button>
            ) : (
              <select
                className="cell-select"
                data-owner={row.id}
                aria-label={`Owner for ${row.name}`}
                disabled={row.parked}
                defaultValue={row.step.owner}
                ref={(node) => {
                  if (node && row.step.kind === "local") node.value = row.step.owner;
                }}
              >
                <option value="">Unassigned</option>
                <option value="joe">Joe</option>
                <option value="dell">Dell</option>
              </select>
            )}
          </td>
          <td className="row-actions">
            {row.retries.map((retry) => (
              <button
                key={retry.cell}
                type="button"
                className="park-button"
                data-retry-write={retry.cell}
                aria-label={`${retry.label} on ${row.name} was not confirmed — send the same change again`}
              >
                {retry.label} not confirmed · Retry
              </button>
            ))}
            <button
              type="button"
              className="park-button"
              data-operating-state={row.parked ? "active" : "parked"}
              data-deal={row.id}
            >
              {row.parked ? "Restore" : "Park"}
            </button>
            {nationalAccountRows ? (
              <button type="button" className="park-button" data-attention={row.id} disabled={row.parked}>
                {row.attention ? "Clear needs attention" : "Mark needs attention"}
                <span className="sr-only"> on {row.name}</span>
              </button>
            ) : (
              <button
                type="button"
                className="row-menu"
                data-open-deal={row.id}
                aria-label={`Open ${row.name} details`}
              >
                •••
              </button>
            )}
          </td>
        </tr>
      ))}
    </>
  );
}

export function mountDealRoomBoard(container: HTMLTableSectionElement) {
  const root = createRoot(container);
  return {
    render: (props: Props) => flushSync(() => root.render(<DealRoomBoard {...props} />)),
    dispose: () => root.unmount(),
  };
}
