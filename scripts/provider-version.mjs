import { setTimeout } from "node:timers/promises";

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
const TRIES = 6;
const RETRY_MS = 10_000;

export function uploadedVersionId(output) {
  const matches = [...String(output).matchAll(new RegExp(`Worker Version ID:\\s*(${UUID})`, "ig"))];
  if (matches.length !== 1) throw new Error("Cloudflare returned no unique Worker Version ID");
  return matches[0][1].toLowerCase();
}

// Cloudflare can briefly answer that a version it just uploaded cannot be found
// (code 100146), so only that answer retries the same version; traffic never moved.
export async function promoteVersion(provider, args, { wait = setTimeout } = {}) {
  for (let attempt = 1; ; attempt++) {
    const result = provider(args, { capture: true, allowFailure: true });
    process.stdout.write(result.stdout);
    process.stderr.write(result.stderr);
    if (result.status === 0) return;
    if (attempt === TRIES || !/code: 100146\b/.test(result.stdout + result.stderr)) {
      throw new Error(`Wrangler failed (${result.signal || result.status})`);
    }
    console.log(`Cloudflare cannot see the new version yet; try ${attempt + 1} of ${TRIES} in ${RETRY_MS / 1000}s.`);
    await wait(RETRY_MS);
  }
}
