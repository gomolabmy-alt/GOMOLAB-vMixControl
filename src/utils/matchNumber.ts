import { useMemo } from 'react';
import { useMatchScheduleStore, type ScheduledMatch } from '../stores/matchScheduleStore';
import { useTournamentStore } from '../stores/tournamentStore';

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

/**
 * Fixture id -> match number (e.g. "MB1"), computed the same way cloudSync.ts
 * does for the push payload (per tournament, using that tournament's own
 * prefix/venue letters, over its FULL schedule so the sequence matches what
 * the public scoring page shows) — reused by the Schedule and Results
 * widgets so an operator sees the exact same match id locally that shows up
 * on the website once pushed, without waiting for a round-trip through the
 * cloud.
 */
export function useMatchNumbers(): Map<string, string> {
  const matches = useMatchScheduleStore(s => s.matches);
  const tournaments = useTournamentStore(s => s.tournaments);
  return useMemo(() => {
    const map = new Map<string, string>();
    const byTournament = new Map<string, ScheduledMatch[]>();
    for (const m of matches) {
      if (!m.tournamentId) continue;
      const arr = byTournament.get(m.tournamentId) ?? [];
      arr.push(m);
      byTournament.set(m.tournamentId, arr);
    }
    for (const [tid, tMatches] of byTournament) {
      const t = tournaments.find(x => x.id === tid);
      for (const [id, code] of computeMatchNumbers(tMatches, t?.matchNumberPrefix, t?.venuePrefixes)) map.set(id, code);
    }
    return map;
  }, [matches, tournaments]);
}
