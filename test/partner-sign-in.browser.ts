import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { after, type TestContext, test } from "node:test";
import type { Page } from "playwright";
import { createInvoiceFixture, invoiceTrackerFixture } from "../js/invoice-tracker-fixture.js";
import { isRetiredPage } from "../js/routes.js";
import { appAssetSnapshot } from "../scripts/fixture-app-assets.mjs";
import { startWorkerFixture } from "../scripts/fixture-http.mjs";
import { chromium } from "./browser-harness.mjs";
import carrReply from "./fixtures/action-link-reply.v2.json" with { type: "json" };
import anniversaries from "./fixtures/client-anniversary-panel/recordings.json" with { type: "json" };
import carrDocumentText from "./fixtures/deal-document-text/produced.json" with { type: "json" };
import { directoryFixture } from "./fixtures/vendor-directory.synthetic.mjs";
import { FixtureHtmlRewriter } from "./fixtures/worker-html.ts";
import { detail, emptyQuietFollowUps, lead, workspace } from "./leads-workspace-fixture.mjs";

Object.defineProperty(globalThis, "HTMLRewriter", { configurable: true, value: FixtureHtmlRewriter });

const cookieName = "__Host-doctorcre_session";
const partners = new Map([
  ["first", "joe"],
  ["second", "dell"],
]);
const deepLink = "/leads?mode=live&filter=open";
const copiedLeadAlias = "30000000-0000-0000-0000-000000000101";
const docLink = "/api/engine/doc/link";
const actionLinkRef = (value: string) => `al1_${Buffer.from(value).toString("base64url")}`;
const leadRef = actionLinkRef("ld:44444444-4444-4444-8444-444444444444");
const successorDraft = "66666666-6666-4666-8666-666666666666";
const chat = {
  id: "33333333-3333-4333-8333-333333333333",
  title: "Demo relocation chat",
  created_at: "2026-11-20T12:00:00Z",
};
const replyTitle = "Reply to the demo relocation email";
const linkedItem = `reply_draft:${successorDraft}`;
const linkedCard = `/api/engine/home/cards/${linkedItem}`;
const linkedCardRead = `/api/engine/home/cards/${encodeURIComponent(linkedItem)}`;
const actionResolver = "/api/engine/action-links/";
const dealId = "11111111-1111-4111-8111-111111111111";
const dealName = "Demo deal on engine sign-in";
const filingId = "55555555-5555-4555-8555-555555555555";
const filingTitle = "Review where to file this email";
const filingChoices = [{ kind: "vendor", label: "Choose vendor" }];
const activityId = "22222222-2222-4222-8222-222222222222";
const noteId = "44444444-4444-4444-8444-444444444444";
const noteSummary = "Confirm the demo showing";
const callSummary = "Discussed the demo showing";
const noteAttributionPath = `/api/engine/activities/${noteId}/deal-attribution`;
const attributionPath = `/api/engine/activities/${activityId}/deal-attribution`;
const dealPage = `/deals?mode=live&deal=${dealId}`;
const filedDocument = { id: carrDocumentText.attachment_id, name: "Demo lease.pdf", version: 1 };
const uploadBytes = Buffer.from("%PDF-1.7 synthetic");
const uploadDigest = createHash("sha256").update(uploadBytes).digest("hex");
const documentTextPath = `/api/engine/deals/${dealId}/documents/${filedDocument.id}/text`;
const carrDocumentReads = new Map<string, object>([
  [
    "list-deal-documents",
    {
      ok: true,
      schema_version: "deal-documents.v1",
      documents: [
        {
          id: filedDocument.id,
          display_name: filedDocument.name,
          document_type: "application/pdf",
          page_count: carrDocumentText.page_count,
          content_hash: carrDocumentText.content_hash,
          stored_at: "2026-01-01T00:00:00Z",
        },
      ],
      has_more: false,
      next_cursor: null,
    },
  ],
  ["read-deal-document-text", { ...carrDocumentText, deal_id: dealId }],
]);
const creditedDeal = { id: dealId, name: dealName };
const candidateDeal = { id: "33333333-3333-4333-8333-333333333333", name: "Example second deal" };
const dealRow = { id: dealId, name: dealName, phase: "research", owner: "joe", operating_state: "active" };
const dealBoard = { schema_version: "local-deals-board.v2", actor: "joe", deals: [dealRow] };
const dealDetail = {
  ...dealRow,
  deal_id: dealId,
  activities: [{ id: activityId, kind: "call", summary: callSummary, occurred_at: "2026-01-01T12:00:00Z" }],
  thread: [{ id: noteId, kind: "note", actor: "joe", text: noteSummary, created_at: "2026-01-02T12:00:00Z" }],
};
const closingAnniversaries = "/api/engine/closing-anniversaries";
const carrAnniversaries = "/api/v1/intelligence/client-anniversary-read";
const anniversaryClientId = "00000000-0000-4000-8000-000000000001";
const anniversaryClientName = "Demo Practice 01";
const invoiceDay = "2026-10-02";
const invoiceName = "Demo Harbor Renewal";
const invoiceId = "00000000-0000-4000-8000-000000000001";
const secondInvoiceId = "00000000-0000-4000-8000-000000000007";
const firstInvoiceRow = (page: Page) => page.getByRole("button", { name: /Demo Harbor Renewal.*12,500/ });
const invoicePath = "/api/engine/invoices";
const paymentPath = invoicePath + "/mark-paid";
const fitPath = "/api/engine/client-fit";
const fitEvidence = "Demo completed practice lease";
const clientFit = {
  schema_version: "ideal-client-profile.v1",
  coverage: "recorded_closed_won_only",
  profiles: [
    {
      vertical: "Dental",
      deal_type: "lease",
      city: "Example City",
      state: "TX",
      won_deals: 1,
      clients: 1,
      hypothesis: "Historical fit, not a prediction or qualification rule.",
      evidence: [{ deal_id: dealId, deal_name: fitEvidence, closed_on: "2026-09-01" }],
    },
  ],
};
const pages = ["/invoices?mode=live", "/doc-chats?mode=live", "/pipeline?mode=live"];
const filingCard = {
  card_id: `conversation:${filingId}`,
  item_id: `suggestion:${filingId}`,
  source_id: filingId,
  source_type: "email_proposal",
  source_version: "1",
  source_state: "needs_attention",
  base_version: "1:0:inbox",
  section: "inbox",
  disposition: "inbox",
  activity_at: "2026-11-21T12:00:00Z",
  hold_until: null,
  snoozed_until: null,
  completed_at: null,
  unseen: false,
  context_label: null,
  due_on: null,
  open_url: null,
  kind_label: "Suggestion",
  merged_source_ids: [filingId],
  deal_id: null,
  action_id: null,
  action_version: null,
  waiting_version: 0,
  waiting_on: null,
  title: filingTitle,
  why: "The sender asked for a floor plan.",
  primary_action: "Choose vendor",
  filing_choices: filingChoices,
  suggestions: [{ id: filingId }],
};
const feedbackId = "22222222-2222-4222-8222-222222222223";
const feedbackItem = `notification:${feedbackId}`;
const feedbackTitle = "Tour feedback on Example Clinic";
const feedbackText = "The exam rooms are bright. Recorded Nov 21, 2026.";
const artifacts = "out/test-artifacts/partner-sign-in";
let assets: ReturnType<typeof appAssetSnapshot> | undefined;
let browser: ReturnType<typeof chromium.launch> | undefined;
after(async () => (await browser)?.close());

const vendorContactNotes = [
  "Imported from Outlook archive",
  "Site tour (agent@example.test)",
  "CARR Financing review",
  "Discussed a site visit",
  null,
];

const switchDayKeys = new Set([
  "deals-from-engine",
  "leads-from-engine",
  "invoices-from-engine",
  "charts-from-engine",
  "national-deals-from-engine",
  "search-from-engine",
  "clients-vendors-from-engine",
  "relationships-from-engine",
  "deals-saves-from-engine",
]);

