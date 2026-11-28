type Category = { slug: string; label: string };

type Market = { id: string; name: string };

type Vendor = {
  id: string;
  name: string;
  owner_label: "Joe" | "Dell";
  owned_by_viewer: boolean;
  recorded_category_label: string | null;
  categories: Category[];
  recorded_disposition: "active" | "parked" | "avoid";
  relationship_level: number | null;
  relationship: { last_contacted_at: string | null };
  territory: string | null;
  markets: Market[];
  city: string;
  state: string;
  is_target: boolean;
  quiet: boolean;
  quiet_days: number | null;
};

export type VendorRoster = { rows: Vendor[]; categories: Category[]; markets: Market[] };

export function vendorRoster(options?: {
  uncategorized?: boolean;
  banking?: string;
  markets?: boolean;
  noQuietContact?: boolean;
}): VendorRoster;

export function directoryFixture(
  url: string,
  options?: { roster: VendorRoster; now?: number },
): Record<string, unknown>;

export declare const PAGE_SIZE: number;
