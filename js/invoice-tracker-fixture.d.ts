export type InvoiceEntry = {
  status: string | null;
  received_on: string | null;
  commission_invoiced_on: string | null;
  commission_id: string | null;
  base_version: number | null;
  [key: string]: unknown;
};
export type InvoiceSnapshot = { entries: InvoiceEntry[]; [key: string]: unknown };
export declare function invoiceTrackerFixture(today: string): InvoiceSnapshot;

type InvoicePayment = {
  commission_id: string;
  base_version: number | null;
  received_on: string;
  idempotency_key: string;
};
export declare function createInvoiceFixture(options?: {
  actor?: string;
  entries?: InvoiceEntry[];
  today?: () => string;
}): {
  getInvoiceTracker(): Promise<InvoiceSnapshot>;
  markInvoicePaid(args: InvoicePayment): Promise<{ ok: true; id: string; base_version: number; received_on: string }>;
};
