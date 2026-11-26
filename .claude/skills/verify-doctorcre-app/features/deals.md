# Deals

Local Deals lets a partner review Board or List, open a full-page Deal Workspace and return to the same record and board scroll position.

## Sub-features

`deals-board-open`, `deals-views`, `deals-list-open`, `deals-deep-link`, `deals-home-open`, `deals-reopen`, `deals-requirement-preview`, `deals-email-followups`.

## How to get to it (user POV)

Choose Local Deals in Primary navigation or open `/deals`. Open a visible deal heading from Board or List, a Home flag, or `/deals?deal=d14` for the local Demo Surgical Practice fixture.

## Driving it with Playwright

Existing coverage: `test/local-deals-browser.test.mjs`, `test/dealroom-acceptance-browser.test.mjs` and the Home link tests. The fixture Playwright project also runs the parked-deal journey in `tests/fixtures/staging-controls.spec.mjs`.

- Board stage headings stay above the cards while scrolling. Collapse a stage to see its count and two-name preview, then expand it with Enter. The choice survives Board/List switches for the current page. `test/deal-card-review.test.mjs` covers 100 cards, full practice names, focus visibility, and both themes at phone and desktop widths. Captures stay under `out/test-artifacts/d02-stages/`.
- Require a visible `.card-open`. Save its title, click, and require visible `main#recordPanel`, matching `#panelTitle` and visible `#detailUpdateForm`.
- Use **Deals** in the top bar or browser Back, require the workspace hidden, then reopen that same heading and compare the title.
- The deal snapshot shows the Board step and any other open step with its owner and due date. With engine reads on, matching open step wording appears once with both owners and separate Done buttons. The engine supplies the Home action title for each email follow-up. With an older engine, the heading uses the email subject with addresses removed, or “Email follow-up” when the subject is missing. Choosing Done for one owner leaves the other owner’s step open. `test/dealroom-acceptance-browser.test.mjs` covers both at phone and desktop widths. Refresh updates the summary when an action arrives or is cleared. `test/local-deals-browser.test.mjs` covers both widths. `tests/fixtures/deal-workspace.spec.mjs` checks that a filed call item stays openable from both views and that other open steps appear once.
- Choose List; require `#listView[aria-pressed="true"]`. Open a **visible** `.card-open` in that view and compare the room title. Return to Board and require `#boardView[aria-pressed="true"]`.
- Open the local direct URL above and compare Demo Surgical Practice. Separately follow the Home flag and navigation link; Board opening does not cover either path.

- Updates previews the newest recorded entry. Expand Recorded updates to verify descending instants with undated entries last. `test/deal-timeline-browser.test.mjs` checks 390px and 1440px in both themes and writes synthetic captures under `out/test-artifacts/newest-updates/`. `test/deal-timeline-check.test.mjs` covers offsets, sub-millisecond timestamps, documents and missing dates.

- Vendor assignments retain role, company and contact name. Expand Contact details to read the recorded email and phone without opening the deal or changing its phase. A contact without either channel has no disclosure. `test/deal-vendors-browser.test.mjs` checks click and keyboard operation, escaped channels, Board, List, parked and archived cards, and the deal room at phone and desktop widths. Synthetic captures remain under `out/test-artifacts/deal-vendors/`.

- Open Draft requirement email in a deal. Enter approved requirements, generate and edit the subject and message, then copy the draft. `test/pipeline-interruption-browser.test.mjs` covers anonymous generation, copy failure, discard, record isolation and identity revocation. Drafts remain only while the page is open.

- Call mode reviews a discussed deal's next step separately from its note. A pending matched proposal offers Confirm next step and Skip next step. A missing date warns that confirmation clears the current date. Settled or unmatched proposals stay visible without decision controls. `test/dealroom-call-mode.test.mjs` drives phone confirmation and desktop skipping with the real dialog, plus stale refusal and retained-request recovery. Synthetic captures remain under `out/test-artifacts/call-next-step/`.

- With engine sign-in, open **Call review** in the deal overview to see recent calls, quoted evidence, and suggestion decisions. Accept or Dismiss a pending suggestion. The review shows why Accept is unavailable for a private note or an assignee with an open next step, and still offers Dismiss. The review is complete when no suggestions are pending. An unanswered decision keeps its original key when the partner returns to the deal. From the Deals board, open Call Mode after a recording files. The report reviews the activity on every deal named in the filing receipt and only shows the summary when that activity appears in the signed-in partner’s call list. The engine cases and the Carr control run in `test/partner-sign-in.browser.ts`.

