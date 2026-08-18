import { useMatchScheduleStore } from '../stores/matchScheduleStore';
import { useMatchResultsStore } from '../stores/matchResultsStore';

/** One-time-per-launch backfill: fills in group/tier on every existing
 *  result that doesn't have them yet, by joining back to the ScheduledMatch
 *  it came from (sourceScheduleId) — the exact fixture is the only reliable
 *  source for this, so unlike backfillTeamIds there's no name-matching
 *  fallback for results with no live linked fixture (avoids mistagging;
 *  isPoolStageResult's round-text fallback in TournamentManager.tsx handles
 *  most of those cases anyway). Only ever fills in currently-unset values —
 *  never overwrites — so it's safe to call on every launch and a cheap
 *  no-op once everything resolvable has been. Returns how many rows were
 *  updated, for a console log. */
export function backfillResultStageData(): number {
  const { matches } = useMatchScheduleStore.getState();
  const { results, updateResult } = useMatchResultsStore.getState();
  let count = 0;
  for (const r of results) {
    if (r.group !== undefined || r.tier !== undefined) continue;
    if (!r.sourceScheduleId) continue;
    const src = matches.find(m => m.id === r.sourceScheduleId);
    if (!src) continue;
    const patch: { group?: string; tier?: string } = {};
    if (src.group !== undefined) patch.group = src.group;
    if (src.tier !== undefined) patch.tier = src.tier;
    if (Object.keys(patch).length > 0) {
      updateResult(r.id, patch);
      count++;
    }
  }
  return count;
}
