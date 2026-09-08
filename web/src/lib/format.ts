export const money = (n: number): string =>
  n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });

export const shortDate = (iso: string): string =>
  new Date(iso).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "America/Chicago",
  });

export const longDate = (iso: string): string =>
  new Date(iso).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "America/Chicago",
  });

export const bedsLabel = (beds: number): string => (beds === 0 ? "Studio" : `${beds} BR`);

export const daysSince = (iso: string): number =>
  Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 86400e3));

export const hoursSince = (iso: string): number =>
  Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 3600e3));

/** Compact age for scrape status, e.g. "3h ago" / "2d ago". */
export const ageLabel = (iso: string): string => {
  const hours = hoursSince(iso);
  if (hours < 1) return "just now";
  if (hours < 48) return `${hours}h ago`;
  return `${daysSince(iso)}d ago`;
};
