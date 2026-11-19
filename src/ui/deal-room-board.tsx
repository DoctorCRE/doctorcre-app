import { Fragment } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";

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
  retries: { cell: string; label: string }[];
  step:
    | { kind: "local"; text: string; empty: boolean; owner: string }
    | {
        kind: "national";
        summaryRef: (node: HTMLButtonElement | null) => void;
        itemsRef: (node: HTMLDivElement | null) => void;
        agent: string;
      };
};
type Props = { rows: Row[]; phases: { value: string; label: string }[]; nationalAccountRows: boolean };

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
                <button
                  type="button"
                  className="step-button"
                  data-next-step={row.id}
                  disabled={row.parked}
                  ref={row.step.summaryRef}
                />
                <div ref={row.step.itemsRef} />
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
