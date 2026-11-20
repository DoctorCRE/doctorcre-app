const day = new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeZone: "UTC" });
const formatDay = (date: string) => day.format(new Date(date));

export function dealCutover(document: Document) {
  const value = document.documentElement.getAttribute("data-deals-saves-from-engine");
  if (value === null) return null;
  const date =
    /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString().slice(0, 10) === value
      ? value
      : null;
  return { date, label: date ? formatDay(date) : null };
}
