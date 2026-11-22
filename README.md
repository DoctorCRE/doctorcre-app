# DoctorCRE

DoctorCRE is the independently built human application for CARR. CARR remains
the authority for business records, domain behavior, control, and assurance.

The application reads and changes real business data through authenticated
CARR and engine interfaces. It never connects to the database directly.
`data/board-seed.json` is a visibly fictional fixture for local development and
tests; it cannot become production state.

The product remains a no-framework static application. Its small edge Worker
serves the immutable static build and uses private Cloudflare service bindings
for the reviewed CARR and engine routes.

Local development and the e2e runner require Node.js 22.22.3 or newer on Node 22, or 24.8.0 or newer.

```bash
npm ci
npx playwright install chromium
npm test
npm run check
npm run build
npm run artifact:verify
npm run serve
npm run dev:staging
```

`npm run privacy:check` requires the private name-hash corpus in
`~/.config/doctorcre-app/private-name-hashes.json`, or an explicit
`DOCTORCRE_PRIVACY_CORPUS_FILE` path. CI reads the
`DOCTORCRE_PRIVACY_CORPUS_JSON` Actions secret. Keep this record-derived lookup
material outside the public repository. Missing or malformed input fails the check.

### End-to-end journeys

The `live` Playwright project runs the app against the CARR checkout pinned by
`contracts/carr-interface.v1/producer.json`, on disposable PostgreSQL. Install that
checkout's locked Node and Python dependencies, then install its existing Node
package into the app with `node scripts/live-producer.mjs`.
Run `npm run build` and `npx playwright test --project=live` with
`CARR_PRODUCER_CHECKOUT` naming that checkout. The harness refuses a different
revision, tracked source edits, or a package resolving outside the declared
checkout. CI prepares the same package directly from the pinned checkout; this
is a test dependency and adds no product runtime dependency.