- Email follow-ups appears inside each deal room. Review the quoted evidence, choose Confirm, inspect the fresh replacement preview, then Confirm change. Dismiss requires a reason. Refresh deal reloads the pending list. `test/email-followups-browser.test.mjs` covers the scoped deal flow, unavailable reads and empty states at phone and desktop widths. The shared module tests cover pagination, stale preview refusal and uncertain-write recovery.

- Deal Workspace defaults to Overview. Its first row is the critical dates, one tile each, soonest first, never wrapping: a tile opens the date with its choices, a proposed date keeps its count and has **Confirm** on the tile, done, dropped and passed dates leave the row, a full row scrolls sideways without clipping a tile, **+** adds a date, and a deal with none shows one line with **Add date** (`test/deal-overview.browser.ts`). The updated time and Refresh sit on their own line under the row. Below it come the next action, updates, vendors, and phase and owner controls. Open **Change next step** in the update form to edit the saved step and date. The top bar reads Deals / the deal name. The five tabs are Overview, Activity, Tours, Documents and Client portal, with the client, phase, owner, kind, reason and market beside them. Activity holds the dated events with a type filter, then threads, meetings and deal notes. The tab row scrolls away on phones and stays visible across tabs on desktop. `tests/fixtures/deal-workspace.spec.mjs` covers direct links, history, scroll restoration, and tab content at phone and desktop widths in both themes.


- Board cards read Next from the earliest open action or from the matching filed call item, and Last from a dated `last_step`. Fixture boards derive these fields from the same actions and history as deal detail. `test/deal-items-check.test.mjs` crosses both adapters. `test/deal-board-summary-browser.test.mjs` verifies visible dates and partner initials at 390, 1280 and 1440 in both themes. Synthetic board captures are retained under `.github/pr-evidence/WR586.S1.J6/round-1/`.


- With legacy deal reads, Documents lists canonical deal files through `listDealDocuments` and `deal-documents.v1`. Open a deal, then select Documents. Rows show stored metadata and canonical UUID/hash identity, with no download or sharing controls. `node --test test/deal-documents-browser.test.mjs` verifies 390px and 1440px in both themes, loading, empty and unavailable states, retry, session expiry, bounded pagination and a late response after leaving the deal. Synthetic captures are under `out/test-artifacts/deal-documents/`.

- With engine Deals reads, select Documents to download a filed file or open its extracted text. The text viewer preserves blank pages. With engine Deals saves enabled, use **Upload to this deal** to file a document. `node --test test/partner-sign-in.browser.ts` drives upload, text and download under both sign-in modes.

## Gotchas

Use actual synthetic staging IDs when verifying staging. Deep-link Back changes the URL, so check URL and workspace visibility independently. Manual read-only inspection must not submit Update, change Phase or Owner, Park, or Mark inactive.

## Call Mode consent and review

Deal Room Call Mode: record Joe and Dell's pipeline call, then review it.

Restored from the working Deal Room shell that carr-system 13411964 (#963)
made inert for the first workspace release, and reinstated by decision
7dc47eea (Joe, 2026-09-23): "a button on the deal room page that started
recording our conversation, transcribed, and fed back to the system for
context and updates." It is not a way to hold a meeting with a client or a
vendor; that stays a Teams meeting.

The recorder is Quill on the partner's own Mac. This page reaches it only
through the loopback companion at http://127.0.0.1:4682 (carr-system
tools/dictation-rig/bin/call-mode.py), and only because a partner pressed a
control (apart from the bounded read-only eligibility probe):

  - creating the controller sends nothing and starts no timer;
  - opening the dialog reads the recorder's state, nothing more;
  - a recording starts only from a Start button AND the consent box ticked
    ("I have told everyone on this call that it will be recorded"), and the
    companion refuses a start without consent_confirmed as well;
  - the post-call review pack is only ever displayed. Every task, deal update
    and email draft in it waits for a partner to Confirm or Skip that item;
    nothing is written to the record and no Outlook draft is created before
    that. There is no send path at all.

The weekly call needs a short-lived deal context index so the local
distiller can attach what was said to exact deals and people. It is read
from get-call-context (at most 50 deals a request, so the agenda is read in
batches), shaped to the companion's exact contract, and handed to the
companion at start. If the recording's report is still `awaiting_context`
when this page next looks at it — the page was closed at start, or the index
failed — it is supplied again then, and the companion processes the
transcript it already has.
