export const MAINTENANCE_MAX = 300;

/** Plain-text banner copy: collapse whitespace, cap at 300 chars (ellipsis), empty -> null. */
export function formatMaintenance(raw: string | null | undefined): string | null {
  const t = (raw ?? '').replace(/\s+/g, ' ').trim();
  if (!t) return null;
  return t.length > MAINTENANCE_MAX ? `${t.slice(0, MAINTENANCE_MAX - 1).trimEnd()}…` : t;
}