async function app(
  t: TestContext,
  {
    width = 1440,
    theme = "dark",
    signIn = "engine",
    switchDay = false,
    holdDocIssue,
    touch = false,
    readAttribution,
    documentText,
    documents = [filedDocument],
    tourDeal,
    readAnniversaries,
    tourFeedback = false,
    tourPlans = false,
    callReview,
  }: {
    width?: number;
    touch?: boolean;
    theme?: "dark" | "light";
    signIn?: "engine" | "carr";
    switchDay?: boolean;
    holdDocIssue?: Promise<void>;
    tourDeal?: () => object;
    readAnniversaries?: (request: Request) => Response;
    tourFeedback?: boolean;
    tourPlans?: boolean;
    callReview?: (request: Request) => Response | Promise<Response>;
    readAttribution?: (request: Request) => Response | Promise<Response>;
    documentText?: string[] | "missing";
    documents?: (typeof filedDocument)[];
  } = {},
) {
  let unavailable = false;
  let carrChecks = 0;
  const carrTools: string[] = [];
  const invoiceEntries = invoiceTrackerFixture(invoiceDay).entries.map((row) =>
    row.name === invoiceName ? { ...row, deal_id: dealId } : row,
  );
  const firstInvoice = invoiceEntries.find((row) => row.commission_id === invoiceId);
  assert.ok(firstInvoice);
  invoiceEntries.push({
    ...firstInvoice,
    commission_id: secondInvoiceId,
    gross_amount: "7500",
    status: "received",
    commission_invoiced_on: "2026-09-25",
    due_on: "2026-10-25",
    received_on: invoiceDay,
  });
  const invoices = createInvoiceFixture({ today: () => invoiceDay, entries: invoiceEntries });
  const screenTools = new Map<string, (args: Parameters<typeof invoices.markInvoicePaid>[0]) => unknown>([
    ["read-invoice-tracker", () => invoices.getInvoiceTracker()],
    ["record-commission-receipt", (args) => invoices.markInvoicePaid(args)],
    ["ideal-client-profile", () => clientFit],
    ["list-doc-conversations", () => ({ conversations: [chat], visible_conversation_count: 1 })],
  ]);
  const partnerReads = new Map<string, string | null>();
  let expiredPath: string | null = null;
  let writes = 0;
  let feedbackOpen = tourFeedback;
  const live = new Set<string>();
  const links = new Map<string, string>();
  const exampleLead = lead(1);
  let leadOwner: string | null = null;
  let expireOnLeadDetail = false;
  let issueCount = 0;
  let loseIssueResponse = false;
  let uploaded: ArrayBuffer | undefined;
  async function dealDocumentsResponse(input: Request, csrf: string) {
    if (!documentText) return;
    const { pathname: path } = new URL(input.url);
    const dealPath = `/api/engine/deals/${dealId}`;
    if (path === dealPath) return Response.json({ ...dealDetail, email_follow_ups: [], ...tourDeal?.(), documents });
    if (path === documentTextPath)
      return documentText === "missing"
        ? Response.json({ error: "not_found" }, { status: 404 })
        : Response.json({ pages: documentText });
    if (path === `/api/engine/files/${uploadDigest}`) {
      assert.equal(input.method, "PUT");
      assert.equal(input.headers.get("x-carr-csrf"), csrf);
      uploaded = await input.arrayBuffer();
      assert.deepEqual(Buffer.from(uploaded), uploadBytes);
      return Response.json({ sha256: uploadDigest }, { status: 201 });
    }
    if (path === dealPath + "/documents") {
      assert.equal(input.method, "POST");
      assert.equal(input.headers.get("x-carr-csrf"), csrf);
      assert.ok(uploaded);
      const { idempotency_key, ...command } = await input.json();
      assert.match(idempotency_key, /^[a-f0-9-]{36}$/);
      assert.deepEqual(command, { sha256: uploadDigest, name: filedDocument.name, kind: "lease" });
      documents.push(filedDocument);
      return Response.json({ document_id: filedDocument.id, deal_id: dealId }, { status: 201 });
    }
    if (path === `/api/engine/documents/${filedDocument.id}` && uploaded && documents.includes(filedDocument))
      return new Response(uploaded, {
        headers: {
          "content-type": "application/pdf",
          "content-disposition": `attachment; filename="${filedDocument.name}"`,
        },
      });
  }
  const env: NonNullable<Parameters<typeof startWorkerFixture>[0]>["env"] = {
    PARTNER_SIGN_IN: signIn,
    WORKSPACE_COMMAND_CENTER_READ_ENABLED: "true",
    ...(switchDay && { APP_ENV: "production" }),
    ENGINE_ROUTING: {
      async get(key: string) {
        if (key === "deal-tours-from-engine" && tourPlans) return "on";
        if (!switchDay) return null;
        return key === "deal-cutover-date" ? "2026-11-20" : switchDayKeys.has(key) ? "on" : null;
      },
    },
    ...(switchDay && {
      ENGINE: {
        async fetch(input: Request) {
          const url = new URL(input.url);
          const path = url.pathname;
          assert.equal(input.headers.get("cookie"), "__Host-dealroom_session=directory-fixture");
          if (signIn === "carr") {
            const response = await dealDocumentsResponse(input, "fixture-carr");
            if (response) return response;
          }
          if (path !== "/api/engine/clients" && path !== "/api/engine/vendors") {
            assert.ok(env?.PARTNER_APP);
            return env.PARTNER_APP.fetch(input);
          }
          url.pathname = path.replace("/api/engine", "/api/v1/business");
          const payload = directoryFixture(url.href);
          if (path === "/api/engine/vendors" && Array.isArray(payload.rows)) {
            for (const row of payload.rows) {
              const note = vendorContactNotes[Number(row.ref.split("-").at(-1)) - 1];
              if (note === undefined) continue;
              row.relationship.last_contacted_at = note === null ? null : "2026-10-01T01:30:00Z";
              row.relationship.last_contact_note = note;
            }
          }
          return Response.json(payload);
        },
      },
    }),
    CARR: {
      fetch: async (input) => {
        const path = new URL(input.url).pathname;
        const navigation = input.headers.get("sec-fetch-mode") === "navigate";
        if (path.startsWith("/auth/") || navigation) carrChecks++;
        const call = path === "/mcp" ? await input.json() : null;
        if (call) carrTools.push(call.params.name);
        if (signIn === "carr") {
          if (isRetiredPage(path)) return new Response(null, { status: 404 });
          if (path === carrAnniversaries && readAnniversaries) return readAnniversaries(input);
          if (path === "/auth/session" || path === "/api/system-work/session")
            return Response.json({ actor: { slug: "joe" }, csrf_token: "fixture-carr" });
          if (path === "/auth/login") return new Response("Sign in");
          if (switchDay && navigation && !input.headers.get("cookie")?.includes("__Host-dealroom_session="))
            return Response.redirect(new URL("/auth/login", input.url));
          if (path.startsWith("/api/v1/business/vendors")) return Response.json(directoryFixture(input.url));
          if (path === "/api/v1/market-terms/read") {
            const recordings = JSON.parse(
              await readFile(new URL("./fixtures/market-terms/recordings.json", import.meta.url), "utf8"),
            );
            return Response.json(recordings.records.full.response);
          }
          if (call) {
            const { id, params } = call;
            const documentRead = documentText ? carrDocumentReads.get(params.name) : undefined;
            const screenTool = screenTools.get(params.name);
            const payload =
              documentRead ??
              (screenTool
                ? await screenTool(params.arguments)
                : params.name === "deal-room-board"
                  ? dealBoard
                  : params.name === "get-deal-room"
                    ? dealDetail
                    : params.name === "resolve-action-link-v2" && params.arguments.ref === carrReply.ref
                      ? carrReply
                      : params.name === "read-activity-deal-attribution"
                        ? {
                            schema: "activity-deal-attribution.v1",
                            state: "empty",
                            attribution: "unknown",
                            activity: null,
                            direct: null,
                            candidates: [],
                            credited_activity_count: 0,
                            coverage: "unknown",
                          }
                        : {});
            return Response.json({
              jsonrpc: "2.0",
              id,
              result: { content: [{ type: "text", text: JSON.stringify(payload) }] },
            });
          }
          return new Response(null, { status: navigation ? 200 : 404 });
        }
        throw Error("CARR unavailable");
      },
    },
    PARTNER_APP: {
      async fetch(input) {
        const url = new URL(input.url);
        const path = url.pathname;
        if (unavailable) return new Response(null, { status: 503 });
        const redirect = (location: string, status = 302, headers: Record<string, string> = {}) =>
          new Response(null, { status, headers: { ...headers, location } });
        if (path === "/auth/login") return redirect("/auth/callback/google" + url.search);
        if (path === "/auth/callback/google") {
          const token = url.searchParams.get("fixture") ?? "first";
          if (!partners.has(token)) return Response.json({ error: "sign_in_required" }, { status: 401 });
          live.add(token);
          return redirect(url.searchParams.get("return_to") ?? "/", 302, {
            "set-cookie": `${cookieName}=${token}; Secure; HttpOnly; SameSite=Lax; Path=/`,
          });
        }
        if (expireOnLeadDetail && path === "/api/engine/leads" && url.searchParams.has("lead_id")) {
          expireOnLeadDetail = false;
          live.clear();
        }
        const carrSession = switchDay && signIn === "carr";
        const token = carrSession
          ? "first"
          : input.headers.get("cookie")?.match(/__Host-doctorcre_session=([^;]+)/)?.[1];
        if (!token || (!carrSession && !live.has(token)))
          return Response.json({ error: "unauthorized" }, { status: 401 });
        partnerReads.set(url.pathname + url.search, input.headers.get("cookie"));
        if (path === closingAnniversaries && readAnniversaries) return readAnniversaries(input);
        if (path === expiredPath) return Response.json({ error: "unauthorized" }, { status: 401 });
        const csrfToken = "fixture-" + token;
        if (path === "/auth/session")
          return Response.json({
            actor: { slug: partners.get(token) },
            csrf_token: csrfToken,
          });
        if (
          input.method === "POST" &&
          (input.headers.get("x-carr-csrf") !== csrfToken ||
            input.headers.get("origin") !== url.origin ||
            input.headers.get("sec-fetch-site") !== "same-origin")
        )
          return Response.json({ error: "forbidden" }, { status: 403 });
        if (path === "/auth/signout") {
          live.delete(token);
          return redirect("/", 303, {
            "set-cookie": `${cookieName}=; Secure; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`,
          });
        }
        if (path === docLink) {
          if (input.method === "POST") {
            links.set(token, "mac_off");
            const credential = String(++issueCount).padStart(43, "a");
            if (loseIssueResponse) {
              loseIssueResponse = false;
              return new Response(null, { status: 503 });
            }
            await holdDocIssue;
            return Response.json({ credential }, { status: 201 });
          }
          const status = links.get(token) ?? "not_set_up";
          return Response.json({
            connected: status !== "not_set_up" && status !== "mac_off",
            issued_at: links.has(token) ? "2026-01-01T00:00:00Z" : null,
            status,
          });
        }
        if (path === `${docLink}/revoke` && input.method === "POST") {
          links.delete(token);
          return new Response(null, { status: 204 });
        }
        if (path === "/api/engine/doc/conversations")
          return Response.json({ conversations: [chat], next_before: null });
        if (path === "/api/engine/doc/turns" && input.method === "POST") {
          const ask = await input.json();
          return Response.json({
            conversation_id: "10000000-0000-4000-8000-000000000001",
            turn: {
              ...ask,
              id: "10000000-0000-4000-8000-000000000002",
              position: 1,
              created_at: "2026-10-02T17:00:00Z",
              state: "queued",
              waiting_reason: "Doc isn't set up on your Mac yet.",
              draft_review: null,
              answer: null,
              confirmation: null,
            },
          });
        }
        if (path === invoicePath) return Response.json(await invoices.getInvoiceTracker());
        if (path === paymentPath && input.method === "POST")
          return Response.json(await invoices.markInvoicePaid(await input.json()));
        if (path === fitPath) return Response.json(clientFit);
        if (path.startsWith(actionResolver)) {
          assert.equal(input.method, "GET");
          assert.equal(url.search, "");
          if (path === actionResolver + carrReply.ref) return Response.json({ kind: "reply_draft", path: linkedCard });
          if (path === actionResolver + leadRef)
            return Response.json({ kind: "lead", path: `/leads?lead=${copiedLeadAlias}` });
          return Response.json({ error: "action_link_unavailable" }, { status: 404 });
        }
        if (path === `/api/engine/reply-drafts/${successorDraft}`)
          return Response.json({
            draft_id: successorDraft,
            version: 2,
            status: "pending",
            subject: "Re: Demo relocation",
            body: "Here is the updated demo reply.",
            to: "sender@example.test",
            cc: "partner@example.test",
            attachments: [],
          });
        if (path === "/api/engine/home/inbox" || path === linkedCardRead) {
          const empty = { count: 0, items: [] };
          if (path === linkedCardRead)
            return Response.json({
              ...filingCard,
              card_id: `conversation:${successorDraft}`,
              item_id: linkedItem,
              kind_label: "Reply draft",
              merged_source_ids: [successorDraft],
              source_id: successorDraft,
              source_version: "2",
              title: replyTitle,
              reply_draft_id: successorDraft,
              reply_draft_status: "pending",
              suggestions: [],
            });
          const feedback = {
            ...filingCard,
            card_id: feedbackItem,
            item_id: feedbackItem,
            source_id: feedbackId,
            source_type: "notification",
            merged_source_ids: [feedbackId],
            kind_label: "Tour feedback",
            kind: "tour_feedback",
            title: feedbackTitle,
            why: feedbackText,
            primary_action: "Review feedback",
            deal_id: dealId,
            property_id: clinic.id,
            open_url: `/deals?mode=live&deal=${dealId}&property=${clinic.id}`,
            suggestions: [],
            filing_choices: [],
          };
          const items = tourFeedback ? (feedbackOpen ? [feedback] : []) : [filingCard];
          return Response.json({
            ok: true,
            schema_version: "home-inbox.v5",
            ...(tourFeedback && { home_mark_drop: true }),
            ...(url.searchParams.get("view") === "dashboard"
              ? { reminders: { count: items.length, items }, waiting: empty }
              : { items, truncated: false, limit: 1000, working_collapsed: true }),
          });
        }
        if (tourFeedback && path === "/api/engine/home/marks" && input.method === "POST") {
          const { item_id, action, base_version } = await input.json();
          assert.deepEqual(
            { item_id, action, base_version },
            { item_id: feedbackItem, action: "done", base_version: "1:0:inbox" },
          );
          feedbackOpen = false;
          return Response.json({
            ok: true,
            item_id,
            base_version: "2:0:done",
            previous: { disposition: null, snoozed_until: null },
          });
        }
        if (path === `/api/engine/proposals/${filingId}`) {
          return Response.json({
            proposal_id: filingId,
            kind: "possible_new_deal",
            evidence: "The sender asked for a floor plan.",
            filing_choices: filingChoices,
          });
        }
        if (path === "/api/engine/home/today") {
          return Response.json({
            ok: true,
            schema_version: "home-today.v1",
            today: "2026-11-21",
            meetings: { state: "ready", items: [] },
            reminders: { late: [], upcoming: [] },
            partners: [],
          });
        }
        if (path === "/api/engine/updates") return Response.json({ unread_count: 0, updates: [] });
        if (path === "/api/engine/updates/changes") return Response.json({ changes: [], next_before: null });
        if (path === "/api/engine/preferences") {
          return Response.json({ time_zone: "America/Chicago", quiet_from: null, quiet_until: null, base_version: 0 });
        }
        if ((path === attributionPath || path === noteAttributionPath) && readAttribution)
          return readAttribution(input);
        if (callReview && (path.endsWith("/call-outcomes") || path.endsWith("/decision"))) return callReview(input);
        const documentResponse = await dealDocumentsResponse(input, csrfToken);
        if (documentResponse) return documentResponse;
        if (path === "/api/engine/deals") return Response.json(dealBoard);
        if (path === tours && tourPlans) return Response.json({ tours: [{ id: tour, planned_on: "2026-11-24" }] });
        if (path === "/api/engine/calendar/critical-dates")
          return Response.json({
            schema_version: "calendar-critical-dates.v1",
            critical_dates: [
              {
                id: "demo-date",
                deal_id: dealId,
                deal_name: dealName,
                kind: "LOI expiry",
                owner: "joe",
                due_on: "2026-11-24",
                done: false,
              },
            ],
            next_steps: [],
          });
        if (path === `/api/engine/deals/${dealId}`)
          return Response.json({
            ...dealDetail,
            email_follow_ups: [],
            ...tourDeal?.(),
          });
        if (/^\/api\/engine\/(clients|vendors)(?:\/|$)/.test(path)) {
          assert.equal(input.headers.get("cookie"), `${cookieName}=${token}`);
          url.pathname = path.replace("/api/engine", "/api/v1/business");
          return Response.json(directoryFixture(url.href));
        }
        if (path === "/api/engine/leads" && url.searchParams.get("workspace") === "leads") {
          assert.equal(
            input.headers.get("cookie"),
            carrSession ? "__Host-dealroom_session=directory-fixture" : `${cookieName}=${token}`,
          );
          const currentLead = { ...exampleLead, owner: leadOwner, base_version: leadOwner ? 2 : 1 };
          const requestedId = url.searchParams.get("lead_id");
          return Response.json({
            ...workspace(),
            leads: [currentLead],
            ...(requestedId && {
              detail:
                requestedId === currentLead.id || requestedId === copiedLeadAlias
                  ? detail({ ...currentLead, id: requestedId })
                  : null,
            }),
          });
        }
        if (path === "/api/engine/leads") return Response.json({ count: 0 });
        if (path === "/api/engine/quiet-follow-ups") return Response.json(emptyQuietFollowUps());
        if (path === `/api/engine/leads/${exampleLead.id}/changes` && input.method === "POST") {
          const command = await input.json();
          assert.equal(input.headers.get("cookie"), `${cookieName}=${token}`);
          const actor = partners.get(token);
          assert.ok(actor);
          assert.equal(command.expected_actor, actor);
          assert.equal(command.action, "claim");
          leadOwner = actor;
          writes++;
          return Response.json({ ok: true, lead_id: exampleLead.id });
        }
        return new Response(null, { status: 404 });
      },
    },
  };
  assets ??= appAssetSnapshot();
  const server = await startWorkerFixture({ assets: await assets, env });
  t.after(() => server.close());
  browser ??= chromium.launch();
  const context = await (await browser).newContext({
    viewport: { width, height: 850 },
    hasTouch: touch,
    ...(tourDeal && { timezoneId: "America/Chicago" }),
    colorScheme: theme,
  });
  t.after(() => context.close());
  if (switchDay) {
    await context.addCookies([
      {
        name: "__Host-dealroom_session",
        value: "directory-fixture",
        url: server.origin.replace("http:", "https:"),
        secure: true,
      },
    ]);
  }
  await context.addInitScript((theme) => localStorage.setItem("dealroom-theme", theme), theme);
  return {
    server,
    context,
    setUnavailable: (value: boolean) => {
      unavailable = value;
    },
    carrChecks: () => carrChecks,
    carrTools,
    partnerReads,
    expireOn: (path: string) => {
      expiredPath = path;
    },
    expireOnNextLeadDetail: () => {
      expireOnLeadDetail = true;
    },
    writes: () => writes,
    setDocStatus: (status: string) => links.set("first", status),
    loseNextDocIssue: () => {
      loseIssueResponse = true;
    },
  };
}

for (const lookup of ["stalled", "unknown", "on"]) {
  const title =
    lookup === "on"
      ? "Home retries initial and refresh outages in place"
      : `Home and the Deals frame ignore ${lookup} Home and Frame switches`;
  test(title, async (t) => {
    let unavailable = lookup === "on";
    const legacyReads: string[] = [];
    const routingReads: string[] = [];
    const held = Promise.withResolvers<string>();
    t.after(() => held.resolve("on"));
    const productionRouting = new Map([
      ...[
        "deals",
        "deals-saves",
        "leads",
        "invoices",
        "charts",
        "national-deals",
        "search",
        "clients-vendors",
        "relationships",
      ].map((name) => [name + "-from-engine", "on"] as const),
      ["deal-cutover-date", "2026-11-20"],
    ]);
    assets ??= appAssetSnapshot();
    const server = await startWorkerFixture({
      assets: await assets,
      env: {
        APP_ENV: "production",
        PARTNER_SIGN_IN: "carr",
        ENGINE_ROUTING: {
          async get(key: string) {
            if (key !== "home-from-engine" && key !== "frame-from-engine") return productionRouting.get(key);
            routingReads.push(key);
            return lookup === "stalled" ? held.promise : lookup === "unknown" ? "ON" : "on";
          },
        },
        CARR: {
          async fetch(request: Request) {
            const path = new URL(request.url).pathname;
            if (path === "/auth/session") return Response.json({ actor: { slug: "joe" }, csrf_token: "synthetic" });
            if (path === "/mcp") return Response.json({ error: "legacy_read" }, { status: 503 });
            return new Response(null, { status: request.headers.get("sec-fetch-mode") === "navigate" ? 200 : 404 });
          },
        },
        ENGINE: {
          async fetch(request: Request) {
            const url = new URL(request.url);
            if (url.pathname === "/api/engine/deals") return Response.json(dealBoard);
            if (url.pathname === "/api/engine/home/today")
              return Response.json({
                ok: true,
                schema_version: "home-today.v1",
                today: "2026-11-21",
                meetings: { state: "ready", items: [] },
                reminders: { late: [], upcoming: [] },
                partners: [],
              });
            if (url.pathname === "/api/engine/home/inbox" && url.searchParams.get("view") === "dashboard")
              return unavailable
                ? Response.json({ error: "engine_unavailable" }, { status: 503 })
                : Response.json({
                    ok: true,
                    schema_version: "home-inbox.v5",
                    reminders: { count: 1, items: [filingCard] },
                    waiting: { count: 0, items: [] },
                  });
            return new Response(null, { status: 404 });
          },
        },
      },
    });
    t.after(() => server.close());
    browser ??= chromium.launch();
    const page = await (await browser).newPage();
    t.after(() => page.context().close());
    page.on("request", (request) => {
      if (new URL(request.url()).pathname !== "/mcp") return;
      const name = request.postDataJSON()?.params?.name;
      if (["calendar-meeting-prep", "today-triage", "read-home-inbox-v5"].includes(name)) legacyReads.push(name);
    });

    if (lookup === "on") await page.clock.install();
    assert.ok((await page.goto(server.origin + "/?mode=live", { timeout: 5000 }))?.ok());
    if (unavailable) {
      const failure = page.getByRole("alert").filter({ hasText: "Reminders and waiting items unavailable" });
      await failure.waitFor({ timeout: 5000 });
      unavailable = false;
      await failure.getByRole("button", { name: "Retry", exact: true }).click({ timeout: 5000 });
    }
    await page.getByText(filingTitle, { exact: true }).waitFor({ timeout: 5000 });
    assert.equal(await page.getByRole("button", { name: "Prepare meetings", exact: true }).count(), 0);
    assert.equal(await page.getByText("A LITTLE LOOK AHEAD", { exact: true }).count(), 0);
    if (lookup === "on") {
      unavailable = true;
      await page.clock.fastForward(60_001);
      const failure = page.getByRole("status").filter({ hasText: "Reminders and waiting items unavailable" });
      await failure.waitFor({ timeout: 5000 });
      assert.ok(await page.getByText(filingTitle, { exact: true }).isVisible());
      unavailable = false;
      await failure.getByRole("button", { name: "Retry", exact: true }).click({ timeout: 5000 });
      await failure.waitFor({ state: "hidden", timeout: 5000 });
      assert.ok(await page.getByText(filingTitle, { exact: true }).isVisible());
    } else {
      const today = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/engine/home/today", {
        timeout: 5000,
      });
      assert.ok((await page.goto(server.origin + "/deals?mode=live", { timeout: 5000 }))?.ok());
      assert.ok((await today).ok());
      assert.deepEqual(routingReads, []);
    }
    assert.deepEqual(legacyReads, []);
  });
}

test("Closing anniversaries shows all 21 engine matches and opens records with blank names", async (t) => {
  const rows = Array.from({ length: 21 }, (_, index) => ({
    client_id: anniversaryClientId,
    client_name: index === 1 ? "" : anniversaryClientName,
    deal_id: index === 0 ? dealId : `aaaaaaaa-aaaa-4aaa-8aaa-${String(index).padStart(12, "0")}`,
    deal_name: index === 0 ? "  " : `Demo closing ${index + 1}`,
    closed_on: "2024-12-01",
    anniversary_on: "2026-12-01",
    years: 2,
    days_until: 10,
  }));
  const { server, context, partnerReads, carrChecks } = await app(t, {
    readAnniversaries: () => Response.json(rows),
  });
  const page = await context.newPage();
  // Loopback pages need an explicit live mode to exercise the destination reads.
  await page.addInitScript(() => {
    const url = new URL(location.href);
    if (url.searchParams.has("record") || url.searchParams.has("deal")) {
      url.searchParams.set("mode", "live");
      history.replaceState(history.state, "", url);
    }
  });
  const oldRequests: string[] = [];
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === carrAnniversaries) oldRequests.push(request.url());
  });

  await page.goto(server.origin + "/leases?mode=live");
  const panel = page.getByRole("region", { name: "Closing anniversaries" });
  await panel.getByRole("link", { name: "Demo closing 21" }).or(panel.getByRole("alert")).waitFor({ timeout: 5000 });
  assert.equal(await panel.getByRole("listitem").count(), 21);
  assert.equal(await panel.getByText(/covers deals closed before|showing the next 20|first slice/i).count(), 0);
  assert.equal(partnerReads.get(closingAnniversaries), `${cookieName}=first`);
  await page.getByRole("button", { name: "More", exact: true }).click();
  assert.equal(
    await page.getByRole("link", { name: "Closing anniversaries", exact: true }).getAttribute("href"),
    "/leases",
  );
  await panel.getByRole("link", { name: "Unnamed client", exact: true }).click();
  await page.getByRole("dialog", { name: anniversaryClientName }).waitFor({ timeout: 5000 });
  assert.equal(new URL(page.url()).searchParams.get("record"), anniversaryClientId);

  await page.goto(server.origin + "/leases?mode=live");
  await panel.getByRole("link", { name: "Unnamed deal", exact: true }).click();
  await page
    .getByRole("main", { name: "Deal Workspace" })
    .getByRole("heading", { name: dealName })
    .waitFor({ timeout: 5000 });
  assert.equal(new URL(page.url()).searchParams.get("deal"), dealId);
  assert.equal(carrChecks(), 0);
  assert.deepEqual(oldRequests, []);
});

