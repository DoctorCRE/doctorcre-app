// A vendor's relationship as the engine stores it, and the save one choice on the card makes.

type Ruling = "parked" | "avoid";
type Level = 0 | 1 | 2 | 3;
export type VendorRole = {
  relationship_level: Level | null;
  disposition: Ruling | null;
  disposition_reason: string | null;
  is_target: boolean;
};
export type RelationshipChoice = { level: Level | null } | { ruling: Ruling; reason: string } | { wantToMeet: boolean };
type Change = { from: unknown; to: unknown };

const FIELDS = ["relationship_level", "disposition", "disposition_reason", "is_target"] as const;
const isLevel = (value: unknown): value is Level => value === 0 || value === 1 || value === 2 || value === 3;
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The vendor role a party read answers, or null when it holds none. */
export function vendorRole(party: unknown): VendorRole | null {
  const role = isRecord(party) ? party.vendor : null;
  if (!isRecord(role)) return null;
  const { relationship_level: level, disposition, disposition_reason: reason } = role;
  return {
    relationship_level: isLevel(level) ? level : null,
    disposition: disposition === "parked" || disposition === "avoid" ? disposition : null,
    disposition_reason: typeof reason === "string" ? reason : null,
    is_target: role.is_target === true,
  };
}

/** The fields one choice changes, each naming the value the partner saw. Choosing a level lifts a ruling. */
export function relationshipChange(role: VendorRole, choice: RelationshipChoice): Record<string, Change> {
  const to: Partial<VendorRole> =
    "level" in choice
      ? { relationship_level: choice.level, disposition: null, disposition_reason: null }
      : "ruling" in choice
        ? { disposition: choice.ruling, disposition_reason: choice.reason.trim() }
        : { is_target: choice.wantToMeet };
  const changes: Record<string, Change> = {};
  for (const field of FIELDS)
    if (field in to && to[field] !== role[field]) changes[field] = { from: role[field], to: to[field] };
  return changes;
}
