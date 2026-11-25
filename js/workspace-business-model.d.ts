export function validRecordPayload(
  payload: unknown,
  dataset: "clients" | "vendors",
  id?: string | null,
  options?: { people?: boolean },
): boolean;
export function recordSections(
  dataset: "clients" | "vendors",
  record: Record<string, unknown> | null,
): {
  title: string;
  fields: { key: string; label: string; text: string; known: boolean; resolved: boolean; code: string | null }[];
}[];
