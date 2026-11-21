import type { InvoiceSnapshot } from "./invoice-tracker-fixture.js";
export declare function validInvoiceTracker(payload: unknown): boolean;
export declare function projectInvoices(
  payload: InvoiceSnapshot,
  options: { today: string; receipts?: ReadonlyMap<string, { base_version: number; received_on: string }> },
): { status: string; age: number | null; overdue: boolean; canMarkPaid: boolean; key: string }[] | null;
