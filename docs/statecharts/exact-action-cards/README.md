# Exact action cards

With engine sign-in, a saved reply link opens the exact Home review at `/inbox/card/:item_id`. A saved lead link opens its Leads drawer. [Engine contract](https://github.com/DoctorCRE/doctorcre-engine/blob/bf37e301712db8eb9a5b31fc2c5a82a2d0c8d3ea/docs/new-database.md#saved-action-links)

With CARR sign-in, lead drafts use `resolve-action-link` and reply drafts use `resolve-action-link-v2`. The exact reference survives sign-in.

Retired post-call review and client tour feedback links show **This link is no longer available** after sign-in. The page links back to Home. The statecharts in this directory describe the original CARR flows before those links were retired.

## Reply link proof

`scripts/prove-exact-action-cards.ts` accepts `--origin`, `--commit`, `--reply-ref`, `--reply-id`, `--foreign-ref` and `--cdp-url`. It uses a signed-in CARR browser session over loopback CDP with a containing release. It independently resolves the reply ID, checks the rendered card, verifies that a foreign reference shows no draft, and checks that the release is stable. The proof is read-only.

Exit 0 means all assertions passed. Exit 1 means an assertion failed. Exit 78 means insufficient evidence, including an unavailable read or session. `node --test test/exact-action-cards.browser.ts` exercises all three exits on synthetic browser fixtures and checks the unavailable page for both retired link types.
