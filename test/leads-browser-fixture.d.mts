import type { Page } from "playwright";
import type { lead, workspace } from "./leads-workspace-fixture.mjs";

export function routeLeads(
  page: Page,
  options?: {
    getBoard?: typeof workspace;
    getReasons?: (args: unknown) => unknown;
    getDetail?: (row: ReturnType<typeof lead> | undefined, args: { correspondence_cursor?: unknown }) => unknown;
  },
): Promise<void>;
