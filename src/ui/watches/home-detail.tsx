import { lazy, Suspense } from "react";
import { recordRoutes } from "../home/routes.tsx";

// Home's first screen never shows a watch, so its control downloads when a card first opens one.
const LeaseWatchControl = lazy(async () => {
  const [{ WatchControl }, { createWatchClient }] = await Promise.all([import("./control.tsx"), import("./client.ts")]);
  const client = createWatchClient();
  return {
    default: ({ lease }: { lease: string }) => (
      <WatchControl subject={{ subject_type: "lease", subject_id: lease }} client={client} />
    ),
  };
});

export function HomeWatchDetail({ open_url }: { open_url: string | null }) {
  const source = recordRoutes.source({ open_url });
  if (!source) return null;
  const url = new URL(source, "https://doctorcre.invalid");
  const lease = url.pathname === "/leases" ? url.searchParams.get("lease") : null;
  if (!lease) return null;
  return (
    <section aria-label="Lease watch details">
      <p>This alert is separate from its watch. Snoozing or settling the card keeps the watch.</p>
      <Suspense>
        <LeaseWatchControl key={lease} lease={lease} />
      </Suspense>
    </section>
  );
}