test("Closing anniversaries shows the plain empty state with an empty engine window", async (t) => {
  const { server, context, partnerReads } = await app(t, { readAnniversaries: () => Response.json([]) });
  const page = await context.newPage();
  await page.goto(server.origin + "/leases?mode=live");
  const panel = page.getByRole("region", { name: "Closing anniversaries" });
  await panel.getByText("No closing anniversaries in the next 30 days.", { exact: true }).waitFor({ timeout: 5000 });
  assert.equal(await panel.getByText(/covers deals closed before|showing the next 20|first slice/i).count(), 0);
  assert.equal(await panel.getByRole("listitem").count(), 0);
  assert.equal(partnerReads.get(closingAnniversaries), `${cookieName}=first`);
});

test("Closing anniversaries retries a failed engine read", async (t) => {
  let reads = 0;
  const { server, context } = await app(t, {
    readAnniversaries: () => (++reads === 1 ? new Response(null, { status: 503 }) : Response.json([])),
  });
  const page = await context.newPage();
  await page.goto(server.origin + "/leases?mode=live");
  const panel = page.getByRole("region", { name: "Closing anniversaries" });
  await panel
    .getByRole("alert")
    .getByText("Closing anniversaries could not be loaded. Try again.")
    .waitFor({ timeout: 5000 });
  assert.equal(reads, 1);
  await panel.getByRole("button", { name: "Retry closing anniversaries" }).click();
  await panel.getByText("No closing anniversaries in the next 30 days.", { exact: true }).waitFor({ timeout: 5000 });
  assert.equal(reads, 2);
});

test("Closing anniversaries rejects an engine response with a missing record ID or date", async (t) => {
  const row = {
    client_id: anniversaryClientId,
    client_name: anniversaryClientName,
    deal_id: dealId,
    deal_name: dealName,
    closed_on: "2024-12-01",
    anniversary_on: "2026-12-01",
    years: 2,
    days_until: 10,
  };
  for (const missing of ["client_id", "anniversary_on"]) {
    await t.test(`missing ${missing}`, async (t) => {
      const { server, context } = await app(t, {
        readAnniversaries: () => Response.json([row, { ...row, [missing]: undefined }]),
      });
      const page = await context.newPage();
      await page.goto(server.origin + "/leases?mode=live");
      const panel = page.getByRole("region", { name: "Closing anniversaries" });
      await panel.getByRole("button", { name: "Retry closing anniversaries" }).waitFor({ timeout: 5000 });
      assert.equal(await panel.getByRole("listitem").count(), 0);
    });
  }
});

test("Closing anniversaries on CARR keeps its bounded Lease Radar snapshot", async (t) => {
  const { more } = JSON.parse(
    await readFile(new URL("./fixtures/client-anniversary-panel/recordings.json", import.meta.url), "utf8"),
  );
  const requests: string[] = [];
  const { server, context, partnerReads } = await app(t, {
    signIn: "carr",
    readAnniversaries: (request) => {
      const url = new URL(request.url);
      requests.push(url.pathname + url.search);
      return Response.json(more.output);
    },
  });
  const page = await context.newPage();
  await page.goto(server.origin + "/leases?mode=live");
  const panel = page.getByRole("region", { name: "Closing anniversaries" });
  await panel
    .getByText("More anniversary rows exist. This first slice shows at most 20.", { exact: true })
    .waitFor({ timeout: 5000 });
  assert.equal(await panel.getByRole("listitem").count(), 20);
  await panel.getByText(/As of .* Scanned .* Skipped invalid/).waitFor({ timeout: 5000 });
  assert.deepEqual(requests, [carrAnniversaries + "?horizon_days=30&limit=20&offset=0"]);
  assert.equal(partnerReads.size, 0);
});

test("Home and the old Updates link load on the engine session and handle expiry", async (t) => {
  const { server, context, partnerReads, carrChecks, expireOn } = await app(t);
  await context.addCookies([
    { name: "__Host-dealroom_session", value: "old", url: server.origin.replace("http:", "https:"), secure: true },
  ]);
  const page = await context.newPage();
  const legacyReads: string[] = [];
  page.on("request", (request) => {
    if (new URL(request.url()).pathname !== "/mcp") return;
    const name = request.postDataJSON()?.params?.name;
    if (
      [
        "read-home-inbox-v5",
        "today-triage",
        "calendar-meeting-prep",
        "notification-feed",
        "read-notification-preferences",
      ].includes(name)
    )
      legacyReads.push(name);
  });
  for (const [path, reads] of [
    ["/?mode=live", ["/api/engine/home/inbox?view=dashboard", "/api/engine/home/today"]],
    ["/notifications?mode=live", ["/api/engine/updates", "/api/engine/updates/changes", "/api/engine/preferences"]],
  ] as const) {
    const pending = reads.map((read) =>
      page.waitForResponse((response) => response.url() === server.origin + read && response.ok()),
    );
    const [, ...responses] = await Promise.all([page.goto(server.origin + path), ...pending]);
    const first = responses[0];
    assert.ok(first);
    assert.match((await first.request().allHeaders()).cookie ?? "", /__Host-dealroom_session=old/);
    for (const read of reads) assert.equal(partnerReads.get(read), cookieName + "=first", read);
  }
  assert.equal(new URL(page.url()).pathname, "/updates");
  assert.deepEqual(legacyReads, []);
  assert.equal(carrChecks(), 0);

  expireOn("/api/engine/updates");
  await page.goto(server.origin + "/updates?mode=live");
  await page.waitForURL("**/public-shell/session-ended.html");
  await page.getByRole("heading", { name: "Session ended" }).waitFor();
  await page.getByRole("link", { name: "Sign in again" }).waitFor();
});

async function recordInvoicePayment(page: Page, origin: string) {
  await page.clock.setFixedTime(new Date(`${invoiceDay}T17:00:00Z`));
  await page.goto(origin + "/invoices?mode=live");
  const row = firstInvoiceRow(page);
  await row.click({ timeout: 5000 });
  const invoice = page.getByRole("dialog", { name: invoiceName });
  await invoice.getByLabel("Paid on").fill(invoiceDay);
  await invoice.getByRole("button", { name: "Mark paid", exact: true }).click();
  await invoice.getByText("Payment recorded Oct 2, 2026.", { exact: true }).waitFor({ timeout: 5000 });
  await page.reload();
  await row.getByText("Paid", { exact: true }).waitFor({ timeout: 5000 });
}

async function openHistoricalFit(page: Page, origin: string) {
  await page.goto(origin + "/?view=charts&mode=live");
  const fit = page.getByRole("region", { name: "Historical client fit", exact: true });
  await fit.getByText("Historical client fit", { exact: true }).click();
  await fit.getByText("Wins (1)", { exact: true }).click({ timeout: 5000 });
  const evidence = fit.getByRole("link", { name: fitEvidence });
  await evidence.waitFor();
  assert.equal(await evidence.getAttribute("href"), `/deals?deal=${dealId}`);
  return fit;
}

test("engine sign-in opens invoices and records a payment with the invoice switch off", async (t) => {
  const { context, server, partnerReads, carrTools } = await app(t);
  await recordInvoicePayment(await context.newPage(), server.origin);
  for (const path of [invoicePath, paymentPath]) assert.equal(partnerReads.get(path), cookieName + "=first");
  assert.deepEqual(carrTools, []);
});

for (const width of [390, 1440]) {
  test(`Open Doc stays in the invoice header and starts a chat about the invoice at ${width}px`, async (t) => {
    const { context, server } = await app(t, { width });
    const page = await context.newPage();
    await page.setViewportSize({ width, height: 420 });
    await page.goto(server.origin + "/invoices?mode=live");
    await page.getByRole("link", { name: "Ask Doc", exact: true }).waitFor({ timeout: 5000 });
    await firstInvoiceRow(page).click({ timeout: 5000 });
    const drawer = page.getByRole("dialog", { name: invoiceName });
    const openDoc = drawer.getByRole("link", { name: "Open Doc", exact: true });
    const close = drawer.getByRole("button", { name: "Close invoice", exact: true });
    await openDoc.waitFor({ timeout: 5000 });
    await drawer.getByText("Details", { exact: true }).click();
    const before = await openDoc.boundingBox();
    const closeBefore = await close.boundingBox();
    assert.ok(before && closeBefore);
    assert.ok(before.x + before.width <= closeBefore.x);
    assert.ok(before.y < closeBefore.y + closeBefore.height && closeBefore.y < before.y + before.height);
    const scrolled = await drawer.locator(".invoice-detail-body").evaluate((body) => {
      body.scrollTop = body.scrollHeight;
      return body.scrollTop;
    });
    assert.ok(scrolled > 0);
    assert.deepEqual(await openDoc.boundingBox(), before);
    assert.deepEqual(await close.boundingBox(), closeBefore);

    await openDoc.click();
    await page.getByRole("heading", { name: "Ask Doc", exact: true }).waitFor();
    const invoice = page.getByRole("link", { name: "Open invoice", exact: true });
    assert.equal(await invoice.getAttribute("href"), `/invoices?invoice=${invoiceId}`);
    const question = page.getByLabel("Question for Doc");
    const prefill = "About the installment 1 invoice for $12,500.00 due Oct 20, 2026 (unpaid): ";
    assert.equal(await question.inputValue(), prefill);

    const second = await context.newPage();
    await second.goto(`${server.origin}/invoices?mode=live&invoice=${secondInvoiceId}`);
    await second.getByRole("dialog", { name: invoiceName }).getByRole("link", { name: "Open Doc" }).click();
    await second.getByRole("link", { name: "Open invoice", exact: true }).waitFor();
    assert.equal(
      await second.getByLabel("Question for Doc").inputValue(),
      "About the installment 2 invoice for $7,500.00 due Oct 25, 2026 (paid): ",
    );

    await question.fill("");
    assert.ok(await page.getByRole("button", { name: "Send", exact: true }).isDisabled());
    await page.reload();
    await invoice.waitFor();
    assert.equal(await question.inputValue(), "");
    const editedQuestion = prefill + "When was this sent?";
    await question.fill(editedQuestion);
    const sent = page.waitForRequest(
      (request) => new URL(request.url()).pathname === "/api/engine/doc/turns" && request.method() === "POST",
    );
    await page.getByRole("button", { name: "Send", exact: true }).click();
    const ask = (await sent).postDataJSON();
    assert.deepEqual(ask.context, { kind: "deal", id: dealId });
    assert.equal(ask.question, editedQuestion);
    await page.getByText("Doc isn't set up on your Mac yet.", { exact: true }).waitFor();
  });

  test(`The visible Doc question can use all 4,000 characters at ${width}px`, async (t) => {
    const { context, server } = await app(t, { width });
    const page = await context.newPage();
    await page.goto(`${server.origin}/invoices?mode=live&invoice=${invoiceId}`);
    await page.getByRole("dialog", { name: invoiceName }).getByRole("link", { name: "Open Doc" }).click();
    const question = page.getByLabel("Question for Doc");
    const send = page.getByRole("button", { name: "Send", exact: true });
    const maximum = "a".repeat(3999) + "😊";
    await question.fill(maximum);
    assert.ok(await send.isEnabled());
    assert.ok(await page.getByText("4,000 / 4,000", { exact: true }).isVisible());
    await question.fill(maximum + " ");
    assert.ok(await send.isDisabled());
    assert.ok(await page.getByText("4,001 / 4,000", { exact: true }).isVisible());
    await question.fill(maximum);
    const sent = page.waitForRequest(
      (request) => new URL(request.url()).pathname === "/api/engine/doc/turns" && request.method() === "POST",
    );
    await send.click();
    assert.equal((await sent).postDataJSON().question, maximum);
  });

  test(`Open Doc follows Ask Doc availability on switched CARR sign-in at ${width}px`, async (t) => {
    const { context, server, carrTools } = await app(t, { width, signIn: "carr", switchDay: true });
    const page = await context.newPage();
    await page.goto(server.origin + "/invoices?mode=live");
    await page.getByRole("button", { name: "Joe: account and settings" }).waitFor({ timeout: 5000 });
    assert.equal(await page.getByRole("link", { name: "Ask Doc", exact: true }).count(), 0);
    await firstInvoiceRow(page).click({ timeout: 5000 });
    const drawer = page.getByRole("dialog", { name: invoiceName });
    await drawer.getByRole("button", { name: "Close invoice", exact: true }).waitFor();
    assert.equal(await drawer.getByRole("link", { name: "Open Doc", exact: true }).count(), 0);
    assert.ok(!carrTools.includes("read-invoice-tracker"));
  });
}

test("engine sign-in shows historical client fit with the charts switch off", async (t) => {
  const { context, server, partnerReads, carrTools, setUnavailable } = await app(t);
  const fit = await openHistoricalFit(await context.newPage(), server.origin);
  await fit.getByLabel("State", { exact: true }).fill("TX");
  await fit.getByRole("button", { name: "Apply filters" }).click();
  await fit.getByText("Wins (1)", { exact: true }).waitFor();
  for (const path of [fitPath, fitPath + "?state=TX"]) assert.equal(partnerReads.get(path), cookieName + "=first");

  setUnavailable(true);
  await fit.getByRole("button", { name: "Refresh history" }).click();
  await fit.getByRole("alert").filter({ hasText: "Historical client fit unavailable" }).waitFor();
  assert.deepEqual(carrTools, []);
});

test("CARR sign-in still reads invoices and client fit and saves payments through CARR with switches off", async (t) => {
  const { context, server, partnerReads, carrTools } = await app(t, { signIn: "carr" });
  const page = await context.newPage();
  await recordInvoicePayment(page, server.origin);
  await openHistoricalFit(page, server.origin);
  for (const name of ["read-invoice-tracker", "record-commission-receipt", "ideal-client-profile"])
    assert.ok(carrTools.includes(name), name);
  assert.equal(partnerReads.size, 0);
});

test("an engine action link opens the successor reply with Home review controls", async (t) => {
  const { server, context, partnerReads, carrChecks } = await app(t);
  const page = await context.newPage();
  const path = `/a/${carrReply.ref}?mode=live`;
  const response = await page.goto(server.origin + path);
  assert.ok(response);
  assert.equal(new URL(response.url()).pathname, `/inbox/card/${linkedItem}`);
  const login = response.request().redirectedFrom()?.redirectedFrom()?.redirectedFrom();
  assert.ok(login);
  assert.equal(new URL(login.url()).searchParams.get("return_to"), path);
  await page.getByRole("heading", { name: replyTitle }).waitFor({ timeout: 5000 });
  await page.getByText("Here is the updated demo reply.", { exact: true }).waitFor({ timeout: 5000 });
  await page.getByRole("button", { name: "Send reply", exact: true }).waitFor({ timeout: 5000 });
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  assert.equal(await page.getByRole("textbox", { name: "Subject", exact: true }).inputValue(), "Re: Demo relocation");
  assert.equal(partnerReads.get(actionResolver + carrReply.ref), `${cookieName}=first`);
  assert.equal(partnerReads.get(linkedCardRead), `${cookieName}=first`);
  assert.equal(partnerReads.has("/api/engine/home/inbox?view=dashboard"), false);
  assert.equal(carrChecks(), 0);
});

test("an engine action link opens the resolved lead drawer", async (t) => {
  const { server, context, partnerReads, carrChecks } = await app(t);
  const page = await context.newPage();
  await page.goto(server.origin + `/a/${leadRef}?mode=live`);
  const destination = new URL(page.url());
  assert.equal(destination.pathname, "/leads");
  assert.equal(destination.searchParams.get("lead"), copiedLeadAlias);
  await page.locator("#leadDetail").getByRole("heading", { name: "Dr. Example 1" }).waitFor({ timeout: 5000 });
  assert.equal(partnerReads.get(actionResolver + leadRef), `${cookieName}=first`);
  assert.equal(carrChecks(), 0);
});

test("unavailable engine action links show the same page for missing and retired records", async (t) => {
  const { server, context, partnerReads, carrChecks } = await app(t);
  const page = await context.newPage();
  const id = "44444444-4444-4444-8444-444444444444";
  for (const ref of ["missing", actionLinkRef(`fe:${id}`)]) {
    const response = await page.goto(server.origin + `/a/${ref}?mode=live`);
    assert.ok(response);
    assert.equal(response.status(), 404);
    assert.equal(response.headers()["cache-control"], "no-store");
    await page.getByRole("heading", { name: "This link is no longer available", exact: true }).waitFor();
    assert.equal(await page.getByRole("link", { name: "Back to Home" }).getAttribute("href"), "/");
    assert.equal(partnerReads.get(actionResolver + ref), `${cookieName}=first`);
  }
  assert.equal(carrChecks(), 0);
});

