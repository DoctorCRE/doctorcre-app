import assert from "node:assert/strict";
import test from "node:test";
import { HOW_FOUND } from "../src/ui/party-editor.ts";

// The engine's how_found list (schema/copy-leads-clients.sql in doctorcre-engine), less Not recorded.
test("How found offers the engine's list, name by name", () => {
  assert.deepEqual(HOW_FOUND, [
    ["referral", "Referral"],
    ["vendor", "Vendor"],
    ["marketing_post", "Marketing post"],
    ["public_records", "Public records"],
    ["cold_outreach", "Cold outreach"],
    ["own_research", "Own research"],
    ["inbound", "Inbound"],
    ["national_account", "National account or corporate lead"],
    ["existing_relationship", "Existing relationship"],
    ["event", "Event"],
  ]);
});
