/** Start of the current calendar month in Asia/Riyadh (UTC+3, no DST), as a UTC instant. */
export function riyadhMonthStart(now = new Date()) {
  const riyadh = new Date(now.getTime() + 3 * 3_600_000);
  return new Date(Date.UTC(riyadh.getUTCFullYear(), riyadh.getUTCMonth(), 1) - 3 * 3_600_000);
}

export function formatDateTime(date: Date) {
  return new Intl.DateTimeFormat("ar-SA-u-nu-latn-ca-gregory", { timeZone: "Asia/Riyadh", dateStyle: "medium", timeStyle: "short" }).format(date);
}

export function formatNumber(value: number) {
  return new Intl.NumberFormat("en-US").format(value);
}

/** A URL-safe slug from a Latin name; Arabic-only names fall back to a short random one. */
export function slugify(name: string) {
  const base = name
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "")
    .slice(0, 40);
  return base || `client-${Math.random().toString(36).slice(2, 8)}`;
}
