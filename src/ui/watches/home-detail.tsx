import { lazy, Suspense } from "react";
import { recordRoutes } from "../home/routes.tsx";

// Home's first screen never shows a watch, so its control downloads when a card first opens one.
const LeaseWatchControl = lazy(async () => {
  try {
    const [{ WatchControl }, { createWatchClient }] = await Promise.all([
      import("./control.tsx"),
      import("./client.ts"),
    ]);
    const client = createWatchClient();
    return {
      default: ({ lease }: { lease: string }) => (
        <WatchControl subject={{ subject_type: "lease", subject_id: lease }} client={client} />
      ),
    };
  } catch {
    // A rejected lazy import has no boundary above it and would blank the whole inbox.
    return {
      default: () => (
        <p className="inbox-detail" role="status">
          Watch settings unavailable. Refresh to try again.
        </p>
      ),
    };
  }
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
      <div className="home-watch-slot">
        <Suspense
          fallback={
            <p className="inbox-detail" role="status">
              Loading watch settings…
            </p>
          }
        >
          <LeaseWatchControl key={lease} lease={lease} />
        </Suspense>
      </div>
    </section>
  );
}
