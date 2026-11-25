# DoctorCRE static application

DoctorCRE is the human application for CARR. This repository owns the browser
product; CARR owns authoritative business records, domain behavior,
authentication, control, and assurance.

## Current transition state

- The app communicates with CARR through the pinned contract in
  `contracts/carr-interface.v1/`; it never connects to CARR's database.
- `data/board-seed.json` contains 11 explicitly synthetic records for local
  development and automated tests. It is not a production data source.

## Run locally

```bash
npm run check
npm test
npm run serve
```

Then open `http://127.0.0.1:8787/`. Local and unknown hosts use the synthetic
fixture. Reviewed DoctorCRE production hosts boot the live adapter.

## Product layout

| Path | Responsibility |
|------|----------------|
| `*.html` | DoctorCRE application surfaces |
| `js/call-mode.js` | Deal Room Call Mode (decision 7dc47eea): records Joe and Dell's pipeline call through the loopback Quill companion only after a Start press with the consent box ticked, supplies the weekly deal context index to the companion (batched get-call-context, shaped to its contract, re-supplied to a session left `awaiting_context`), and shows the post-call review pack in which every deal update, task and Outlook draft waits for a partner to approve it. There is no send path |
| `/tasks` and `/tasks.html` | Legacy routes that redirect to Home at `/`, served by `workspace.html`. Declared in `js/routes.js` |
| `pipeline.html` | V5-UX-B03 Deals at `/pipeline`: the eight-phase Kanban, moved by drag or keyboard, with the completion dialog, the crossed-edits chooser and the record panel |
| `js/pipeline-model.js` | Pure board rules: the eight columns and their one-to-one phase map, grouping, the move intent, the ordered completion plan and the keyboard target |
| `js/pipeline.js` | Deals DOM wiring over `deal-room-board` and `patch-deal-field`, through the board coordinator, the field-write kernel and the command dock |
| `notifications.html` | V5-UX-B12a/B12 Notifications at `/notifications`: the items addressed to you, the delivery state per channel including what quiet hours held, and the accountable activity stream beside them |
| `settings.html` | Settings at `/settings`, opened from the account menu: the quiet-hours and device opt-in preference form under a compare-and-swap on `version`, Doc link, and phone notifications |
| `js/notifications-model.js` | Pure notification rules: the feed payload's exact keys, the two-value severity vocabulary, the delivery phrases, the deep-link route lookup, the eight UX20 states and the one write's arguments |
| `js/notifications.js` | Notifications DOM wiring over `notification-feed` and `GET /pipeline/changes`, with `acknowledge-notification` sent through the shared command kernel and dock |
| `conversations.html` | V5-UX-B07 Doc conversations at `/conversations?id=…`: the record layer's list of conversations, one conversation's turns, who can read it, and create / rename / pin / archive / share through the record layer |
| `css/conversations.css` | The conversations page layer: private versus shared drawn with a word, a glyph and an accent, the one-column transcript, and the 44px floor at 360px |
| `js/conversations-model.js` | Pure conversation rules: the verb's own uuid shape, the read and list payloads' exact keys, the list door's three optional arguments, the eight UX20 states, the compare-and-swap argument builders and the five operation keys |
| `js/conversations.js` | Conversations DOM wiring over `list-doc-conversations` and `read-doc-conversation`, with `create-`, `rename-` and `share-doc-conversation` sent through the shared command kernel and dock |
| `calendar.html` | V5-UX-B04 Calendar at `/calendar?view=month\|week&d=…&day=…`: every deal's critical dates by month or week, read only, with the approach pulse, the day panel, the upcoming agenda and the undated rows |
| `js/calendar-model.js` | Pure calendar rules: YYYY-MM-DD arithmetic, the month grid and week strip, the URL state, the approach bands, the bounded board-then-each-deal read and its partial/undated/signed-out states |
| `js/calendar.js` | Calendar DOM wiring over `deal-room-board` and `get-deal-room` (one per deal, at most four in flight) |
| `js/record-activity-model.js` | V5-UX-B04 recent activity on a Vendors or Clients record: `find-and-catch-up` shown only when its one match is the record's own ref |
| `status.html` | V5-UX-C15 Status at `/status`: the one page served ahead of the CARR sign-in gate, so an app outage and a record-layer outage can be told apart without signing in |
| `js/status-model.js` | Pure status rules: the four headline scenarios, the sanitized refusal sentence, the payload-free last-known snapshot and the named integration gaps |
| `js/status.js` | Status DOM wiring over `GET /app-release` and scoped assurance health |
| `js/shell.js` | The shell every surface shares: the three presentation icons (one storage key, legacy key migrated), the tab strip, and shared controls |
| `css/` | Product presentation and responsive behavior; `css/system.css` defines the shared visual system |
| `src/ui/doc-chat.tsx` | Ask Doc conversations and turns, opened from the shared top bar |
| `src/ui/` | Strict TypeScript React islands (decision d23358f1, V2-WORKSPACE). `scripts/ui-bundle.mjs` compiles narrow browser entries with shared React chunks into the artifact. Each caller imports its own island: `/invoices?ui=react` enables the zoomable workspace on a desktop fixture boot. The rest of the app stays static HTML and JavaScript modules |
| `js/client.js` | Small client interface selected by the app |
| `js/live-client.js` | Authenticated same-origin CARR adapter |
| `js/fixture-client.js` | In-memory synthetic adapter |
| `contracts/` | Pinned CARR consumer boundary and runtime contracts |
| `data/board-seed.json` | Synthetic local/test fixture only |
| `tours/` | DoctorCRE tour presentation |

## Boundary invariants

- Real deal data is read and changed through authenticated CARR interfaces.
- The browser never receives database credentials or chooses its own authority.
- Retries preserve idempotency keys and reconcile uncertain writes with CARR.
- No CARR server implementation is imported into this repository.
- No software-factory component is a runtime dependency.