test("retired action links show Home at both screen sizes and sign-ins", async (t) => {
  const id = "44444444-4444-4444-8444-444444444444";
  for (const signIn of ["engine", "carr"] as const) {
    const { server, context } = await app(t, { signIn });
    const page = await context.newPage();
    for (const width of [390, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      for (const kind of ["cr", "fe"]) {
        const response = await page.goto(server.origin + `/a/${actionLinkRef(`${kind}:${id}:1`)}?mode=live`);
        assert.equal(response?.status(), 404);
        await page.getByRole("heading", { name: "This link is no longer available", exact: true }).waitFor();
        assert.equal(await page.getByRole("link", { name: "Back to Home" }).getAttribute("href"), "/");
      }
    }
  }
});

test("a CARR action link still opens the approval screen through its legacy resolver", async (t) => {
  const { server, context, partnerReads } = await app(t, { signIn: "carr" });
  const page = await context.newPage();
  const path = `/a/${carrReply.ref}?mode=live`;
  await page.goto(server.origin + path);
  await page.getByRole("heading", { name: carrReply.card.subject }).waitFor({ timeout: 5000 });
  await page.getByRole("button", { name: "Submit reply for sending", exact: true }).waitFor({ timeout: 5000 });
  assert.equal(page.url(), server.origin + path);
  assert.equal(partnerReads.size, 0);
});

test("Home filing searches vendors on the engine session", async (t) => {
  const { server, context, partnerReads, carrChecks } = await app(t);
  await context.addCookies([
    { name: "__Host-dealroom_session", value: "old", url: server.origin.replace("http:", "https:"), secure: true },
  ]);
  const page = await context.newPage();
  await page.goto(server.origin + "/?mode=live");
  await page.getByRole("button", { name: "Review filing", exact: true }).click();
  const filing = page.getByRole("region", { name: "File this email", exact: true });
  await filing.getByRole("button", { name: "Choose vendor", exact: true }).click();
  const name = "Demo Partner 62";
  await filing.getByRole("searchbox", { name: "Vendor name" }).fill(name);
  const [response] = await Promise.all([
    page.waitForResponse((response) => {
      const url = new URL(response.url());
      return url.pathname === "/api/v1/business/vendors" && url.searchParams.get("q") === name;
    }),
    filing.getByRole("button", { name: "Search vendors" }).click(),
  ]);
  assert.equal(response.status(), 200);
  assert.match((await response.request().allHeaders()).cookie ?? "", /__Host-dealroom_session=old/);
  const { search } = new URL(response.url());
  assert.equal(partnerReads.get("/api/engine/vendors" + search), cookieName + "=first");
  await filing.getByRole("combobox", { name: "Vendor", exact: true }).selectOption({ label: name });
  assert.equal(await filing.getByRole("button", { name: "File email", exact: true }).isEnabled(), true);
  assert.equal(carrChecks(), 0);
});

test("Doc settings show each Mac status and keep link codes private", async (t) => {
  const { server, context, setDocStatus, loseNextDocIssue } = await app(t, { width: 390 });
  const first = await context.newPage();
  await first.goto(server.origin + deepLink);
  await first.locator('#selfAvatar[aria-label*="account and settings"]').click();
  await first.getByRole("link", { name: "Doc link", exact: true }).click({ timeout: 4000 });
  assert.equal(first.url(), server.origin + "/updates#docLinkSettings");
  const target = "/updates?mode=live#docLinkSettings";
  await first.goto(server.origin + target);
  const settings = first.getByRole("region", { name: "Doc link" });
  await settings.getByText("Doc isn't set up on your Mac yet.").waitFor();

  loseNextDocIssue();
  await settings.getByRole("button", { name: "Make link code" }).click();
  await settings.getByText("The code could not be shown. Replace it to get a new one.").waitFor();
  await settings.getByRole("button", { name: "Replace link code" }).click();
  const replacement = "2".padStart(43, "a");
  const code = settings.getByText(replacement, { exact: true });
  await code.waitFor();
  assert.equal(await code.count(), 1);
  assert.equal(await first.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);

  const otherContext = await (await browser)?.newContext();
  assert.ok(otherContext);
  t.after(() => otherContext.close());
  const other = await otherContext.newPage();
  await other.goto(server.origin + "/auth/callback/google?fixture=second&return_to=" + encodeURIComponent(target));
  await other.getByText("Doc isn't set up on your Mac yet.").waitFor();
  assert.equal(await other.getByText(replacement, { exact: true }).count(), 0);
  assert.equal(await other.getByRole("button", { name: "Revoke link code" }).count(), 0);
  const otherRevoke = await other.evaluate(
    async (path) => (await fetch(path, { method: "POST", headers: { "x-carr-csrf": "fixture-second" } })).status,
    docLink + "/revoke",
  );
  assert.equal(otherRevoke, 204);
  await code.waitFor();

  await first.reload();
  const refresh = settings.getByRole("button", { name: "Refresh Doc status" });
  await settings.getByText("Doc answers when your Mac is on.").waitFor();
  assert.equal(await code.count(), 0);
  for (const [status, copy] of [
    ["signed_out", "Sign in to Claude Code on your Mac."],
    ["plan_limited", "Doc is paused until your Claude plan resets."],
    ["ready", "Doc is ready on your Mac."],
  ] as const) {
    setDocStatus(status);
    await refresh.click();
    await settings.getByText(copy, { exact: true }).waitFor();
  }

  await settings.getByRole("button", { name: "Revoke link code" }).click();
  await settings.getByText("Doc isn't set up on your Mac yet.").waitFor();
});

for (const issuance of ["completed", "pending"] as const)
  test(`Doc link clears the ${issuance} code when switching settings through the account menu`, async (t) => {
    const issue = Promise.withResolvers<void>();
    t.after(() => issue.resolve());
    const { server, context } = await app(t, { width: 390, holdDocIssue: issue.promise });
    const page = await context.newPage();
    await page.goto(server.origin + "/updates?mode=live#docLinkSettings");
    const settings = page.getByRole("region", { name: "Doc link" });
    const making = page.waitForRequest((request) => request.method() === "POST" && request.url().endsWith(docLink));
    await settings.getByRole("button", { name: "Make link code" }).click();
    await making;
    const code = settings.getByText("1".padStart(43, "a"), { exact: true });
    if (issuance === "completed") {
      issue.resolve();
      await code.waitFor();
    }

    // The live fixture boots with a query that the production menu hrefs omit.
    await page.evaluate(() => history.replaceState(null, "", "/updates#docLinkSettings"));
    const avatar = page.locator('#selfAvatar[aria-label*="account and settings"]');
    await avatar.click();
    await page.getByRole("link", { name: "Notification preferences" }).click();
    await page.waitForURL("**/updates#prefForm");
    await page.keyboard.press("Escape");
    await avatar.click();
    await page.getByRole("link", { name: "Doc link", exact: true }).click();
    await page.waitForURL("**/updates#docLinkSettings");
    issue.resolve();
    const replace = settings.getByRole("button", { name: "Replace link code" });
    await code.or(replace).waitFor();
    assert.equal(await code.count(), 0, "the issued code must be gone upon returning");
  });

test("phone notifications are available only with CARR sign-in", async (t) => {
  for (const signIn of ["engine", "carr"] as const) {
    const { server, context } = await app(t, { signIn });
    const page = await context.newPage();
    const calls: string[] = [];
    await page.route("**/mcp", async (route) => {
      const body = route.request().postDataJSON();
      if (body.params?.name?.includes("web-push")) {
        calls.push(body.params.name);
        await route.fulfill({ json: { result: { structuredContent: {} } } });
      } else await route.continue();
    });
    await page.goto(server.origin + "/updates?mode=live");
    if (signIn === "carr") {
      await page
        .getByText("Phone notifications are unavailable because the public notification configuration is invalid.")
        .waitFor();
      assert.deepEqual(calls, ["read-web-push-config-v1"]);
    } else {
      await page.locator("html[data-updates-from-engine]").waitFor();
      await page.getByRole("heading", { name: "Updates", exact: true }).waitFor();
      await page.waitForLoadState("networkidle");
      assert.equal(await page.locator("#phonePush").textContent(), "");
      assert.deepEqual(calls, []);
    }
  }
});

test("Doc link settings are available only with engine sign-in", async (t) => {
  for (const signIn of ["engine", "carr"] as const) {
    const { server, context } = await app(t, { signIn });
    const page = await context.newPage();
    if (signIn === "carr") {
      await page.route("**/js/notifications.js", async (route) => {
        const response = await route.fetch();
        const source = await response.text();
        const end = /\.catch\(\(\)=>\{[^{}]*"Couldn't load Doc link settings\."\)\}\)/;
        assert.match(source, end, "Doc link initialization must be observed");
        await route.fulfill({
          response,
          body: source.replace(end, '$&.finally(() => { document.documentElement.dataset.docLinkSettled = "true"; })'),
        });
      });
    }
    await page.goto(server.origin + "/updates?mode=live#docLinkSettings");
    await page.locator('#selfAvatar[aria-label*="account and settings"]').click();
    await page.getByRole("link", { name: "Notification preferences" }).waitFor();
    const entry = page.getByRole("link", { name: "Doc link", exact: true });
    const settings = page.getByRole("region", { name: "Doc link" });
    if (signIn === "engine") {
      await entry.waitFor();
      await settings.getByText("Doc isn't set up on your Mac yet.").waitFor();
    } else {
      await page.getByText("Joe's Workspace", { exact: true }).waitFor();
      await page.locator('html[data-doc-link-settled="true"]').waitFor();
      assert.equal(await entry.count(), 0, "CARR sign-in must hide the Doc link entry");
      assert.equal(
        server.requests.some(({ path }) => path === docLink),
        false,
      );
      assert.equal(await settings.count(), 0);
    }
  }
});

test("Compare terms is empty on engine sign-in and legacy deal features make no requests", async (t) => {
  const { server, context } = await app(t);
  const page = await context.newPage();
  const legacyRequests: string[] = [];
  page.on("request", (request) => {
    const { pathname } = new URL(request.url());
    if (
      /\/api\/(?:tours\/|engine\/(?:deals\/[^/]+\/tours|properties\/search))/.test(pathname) ||
      pathname === "/api/v1/market-terms/read" ||
      (pathname === "/mcp" && /read-subject-watch-v2|read-activity-deal-attribution/.test(request.postData() ?? ""))
    )
      legacyRequests.push(pathname);
  });
  await page.goto(server.origin + dealPage);
  const room = page.getByRole("main", { name: "Deal Workspace" });
  await room.getByRole("heading", { name: dealName }).waitFor({ timeout: 4000 });
  await room
    .getByRole("region", { name: "Deal watch settings" })
    .getByText("Not available yet", { exact: true })
    .waitFor({ timeout: 4000 });
  await room.getByRole("tab", { name: "Compare terms" }).click();
  await room
    .getByRole("tabpanel", { name: "Compare terms" })
    .getByText("No comparable terms match these filters.", { exact: true })
    .waitFor({ timeout: 4000 });
  await room.getByRole("tab", { name: "Tours", exact: true }).click();
  await room
    .getByRole("tabpanel", { name: "Tours" })
    .getByText("Not available yet", { exact: true })
    .waitFor({ timeout: 4000 });
  assert.equal(
    server.requests.some(({ path }) => path === attributionPath || path === noteAttributionPath),
    false,
  );
  assert.deepEqual(legacyRequests, []);
});

for (const [scenario, documentText, message] of [
  ["ordered pages with a blank gap", ["\nFirst page <draft>\nNew paragraph.", "", "Third page."], null],
  ["no text", [], "No text found in this file."],
  ["a missing document", "missing", "Document text is unavailable."],
] satisfies [string, string[] | "missing", string | null][]) {
  test(`engine deal Documents shows ${scenario}`, async (t) => {
    const { server, context, partnerReads } = await app(t, { documentText, width: 390 });
    const page = await context.newPage();
    const legacyReads: string[] = [];
    page.on("request", (request) => {
      if (
        new URL(request.url()).pathname === "/mcp" &&
        request.postDataJSON()?.params?.name === "read-deal-document-text"
      )
        legacyReads.push(request.url());
    });
    await page.goto(server.origin + "/deals?mode=live");
    const dealCard = page.getByRole("button", { name: dealName, exact: true });
    await dealCard.click();
    await page.getByRole("tab", { name: "Documents", exact: true }).click();
    const panel = page.getByRole("tabpanel", { name: "Documents" });
    assert.equal(
      await panel.getByRole("link", { name: `${filedDocument.name}, Version 1` }).getAttribute("href"),
      `/api/engine/documents/${filedDocument.id}`,
    );
    assert.equal(partnerReads.has(documentTextPath), false);
    const openText = panel.getByRole("button", { name: `Open text for ${filedDocument.name}, Version 1` });
    await openText.click({ timeout: 4000 });
    const dialog = page.getByRole("dialog", { name: filedDocument.name });
    if (message) {
      await dialog.getByText(message, { exact: true }).waitFor();
      assert.equal(await dialog.getByRole("region", { name: /Page/ }).count(), 0);
      assert.equal(await dialog.getByRole("button", { name: "Retry" }).count(), documentText === "missing" ? 1 : 0);
    } else {
      await dialog.getByText("Third page.", { exact: true }).waitFor();
      const sections = dialog.getByRole("region", { name: /Page/ });
      assert.deepEqual(await sections.evaluateAll((nodes) => nodes.map((node) => node.getAttribute("aria-label"))), [
        "Page 1",
        "Page 2",
        "Page 3",
      ]);
      assert.deepEqual(await sections.locator("pre").allTextContents(), documentText);
      assert.ok((await dialog.getByRole("region", { name: "Page 2" }).locator("pre").boundingBox())?.height);
    }
    assert.equal(partnerReads.get(documentTextPath), `${cookieName}=first`);
    assert.deepEqual(legacyReads, []);
    await dialog.getByRole("button", { name: "Close document text" }).click();
    await dialog.waitFor({ state: "hidden" });
  });
}

test("the served install manifests omit the old phone share target", async (t) => {
  const { context, server } = await app(t);
  for (const path of ["/manifest.webmanifest", "/public-shell/manifest.webmanifest"]) {
    const reply = await context.request.get(server.origin + path);
    assert.equal(reply.status(), 200, path);
    assert.equal(Object.hasOwn(await reply.json(), "share_target"), false, path);
  }
});

for (const signIn of ["engine", "carr"] as const) {
  test(`Deal Documents files, reads and downloads through the engine with ${signIn} sign-in`, async (t) => {
    const text = "Synthetic lease page.";
    const { server, context } = await app(t, { signIn, switchDay: true, documentText: [text], documents: [] });
    const page = await context.newPage();
    await page.goto(server.origin + dealPage);
    await page.getByRole("tab", { name: "Documents", exact: true }).click();
    const panel = page.getByRole("tabpanel", { name: "Documents" });
    await panel.getByText("No documents filed for this deal.").waitFor();
    await panel.getByLabel("File", { exact: true }).setInputFiles({
      name: filedDocument.name,
      mimeType: "application/pdf",
      buffer: uploadBytes,
    });
    await panel.getByLabel("Document type").selectOption("lease");
    await panel.getByRole("button", { name: "Upload to this deal" }).click();
    await panel.getByText("Document added.", { exact: true }).waitFor();

    const fileName = `${filedDocument.name}, Version 1`;
    await panel.getByRole("button", { name: `Open text for ${fileName}` }).click({ timeout: 4000 });
    const viewer = page.getByRole("dialog", { name: filedDocument.name });
    await viewer.getByText(text, { exact: true }).waitFor();
    await viewer.getByRole("button", { name: "Close document text" }).click();
    await viewer.waitFor({ state: "hidden" });

    const [download] = await Promise.all([
      page.waitForEvent("download"),
      panel.getByRole("link", { name: fileName }).click(),
    ]);
    assert.equal(download.suggestedFilename(), filedDocument.name);
    assert.deepEqual(await readFile(await download.path()), uploadBytes);
    assert.equal(
      server.requests.some(({ path }) => path.startsWith("/api/v1/deal-deliverables")),
      false,
    );
  });
}

