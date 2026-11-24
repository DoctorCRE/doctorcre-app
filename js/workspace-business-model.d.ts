export function validRecordPayload(
  payload: unknown,
  dataset: "clients" | "vendors",
  id?: string | null,
  options?: { people?: boolean },
): boolean;
