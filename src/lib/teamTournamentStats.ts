import type { SavedMatchResult } from '../stores/matchResultsStore';

export interface TeamTournamentStats {
  played: number;
  totalPoints: number;
  breakdown: Record<string, number>; // scoreLog action label -> count
  cards: { yellow: number; orange: number; red: number };
}

const norm = (s?: string) => (s ?? '').trim().toLowerCase();

/**
 * A team's own cumulative stats across every one of its matches in a given
 * tournament (regardless of opponent) — the "season form" comparison shown
 * next to the head-to-head record, not the head-to-head itself.
 */
export function computeTeamTournamentStats(
  results: SavedMatchResult[],
  team: { name: string; shortName?: string },
  tournamentId: string | undefined,
  /** Schedule fixture ids that are NOT yet marked completed — a saved result
   *  can exist for one of these (e.g. an in-progress "Save Result" click, or
   *  the auto-save that runs before a board gets overwritten) without the
   *  match actually being over, so it shouldn't count as "played" yet. */
  incompleteScheduleIds?: Set<string>,
): TeamTournamentStats {
  const stats: TeamTournamentStats = {
    played: 0, totalPoints: 0, breakdown: {}, cards: { yellow: 0, orange: 0, red: 0 },
  };
  const nameKey = norm(team.name);
  const shortKey = norm(team.shortName);
  if (!nameKey) return stats;

  for (const r of results) {
    if (r.matchType === 'bye') continue; // nothing was actually played
    if (r.sourceScheduleId && incompleteScheduleIds?.has(r.sourceScheduleId)) continue; // match is still running
    if (tournamentId && r.tournamentId && r.tournamentId !== tournamentId) continue;
    const aMatch = norm(r.teamAName) === nameKey || (!!shortKey && norm(r.teamAShortName) === shortKey);
    const bMatch = norm(r.teamBName) === nameKey || (!!shortKey && norm(r.teamBShortName) === shortKey);
    if (!aMatch && !bMatch) continue;
    const side: 'A' | 'B' = aMatch ? 'A' : 'B';

    stats.played++;
    stats.totalPoints += side === 'A' ? r.scoreA : r.scoreB;

    for (const e of r.scoreLog ?? []) {
      if (e.team !== side) continue;
      stats.breakdown[e.action] = (stats.breakdown[e.action] ?? 0) + 1;
    }
    for (const c of r.cards ?? []) {
      if (c.team !== side) continue;
      stats.cards[c.type]++;
    }
  }
  return stats;
}
