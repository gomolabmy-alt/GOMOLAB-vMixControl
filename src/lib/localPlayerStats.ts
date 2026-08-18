import type { SavedTeam } from '../stores/teamDbStore';
import type { SavedMatchResult } from '../stores/matchResultsStore';
import type { Player } from '../types/tournament';

const norm = (s?: string) => (s ?? '').trim().toLowerCase();

type LocalStatKey = 'tries' | 'conversions' | 'penalties' | 'dropGoals';

// Action labels are free text (the scoreboard's own increment button
// labels, see RUGBY_UNION_INCS/RUGBY_LEAGUE_INCS in WidgetConfigPanel.tsx) —
// matched loosely so "Try"/"TRY"/"Penalty Try" etc. all classify sensibly.
// "try" is checked before "pen" so a Penalty Try (worth a try, not a kick)
// still lands on tries rather than penalties.
function classifyAction(action: string): LocalStatKey | null {
  const a = action.toLowerCase();
  if (a.includes('try')) return 'tries';
  if (a.includes('conv')) return 'conversions';
  if (a.includes('drop')) return 'dropGoals';
  if (a.includes('pen')) return 'penalties';
  return null;
}

function teamSideInResult(result: SavedMatchResult, team: SavedTeam): 'A' | 'B' | null {
  if (team.tournamentId && result.tournamentId && result.tournamentId !== team.tournamentId) return null;
  const name = norm(team.name);
  const short = norm(team.shortName);
  if (name && norm(result.teamAName) === name) return 'A';
  if (short && norm(result.teamAShortName) === short) return 'A';
  if (name && norm(result.teamBName) === name) return 'B';
  if (short && norm(result.teamBShortName) === short) return 'B';
  return null;
}

/**
 * Recomputes tries/conversions/penalties/dropGoals for every player on
 * `team` from that team's own saved match history — a full recompute every
 * time (not an incremental counter), so it's always safe to re-run and can
 * never double-count. Only scoreLog entries with a `scorer` attributed via
 * the Scoreboard's quick-scorer picker are counted; skipped/anonymous score
 * events aren't attributable to any one player and are silently excluded.
 * Yellow/red cards and appearances aren't computed here — the app doesn't
 * yet persist per-player card/lineup data into a saved match result.
 */
export function computeLocalStatsForTeam(
  team: SavedTeam, results: SavedMatchResult[],
): Map<string, Record<LocalStatKey, number>> {
  const totals = new Map<string, Record<LocalStatKey, number>>();
  for (const p of team.players) totals.set(p.id, { tries: 0, conversions: 0, penalties: 0, dropGoals: 0 });

  for (const result of results) {
    const side = teamSideInResult(result, team);
    if (!side || !result.scoreLog) continue;
    for (const entry of result.scoreLog) {
      if (entry.team !== side || !entry.scorer) continue;
      const key = classifyAction(entry.action);
      if (!key) continue;
      const player = team.players.find(p =>
        norm(p.name) === norm(entry.scorer) || (!!entry.jerseyNo && !!p.jerseyNo && p.jerseyNo === entry.jerseyNo)
      );
      if (!player) continue;
      totals.get(player.id)![key]++;
    }
  }
  return totals;
}

export interface PlayerMatchHistoryEntry {
  resultId: string;
  date: string;
  opponent: string;
  round?: string;
  competition?: string;
  actions: { action: string; points: number; period?: number }[];
  totalPoints: number;
}

/**
 * Every saved match a player actually scored in, newest first — one row per
 * match with that match's own breakdown of what they scored (not a running
 * total). Same scorer-name/jersey matching as computeLocalStatsForTeam, and
 * the same limitation: only scoreLog entries with a scorer attributed via
 * the Scoreboard's quick-scorer picker show up here at all.
 */
export function getPlayerMatchHistory(player: Player, team: SavedTeam, results: SavedMatchResult[]): PlayerMatchHistoryEntry[] {
  const history: PlayerMatchHistoryEntry[] = [];
  for (const result of results) {
    const side = teamSideInResult(result, team);
    if (!side || !result.scoreLog) continue;
    const mine = result.scoreLog.filter(e =>
      e.team === side && !!e.scorer &&
      (norm(e.scorer) === norm(player.name) || (!!e.jerseyNo && !!player.jerseyNo && e.jerseyNo === player.jerseyNo))
    );
    if (mine.length === 0) continue;
    history.push({
      resultId: result.id,
      date: result.date,
      opponent: side === 'A' ? (result.teamBShortName || result.teamBName) : (result.teamAShortName || result.teamAName),
      round: result.round,
      competition: result.competition,
      actions: mine.map(e => ({ action: e.action, points: e.points, period: e.period })),
      totalPoints: mine.reduce((sum, e) => sum + e.points, 0),
    });
  }
  return history.sort((a, b) => b.date.localeCompare(a.date));
}

/** "2× Try, 1× Conversion" — collapses repeated identical action labels
 *  into one count instead of listing every single one, for a compact
 *  one-line-per-match summary. */
export function summarizeActions(actions: { action: string; points: number }[]): string {
  const counts = new Map<string, number>();
  for (const a of actions) counts.set(a.action, (counts.get(a.action) ?? 0) + 1);
  return Array.from(counts.entries()).map(([action, n]) => `${n}× ${action}`).join(', ');
}
