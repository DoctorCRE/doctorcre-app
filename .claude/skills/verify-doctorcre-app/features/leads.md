# Leads

Leads lets a partner search the board, filter by owner, market, specialty or stage, and inspect a lead.

## Sub-features

`leads-search`, `leads-filter`, `leads-detail`, bounded stage lanes.

## How to get to it (user POV)

Choose Leads in Primary navigation or open `/leads`. Use Search leads, Owner, Market, Specialty, Board stage, or a visible lead's detail control.

## Driving it with Playwright

Existing coverage: `tests/fixtures/staging-leads.spec.mjs` runs the staging assertions through `test/leads-browser-fixture.mjs` and its synthetic HTTP adapter. The Node suite also runs `test/leads-workspace.test.mjs` and the Leads browser tests.

- Require visible `#leadBoard .lead-card` and hidden `#leadBoardError` before starting.
- Search for a unique nonmatching string; require zero board cards. Clear Search leads and require the board restored. Scope assertions to `#leadBoard`; the board is the only ranked lead list.
- Choose Unclaimed in `#ownerFilter`, then clear it with All owners. Choose a populated Board stage in `#stageFilter`. Check `#leadCount` and open a matching card. Never assume staging has owner `joe`.
- Choose Show territory and require the default frame to cover Mobile, Tallahassee and Dothan. Filters and refresh keep the same camera and canvas.
- Choose a Specialty and require the board, market counts and map markers to narrow together. Clear it with All specialties. A refreshed snapshot with no matching specialty keeps the filter and shows zero matches.
- Select Quiet leads and confirm the board shows due leads. Only overdue follow-ups earn a badge. Combine Quiet leads with Owner, then use Reset filters.
- The Territory link beside the page title jumps to the market map and chips. Show territory loads the map on demand.
- Each stage starts with at most five cards. Choose Show all in its heading to scroll the full lane beneath the heading and Collapse control. Counts and search include every matching lead.
- Hover or focus a map marker. Require a readable preview with current count, place names, up to three lead titles and **Market area only**. Escape dismisses without moving focus. Filtering refreshes or removes the preview.
- Activate a multi-lead city group on the map, or a terminal cluster at zoom 11. Require the **Leads in this place** chooser and **Market area only** label. On a phone the chooser opens below the map and the marker stays in place. Open each member with mouse and Enter, compare the detail title and selected card, then close and require the same member focus and unchanged camera. Escape closes the chooser and returns focus to its marker. Filters remove excluded members. No city group offers address navigation.
- Use the selected card's `.lead-open` button. Compare `#detailTitle` to that lead's title and require visible `#leadDetail`. Use Close lead details and require it hidden.

## Gotchas

The plain static preview does not supply the Leads workspace API. Use the existing routed fixture tests for populated local coverage. Claim, stage moves, and client links write records. The automated fixtures isolate those writes.

Engine sign-in sends Claim, stage moves, and confirmed client links to the engine using the board UUID. With CARR sign-in, the same routing requires both `leads-from-engine` and `deals-saves-from-engine`. An archive sends the partner's reason. `test/engine-switch.test.ts` checks the three routes, the old route before cutover, and the response to stale or unconfirmed saves.

Reasons to reach out loads the pinned `practice-origination.v1` read independently of the board. Each existing work card shows registration or publication evidence with a public CMS source. Exact client matches open `/clients?record=...`; ambiguous matches say Needs review and offer only the source. Coverage shows covered sources and blocked updates. More reasons pages with the server cursor. Home loads reasons when its secondary panels enter view, shows at most three research reasons and links to this section. `test/practice-origination.test.mjs` covers the client reads, synthetic routes, coverage, rendered copy, failure recovery and session retirement. `test/contact-reasons-browser.test.mjs` drives both entry points at 390px and 1440px in light and dark, with synthetic captures under `out/test-artifacts/contact-reasons/`. These checks do not prove signed-in staging or live source imports.

One-tap draft links open `/a/:ref` directly in the React review screen. The app uses the Leads page gate and preserves the exact link through sign-in. Read the subject, body and planned date, then choose Approve draft. Approval records the displayed revision and sends nothing. A stale revision requires Reload draft. An unconfirmed write offers Retry approval with the same key. Unavailable or foreign links offer no approval. `test/action-link-route.test.mjs` verifies gating, `test/action-link.test.mjs` covers refusal and retry behavior, and `test/action-link-browser.test.mjs` drives synthetic review and approval at 390px and 1440px in both themes. Captures are under `out/test-artifacts/action-links/`. These tests do not prove signed-in staging or production persistence.
