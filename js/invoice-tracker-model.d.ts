import type { InvoiceSnapshot } from "./invoice-tracker-fixture.js";
export declare function isInvoiceBaseVersion(value: unknown): value is number | null;
export declare function validInvoiceTracker(payload: unknown): boolean;
export declare function projectInvoices(
  payload: InvoiceSnapshot,
  options: { today: string },
): { status: string; age: number | null; overdue: boolean; canMarkPaid: boolean; key: string }[] | null;
