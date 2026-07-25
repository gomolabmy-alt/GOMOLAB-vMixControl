import type { SavedMatchResult } from '../stores/matchResultsStore';

export interface HeadToHeadStats {
  /** Newest first. */
  meetings: SavedMatchResult[];
  aWins: number;
  bWins: number;
  draws: number;
  aTotalScore: number;
  bTotalScore: number;
  /** Score-event action label (e.g. "Try", "Conversion") → count, tallied
   *  across every meeting that has a captured scoreLog. Generic across
   *  sports — just whatever action strings were actually used. */
  aBreakdown: Record<string, number>;
  bBreakdown: Record<string, number>;
}

const norm = (s?: string) => (s ?? '').trim().toLowerCase();

/** Whether a result's side matches the given team identity — id match
 *  preferred when both the team and that side have one (unambiguous even
 *  across categories that reuse a team name); otherwise falls back to
 *  category + name/shortName (same case-insensitive convention used for
 *  team disambiguation elsewhere in this app, see TeamMatchHistoryButton) —
 *  checked per-side so a legacy result with no id on this particular side
 *  still gets the category guard, even when the team we're comparing
 *  against does have an id (from a DIFFERENT, id-carrying result). */
function sideIs(id: string | undefined, n: string | undefined, s: string | undefined, resultCategory: string | undefined, team: { id?: string; name: string; shortName?: string; category?: string }): boolean {
  if (team.id && id) return id === team.id;
  if (norm(resultCategory) !== norm(team.category)) return false;
  const nameKey = norm(team.name);
  const shortKey = norm(team.shortName);
  if (!nameKey || !n) return false;
  return norm(n) === nameKey || (!!shortKey && norm(s) === shortKey);
}

/**
 * All-time head-to-head record between two teams, pulled from every saved
 * result in the database (no TOURNAMENT scoping — "head to head" means the
 * all-time record, the standard broadcast meaning, so a rematch in next
 * year's tournament still counts). Still scoped by CATEGORY when given
 * (id match, when available, makes this redundant but harmless) — some team
 * names are reused across categories in the same tournament (e.g. a state's
 * Boys and Girls squads both named "PERAK"), and those are different teams
 * entirely, not a rivalry history to combine.
 */
export function computeHeadToHead(
  results: SavedMatchResult[],
  teamA: { id?: string; name: string; shortName?: string; category?: string },
  teamB: { id?: string; name: string; shortName?: string; category?: string },
  /** Schedule fixture ids not yet marked completed — a result can exist for
   *  one (an in-progress save, or the auto-save before a board is
   *  overwritten) without the match actually being over, so it isn't a
   *  finished "meeting" yet. */
  incompleteScheduleIds?: Set<string>,
): HeadToHeadStats {
  const stats: HeadToHeadStats = {
    meetings: [], aWins: 0, bWins: 0, draws: 0, aTotalScore: 0, bTotalScore: 0,
    aBreakdown: {}, bBreakdown: {},
  };
  if (!teamA.name || !teamB.name) return stats;

  const tally = (breakdown: Record<string, number>, log?: SavedMatchResult['scoreLog']) => {
    for (const e of log ?? []) breakdown[e.action] = (breakdown[e.action] ?? 0) + 1;
  };

  for (const r of results) {
    if (r.matchType === 'bye') continue; // nothing was actually played
    if (r.sourceScheduleId && incompleteScheduleIds?.has(r.sourceScheduleId)) continue; // match is still running
    const straight = sideIs(r.teamAId, r.teamAName, r.teamAShortName, r.category, teamA) && sideIs(r.teamBId, r.teamBName, r.teamBShortName, r.category, teamB);
    const swapped = sideIs(r.teamAId, r.teamAName, r.teamAShortName, r.category, teamB) && sideIs(r.teamBId, r.teamBName, r.teamBShortName, r.category, teamA);
    if (!straight && !swapped) continue;

    stats.meetings.push(r);
    const aScore = straight ? r.scoreA : r.scoreB;
    const bScore = straight ? r.scoreB : r.scoreA;
    stats.aTotalScore += aScore;
    stats.bTotalScore += bScore;
    if (aScore > bScore) stats.aWins++;
    else if (bScore > aScore) stats.bWins++;
    else if (r.shootout) {
      const aWonShootout = straight ? r.shootout.winner === 'A' : r.shootout.winner === 'B';
      if (aWonShootout) stats.aWins++; else stats.bWins++;
    } else stats.draws++;

    for (const e of r.scoreLog ?? []) {
      const isASide = straight ? e.team === 'A' : e.team === 'B';
      tally(isASide ? stats.aBreakdown : stats.bBreakdown, [e]);
    }
  }

  stats.meetings.sort((a, b) => b.savedAt - a.savedAt);
  return stats;
}
