import type { SavedMatchResult } from '../stores/matchResultsStore';
import type { ScheduledMatch } from '../stores/matchScheduleStore';
import type { SavedTeam } from '../stores/teamDbStore';

const norm = (s?: string) => (s ?? '').trim().toLowerCase();

/** Strips a "Category · " prefix some round strings carry (legacy data, category
 *  folded into the round field before it had its own column), leaving just the
 *  stage — e.g. "Men · Quarterfinal 2" -> "Quarterfinal 2". */
export function stageLabel(round?: string): string {
  if (!round) return '';
  const idx = round.indexOf(' · ');
  return idx >= 0 ? round.slice(idx + 3) : round;
}

/** A scoreboard only ever carries a team's NAME (teamAName/teamBName), never
 *  its id — resolving the actual SavedTeam record (for its roster, used by
 *  the Player H2H / Player Stats widgets) means matching by name, scoped by
 *  category so two same-named teams in different categories (e.g. a club
 *  fielding both a Boys and a Girls side) are never crossed. */
export function findTeamRecord(
  teams: SavedTeam[], name: string, category: string | undefined, tournamentId: string | undefined,
): SavedTeam | undefined {
  const candidates = teams.filter(t => norm(t.name) === norm(name) && (!tournamentId || t.tournamentId === tournamentId));
  if (candidates.length <= 1) return candidates[0];
  return candidates.find(t => norm(t.category) === norm(category)) ?? candidates[0];
}

function isThisTeam(
  team: { name: string; shortName?: string }, category: string | undefined, tournamentId: string | undefined,
  n?: string, s?: string, recCategory?: string, recRound?: string, recTournamentId?: string,
): boolean {
  const nameKey = norm(team.name);
  const shortKey = norm(team.shortName);
  if (!nameKey || !n) return false;
  const nameOk = norm(n) === nameKey || (!!shortKey && norm(s) === shortKey);
  if (!nameOk) return false;
  if (tournamentId && recTournamentId && recTournamentId !== tournamentId) return false;
  if (!category) return true;
  const effectiveCat = recCategory ?? (recRound?.includes(' · ') ? recRound.split(' · ')[0] : undefined);
  return !effectiveCat || effectiveCat === category;
}

export interface ResultFormRow {
  stage: string;
  a?: { r: SavedMatchResult; side: 'A' | 'B' };
  b?: { r: SavedMatchResult; side: 'A' | 'B' };
}
export interface UpcomingFormRow {
  stage: string;
  a?: { m: ScheduledMatch; side: 'A' | 'B' };
  b?: { m: ScheduledMatch; side: 'A' | 'B' };
}

/**
 * Merges both teams' own results into one row per stage/round — e.g. "Round
 * 1" shows what each team did that round, side by side (blank when a team
 * has no match recorded for that stage), rather than two independently
 * chronological lists.
 */
export function mergeResultRows(
  results: SavedMatchResult[],
  teamA: { name: string; shortName?: string },
  teamB: { name: string; shortName?: string },
  category: string | undefined,
  tournamentId: string | undefined,
): ResultFormRow[] {
  const rows = new Map<string, ResultFormRow>();
  for (const r of results) {
    const sideA = isThisTeam(teamA, category, tournamentId, r.teamAName, r.teamAShortName, r.category, r.round, r.tournamentId) ? 'A' as const
      : isThisTeam(teamA, category, tournamentId, r.teamBName, r.teamBShortName, r.category, r.round, r.tournamentId) ? 'B' as const : null;
    const sideB = isThisTeam(teamB, category, tournamentId, r.teamAName, r.teamAShortName, r.category, r.round, r.tournamentId) ? 'A' as const
      : isThisTeam(teamB, category, tournamentId, r.teamBName, r.teamBShortName, r.category, r.round, r.tournamentId) ? 'B' as const : null;
    if (!sideA && !sideB) continue;
    const stage = stageLabel(r.round) || '—';
    const key = stage.toLowerCase();
    if (!rows.has(key)) rows.set(key, { stage });
    const row = rows.get(key)!;
    if (sideA) row.a = { r, side: sideA };
    if (sideB) row.b = { r, side: sideB };
  }
  return Array.from(rows.values()).sort((x, y) => {
    const dx = x.a?.r.savedAt ?? x.b?.r.savedAt ?? 0;
    const dy = y.a?.r.savedAt ?? y.b?.r.savedAt ?? 0;
    return dy - dx; // newest first
  });
}

export function mergeUpcomingRows(
  matches: ScheduledMatch[],
  teamA: { name: string; shortName?: string },
  teamB: { name: string; shortName?: string },
  category: string | undefined,
  tournamentId: string | undefined,
): UpcomingFormRow[] {
  const rows = new Map<string, UpcomingFormRow>();
  for (const m of matches) {
    if (m.completedAt) continue;
    const sideA = isThisTeam(teamA, category, tournamentId, m.teamAName, m.teamAShortName, m.category, m.round, m.tournamentId) ? 'A' as const
      : isThisTeam(teamA, category, tournamentId, m.teamBName, m.teamBShortName, m.category, m.round, m.tournamentId) ? 'B' as const : null;
    const sideB = isThisTeam(teamB, category, tournamentId, m.teamAName, m.teamAShortName, m.category, m.round, m.tournamentId) ? 'A' as const
      : isThisTeam(teamB, category, tournamentId, m.teamBName, m.teamBShortName, m.category, m.round, m.tournamentId) ? 'B' as const : null;
    if (!sideA && !sideB) continue;
    const stage = stageLabel(m.round) || '—';
    const key = stage.toLowerCase();
    if (!rows.has(key)) rows.set(key, { stage });
    const row = rows.get(key)!;
    if (sideA) row.a = { m, side: sideA };
    if (sideB) row.b = { m, side: sideB };
  }
  return Array.from(rows.values()).sort((x, y) => {
    const dx = x.a?.m.date ?? x.b?.m.date ?? '';
    const dy = y.a?.m.date ?? y.b?.m.date ?? '';
    return dx.localeCompare(dy); // soonest first
  });
}
