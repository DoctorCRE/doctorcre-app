export type NameMatchFacts = {
  city?: string | null;
  deal_count?: number;
  is_national_account?: boolean;
};

export function nameMatchDetails({ city, deal_count }: NameMatchFacts): string {
  const cityLabel = city === null || typeof city === "string" ? city?.trim() || "No city recorded" : undefined;
  const deals =
    typeof deal_count === "number" && Number.isSafeInteger(deal_count) && deal_count >= 0
      ? `${deal_count} ${deal_count === 1 ? "deal" : "deals"}`
      : undefined;
  return [cityLabel, deals].filter(Boolean).join(" · ");
}
