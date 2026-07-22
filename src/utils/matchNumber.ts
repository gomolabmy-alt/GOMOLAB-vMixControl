import type { ScheduledMatch } from '../stores/matchScheduleStore';

/**
 * Auto match number for a fixture, e.g. "MB1" / "MC1" — a base prefix (e.g.
 * "M") plus a per-venue letter code, plus a sequence number that counts up
 * independently PER VENUE (restarting the count for each venue code, not
 * shared across them) — so two venues running in parallel number their own
 * matches "which match at this venue" and rise together in step:
 * "MB1, MC1, MB2, MC2, MB3, MC3...".
 *
 * `matchesInOrder` must already be in the schedule's running order (the
 * matchScheduleStore keeps `matches` sorted this way at all times) — that
 * order is what determines each venue's own 1st/2nd/3rd... match. Returns
 * an empty map when `prefix` is unset — the feature is opt-in per tournament.
 */
export function computeMatchNumbers(
  matchesInOrder: ScheduledMatch[],
  prefix: string | undefined,
  venuePrefixes: Record<string, string> | undefined,
): Map<string, string> {
  const map = new Map<string, string>();
  if (!prefix) return map;
  const perVenueCount = new Map<string, number>();
  for (const m of matchesInOrder) {
    const venueCode = (m.venue && venuePrefixes?.[m.venue]) || '';
    const next = (perVenueCount.get(venueCode) ?? 0) + 1;
    perVenueCount.set(venueCode, next);
    map.set(m.id, `${prefix}${venueCode}${next}`);
  }
  return map;
}
