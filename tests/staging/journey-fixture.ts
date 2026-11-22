import { randomUUID } from "node:crypto";
import { test } from "@playwright/test";
import { z } from "zod";

const endpoint = "https://doctorcre-engine-staging.joe-bookout-carr-us.workers.dev/jobs/sign-in-rehearsal";
const prepared = z
  .object({
    run_id: z.uuid(),
    deal_id: z.uuid(),
    deal_name: z.string().min(1),
    next_step_id: z.uuid(),
    home_item_id: z.string(),
    tour_id: z.uuid(),
    property_id: z.uuid(),
    notes: z.array(z.string()).length(2),
  })
  .refine((fixture) => fixture.home_item_id === `next_action:${fixture.next_step_id}`);
const cleaned = z.object({ run_id: z.uuid(), remaining: z.literal(0) });

type Fixture = z.infer<typeof prepared>;
type Options = {
  fetch?: (url: string, request: RequestInit) => Promise<Response>;
  env?: NodeJS.ProcessEnv;
};

export async function withJourneyFixture<T>(
  body: (fixture: Fixture) => T | Promise<T>,
  { fetch = globalThis.fetch, env = process.env }: Options = {},
): Promise<T> {
  const { E2E_ENGINE_JOBS_CLIENT_ID: clientId, E2E_ENGINE_JOBS_CLIENT_SECRET: clientSecret } = env;
  if (!clientId || !clientSecret)
    throw new Error("Set E2E_ENGINE_JOBS_CLIENT_ID and E2E_ENGINE_JOBS_CLIENT_SECRET for staging fixtures");

  const headers = {
    "Content-Type": "application/json",
    "CF-Access-Client-Id": clientId,
    "CF-Access-Client-Secret": clientSecret,
    "Engine-Job": "sign-in-rehearsal",
  };
  const run_id = randomUUID();
  async function call<Value extends { run_id: string }>(
    action: "prepare" | "cleanup",
    status: number,
    schema: z.ZodType<Value>,
  ) {
    const response = await fetch(`${endpoint}/${action}`, {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(30_000),
      headers: action === "prepare" ? { ...headers, "Engine-For-User": "joe" } : headers,
      body: JSON.stringify({ run_id }),
    }).catch(() => {
      throw new Error(`Fixture ${action} request failed for run ${run_id}`);
    });
    if (response.status !== status)
      throw new Error(`Fixture ${action} returned HTTP ${response.status} for run ${run_id}`);
    const result = schema.safeParse(await response.json().catch(() => undefined));
    if (!result.success || result.data.run_id !== run_id)
      throw new Error(`Invalid ${action} response for fixture run ${run_id}`);
    return result.data;
  }

  async function cleanup() {
    // The engine closes the run even if prepare never reached it.
    for (let attempt = 1; ; attempt++) {
      try {
        await call("cleanup", 200, cleaned);
        return;
      } catch (error) {
        if (attempt === 3) throw error;
      }
    }
  }

  let result: T;
  try {
    result = await body(await call("prepare", 201, prepared));
  } catch (error) {
    await cleanup().catch((cleanupError) => {
      throw new AggregateError([error, cleanupError], `${error}\n${cleanupError}`);
    });
    throw error;
  }
  await cleanup();
  return result;
}

export const journeyTest = test.extend<{ rehearsal: Fixture; journeyFixtureOptions: Options }>({
  journeyFixtureOptions: [{}, { option: true }],
  rehearsal: [({ journeyFixtureOptions }, use) => withJourneyFixture(use, journeyFixtureOptions), { timeout: 125_000 }],
});
