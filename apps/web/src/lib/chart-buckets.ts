import type { DashboardBucket } from "@ufv/shared/dashboard";

const localDay = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Kyiv", year: "numeric", month: "2-digit", day: "2-digit" });

/** Combine hour bins for display; proof links retain the exact rolling window. */
export function dailyBuckets(hours: DashboardBucket[], start: string, end: string): DashboardBucket[] {
  const days = new Map<string, DashboardBucket>();
  for (const hour of hours) {
    const day = localDay.format(new Date(hour.at));
    let bucket = days.get(day);
    if (!bucket) {
      const href = new URL(hour.href, "https://chart.invalid");
      href.searchParams.set("from", start);
      href.searchParams.set("until", end);
      href.searchParams.set("day", day);
      bucket = { at: day, count: 0, topics: {}, href: href.pathname + href.search };
      days.set(day, bucket);
    }
    bucket.count += hour.count;
    for (const [topic, count] of Object.entries(hour.topics)) bucket.topics[topic] = (bucket.topics[topic] ?? 0) + count;
  }
  return [...days.values()].sort((a, b) => a.at.localeCompare(b.at));
}
