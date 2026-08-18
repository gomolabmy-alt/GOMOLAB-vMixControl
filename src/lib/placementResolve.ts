import type { ScheduledMatch } from '../stores/matchScheduleStore';
import type { SavedMatchResult } from '../stores/matchResultsStore';
import type { SavedTeam } from '../stores/teamDbStore';
import type { TournamentSettings } from '../types/tournament';
import { isPlacementRoundLabel, placementRoundRange } from './scheduleGen';
import { computeStandings, findMatchWinner, extractKnockoutStage, isPoolStageResult } from '../components/TournamentManager';

export interface ResolvedPlacementTeam {
  id?: string;
  name: string;
  shortName?: string;
  color: string;
  logo?: string;
}

const oppositeSide = (s: 'A' | 'B'): 'A' | 'B' => (s === 'A' ? 'B' : 'A');

function sideOf(m: ScheduledMatch, side: 'A' | 'B'): ResolvedPlacementTeam {
  return side === 'A'
    ? { id: m.teamAId, name: m.teamAName, shortName: m.teamAShortName, color: m.teamAColor, logo: m.teamALogo }
    : { id: m.teamBId, name: m.teamBName, shortName: m.teamBShortName, color: m.teamBColor, logo: m.teamBLogo };
}

/** Resolves which team finished in a given overall placement (1st, 2nd,
 *  3rd…) for one tournament/category, for the Placement Lower Third widget
 *  to auto-fill once that place is actually decided — never guesses from an
 *  in-progress fixture, returns null instead. `scopedMatches`/
 *  `scopedResults`/`scopedTeams` must already be filtered to the one
 *  tournament (+ category, if applicable) this placement belongs to.
 *
 *  Tries, in order:
 *  1. Ranks 1-2 — the Cup's own Final (works whichever wording it's using:
 *     the named-tier format's plain "Final", or the ranked-placement
 *     format's relabeled "Gold Final" — both keep stage/group "Final"
 *     untouched, see buildRankedPlacementKnockout in scheduleGen.ts).
 *  2. Ranks 3-4 — the Cup's 3rd Place Playoff (group === '3rd Place', same
 *     "Bronze Final" relabeling note as above).
 *  3. Any rank — a placement-ladder tier's own 2-wide FINAL range fixture
 *     (e.g. "9th-10th Placing" decides rank 9 via its winner, rank 10 via
 *     its loser) — see buildPlacementLadder in scheduleGen.ts.
 *  4. Fallback — plain standings across every team in scope, for a
 *     round-robin-only tournament with no bracket at all (best-effort if a
 *     bracket exists but simply doesn't cover this particular rank). */
export function resolvePlacementTeam(
  rank: number,
  scopedMatches: ScheduledMatch[],
  scopedResults: SavedMatchResult[],
  scopedTeams: SavedTeam[],
  tournamentId: string,
  settings: TournamentSettings,
): ResolvedPlacementTeam | null {
  if (rank === 1 || rank === 2) {
    const final = scopedMatches.find(m => extractKnockoutStage(m) === 'Final' && (!m.tier || m.tier === 'Cup'));
    if (final) {
      const win = findMatchWinner(final, scopedResults, tournamentId);
      if (win) return sideOf(final, rank === 1 ? win.side : oppositeSide(win.side));
    }
  }

  if (rank === 3 || rank === 4) {
    const bronze = scopedMatches.find(m => m.group === '3rd Place' && (!m.tier || m.tier === 'Cup'));
    if (bronze) {
      const win = findMatchWinner(bronze, scopedResults, tournamentId);
      if (win) return sideOf(bronze, rank === 3 ? win.side : oppositeSide(win.side));
    }
  }

  const ladderFinal = scopedMatches.find(m => {
    if (!m.tier || !isPlacementRoundLabel(m.tier)) return false;
    const range = placementRoundRange(m.round ?? '');
    return !!range && range.hi - range.lo === 1 && rank >= range.lo && rank <= range.hi;
  });
  if (ladderFinal) {
    const win = findMatchWinner(ladderFinal, scopedResults, tournamentId);
    if (win) {
      const range = placementRoundRange(ladderFinal.round ?? '')!;
      return sideOf(ladderFinal, rank === range.lo ? win.side : oppositeSide(win.side));
    }
  }

  const standing = computeStandings(scopedTeams, scopedResults.filter(isPoolStageResult), settings)[rank - 1];
  if (standing) {
    return { id: standing.teamId, name: standing.name, shortName: standing.shortName, color: standing.color, logo: standing.logo };
  }

  return null;
}
