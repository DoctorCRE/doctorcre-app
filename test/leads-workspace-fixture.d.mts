export function workspace(): { leads: { id: string }[]; detail?: unknown };
export function detail(lead: { id: string } | undefined): Record<string, unknown>;

export function id(n: number): string;
export function lead(n: number, fields?: Record<string, unknown>): { id: string };
export function emptyQuietFollowUps(): unknown;