test("Back closes engine document text before leaving the deal", async (t) => {
  const documents = Array.from({ length: 12 }, (_, index) => ({
    ...filedDocument,
    id: `80000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    name: `Demo attachment ${index + 1}.pdf`,
  })).concat(filedDocument);
  const { server, context } = await app(t, { documentText: ["Demo text"], documents, width: 390 });
  const page = await context.newPage();
  await page.goto(server.origin + "/deals?mode=live");
  const dealCard = page.getByRole("button", { name: dealName, exact: true });
  await dealCard.click();
  const documentsTab = page.getByRole("tab", { name: "Documents", exact: true });
  await documentsTab.click();
  const openText = page.getByRole("button", { name: `Open text for ${filedDocument.name}, Version 1` });
  await openText.scrollIntoViewIfNeeded();
  const scroll = await page.evaluate(() => window.scrollY);
  assert.ok(scroll > 0);
  await openText.click();
  const viewer = page.getByRole("dialog", { name: filedDocument.name });
  await viewer.waitFor({ timeout: 4000 });

  await page.goBack();
  await viewer.waitFor({ state: "hidden" });
  assert.equal(new URL(page.url()).searchParams.get("deal"), dealId);
  const workspace = page.getByRole("main", { name: "Deal Workspace" });
  assert.ok(await workspace.getByRole("heading", { name: dealName, exact: true }).isVisible());
  assert.equal(await documentsTab.getAttribute("aria-selected"), "true");
  assert.equal(await page.evaluate(() => window.scrollY), scroll);

  await page.goBack();
  await dealCard.waitFor({ timeout: 4000 });
  assert.equal(new URL(page.url()).searchParams.has("deal"), false);

  await page.goForward();
  await page.goForward();
  await viewer.waitFor({ timeout: 4000 });
  await page.keyboard.press("Escape");
  await viewer.waitFor({ state: "hidden" });
  await page.goBack();
  await dealCard.waitFor({ timeout: 4000 });
});

test("the engine document text close icon leaves Back ready to return to the board", async (t) => {
  const { server, context } = await app(t, { documentText: ["Demo text"] });
  const page = await context.newPage();
  await page.goto(server.origin + "/deals?mode=live");
  const dealCard = page.getByRole("button", { name: dealName, exact: true });
  await dealCard.click();
  await page.getByRole("tab", { name: "Documents", exact: true }).click();
  await page.getByRole("button", { name: `Open text for ${filedDocument.name}, Version 1` }).click();
  const viewer = page.getByRole("dialog", { name: filedDocument.name });
  const close = viewer.getByRole("button", { name: "Close document text" });
  assert.equal(await close.textContent(), "×");
  await close.click();
  await viewer.waitFor({ state: "hidden" });
  assert.equal(new URL(page.url()).searchParams.get("deal"), dealId);

  await page.goBack();
  await dealCard.waitFor({ timeout: 4000 });
  assert.equal(new URL(page.url()).searchParams.has("deal"), false);
});

test("CARR deal Documents still reads document text through the existing verb", async (t) => {
  const { server, context, partnerReads } = await app(t, { signIn: "carr", documentText: [] });
  const page = await context.newPage();
  await page.goto(server.origin + dealPage);
  await page.getByRole("tab", { name: "Documents", exact: true }).click();
  const open = page.getByRole("button", { name: `Open text for ${filedDocument.name}`, exact: true });
  const reading = page.waitForRequest(
    (request) => request.url().endsWith("/mcp") && request.postDataJSON()?.params?.name === "read-deal-document-text",
  );
  await open.click();
  assert.deepEqual((await reading).postDataJSON().params.arguments, {
    deal_id: dealId,
    attachment_id: filedDocument.id,
    content_hash: carrDocumentText.content_hash,
  });
  const text = page.getByRole("region", { name: "Document text", exact: true });
  await text.getByText("first", { exact: true }).waitFor();
  assert.equal(partnerReads.has(documentTextPath), false);
});

const tour = "33333333-3333-4333-8333-333333333333";
const first = "44444444-4444-4444-8444-444444444444";
const second = "55555555-5555-4555-8555-555555555555";
const added = "66666666-6666-4666-8666-666666666666";
const tours = `/api/engine/deals/${dealId}/tours`;
const preview = "November 24, 2026\n\n1. Example Clinic, 10 Example Way\n2. 30 Example Way";
const clinic = { id: first, name: "Example Clinic", address: "10 Example Way" };
const annex = { id: second, name: null, address: "20 Example Way" };

async function followTourFeedbackLink(page: Page, origin: string, engineTours = false) {
  page.setDefaultTimeout(5000);
  const evidenceRequests: string[] = [];
  page.on("request", (request) => {
    const { pathname } = new URL(request.url());
    if (pathname.startsWith("/api/tours/property-evidence")) evidenceRequests.push(pathname);
  });
  if (engineTours) {
    await page.route(origin + tours, (route) => route.fulfill({ json: { tours: [] } }));
    await page.route("**/deals?*", async (route) => {
      const response = await route.fetch();
      const body = (await response.text()).replace("<html", "<html data-deal-tours-from-engine");
      await route.fulfill({ response, body });
    });
  }
  await page.goto(`${origin}/?mode=live`);
  await page.getByRole("button", { name: "Review feedback", exact: true }).click();
  const card = page.getByRole("region", { name: `Details for ${feedbackTitle}` });
  await card.getByText(feedbackText, { exact: true }).waitFor();
  await card.getByRole("link", { name: "Open property", exact: true }).click();
  return evidenceRequests;
}

test("engine sign-in opens the linked property from Home and finishes the feedback review", async (t) => {
  const { server, context, partnerReads } = await app(t, {
    tourFeedback: true,
    tourDeal: () => ({ properties: [annex, clinic] }),
  });
  const page = await context.newPage();
  const evidenceRequests = await followTourFeedbackLink(page, server.origin);
  const property = page.getByRole("region", { name: "Property from tour feedback" });
  const address = property.getByText(clinic.address, { exact: true });
  await address.or(property.getByText("Property details are unavailable.", { exact: true })).waitFor();
  assert.deepEqual(evidenceRequests, []);
  await address.waitFor();
  await property.getByText(clinic.name, { exact: true }).waitFor();
  assert.equal(await property.getByText(annex.address, { exact: true }).count(), 0);

  await page.goto(`${server.origin}/?mode=live`);
  const review = page.getByRole("button", { name: "Review feedback", exact: true });
  await review.click();
  const card = page.getByRole("region", { name: `Details for ${feedbackTitle}` });
  await card.getByRole("button", { name: "Done", exact: true }).click();
  await review.waitFor({ state: "detached" });
  assert.equal(partnerReads.has("/api/engine/home/marks"), true);
});

for (const engineTours of [true, false]) {
  test(`a missing property from Home opens the deal with engine Tours ${engineTours ? "on" : "off"}`, async (t) => {
    const { server, context } = await app(t, {
      tourFeedback: true,
      tourDeal: () => ({ properties: [annex] }),
    });
    const page = await context.newPage();
    const evidenceRequests = await followTourFeedbackLink(page, server.origin, engineTours);
    const room = page.getByRole("main", { name: "Deal Workspace" });
    await room.getByRole("heading", { name: dealName, exact: true }).waitFor();
    const panel = room.getByRole("tabpanel", { name: "Tours" });
    const message = "This property is no longer on this deal.";
    assert.equal(await page.locator("html[data-deal-tours-from-engine]").count(), Number(engineTours));
    const previousView = engineTours ? "No planned tours." : "Not available yet";
    await panel
      .getByText(message, { exact: true })
      .or(panel.getByText(previousView, { exact: true }))
      .waitFor();
    assert.equal(await panel.textContent(), message);
    assert.deepEqual(evidenceRequests, []);

    await room.getByRole("tab", { name: "Overview", exact: true }).click();
    await room.getByRole("tabpanel", { name: "Overview" }).waitFor();
  });
}

type Stop = { property_id: string } | { address: string; name: string | null };
type Plan = { planned_on: string; notes: string | null; stops: Stop[] };
type Draft = Plan & { idempotency_key: string; revision?: number };
type Completion = { revision: number; happened_at: string; visited_stops: Stop[]; idempotency_key: string };

const laterTour = "77777777-7777-4777-8777-777777777777";
const cancelledAt = "2026-11-24T23:00:00Z";
function tourCancelledEvent(id: string) {
  return {
    id,
    recorded_at: cancelledAt,
    actor: "joe",
    verb: "cancel-tour",
    field: "cancelled_at",
    new_value: cancelledAt,
  };
}

function tourFixture(t: TestContext, planned = false, cancellationGates?: ReadonlyMap<string, Promise<void>>) {
  const properties = [clinic, annex];
  const writes: Draft[] = [];
  let saved: Plan | undefined = planned
    ? { planned_on: "2026-11-24", notes: "Original notes", stops: [{ property_id: first }, { property_id: second }] }
    : undefined;
  const plan = `${tours}/${tour}`;
  let revision = planned ? 1 : 0;
  const cancelledTours = new Set<string>();
  let meeting: { activity_id: string; happened_at: string; properties: typeof properties } | undefined;
  const completions: Completion[] = [];
  function tourDeal() {
    return {
      correspondence: meeting ? [{ ...meeting, kind: "meeting", title: "Property tour" }] : [],
      events: [...cancelledTours].map(tourCancelledEvent),
    };
  }
  let failSave = false;
  async function open(actor = "joe", { width = 390, linked }: { width?: number; linked?: typeof properties } = {}) {
    const { server, context } = await app(t, {
      width,
      touch: width === 390,
      tourDeal: () => ({ ...tourDeal(), ...(linked && { properties: linked }) }),
    });
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    const page = await context.newPage();
    await page.request.get(`${server.origin}/auth/callback/google?fixture=${actor === "joe" ? "first" : "second"}`);
    await page.route("**/deals?*", async (route) => {
      const response = await route.fetch();
      const body = (await response.text()).replace("<html", "<html data-deal-tours-from-engine");
      await route.fulfill({ response, body });
    });
    await page.route(/\/api\/engine\/(deals\/[^/]+\/tours|properties\/search)/, async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      const path = url.pathname;
      if (path === "/api/engine/properties/search") {
        const query = url.searchParams.get("query")?.toLowerCase();
        return route.fulfill({
          json: {
            properties: properties.filter((p) => query && `${p.name} ${p.address}`.toLowerCase().includes(query)),
          },
        });
      }
      if (request.method() === "POST") {
        assert.equal(request.headers()["x-carr-csrf"], `fixture-${actor === "joe" ? "first" : "second"}`);
        if (path === `${plan}/complete`) {
          const done: Completion = request.postDataJSON();
          completions.push(done);
          if (!meeting) {
            assert.equal(done.revision, revision);
            const visited = done.visited_stops.flatMap((stop) =>
              "property_id" in stop ? properties.filter(({ id }) => id === stop.property_id) : [{ id: added, ...stop }],
            );
            meeting = { activity_id: added, happened_at: done.happened_at, properties: visited };
          }
          if (completions.length === 1) return route.abort();
          return route.fulfill({ json: { id: tour, activity_id: meeting.activity_id } });
        }
        const draft: Draft = request.postDataJSON();
        if (path !== tours && draft.revision !== revision)
          return route.fulfill({ status: 409, json: { error: "version_conflict", current_revision: revision } });
        if (path === `${plan}/cancel` || (cancellationGates && path === `${tours}/${laterTour}/cancel`)) {
          assert.match(draft.idempotency_key, /^[a-f0-9-]{36}$/);
          const id = path === `${plan}/cancel` ? tour : laterTour;
          await cancellationGates?.get(id);
          cancelledTours.add(id);
          return route.fulfill({ json: { id, revision: revision + 1, cancelled_at: cancelledAt } });
        }
        writes.push(draft);
        if (failSave) return route.fulfill({ status: 422, json: { error: "invalid_field_value", fields: ["stops"] } });
        if (draft.stops.some((stop) => "property_id" in stop && !properties.some((p) => p.id === stop.property_id)))
          return route.fulfill({
            status: 422,
            json: {
              error: "database_refused_the_statement",
              rule: "tour_stop_property_id_fkey",
              correlation_id: tour,
              hint: "The operation could not be completed. Quote the correlation_id when reporting it.",
            },
          });
        const stops = draft.stops.map((stop) => {
          if ("property_id" in stop) return stop;
          properties.push({ ...stop, id: added });
          return { property_id: added };
        });
        saved = { ...draft, stops };
        return route.fulfill({ status: path === tours ? 201 : 200, json: { id: tour, revision: ++revision } });
      }
      if (path === tours) {
        const plans = saved && !meeting ? [{ id: tour, planned_on: saved.planned_on }] : [];
        if (cancellationGates) plans.push({ id: laterTour, planned_on: "2026-11-25" });
        return route.fulfill({ json: { tours: plans.filter(({ id }) => !cancelledTours.has(id)) } });
      }
      if (path === `${tours}/${tour}/stop-list`) return route.fulfill({ json: { text: preview } });
      assert.ok(saved && (path === plan || (cancellationGates && path === `${tours}/${laterTour}`)));
      const id = path === plan ? tour : laterTour;
      const stops = saved.stops.map((stop, index) => {
        const property = properties.find((p) => "property_id" in stop && p.id === stop.property_id);
        assert.ok(property);
        return { property_id: property.id, name: property.name, address: property.address, position: index + 1 };
      });
      return route.fulfill({
        json: {
          ...saved,
          revision,
          id,
          deal_id: dealId,
          planned_on: id === tour ? saved.planned_on : "2026-11-25",
          stops,
          completed_activity_id: meeting?.activity_id ?? null,
          cancelled_at: cancelledTours.has(id) ? cancelledAt : null,
        },
      });
    });
    await page.goto(`${server.origin}/deals?mode=live&deal=${dealId}`);
    return page;
  }
  return {
    open,
    writes,
    completions,
    removeAnnex: () => properties.splice(properties.indexOf(annex), 1),
    fail: (value: boolean) => {
      failSave = value;
    },
  };
}

test("partners plan, open, and copy a tour using a linked property at phone width", async (t) => {
  const fixture = tourFixture(t);
  const joe = await fixture.open("joe", { linked: [clinic] });
  const button = (name: string) => joe.getByRole("button", { name, exact: true });
  await joe.getByRole("tab", { name: "Tours" }).click();
  await joe.getByText("No planned tours.", { exact: true }).waitFor();
  await button("Plan tour").click();
  await joe.getByLabel("Tour date").fill("2026-11-24");
  await button("Save tour").click();
  await joe.getByText("Add at least one property.").waitFor();
  const search = async (query: string) => {
    await joe.getByLabel("Property name or address").fill(query);
    await button("Search properties").click();
  };
  await button("Add Example Clinic, 10 Example Way").tap({ timeout: 5000 });
  await joe.getByRole("list", { name: "Tour stops" }).getByText(clinic.address, { exact: false }).waitFor();
  await search("20 Example Way");
  await button("20 Example Way").click();
  await joe.getByRole("listitem").filter({ hasText: "20 Example Way" }).getByRole("button", { name: "Remove" }).tap();
  await search("30 Example Way");
  await joe.getByRole("status").filter({ hasText: "No properties match your search." }).waitFor();
  await joe.getByLabel("New property address").fill("30 Example Way");
  await button("Add property").click();
  await button("Move up").press("Enter");
  const firstStop = joe.getByRole("list", { name: "Tour stops" }).getByRole("listitem").first();
  assert.match((await firstStop.textContent()) ?? "", /^30 Example Way/);
  await button("Move down").tap();
  await joe.getByLabel("Tour notes (optional)").fill("Private notes for the visit");
  fixture.fail(true);
  await button("Save tour").click();
  await joe.getByText("Check the properties in the stop list.").waitFor();
  assert.equal(await joe.getByLabel("Tour notes (optional)").inputValue(), "Private notes for the visit");
  assert.equal(await joe.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  fixture.fail(false);
  await button("Save tour").click();
  await joe.locator("#workspace-tours summary", { hasText: "November 24, 2026" }).waitFor();
  const stops = [{ property_id: first }, { address: "30 Example Way", name: null }];
  assert.deepEqual(
    fixture.writes.map((draft) => draft.stops),
    [stops, stops],
  );
  assert.equal(fixture.writes[0]?.idempotency_key, fixture.writes[1]?.idempotency_key);
  await button("Preview stop list").click();
  assert.equal(await joe.getByLabel("Client stop list").inputValue(), preview);
  await joe.locator("#workspace-tours").screenshot({ path: `${artifacts}/tour-plan-390.png` });
  await button("Copy stop list").click();
  await joe.getByText("Stop list copied.").waitFor();
  assert.equal(await joe.evaluate(() => navigator.clipboard.readText()), preview);
  assert.equal(await joe.getByRole("navigation", { name: "Primary" }).getByText("Tours", { exact: true }).count(), 0);

  const dell = await fixture.open("dell");
  await dell.getByRole("tab", { name: "Tours" }).click();
  const listed = dell.locator("#workspace-tours summary", { hasText: "November 24, 2026" });
  await listed.waitFor();
  assert.equal(await listed.count(), 1);
  await listed.click();
  await dell.getByText("Private notes for the visit").waitFor();
  assert.deepEqual(await dell.getByRole("list", { name: "Tour stops" }).getByRole("listitem").allTextContents(), [
    "Example Clinic, 10 Example Way",
    "30 Example Way",
  ]);
});

test("tour planner keeps Search and the main actions in view on desktop and phone", async (t) => {
  const fixture = tourFixture(t);
  const linked = [
    clinic,
    annex,
    ...Array.from({ length: 10 }, (_, index) => ({
      id: `66666666-6666-4666-8666-${String(index).padStart(12, "0")}`,
      address: `${40 + index} Example Way`,
      name: null,
    })),
  ];
  for (const width of [1440, 390]) {
    const page = await fixture.open("joe", { width, linked });
    await page.setViewportSize({ width, height: 700 });
    await page.getByRole("tab", { name: "Tours" }).click();
    await tourButton(page, "Plan tour").click();
    await page.screenshot({ path: `${artifacts}/tour-planner-${width}.png` });
    for (const name of ["Add Example Clinic, 10 Example Way", ...tourActions]) await assertTourActionInView(page, name);
    const suggestions = page.getByRole("list", { name: "Deal properties" });
    const buttons = suggestions.getByRole("button");
    assert.equal(await buttons.count(), linked.length);
    assert.deepEqual((await buttons.allInnerTexts()).slice(0, 2), [
      "Add Example Clinic, 10 Example Way",
      "Add 20 Example Way",
    ]);
    const choicesBox = await suggestions.boundingBox();
    const searchBox = await tourButton(page, "Search properties").boundingBox();
    assert.ok(choicesBox && searchBox && choicesBox.y < searchBox.y);
    await tourButton(page, "Add 49 Example Way").click({ timeout: 5000 });
    await page.getByRole("list", { name: "Tour stops" }).getByText("49 Example Way").waitFor();
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    for (const name of tourActions) await assertTourActionInView(page, name);
    page.once("dialog", (dialog) => dialog.accept());
    await tourButton(page, "Back to tours").click();
    await tourButton(page, "Plan tour").waitFor();
  }
});

const tourActions = ["Search properties", "Save tour", "Back to tours"];

async function assertTourActionInView(page: Page, name: string) {
  const inView = await tourButton(page, name).evaluate((button) => {
    const { left, top, right, bottom } = button.getBoundingClientRect();
    return (
      top >= 0 &&
      bottom <= innerHeight &&
      [top + 1, bottom - 1].every((y) => button.contains(document.elementFromPoint((left + right) / 2, y)))
    );
  });
  const viewport = page.viewportSize();
  assert.ok(inView, `${name} is in view at ${viewport?.width} × ${viewport?.height}`);
}

for (const { height, ...options } of [
  { width: 320, height: 568, linked: [clinic, annex] },
  { width: 390, height: 700 },
]) {
  const { width } = options;
  test(`tour actions stay in view after a no-match search at ${width} × ${height}`, async (t) => {
    const page = await tourFixture(t).open("joe", options);
    await page.setViewportSize({ width, height });
    await page.getByRole("tab", { name: "Tours" }).click();
    await tourButton(page, "Plan tour").click();
    await page.getByLabel("Property name or address").fill("30 Example Way");
    await tourButton(page, "Search properties").click();
    await page.getByRole("status").filter({ hasText: "No properties match your search." }).waitFor();
    assert.equal(await page.getByLabel("New property address").isVisible(), true);
    assert.equal(await tourButton(page, "Add property").isVisible(), true);
    await page.screenshot({ path: `${artifacts}/tour-no-match-${width}.png` });
    for (const name of [...tourActions, "Add property"]) await assertTourActionInView(page, name);
    await page.getByLabel("New property address").fill("30 Example Way");
    for (const name of tourActions) await assertTourActionInView(page, name);
    await tourButton(page, "Add property").click({ timeout: 5000 });
    await page.getByRole("list", { name: "Tour stops" }).getByText("30 Example Way").waitFor();
  });
}

test("double-tapping a linked property and picking it in search saves one stop", async (t) => {
  const fixture = tourFixture(t);
  const page = await fixture.open("joe", { linked: [clinic] });
  await page.getByRole("tab", { name: "Tours" }).click();
  await tourButton(page, "Plan tour").click();
  await page.getByLabel("Tour date").fill("2026-11-24");

  const suggestions = page.getByRole("list", { name: "Deal properties" });
  const linked = suggestions.getByRole("button", { name: /10 Example Way/ });
  await linked.tap();
  await linked.tap({ force: true });
  await page.getByLabel("Property name or address").fill(clinic.address);
  await tourButton(page, "Search properties").click();
  const linkedMarkedAdded = await suggestions.getByRole("button", { name: /10 Example Way \(added\)/ }).count();
  const linkedDisabled = await linked.isDisabled();
  const searchResults = page.locator("[data-results]");
  const match = searchResults.getByRole("button", { name: /10 Example Way/ });
  await match.waitFor();
  const matchMarkedAdded = await searchResults.getByRole("button", { name: /10 Example Way \(added\)/ }).count();
  const matchDisabled = await match.isDisabled();
  await match.tap({ force: true });
  const rows = await page.getByRole("list", { name: "Tour stops" }).getByRole("listitem").count();
  await tourButton(page, "Save tour").click();
  await page.getByText("November 24, 2026", { exact: true }).waitFor();
  assert.deepEqual({ rows, stops: fixture.writes[0]?.stops }, { rows: 1, stops: [{ property_id: first }] });
  assert.ok(linkedDisabled && matchDisabled);
  assert.equal(linkedMarkedAdded, 1);
  assert.equal(matchMarkedAdded, 1);
});

test("removing and re-adding a stop preserves the other stops' order", async (t) => {
  const fixture = tourFixture(t);
  const page = await fixture.open("joe", { linked: [clinic, annex] });
  await page.getByRole("tab", { name: "Tours" }).click();
  await tourButton(page, "Plan tour").click();
  await page.getByLabel("Tour date").fill("2026-11-24");
  await tourButton(page, "Add Example Clinic, 10 Example Way").click();
  await tourButton(page, "Add 20 Example Way").click();
  await page.getByLabel("Property name or address").fill("30 Example Way");
  await tourButton(page, "Search properties").click();
  await page.getByLabel("New property address").fill("30 Example Way");
  await tourButton(page, "Add property").click({ timeout: 5000 });

  await page.getByLabel("Property name or address").fill(clinic.address);
  await tourButton(page, "Search properties").click();
  const match = page.locator("[data-results]").getByRole("button", { name: /10 Example Way/ });
  await match.waitFor();
  assert.equal(await match.isDisabled(), true);
  const rows = page.getByRole("list", { name: "Tour stops" }).getByRole("listitem");
  await rows.filter({ hasText: clinic.address }).getByRole("button", { name: "Remove" }).click();
  assert.equal(await tourButton(page, "Add Example Clinic, 10 Example Way").isEnabled(), true);
  await match.click();
  await tourButton(page, "Save tour").click();
  await page.getByText("November 24, 2026", { exact: true }).waitFor();
  assert.deepEqual(fixture.writes[0]?.stops, [
    { property_id: second },
    { address: "30 Example Way", name: null },
    { property_id: first },
  ]);
});

test("tour planner can search and save when the deal read omits properties", async (t) => {
  const fixture = tourFixture(t);
  const page = await fixture.open();
  await page.getByRole("tab", { name: "Tours" }).click();
  await tourButton(page, "Plan tour").click();
  assert.equal(await page.getByRole("list", { name: "Deal properties" }).count(), 0);
  await page.getByLabel("Property name or address").fill(annex.address);
  await tourButton(page, "Search properties").click();
  await tourButton(page, annex.address).click();
  await page.getByLabel("Tour date").fill("2026-11-24");
  await tourButton(page, "Save tour").click();
  await page.getByText("November 24, 2026", { exact: true }).waitFor();
  assert.deepEqual(fixture.writes[0]?.stops, [{ property_id: second }]);
});

test("an unavailable tour stop is named and the remaining draft can be saved", async (t) => {
  const fixture = tourFixture(t);
  const page = await fixture.open();
  const button = (name: string) => page.getByRole("button", { name, exact: true });
  await page.getByRole("tab", { name: "Tours" }).click();
  await button("Plan tour").click();
  await page.getByLabel("Tour date").fill("2026-11-24");
  await page.getByLabel("Tour notes (optional)").fill("Bring the floor plan");
  for (const property of [clinic, annex]) {
    await page.getByLabel("Property name or address").fill(property.address);
    await button("Search properties").click();
    await button(property.name ? `${property.name}, ${property.address}` : property.address).click();
  }
  fixture.removeAnnex();
  await button("Save tour").click();
  await page
    .getByText("20 Example Way is no longer available. Remove or reselect this stop.", { exact: true })
    .waitFor({ timeout: 5000 });
  assert.equal(await page.getByLabel("Tour date").inputValue(), "2026-11-24");
  assert.equal(await page.getByLabel("Tour notes (optional)").inputValue(), "Bring the floor plan");
  const stops = page.getByRole("list", { name: "Tour stops" }).getByRole("listitem");
  assert.equal(await stops.count(), 2);
  await stops.filter({ hasText: annex.address }).getByRole("button", { name: "Remove" }).click();
  await button("Save tour").click();
  await page.locator("#workspace-tours summary", { hasText: "November 24, 2026" }).waitFor();
  assert.equal(fixture.writes.length, 2);
  assert.deepEqual(fixture.writes[1]?.stops, [{ property_id: first }]);
  assert.equal(fixture.writes[1]?.notes, "Bring the floor plan");
});

async function openPlannedTour(page: Page, day = 24) {
  await page.getByRole("tab", { name: "Tours", exact: true }).click();
  await page.locator("#workspace-tours summary", { hasText: `November ${day}, 2026` }).click({ timeout: 5000 });
}
const tourButton = (page: Page, name: string) => page.getByRole("button", { name, exact: true });

test("partners edit a tour, keep refused edits, and reload a newer plan", async (t) => {
  const fixture = tourFixture(t, true);
  const joe = await fixture.open();
  const dell = await fixture.open("dell");
  const reader = await fixture.open("dell");
  await openPlannedTour(reader);
  await reader.getByText("Original notes", { exact: true }).waitFor();
  for (const page of [joe, dell]) {
    await openPlannedTour(page);
    await tourButton(page, "Edit tour").click({ timeout: 5000 });
  }
  await joe.getByLabel("Tour date").fill("2026-11-25");
  await joe.getByLabel("Tour notes (optional)").fill("Bring the new floor plan");
  await tourButton(joe, "Move up").press("Enter");
  fixture.fail(true);
  await tourButton(joe, "Save tour").tap();
  await joe.getByRole("alert").filter({ hasText: "Check the properties in the stop list." }).waitFor();
  assert.equal(await joe.getByLabel("Tour date").inputValue(), "2026-11-25");
  assert.equal(await joe.getByLabel("Tour notes (optional)").inputValue(), "Bring the new floor plan");
  assert.equal(await joe.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  fixture.fail(false);
  await tourButton(joe, "Save tour").tap();
  await joe.getByText("Bring the new floor plan", { exact: true }).waitFor();

  await dell.getByLabel("Tour notes (optional)").fill("My earlier draft");
  await tourButton(dell, "Save tour").click();
  await tourButton(dell, "Reload tour").waitFor();
  assert.equal(await dell.getByLabel("Tour notes (optional)").inputValue(), "My earlier draft");
  assert.equal(await tourButton(dell, "Save tour").isEnabled(), false);
  dell.once("dialog", (dialog) => dialog.accept());
  await tourButton(dell, "Reload tour").click();
  await reader.locator("#workspace-tours details[open] summary").click();
  await openPlannedTour(reader);
  for (const page of [joe, dell, reader]) {
    await page.locator("#workspace-tours details[open] summary", { hasText: "November 25, 2026" }).waitFor();
    await page.getByText("Bring the new floor plan", { exact: true }).waitFor();
    assert.deepEqual(await page.getByRole("list", { name: "Tour stops" }).getByRole("listitem").allTextContents(), [
      annex.address,
      `${clinic.name}, ${clinic.address}`,
    ]);
  }
});

test("finishing a tour records one meeting through a lost response and a second partner's save", async (t) => {
  const fixture = tourFixture(t, true);
  const joe = await fixture.open();
  const dell = await fixture.open("dell");
  for (const page of [joe, dell]) {
    await openPlannedTour(page);
    await tourButton(page, "Mark done").click({ timeout: 5000 });
    assert.equal(await page.getByLabel("Visit date").inputValue(), "2026-11-24");
    assert.equal(await page.getByLabel("Local time").inputValue(), "");
    await page.getByLabel("Local time").fill("14:35");
  }
  await joe.getByLabel("Visit date").fill("2026-11-25");
  const visited = joe.getByRole("list", { name: "Visited properties" }).getByRole("listitem");
  assert.equal(await visited.count(), 2);
  await visited.filter({ hasText: annex.address }).getByRole("button", { name: "Remove" }).tap();
  await joe.getByLabel("Property name or address").fill("30 Example Way");
  await tourButton(joe, "Search properties").press("Enter");
  await joe.getByLabel("New property address").fill("30 Example Way");
  await tourButton(joe, "Add property").tap();
  assert.equal(await joe.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);

  await tourButton(joe, "Save meeting").tap();
  await joe.getByText("Could not confirm the save. Try saving again.").waitFor();
  assert.equal(await joe.getByLabel("Local time").inputValue(), "14:35");
  await tourButton(joe, "Save meeting").tap();
  await joe.getByText("No planned tours.").waitFor();
  await tourButton(dell, "Save meeting").click();
  await dell.getByText("No planned tours.").waitFor();

  assert.equal(fixture.completions.length, 3);
  assert.deepEqual(fixture.completions[0], fixture.completions[1]);
  assert.notEqual(fixture.completions[2]?.idempotency_key, fixture.completions[0]?.idempotency_key);
  assert.equal(fixture.completions[0]?.happened_at, "2026-11-25T20:35:00.000Z");
  assert.deepEqual(fixture.completions[0]?.visited_stops, [
    { property_id: first },
    { address: "30 Example Way", name: null },
  ]);
  assert.equal(fixture.writes.length, 0, "completion leaves the saved plan untouched");
  for (const page of [joe, dell]) {
    await page.getByRole("tab", { name: "Correspondence & notes" }).click();
    const meeting = page.getByText("Property tour", { exact: true });
    await meeting.click();
    assert.equal(await meeting.count(), 1);
    await page.getByText(clinic.address, { exact: false }).waitFor();
    await page.getByText("30 Example Way", { exact: true }).waitFor();
    assert.equal(await page.getByText(annex.address, { exact: true }).count(), 0);
  }
});

test("cancelling a tour requires confirmation and records a change without a meeting", async (t) => {
  const page = await tourFixture(t, true).open();
  await openPlannedTour(page);
  const cancel = tourButton(page, "Cancel tour");
  page.once("dialog", (dialog) => dialog.dismiss());
  await cancel.press("Enter", { timeout: 5000 });
  await page.getByText("Original notes", { exact: true }).waitFor();
  page.once("dialog", (dialog) => dialog.accept());
  await cancel.tap();
  await page.getByText("No planned tours.").waitFor();
  await page.getByRole("tab", { name: "Timeline" }).click();
  await page.getByText("Tour cancelled", { exact: true }).waitFor();
  await page.getByRole("tab", { name: "Correspondence & notes" }).click();
  await page.getByText("No emails or meetings filed to this deal yet.").waitFor();
});

test("overlapping tour cancellations both leave Planned tours and reach Timeline", async (t) => {
  const firstCancel = Promise.withResolvers<void>();
  const secondCancel = Promise.withResolvers<void>();
  t.after(() => {
    firstCancel.resolve();
    secondCancel.resolve();
  });
  const page = await tourFixture(
    t,
    true,
    new Map([
      [tour, firstCancel.promise],
      [laterTour, secondCancel.promise],
    ]),
  ).open();
  await openPlannedTour(page);
  const firstRow = page.locator("#workspace-tours details", { hasText: "November 24, 2026" });
  const secondRow = page.locator("#workspace-tours details", { hasText: "November 25, 2026" });
  await secondRow.locator("summary").click();
  for (const [row, id] of [
    [firstRow, tour],
    [secondRow, laterTour],
  ] as const) {
    const requested = page.waitForRequest((request) => new URL(request.url()).pathname === `${tours}/${id}/cancel`);
    page.once("dialog", (dialog) => dialog.accept());
    await row.getByRole("button", { name: "Cancel tour" }).click();
    await requested;
  }
  firstCancel.resolve();
  await firstRow.waitFor({ state: "detached", timeout: 5000 });
  await secondRow.locator("summary").waitFor({ timeout: 5000 });
  const cancellations = page.getByText("Tour cancelled", { exact: true });
  await cancellations.waitFor({ state: "attached", timeout: 5000 });
  const committed = page.waitForResponse(
    (response) => new URL(response.url()).pathname === `${tours}/${laterTour}/cancel`,
  );
  secondCancel.resolve();
  assert.equal((await committed).ok(), true);
  await page.getByText("No planned tours.", { exact: true }).waitFor({ timeout: 5000 });
  assert.equal(await page.locator("#workspace-tours details").count(), 0);
  await page.getByRole("tab", { name: "Timeline" }).click();
  await cancellations.nth(1).waitFor({ timeout: 5000 });
  assert.equal(await cancellations.count(), 2);
});

test("the deal tour switch hides visited properties and the cancellation label when off", async (t) => {
  const { server, context } = await app(t, {
    tourDeal: () => ({
      correspondence: [
        {
          kind: "meeting",
          title: "Property tour",
          activity_id: activityId,
          happened_at: cancelledAt,
          properties: [clinic],
        },
      ],
      events: [tourCancelledEvent(tour)],
    }),
  });
  const page = await context.newPage();
  await page.request.get(`${server.origin}/auth/callback/google?fixture=first`);
  await page.goto(server.origin + dealPage);
  assert.equal(await page.locator("html[data-deal-tours-from-engine]").count(), 0);
  await page.getByRole("tab", { name: "Correspondence & notes" }).click();
  await page.getByText("Property tour", { exact: true }).waitFor();
  const visitedProperties = await page.getByRole("list", { name: "Visited properties", includeHidden: true }).count();
  await page.getByRole("tab", { name: "Timeline" }).click();
  await page.getByRole("heading", { name: "Dated events" }).waitFor();
  const cancellationLabels = await page.getByText("Tour cancelled", { exact: true }).count();
  assert.deepEqual({ visitedProperties, cancellationLabels }, { visitedProperties: 0, cancellationLabels: 0 });
});

test("a saved Leads link opens on the engine session, supports claim and prompts after expiry", async (t) => {
  const { server, context, carrChecks, expireOnNextLeadDetail, writes } = await app(t);
  const path = "/leads?mode=live&lead=L-1";
  const page = await context.newPage();
  await page.goto(server.origin + path);
  const drawer = page.locator("#leadDetail");
  await drawer.getByRole("heading", { name: "Dr. Example 1" }).waitFor({ timeout: 5000 });
  await drawer.getByRole("button", { name: "Claim", exact: true }).click();
  await page.getByText("Lead claimed", { exact: true }).waitFor({ timeout: 5000 });
  await drawer.getByText("Joe", { exact: true }).waitFor({ timeout: 5000 });
  assert.equal(writes(), 1);

  await drawer.getByRole("button", { name: "Close lead details" }).click();
  await drawer.waitFor({ state: "hidden" });
  expireOnNextLeadDetail();
  const leadButton = page.getByRole("button", { name: "Dr. Example 1", exact: true });
  await leadButton.click();
  await page.getByRole("link", { name: "Sign in again" }).waitFor({ timeout: 5000 });
  assert.equal(await leadButton.count(), 0);
  assert.equal(carrChecks(), 0);
});

test("a saved Leads link with a second copied UUID opens the lead and supports claim", async (t) => {
  const { server, context, writes } = await app(t);
  const page = await context.newPage();
  await page.goto(`${server.origin}/leads?mode=live&lead=${copiedLeadAlias}`);
  const drawer = page.locator("#leadDetail");
  await drawer.getByRole("heading", { name: "Dr. Example 1" }).waitFor({ timeout: 5000 });
  await drawer.getByText("Planning a dental relocation.", { exact: false }).waitFor({ timeout: 5000 });
  await drawer.getByRole("button", { name: "Claim", exact: true }).click();
  await page.getByText("Lead claimed", { exact: true }).waitFor({ timeout: 5000 });
  assert.equal(writes(), 1);
});

for (const width of [390, 1440]) {
  test(`Vendor rows show only the contact date on switched CARR sign-in at ${width}px`, async (t) => {
    const { context, server } = await app(t, { width, signIn: "carr", switchDay: true });
    const page = await context.newPage();
    await page.goto(server.origin + "/vendors");
    for (const [index, note] of vendorContactNotes.entries()) {
      const row = page.getByRole("link", { name: new RegExp(`^Demo Partner 0${index + 1}\\b`) });
      const text = (await row.textContent({ timeout: 5000 })) ?? "";
      if (note === null) {
        assert.doesNotMatch(text, /Last contacted/);
      } else {
        assert.ok(await row.getByText("Last contacted Sep 30, 2026", { exact: true }).isVisible(), text);
      }
    }
  });

  test(`Clients has one level-one heading on switched CARR sign-in at ${width}px`, async (t) => {
    const { context, server } = await app(t, { width, signIn: "carr", switchDay: true });
    const page = await context.newPage();
    await page.goto(server.origin + "/clients");
    await page.getByRole("link", { name: /^Demo Practice 01\b/ }).waitFor({ timeout: 5000 });
    assert.deepEqual(await page.getByRole("heading", { level: 1 }).allTextContents(), ["Clients"]);
  });
}

test("the Vendor drawer keeps the track record and shows the rating editor only in CARR mode", async (t) => {
  for (const signIn of ["engine", "carr"] as const) {
    const { server, context, carrChecks } = await app(t, { signIn });
    await context.addCookies([
      {
        name: "__Host-dealroom_session",
        value: "stale",
        domain: new URL(server.origin).hostname,
        path: "/",
        secure: true,
      },
    ]);
    const page = await context.newPage();
    await page.goto(server.origin + "/vendors?mode=live&q=Demo+Partner+01");
    await page.locator(".record-row").filter({ hasText: "Demo Partner 01" }).click({ timeout: 5000 });
    const drawer = page.getByRole("dialog");
    await drawer.getByText("Deals worked", { exact: true }).waitFor({ timeout: 5000 });
    assert.equal(await drawer.getByText("Trust rating", { exact: true }).count(), signIn === "carr" ? 1 : 0);
    if (signIn === "engine") assert.equal(carrChecks(), 0);
  }
});

function attributionButton(page: Page, update: string) {
  return page
    .getByRole("region", { name: "Deal updates" })
    .getByRole("article")
    .filter({ hasText: update })
    .getByRole("button", { name: "Show deal attribution" });
}

test("an engine history note offers attribution for its activity ID", async (t) => {
  const { server, context } = await app(t, {
    readAttribution: () => Response.json({ kind: "credited", deal: creditedDeal }),
  });
  const page = await context.newPage();
  await page.goto(server.origin + dealPage);
  await page.locator(".updates-history summary").click();
  await page.getByRole("region", { name: "Deal updates" }).getByText(noteSummary, { exact: true }).waitFor();
  const button = attributionButton(page, noteSummary);
  assert.equal(await button.count(), 1, "The engine note should have a deal attribution button");
  await button.click();
  const panel = page.getByRole("region", { name: "Activity deal attribution" });
  await panel.getByRole("link", { name: dealName }).waitFor();
  assert.deepEqual(
    server.requests.filter(({ path }) => path === noteAttributionPath).map(({ method }) => method),
    ["GET"],
  );
});

const attributionCases = [
  {
    title: "Direct deal attribution",
    deals: [creditedDeal],
    response: () => Response.json({ kind: "credited", deal: creditedDeal }),
  },
  {
    title: "Ambiguous deals need review",
    deals: [creditedDeal, candidateDeal],
    response: () => Response.json({ kind: "ambiguous", candidates: [creditedDeal, candidateDeal] }),
  },
  {
    title: "Activity attribution unknown",
    deals: [],
    response: () => Response.json({ error: "not_found" }, { status: 404 }),
  },
];

for (const { title, deals, response } of attributionCases)
  test(`engine deal history shows ${title.toLowerCase()}`, async (t) => {
    const { server, context } = await app(t, { readAttribution: response });
    const page = await context.newPage();
    await page.goto(server.origin + dealPage);
    await page.locator(".updates-history summary").click();
    await attributionButton(page, callSummary).click();
    const panel = page.getByRole("region", { name: "Activity deal attribution" });
    await panel.getByRole("heading", { name: title }).waitFor();
    await panel.getByText(`${deals.length === 1 ? 1 : 0} credited activities`, { exact: true }).waitFor();
    const links = panel.getByRole("link");
    assert.deepEqual(
      await links.allTextContents(),
      deals.map(({ name }) => name),
    );
    for (const [index, deal] of deals.entries())
      assert.equal(await links.nth(index).getAttribute("href"), `/deals?deal=${deal.id}`);
    assert.deepEqual(
      server.requests.filter(({ path }) => path === attributionPath).map(({ method, target }) => [method, target]),
      [["GET", attributionPath]],
    );
  });

test("a signed-out attribution read returns the partner to sign-in", async (t) => {
  const { server, context } = await app(t, {
    readAttribution: () => Response.json({ error: "unauthorized" }, { status: 401 }),
  });
  const page = await context.newPage();
  await page.goto(server.origin + dealPage);
  await page.locator(".updates-history summary").click();
  await attributionButton(page, callSummary).click();
  await page.waitForURL("**/public-shell/session-ended.html");
  await page.getByRole("link", { name: "Sign in again" }).waitFor();
  assert.equal(await page.getByRole("heading", { name: dealName }).count(), 0);
});

test("an attribution timeout aborts the read and shows a sign-in prompt", async (t) => {
  const started = Promise.withResolvers<void>();
  const cancelled = Promise.withResolvers<void>();
  t.after(() => cancelled.resolve());
  const { server, context } = await app(t, {
    async readAttribution(request) {
      request.signal.addEventListener("abort", () => cancelled.resolve(), { once: true });
      started.resolve();
      await cancelled.promise;
      return Response.json({ kind: "credited", deal: creditedDeal });
    },
  });
  const page = await context.newPage();
  await page.clock.install();
  await page.goto(server.origin + dealPage);
  await page.locator(".updates-history summary").click();
  await attributionButton(page, callSummary).click();
  await started.promise;
  await page.clock.fastForward(30_001);
  await page
    .getByRole("region", { name: "Activity deal attribution" })
    .getByRole("link", { name: "Sign in" })
    .waitFor();
  await cancelled.promise;
  await page.getByRole("heading", { name: dealName }).waitFor();
  assert.equal(await page.getByText("1 credited activities", { exact: true }).count(), 0);
});

test("CARR deal history and Compare terms use their existing reads", async (t) => {
  const { server, context } = await app(t, { signIn: "carr" });
  const page = await context.newPage();
  await page.goto(server.origin + dealPage);
  await page.locator(".updates-history summary").click();
  await page.getByRole("region", { name: "Deal updates" }).getByText(noteSummary, { exact: true }).waitFor();
  assert.equal(await attributionButton(page, noteSummary).count(), 0);
  const reading = page.waitForRequest(
    (request) =>
      request.url().endsWith("/mcp") && request.postDataJSON()?.params?.name === "read-activity-deal-attribution",
  );
  await attributionButton(page, callSummary).click();
  assert.deepEqual((await reading).postDataJSON().params.arguments, { activity_id: activityId });
  await page.getByRole("heading", { name: "Activity attribution unknown" }).waitFor();
  await page.getByText("Version evidence", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Close attribution" }).click();
  await page.getByRole("tab", { name: "Compare terms" }).click();
  await page.getByRole("tabpanel", { name: "Compare terms" }).getByRole("table").waitFor();
  assert.deepEqual(
    server.requests.filter(({ path }) => path === "/api/v1/market-terms/read").map(({ method }) => method),
    ["POST"],
  );
  assert.equal(
    server.requests.some(({ path }) => path === attributionPath || path === noteAttributionPath),
    false,
  );
});

for (const width of [390, 1440])
  for (const theme of ["light", "dark"] as const) {
    test(`engine sign-in gates real app pages at ${width}px in ${theme}`, async (t) => {
      const { server, context, setUnavailable, carrChecks } = await app(t, { width, theme });
      const page = await context.newPage();
      const target = server.origin + deepLink;
      setUnavailable(true);
      const outage = await page.goto(target);
      assert.ok(outage);
      assert.equal(outage.status(), 503);
      await page.getByRole("heading", { name: "DoctorCRE is temporarily unavailable" }).waitFor();
      assert.equal(await page.locator("html").getAttribute("data-theme"), theme);
      await mkdir(artifacts, { recursive: true });
      await page.screenshot({ path: `${artifacts}/unavailable-${width}-${theme}.png` });
      const loginOutage = await page.goto(server.origin + "/auth/login");
      assert.ok(loginOutage);
      assert.equal(loginOutage.status(), 503);
      await page.getByRole("heading", { name: "DoctorCRE is temporarily unavailable" }).waitFor();
      setUnavailable(false);

      const pageResponse = await page.goto(target);
      assert.equal(page.url(), target);
      assert.ok(pageResponse);
      assert.equal(pageResponse.status(), 200);
      assert.equal(pageResponse.headers()["cache-control"], "no-store");
      const login = pageResponse.request().redirectedFrom()?.redirectedFrom();
      assert.ok(login);
      assert.equal(new URL(login.url()).searchParams.get("return_to"), deepLink);
      await page.locator('#selfAvatar[aria-label*="account and settings"]').waitFor();
      for (const path of pages) {
        const response = await page.goto(server.origin + path);
        assert.ok(response);
        assert.equal(response.status(), 200, path);
        assert.equal(response.headers()["cache-control"], "no-store", path);
        await page.locator("main").first().waitFor({ state: "attached" });
      }
      assert.deepEqual(await page.evaluate(() => fetch("/api/engine/leads").then((response) => response.json())), {
        count: 0,
      });
      assert.equal(carrChecks(), 0);
    });
    test(`a refused Google sign-in can be retried at ${width}px in ${theme}`, async (t) => {
      const { server, context } = await app(t, { width, theme });
      const page = await context.newPage();
      const response = await page.goto(server.origin + "/auth/callback/google?fixture=refused");
      assert.ok(response);
      assert.equal(response.status(), 401);
      assert.match(response.headers()["content-type"] ?? "", /^text\/html\b/);
      assert.equal(response.headers()["cache-control"], "no-store");
      await page.getByRole("heading", { name: "We couldn’t complete Google sign-in" }).waitFor();
      assert.equal(await page.locator("html").getAttribute("data-theme"), theme);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), width);
      await mkdir(artifacts, { recursive: true });
      await page.screenshot({ path: `${artifacts}/refused-${width}-${theme}.png` });
      await page.getByRole("link", { name: "Try again" }).click();
      await page.waitForURL(server.origin + "/");
      await page.locator('#selfAvatar[aria-label*="account and settings"]').waitFor();
    });
  }

test("engine sign-out clears two tabs, revokes the cookie, and leaves another context signed in", async (t) => {
  const { server, context } = await app(t);
  const first = await context.newPage();
  const otherTab = await context.newPage();
  assert.ok(browser);
  const separate = await (await browser).newContext();
  t.after(() => separate.close());
  const otherPartner = await separate.newPage();
  const target = server.origin + deepLink;
  await first.goto(target);
  await otherTab.goto(target);
  await otherPartner.goto(
    server.origin + "/auth/callback/google?fixture=second&return_to=" + encodeURIComponent(deepLink),
  );
  for (const page of [first, otherTab, otherPartner])
    await page.locator('#selfAvatar[aria-label*="account and settings"]').waitFor();
  await first.locator("#selfAvatar").click();
  await first.getByRole("button", { name: "Sign out", exact: true }).click();
  await Promise.all([first, otherTab].map((page) => page.waitForURL("**/public-shell/session-ended.html")));
  assert.equal((await context.request.get(server.origin + "/auth/session")).status(), 401);
  assert.equal(
    (await context.cookies()).some((cookie) => cookie.name === cookieName),
    false,
  );
  assert.equal((await separate.request.get(server.origin + "/auth/session")).status(), 200);
});

test("a delayed session change notification leaves the new engine workspace open", async (t) => {
  const { server, context } = await app(t);
  const stale = await context.newPage();
  const fresh = await context.newPage();
  const avatar = '#selfAvatar[aria-label*="account and settings"]';
  const target = server.origin + deepLink;
  await stale.addInitScript(() => {
    const delayEpoch = (event: StorageEvent) => {
      if (event.key !== "doctorcre-session-epoch-v1") return;
      event.stopImmediatePropagation();
      window.removeEventListener("storage", delayEpoch, true);
      const notification = new StorageEvent("storage", event);
      window.addEventListener("release-session-change", () => window.dispatchEvent(notification), { once: true });
      document.documentElement.dataset.sessionChangeDelayed = "true";
    };
    window.addEventListener("storage", delayEpoch, true);
  });

  await stale.goto(target);
  await stale.locator(avatar).waitFor();
  await fresh.goto(server.origin + "/auth/callback/google?fixture=second&return_to=" + encodeURIComponent(deepLink));
  await fresh.locator(avatar).waitFor();
  await stale.locator('html[data-session-change-delayed="true"]').waitFor({ state: "attached" });
  await fresh.evaluate(() => localStorage.setItem("doctorcre:fixture-new-draft", "New synthetic draft"));

  await stale.evaluate(() => window.dispatchEvent(new Event("release-session-change")));
  await stale.waitForURL("**/public-shell/session-ended.html");
  assert.equal((await context.request.get(server.origin + "/auth/session")).status(), 200);
  assert.equal(fresh.url(), target);
  assert.equal(await fresh.locator(avatar).isVisible(), true);
  assert.equal(await fresh.evaluate(() => localStorage.getItem("doctorcre:fixture-new-draft")), "New synthetic draft");
});

test("engine session changes fence old tabs and offline navigation shows the public shell", async (t) => {
  const { server, context, writes } = await app(t);
  const stale = await context.newPage();
  const fresh = await context.newPage();
  const target = server.origin + deepLink;
  await stale.goto(target);
  await stale.locator('#selfAvatar[aria-label*="account and settings"]').waitFor();
  await context.request.get(server.origin + "/auth/callback/google?fixture=second", { maxRedirects: 0 });
  await stale.evaluate(() => {
    const sessionModule: string = "/js/private-session.js";
    void import(sessionModule)
      .then(({ privateSession }) =>
        privateSession().fetch("/api/engine/leads", {
          method: "POST",
          headers: { "x-carr-csrf": "fixture-first" },
          body: "{}",
        }),
      )
      .catch(() => {});
  });
  await stale.waitForURL("**/public-shell/session-ended.html");
  assert.equal(writes(), 0);
  await fresh.goto(target);
  await fresh.locator('#selfAvatar[aria-label*="account and settings"]').waitFor();
  await fresh.evaluate(() => navigator.serviceWorker.register("/sw.js"));
  await fresh.waitForFunction(() => navigator.serviceWorker.controller !== null);
  await context.setOffline(true);
  const api = await fresh.evaluate(() => fetch("/api/engine/leads").then((response) => response.json()));
  assert.equal(api.error, "offline");
  await fresh.goto(target);
  await fresh.getByRole("heading", { name: "Reconnecting…" }).waitFor();
  assert.equal(await fresh.locator("#selfAvatar").count(), 0);
});

test("an engine login opens the original page after clearing the previous session state", async (t) => {
  const { server, context } = await app(t);
  await context.addInitScript(() => {
    if (localStorage.getItem("fixture-previous-session-seeded")) return;
    localStorage.setItem("fixture-previous-session-seeded", "true");
    localStorage.setItem("doctorcre-session-binding-v1", "0".repeat(64));
    localStorage.setItem("doctorcre:previous-session-draft", "Old synthetic draft");
  });
  const page = await context.newPage();
  const target = server.origin + deepLink;
  await page.goto(target);
  await page.locator('#selfAvatar[aria-label*="account and settings"]').waitFor({ timeout: 3500 });
  assert.equal(page.url(), target);
  assert.equal(await page.evaluate(() => localStorage.getItem("doctorcre:previous-session-draft")), null);
  assert.equal(server.requests.filter((request) => request.path === "/auth/callback/google").length, 1);
});

const callOutcomesPath = `/api/engine/deals/${dealId}/call-outcomes`;
const callProposalId = "66666666-6666-4666-8666-666666666666";
const callDecisionPath = `/api/engine/proposals/${callProposalId}/decision`;
const callEvidence = "Please send the revised demo floor plan.";

function callOutcomes(status: string, block: string | null = null, includeOlder = false) {
  return Response.json({
    deal_id: dealId,
    deal_name: dealName,
    calls: [
      {
        activity_id: activityId,
        started_at: "2026-11-19T18:00:00Z",
        call_date: "2026-11-19",
        proposals: [
          {
            proposal_id: callProposalId,
            status,
            accept_blocked: block,
            kind: block === "private_call" ? "log_call" : "next_step",
            what: "Send the demo floor plan",
            owner: "joe",
            due_on: "2026-11-23",
            from_phase: null,
            to_phase: null,
            phase_on: null,
            next_step_id: null,
            evidence: callEvidence,
          },
        ],
      },
      ...(includeOlder ? [{ activity_id: noteId, call_date: "2026-11-10", proposals: [] }] : []),
    ],
  });
}

async function openCallReview(t: TestContext, callReview: (request: Request) => Response | Promise<Response>) {
  const { server, context } = await app(t, { callReview });
  const page = await context.newPage();
  await page.goto(server.origin + dealPage);
  await page.getByText("Call review", { exact: true }).click({ timeout: 5_000 });
  return page.getByRole("region", { name: "Review recorded calls" });
}

test("deal call review reads the selected deal and shows dates, evidence, and pending state", async (t) => {
  const paths: string[] = [];
  const review = await openCallReview(t, (request) => {
    paths.push(new URL(request.url).pathname);
    return callOutcomes("pending");
  });
  await review.getByText(callEvidence, { exact: true }).waitFor();
  await review.getByText("Thu, Nov 19, 2026", { exact: true }).waitFor();
  await review.getByText("Needs your decision", { exact: true }).waitFor();
  assert.deepEqual(paths, [callOutcomesPath]);
});

test("retrying a call decision reuses its key and refreshes the proposal state", async (t) => {
  const writes: unknown[] = [];
  let state = "pending";
  let reads = 0;
  const review = await openCallReview(t, async (request) => {
    const path = new URL(request.url).pathname;
    if (request.method === "GET") {
      assert.equal(path, callOutcomesPath);
      reads++;
      return callOutcomes(state);
    }
    assert.equal(path, callDecisionPath);
    const decision = await request.json();
    assert.equal(decision.decision, "accept");
    assert.match(decision.idempotency_key, /^[0-9a-f-]{36}$/);
    writes.push(decision);
    const replay = state === "accepted";
    state = "accepted";
    if (!replay) return new Response(null, { status: 503 });
    return Response.json({ proposal_id: callProposalId, status: state, created: {}, replayed: true });
  });
  await review.getByRole("button", { name: "Accept", exact: true }).click();
  await review.getByRole("button", { name: "Check outcome", exact: true }).click();
  await review.getByText("Accepted", { exact: true }).waitFor();
  await review.getByText("Call review complete.", { exact: true }).waitFor();
  assert.equal(writes.length, 2);
  assert.deepEqual(writes[1], writes[0]);
  assert.ok(reads > 1);
});

test("Check outcome replays the original call decision after a failed refresh", async (t) => {
  const writes: unknown[] = [];
  let reviewUnavailable = false;
  const review = await openCallReview(t, async (request) => {
    if (request.method === "GET") {
      if (reviewUnavailable) return new Response(null, { status: 503 });
      return callOutcomes(writes.length ? "accepted" : "pending");
    }
    assert.equal(new URL(request.url).pathname, callDecisionPath);
    writes.push(await request.json());
    if (writes.length === 1) return new Response(null, { status: 503 });
    assert.equal(reviewUnavailable, true);
    reviewUnavailable = false;
    return Response.json({ proposal_id: callProposalId, status: "accepted", created: {}, replayed: true });
  });
  const checkOutcome = review.getByRole("button", { name: "Check outcome", exact: true });
  await review.getByRole("button", { name: "Accept", exact: true }).click();
  await checkOutcome.waitFor();
  reviewUnavailable = true;
  await review.getByRole("button", { name: "Refresh call review", exact: true }).click();
  await review.getByText("Could not load all of the call review. Try refreshing.", { exact: true }).waitFor();
  assert.equal(await review.getByText("No recorded calls found.", { exact: true }).count(), 0);
  assert.equal(writes.length, 1);

  await checkOutcome.click();
  await review.getByText("Accepted", { exact: true }).waitFor({ timeout: 5_000 });
  assert.equal(writes.length, 2);
  assert.deepEqual(writes[1], writes[0]);
});

for (const [block, message] of [
  ["private_call", "Accepting would file this private call note on a shared record."],
  ["open_step_exists", "The person assigned already has an open next step on this deal."],
] as const) {
  test(`call review explains ${block} and still lets the partner dismiss`, async (t) => {
    let state = "pending";
    const review = await openCallReview(t, async (request) => {
      if (request.method === "GET") return callOutcomes(state, state === "pending" ? block : null);
      assert.equal(new URL(request.url).pathname, callDecisionPath);
      assert.equal((await request.json()).decision, "dismiss");
      state = "dismissed";
      return Response.json({ proposal_id: callProposalId, status: state, created: {} });
    });
    await review.getByText(message, { exact: true }).waitFor();
    assert.equal(await review.getByRole("button", { name: "Accept", exact: true }).isEnabled(), false);
    await review.getByRole("button", { name: "Dismiss", exact: true }).click();
    await review.getByText("Dismissed", { exact: true }).waitFor();
  });
}

test("settled call proposals open as a completed review without a write", async (t) => {
  const methods: string[] = [];
  const review = await openCallReview(t, (request) => {
    methods.push(request.method);
    return callOutcomes("dismissed");
  });
  await review.getByText("Call review complete.", { exact: true }).waitFor();
  await review.getByText(callEvidence, { exact: true }).waitFor();
  assert.deepEqual(methods, ["GET"]);
});

test("Carr sign-in keeps its deal page and makes no engine call review request", async (t) => {
  const { server, context } = await app(t, { signIn: "carr" });
  const page = await context.newPage();
  const requests: string[] = [];
  page.on("request", (request) => {
    if (new URL(request.url()).pathname.endsWith("/call-outcomes")) requests.push(request.url());
  });
  await page.goto(server.origin + dealPage);
  await page.getByRole("region", { name: "Deal snapshot" }).waitFor();
  assert.equal(await page.getByText("Call review", { exact: true }).count(), 0);
  assert.deepEqual(requests, []);
});

const recorderSummary = "Private synthetic recorder summary.";
const recorderReceipt = {
  outcome: "stored",
  activity_id: activityId,
  about: [{ deal_id: dealId }],
};

async function routeRecorder(page: Page, status: () => object) {
  await page.route("http://127.0.0.1:4682/**", (route) => {
    const url = new URL(route.request().url());
    return route.fulfill({
      headers: { "access-control-allow-origin": "*", "access-control-allow-headers": "x-carr-call-mode" },
      json:
        url.pathname === "/api/state"
          ? { state: "filed", session: "demo-local-session", mode: "weekly_deal_call" }
          : status(),
    });
  });
}

async function openRecorder(page: Page) {
  await page.locator("#selfAvatar").click();
  await page.locator("#callModeRetry").click();
  await page.locator("#callModeButton").click();
  return page.locator("#callModeDialog");
}

test("the Call Mode report opens review for its captured activity on the selected deal", async (t) => {
  const { server, context } = await app(t, { callReview: () => callOutcomes("pending", null, true) });
  const page = await context.newPage();
  await routeRecorder(page, () => ({ status: "filed", report: { engine_call: recorderReceipt } }));
  await page.goto(server.origin + dealPage);
  await page.getByRole("region", { name: "Deal snapshot" }).waitFor();
  const dialog = await openRecorder(page);
  await dialog.getByText(callEvidence, { exact: true }).waitFor({ timeout: 5_000 });
  assert.equal(await dialog.getByText("Nov 10", { exact: true }).count(), 0);
});

test("the recorder hides the summary when the signed-in partner cannot see the activity", async (t) => {
  let visible = true;
  const { server, context } = await app(t, {
    callReview: (request) =>
      visible && request.headers.get("cookie") === cookieName + "=first"
        ? callOutcomes("pending")
        : Response.json({ deal_id: dealId, deal_name: dealName, calls: [] }),
  });
  const page = await context.newPage();
  const report = { report: { summary: recorderSummary }, engine_call: recorderReceipt };
  await routeRecorder(page, () => ({ status: "filed", report }));
  await page.goto(server.origin + dealPage);
  await page.getByRole("region", { name: "Deal snapshot" }).waitFor();
  const dialog = await openRecorder(page);
  await dialog.getByText(recorderSummary, { exact: true }).waitFor({ timeout: 5_000 });

  visible = false;
  await dialog.getByRole("button", { name: "Refresh", exact: true }).click();
  await dialog.getByText("No recorded calls found.", { exact: true }).waitFor({ timeout: 5_000 });
  assert.equal(await dialog.getByText(recorderSummary, { exact: true }).count(), 0);

  visible = true;
  await page.goto(server.origin + "/auth/callback/google?fixture=second&return_to=" + encodeURIComponent(dealPage));
  await page.getByRole("region", { name: "Deal snapshot" }).waitFor();
  const secondDialog = await openRecorder(page);
  await secondDialog.getByText("No recorded calls found.", { exact: true }).waitFor({ timeout: 5_000 });
  assert.equal(await secondDialog.getByText(recorderSummary, { exact: true }).count(), 0);
});

test("the recorder opens every filed deal from the Deals board", async (t) => {
  const secondPath = `/api/engine/deals/${candidateDeal.id}/call-outcomes`;
  const secondEvidence = "Please confirm the second demo location.";
  const reads: string[] = [];
  const { server, context } = await app(t, {
    callReview: async (request) => {
      const path = new URL(request.url).pathname;
      reads.push(path);
      const answer = await callOutcomes("pending").json();
      if (path === secondPath) {
        answer.deal_id = candidateDeal.id;
        answer.deal_name = candidateDeal.name;
        answer.calls[0].proposals[0].proposal_id = filingId;
        answer.calls[0].proposals[0].evidence = secondEvidence;
      }
      return Response.json(answer);
    },
  });
  const page = await context.newPage();
  const engine_call = { ...recorderReceipt, about: [...recorderReceipt.about, { deal_id: candidateDeal.id }] };
  await routeRecorder(page, () => ({ status: "filed", report: { engine_call } }));
  await page.goto(server.origin + "/deals?mode=live");
  await page.getByRole("heading", { name: dealName }).waitFor();
  const dialog = await openRecorder(page);
  await dialog.getByText(callEvidence, { exact: true }).waitFor({ timeout: 5_000 });
  await dialog.getByText(secondEvidence, { exact: true }).waitFor({ timeout: 5_000 });
  assert.deepEqual(reads.sort(), [callOutcomesPath, secondPath].sort());
});

test("the recorder waits for engine filing with either Deals save setting", async (t) => {
  for (const callSavesOn of [false, true]) {
    await t.test(callSavesOn ? "engine saves on" : "engine saves off", async (t) => {
      let statusReads = 0;
      const { server, context } = await app(t, { callReview: () => callOutcomes("pending") });
      const page = await context.newPage();
      if (callSavesOn)
        await page.route("**/deals?*", async (route) => {
          const response = await route.fetch();
          await route.fulfill({
            response,
            body: (await response.text()).replace("<html ", "<html data-deals-saves-from-engine "),
          });
        });
      await page.clock.install();
      await routeRecorder(page, () => ({
        status: { state: "ready_review" },
        report: ++statusReads > 1 ? { engine_call: recorderReceipt } : { report: { summary: recorderSummary } },
      }));
      await page.goto(server.origin + dealPage);
      await page.getByRole("region", { name: "Deal snapshot" }).waitFor();
      assert.equal(await page.locator("html[data-deals-saves-from-engine]").count(), Number(callSavesOn));
      const firstStatus = page.waitForResponse((response) => response.url().includes("/api/post-call?"));
      const dialog = await openRecorder(page);
      await firstStatus;
      await page.clock.runFor(61_000);
      await dialog.getByText(callEvidence, { exact: true }).waitFor({ timeout: 6_000 });
      assert.ok(statusReads > 1);
    });
  }
});

test("an uncertain call decision keeps its key after leaving and reopening the deal", async (t) => {
  const writes: unknown[] = [];
  let state = "pending";
  const { server, context } = await app(t, {
    callReview: async (request) => {
      if (request.method === "GET") return callOutcomes(state);
      writes.push(await request.json());
      if (writes.length === 1) return new Response(null, { status: 503 });
      state = "accepted";
      return Response.json({ proposal_id: callProposalId, status: state });
    },
  });
  const page = await context.newPage();
  await page.goto(server.origin + "/deals?mode=live");
  const openDeal = page.getByRole("heading", { name: dealName });
  const disclosure = page.getByText("Call review", { exact: true });
  const review = page.getByRole("region", { name: "Review recorded calls" });
  const accept = review.getByRole("button", { name: "Accept", exact: true });
  await openDeal.click();
  await disclosure.click();
  await accept.click();
  await review.getByRole("button", { name: "Check outcome", exact: true }).waitFor();
  await page.getByRole("button", { name: "Back to deals" }).click();
  await openDeal.click();
  await disclosure.click();
  await accept.click();
  await review.getByText("Accepted", { exact: true }).waitFor();
  assert.equal(writes.length, 2);
  assert.deepEqual(writes[1], writes[0]);
});

for (const signIn of ["engine", "carr"] as const) {
  test(`${signIn} sign-out preserves the original retired bookmark at login`, async (t) => {
    const { server, context } = await app(t, { signIn, switchDay: signIn === "carr" });
    const page = await context.newPage();
    await page.goto(server.origin + "/");
    const bookmark = "/work-requests?work_request=WR-000042";
    const home = await page.goto(server.origin + bookmark);
    assert.equal(home?.status(), 200);
    assert.equal(new URL(page.url()).pathname, "/");
    const redirect = await home?.request().redirectedFrom()?.response();
    await context.clearCookies();
    const [login] = await Promise.all([
      page.waitForRequest((request) => new URL(request.url()).pathname === "/auth/login"),
      page.goto(server.origin + bookmark),
    ]);
    assert.equal(new URL(login.url()).searchParams.get("return_to"), bookmark);
    assert.equal(await redirect?.headerValue("cache-control"), "no-store");
  });
}

for (const [signIn, width] of [
  ["engine", 390],
  ["engine", 1440],
  ["carr", 390],
  ["carr", 1440],
] as const) {
  test(`${signIn} sign-in opens retired bookmarks on Home and renders the kept business pages at ${width}px`, async (t) => {
    const { server, context } = await app(t, {
      width,
      signIn,
      switchDay: signIn === "carr",
      tourPlans: true,
      readAnniversaries: () =>
        Response.json(signIn === "engine" ? anniversaries.ready.output.rows : anniversaries.ready.output),
    });
    const page = await context.newPage();
    page.setDefaultTimeout(5000);
    await page.clock.install({ time: new Date("2026-11-21T16:00:00Z") });
    const errors: string[] = [];
    const missingAssets: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("response", (response) => {
      const url = new URL(response.url());
      const type = response.request().resourceType();
      if (
        url.origin === server.origin &&
        response.status() === 404 &&
        (["script", "stylesheet", "font", "image"].includes(type) || /\.(?:[cm]?js|css)$/.test(url.pathname))
      )
        missingAssets.push(url.pathname);
    });
    const paths = ["/work-requests?work_request=WR-000042", "/control-room/progress/board/example", "/doc-activity"];
    for (const path of paths) {
      assert.equal((await page.goto(server.origin + path))?.status(), 200);
      assert.equal(new URL(page.url()).pathname, "/");
    }
    const screens = [
      ["/", page.getByText(filingTitle, { exact: true })],
      ["/deals", page.getByRole("heading", { name: dealName, exact: true })],
      ["/leads", page.getByRole("button", { name: "Dr. Example 1", exact: true })],
      ["/vendors", page.getByRole("link", { name: /^Demo Partner 01\b/ })],
      ["/clients", page.getByRole("link", { name: /^Demo Practice 01\b/ })],
      ["/calendar?day=2026-11-24", page.locator("#dayPanelBody").getByText(dealName, { exact: false }).first()],
      ["/invoices", page.getByText(invoiceName, { exact: true }).first()],
      ["/doc-chats", page.getByRole(signIn === "engine" ? "link" : "heading", { name: chat.title, exact: true })],
      ["/leases", page.getByText("Synthetic Clinic", { exact: true })],
    ] as const;
    for (const [path, ready] of screens) {
      const url = new URL(path, server.origin);
      url.searchParams.set("mode", "live");
      assert.equal((await page.goto(url.href))?.status(), 200, path);
      if (path === "/doc-chats" && signIn === "engine" && width === 390)
        await page.getByRole("button", { name: "Recent chats", exact: true }).click();
      await ready.waitFor().catch(async (error) => {
        throw new Error(`${path} did not render its fixture. ${await page.locator("main").first().textContent()}`, {
          cause: error,
        });
      });
      assert.equal(await page.locator("#docPresence, a[href='/doc-activity'], a[href^='/ideas-events']").count(), 0);
      assert.deepEqual(errors, [], path);
      assert.deepEqual(missingAssets, [], path);
    }
    assert.equal((await page.goto(server.origin + dealPage))?.status(), 200);
    await page.getByRole("tab", { name: "Tours", exact: true }).click();
    const panel = page.getByRole("tabpanel", { name: "Tours", exact: true });
    await panel.getByText("November 24, 2026", { exact: true }).waitFor();
    assert.deepEqual(errors, [], "Tours");
    assert.deepEqual(missingAssets, [], "Tours");
  });
}
