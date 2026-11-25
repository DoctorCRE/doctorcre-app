export function validNetwork(value: unknown): boolean;
type Network = {
  nodes: { name: string; kind: string; ref?: string }[];
  edges: { summary?: string | null; detail?: string | null }[];
  suggestions: { reason: string; detail?: string | null }[];
};
export function readableNetwork<T extends Network>(
  network: T,
): Omit<T, "nodes"> & { nodes: (T["nodes"][number] & { unnamed?: true })[] };