The [e2e](https://www.npmjs.com/package/e2e) runner starts the fixture server
(`npm run serve`) and runs `tests/journeys` on a desktop and a phone viewport.
The QA regressions use their own fixture server and config.

```bash
npm run build
npx e2e run
npm run test:regressions
```

For the signed-in smoke in engine mode, set `E2E_ENGINE_STORAGE_STATE` to the
path of an approved Playwright storage state file for the staging test actor
(`joe`). Keep the file outside the checkout and out of logs. Then run:

```bash
./node_modules/.bin/playwright test --config=tests/staging/playwright.config.ts --project=staging-engine
```

Setup checks the session and sign-in mode at the fixed staging origin before
the smoke opens any screens. If the session has expired, replace the file with
fresh approved state. If staging has rolled back to CARR, setup reports the
mode and stops. The engine smoke refuses Playwright traces, recordings,
screenshots, and debug logging. The Google sign-in round trip is a separate
manual check.

The manual **Signed-in staging tests** workflow deploys the selected app
revision, verifies its exact source SHA at `/app-release`, and runs the Deals,
Home, deal tour plan, and signed-in navigation specs in the `chromium` project.
Set `E2E_STAGING_ACCESS_CLIENT_ID` and `E2E_STAGING_ACCESS_CLIENT_SECRET` in
the GitHub `staging` environment for a service token allowed by the staging app's
Cloudflare Access policy. The browser tests also need
`E2E_ENGINE_STORAGE_STATE` (approved storage state JSON for `joe`) and
`E2E_ENGINE_JOBS_CLIENT_ID` and `E2E_ENGINE_JOBS_CLIENT_SECRET` (staging jobs
Access credentials). The engine rehearsal job must be deployed and its staging
schema installed. Deals, Home and Tours each prepare and clean up their own
synthetic run through that job.

For a CARR rollback rehearsal against a staging release already in CARR mode,
run `./node_modules/.bin/playwright test --project=chromium` with the same jobs
credentials and `E2E_SESSION_SECRET`, with `E2E_ENGINE_STORAGE_STATE` unset.
Setup exchanges the secret for the synthetic `e2e-joe` session. Both modes
require the staging data routes for Deals, Home and deal tour plans.

`./node_modules/.bin/playwright test --project=fixtures` runs credential-free
browser tests with Playwright's page and context fixtures.

The Home section browser tests open step links on Prospects and Relationships
at phone and desktop widths. Each link brings the selected step into view
and shows its recorded origin in the same words as the deal page. This includes
Done links to prospect follow-ups. A saved Relationships step link still opens
the selected node when an older engine only supports the base network read.

`npm run release:prepare` runs checks, tests, build and source-bound artifact
verification with a credential-free child environment. Run it before either
publication command. The CARR pipeline invokes this entrypoint separately from
the provider step.

`npm run release:staging` requires Python 3 on `PATH`. Python owns staging
orchestration; the shared Node adapter keeps credential filtering and locked
Wrangler selection identical to production. Failures name the stopped step and
a recovery action. Publication failures require inspecting provider state before
retrying because the provider may have completed the request.

`npm run release:staging` accepts only a clean checkout whose `HEAD` exactly
matches `origin/main`, verifies the prepared artifact, creates the staging
Worker on first use, and otherwise uploads and promotes an immutable version.
For a clean staging candidate, `npm run release:staging -- --source-sha <HEAD-SHA>` pins that exact commit instead of `origin/main`.
`npm run rollback:staging -- <version-id>` restores one explicit earlier staging
version.

`npm run preview:pr -- <PR#>` gives an open same-repository PR a clickable,
fixture-only preview. Run it where Wrangler is logged in (hosted CI never holds
Cloudflare credentials), from a checkout of `jbookout/doctorcre-app` that is
clean `main` at `origin/main`: the script fetches, then refuses to run on any
other commit or with edits to tracked files, because that checkout supplies the deploy
script and pinned Wrangler. PR code runs only in the hosted CI preview job,
which builds the exact PR head without deployment secrets and uploads
`pr-preview-<PR#>-<head SHA>`. The local command requires a completed-success CI
run for that exact SHA, then uses `gh run download` to retrieve only its named
artifact. It never clones, installs or builds PR code locally.

Downloaded assets must be regular files (no links, dotfiles or escapes). The
script stages them with main's fixture Worker and generated config, then uses
main's lockfile-pinned Wrangler. The Worker remains `doctorcre-app-pr-<PR#>`;
one owned PR comment carries its `workers.dev` URL. `--dry-run` downloads and
validates without deploying or commenting. When PRs close or merge,
`npm run preview:clean` deletes Workers with live preview comments
(`-- <PR#>` targets one closed PR; `--dry-run` previews removal).

The production Worker configuration deliberately declares no public route.
Run `npm run deployment:check:production` to validate it locally.

`PARTNER_SIGN_IN` is `carr` in production and `engine` in staging. Setting it
to `engine` switches auth routes, protected page gates and engine partner calls
together. After either switch, the app expires the inactive sign-in's session
and Google callback cookies that the browser sends on this host. On rollback,
keep the CARR issuance cutoff and end the engine sessions and pending Google
flows created during the failed window before switching again.

The app binds `PARTNER_APP` to the matching engine
environment's `PartnerApp` entrypoint. That entrypoint must be deployed before
the app release adds the binding. In engine mode, keep
`WORKSPACE_COMMAND_CENTER_READ_ENABLED` aligned with the corresponding CARR
environment until the old gate is removed. See the
[partner sign-in cutover plan](https://github.com/DoctorCRE/doctorcre-engine/blob/main/docs/sign-in.md#switch-after-hours-with-advance-notice).

Old engineering, Ideas, Events, and Doc Work or Activity bookmarks open Home.
The app closes the matching proxies. CARR's own MCP endpoint still handles
work requests and board answers. CARR sign-in retains Doc conversation history,
the session read, and legacy Home's calendar read and dismissal. New Ask Doc
turns use PartnerApp with engine sign-in.

In engine sign-in mode, PartnerApp serves the Deals board, deal detail, deal
saves, board polling, client and vendor context, the national capture queue, and
call recorder context regardless of the legacy routing switches. The app blocks
the CARR forwarder in engine mode. PartnerApp receives only the engine session
cookie, with the engine's short-lived OAuth state cookie allowed on the Google
callback. The board stops polling after its first engine-backed load. Updates
reads deal attribution from PartnerApp. Compare terms shows an empty state
while there are no recorded comparable terms. Deal watch settings and Tours
show “Not available yet” until their engine endpoints are available.

PartnerApp also serves Leads reads, claim, stage changes, email acknowledgement
and client linking. Clients, Vendors, Relationships, Search and recent activity
use the same session regardless of their legacy routing switches. The Vendors
drawer shows the track record. The manual rating editor is available with CARR
sign-in, and Relationships uses recorded links and introduction offers.

Home cards and their actions, Today, Calendar dates, and Updates also use
PartnerApp in engine sign-in mode. The deal saves switch also routes Updates
and its navigation badge to the engine. Opening an unread update marks it read
and removes it from Home. The activity list uses the partner's saved time zone.
Invoices, Mark paid, and Historical client fit
use PartnerApp regardless of their legacy routing switches. The engine should
set `INVOICES_READ_SCHEMA=next` so invoices and payments use the same records.

`npm run release:production` consumes the prepared artifact, replaces `dist/site`
from its verified source bytes, and runs only provider upload, promotion and
readback commands. It refuses a missing `CLOUDFLARE_API_TOKEN`. Run publication from a clean
checkout at exactly `origin/main`
under the authorized release workflow. It uploads and promotes an
immutable production version through the same checks as staging; it never
creates a Worker on first use. `npm run rollback:production -- <version-id>`
restores one explicit earlier production version. Attaching `app.doctorcre.com`
or moving the hostname stays outside these scripts and outside `wrangler.jsonc`.

`npm run build` produces a deterministic `dist/doctorcre-app.tar`, its complete
file-and-contract manifest, a SHA-256 sidecar, and the exact `dist/site` static
deployment directory. Tagged `app-v*` releases run
the same checks and publish those three files. Consumers pin the exact source
commit and archive digest; they never import this repository's source tree.

The pinned consumer contract is `contracts/carr-interface.v1/`, one file per
entry so that two branches adding verbs never edit the same lines.
`scripts/carr-interface.mjs` composes it into one object. A feature adds
`mcp_operations/<encoded-verb>.json` (a JSON string), `http_surfaces/<encoded-path>.json`
(`{"value":"/api/v1/example","order":28}`), and its own `<section>.json`.
List filenames use `entryFileName`, a reversible lowercase UTF-8 hex encoding of
the full verb or surface key. The composer rejects duplicate entry files. The
contract digest recursively sorts object keys while retaining array order.
Surface order preserves the original contract
array; append with the next order number. Equal orders from parallel additions
sort by value. CI rejects the retired single file. Tests read the
contract through `test/carr-contract.mjs` and assert only the entries they own.
The live and fixture adapters satisfy the same `DealRoomClient` interface in `js/client.js`.

The repository is publicly visible. No open-source license has been selected;
public visibility alone does not grant reuse rights.

Every PR runs `npm run performance:check` after the build in the required CI
`test` job. It measures Home, Local Deals, Vendors, Tours, Relationships, and
Invoices from `dist/site`, with synthetic records and cold Chromium contexts:
390×844 mobile viewport, 4× CPU slowdown, 150 ms latency, 1.6 Mbps download.
Home uses five cold loads and fails if median LCP exceeds 4,000 ms. All samples
and the median are reported. Other screens use three runs for median LCP and
scripted interaction latency; screen JS is
the largest unique script-byte total loaded through that interaction. Home JS
bytes are informational and have no budget. Total
shipped JS includes every `.js`/`.mjs` in the static artifact; gzip is reported
as the sum of per-file compressed sizes.

`contracts/performance-budget.v1.json` records the measured baseline, source
commit, build digest, and headroom. A breach fails with screen, metric, before,
after, and budget. PR authors reduce the failing metric and rerun the check;
budget increases require visible review in the budget diff. To re-measure the
baseline, save a hosted `test` job log (it holds one `performance-report <base64url>` line) and run
`node scripts/performance-budget.mjs --rebaseline contracts/performance-budget.v1.json <file>`;
it applies the headroom rule to other metrics and preserves the Home load limit. This is a lab
regression guard: interaction latency runs from the browser pointer timestamp
to the verified UI change plus two animation frames, and is not field INP.
The baseline preserves existing slow screens; it does not certify speed.

CI keeps JSON, the performance summary, and Playwright failure traces as artifacts.
The CI job publishes the performance summary in its job summary.

`npm run docs:check` warns about broken local Markdown links and unknown documented npm commands.

Client scheduling is checked with `npm run lint`. Use `createPageBudget` /
`createRequestBudget` for bounded reads and TanStack Query `refetchInterval`
for React polling. Audited local callbacks carry an inline
`eslint-disable-next-line no-restricted-syntax -- <reason>` comment naming the
specific bound or cancellation owner in at least four words; placeholder reasons are rejected.
Raw scheduler aliases, global-object aliases, and static computed scheduler keys
are checked. Schedulers reached through function parameters, returned values,
non-global object properties, or dynamic computed keys are outside this analysis.

`node scripts/prove-loop-lint-coverage.mjs` compares the pinned pre-migration main
revision with ESLint, lists both coverage sets, and asserts containment. It
reports historical direct-form inventory diagnostics separately from wrappers and
name collisions; it gives no scheduler-origin credit to those entries.
The pinned commit must be present in local Git history.
