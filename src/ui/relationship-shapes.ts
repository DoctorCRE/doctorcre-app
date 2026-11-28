// Each relationship's mark, drawn in a 12-unit box in the relationship's color.
export const RELATIONSHIP_SHAPES = {
  core: '<circle cx="6" cy="6" r="5.2" fill="none" stroke="currentColor" stroke-width="1.4"/><circle cx="6" cy="6" r="2.6" fill="currentColor"/>',
  established: '<circle cx="6" cy="6" r="5.4" fill="currentColor"/>',
  building:
    '<circle cx="6" cy="6" r="4.7" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M6 1.3a4.7 4.7 0 000 9.4z" fill="currentColor"/>',
  prospective: '<circle cx="6" cy="6" r="4.7" fill="none" stroke="currentColor" stroke-width="1.4"/>',
  not_rated:
    '<circle cx="6" cy="6" r="4.7" fill="none" stroke="currentColor" stroke-width="1.4" stroke-dasharray="2.2 2.2"/>',
  parked:
    '<rect x="2.4" y="1.8" width="2.6" height="8.4" rx=".8" fill="currentColor"/><rect x="7" y="1.8" width="2.6" height="8.4" rx=".8" fill="currentColor"/>',
  avoid:
    '<circle cx="6" cy="6" r="4.7" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M2.7 9.3l6.6-6.6" stroke="currentColor" stroke-width="1.4"/>',
} as const satisfies Record<string, string>;
export type RelationshipKey = keyof typeof RELATIONSHIP_SHAPES;
