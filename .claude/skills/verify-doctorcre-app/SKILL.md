---
name: verify-doctorcre-app
description: Verify DoctorCRE UI changes with the app's existing tests and local fixture preview, retain evidence, and report coverage gaps.
---

# Verify DoctorCRE app

Read [the feature index](features/README.md) and the changed feature's recipe. Run from an isolated checkout's repository root. Use the existing runners; do not create another launcher, harness or disposable test script.

## Launch

In Foreman's attempt container, the image and setup in `.foreman/contract.yaml` have already run: Node, Chromium, WebKit and Ruby are present and the locked dependencies are installed. The network is gone once setup ends. Skip to the preview.

Elsewhere, use Git, Ruby (the existing action-pin check parses YAML with it), and Node `^22.22.3 || >=24.8.0`. Install the locked dependencies and both browser engines used by the suite:

```sh
npm ci
npx playwright install chromium webkit
```

Browser installation needs access to Playwright's download hosts. On Linux, missing system libraries require the existing Playwright install command's `--with-deps` option. On macOS 27+, follow the WebKit skip documented in `test/browser-harness.mjs`; Linux CI supplies that coverage.

For manual inspection, start the existing synthetic preview in a separate terminal. The contract's start command pins the port:

```sh
PORT=8787 npm run serve
```

It is up when `curl -fsS http://127.0.0.1:8787/app-release` exits 0. Outside the container, `PORT=0` lets the server pick a free port; open the printed loopback URL. No credentials, database or migrations are needed. Keep local pages in fixture mode; do not append `?mode=live`. Tests start or route their own fixtures and do not use this preview process.

## Sign in

The preview is already signed in. Every page opens as the synthetic partner `joe`, with no account, password or cookie, and `/api/engine/home/today` answers `"viewer":"joe"`. The test account for a browser run is that fixture partner.

Signing in to a running engine is the engine's verify skill. No app secret is needed to start the preview, so the contract names none.

## Doctor

Require rendered controls and readable fixture data, not just a listening server. `/app-release` must identify `doctorcre-app`, environment `fixture`, and the current `contracts/carr-interface.v1/version.json` version. Its zero source SHA is a fixture marker, so it cannot prove a deployed revision.

```sh
npm run check
npm run docs:check
npm run ci:fast
```

Signed-in staging is a separate target. Follow the existing [staging instructions](../../../README.md#end-to-end-journeys) and `playwright.config.ts` only when its secret is provisioned. Never print environment variables, credentials, auth state, cookies or headers. Compare staging's `/app-release` source revision before attributing behavior to a checkout. Without access, report staging identity, session reuse, deployed revision, live reads and remote persistence as unverified.

## Drive

Run the existing offline suite, then the existing fixture Playwright project with retained traces:

```sh
npm test
npx playwright test --project=fixtures --trace=on --output=.e2e/verify-fixtures
npm run build
npm run artifact:verify
```

When browsers are unavailable, run the repo's existing `node .githooks/pre-push --test --fast` subset and report the full Node and Playwright suites as not run. Its dependency classifier deliberately excludes tests it cannot prove browser-free.

The Node suite uses `test/browser-harness.mjs`; fixture Playwright specs supply their own synthetic HTTP adapters. Some tests deliberately exercise writes against disposable synthetic state. These runs do not prove staging authentication or remote persistence. Inspect the changed feature in the preview using its map; record which entry points were actually driven.

## Evidence

Captures are not redacted, so no screenshot, trace, video or log excerpt may show a secret: no environment variable, credential, auth state, cookie, token or request header. Capture the page, never a terminal or devtools panel that shows those.

Keep command exit results, assertion failures, traces under `.e2e/verify-fixtures`, and screenshots written by existing tests under `out/test-artifacts` or `test-artifacts`. Inspect images before claiming visual proof. Copy relevant artifacts outside a checkout before retiring it. Report skipped tests and missing preconditions explicitly; a passing unrelated test is not coverage of the changed path.

The private-name check is part of hosted CI. If its private corpus is provisioned, run:

```sh
npm run privacy:check
```

An unavailable corpus is a blocked check; never invent one or report a pass. Publish only reviewed synthetic evidence. Keep staging artifacts private.

## Cleanup

Stop the preview with Ctrl-C in the terminal that launched it. Existing tests own their browser and server teardown. Preserve evidence; remove only run-owned temporary files. Do not kill unrelated listeners or reset shared staging data.

## Helpers

Reuse `test/browser-harness.mjs`, `scripts/fixture-server.mjs`, `playwright.config.ts` and existing feature tests. Add coverage through the repo's normal test workflow when a changed behavior lacks a test. Keep this skill and the feature map aligned with those interfaces.
