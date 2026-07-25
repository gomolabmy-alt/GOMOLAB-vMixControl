import { useTeamDbStore } from '../stores/teamDbStore';
import { useMatchScheduleStore } from '../stores/matchScheduleStore';
import { useMatchResultsStore } from '../stores/matchResultsStore';

const norm = (s?: string) => (s ?? '').trim().toLowerCase();

// Same category+name/shortName resolution every id-preferred matcher already
// falls back to (see computeStandings, findMatchScore, etc.) — used here to
// promote OLD fixtures/results (saved before teamAId/teamBId existed) up to
// unambiguous id matching too, instead of leaving them on the fallback path
// forever.
function resolveTeamId(tournamentId: string | undefined, category: string | undefined, name: string | undefined, shortName: string | undefined): string | undefined {
  if (!tournamentId || !name) return undefined;
  const nameKey = norm(name);
  const shortKey = norm(shortName);
  const catKey = norm(category);
  const t = useTeamDbStore.getState().teams.find(t2 =>
    t2.tournamentId === tournamentId &&
    norm(t2.category) === catKey &&
    (norm(t2.name) === nameKey || (!!shortKey && norm(t2.shortName) === shortKey))
  );
  return t?.id;
}

/** One-time-per-launch backfill: fills in teamAId/teamBId on every existing
 *  fixture/result that doesn't have one yet, resolving against the Team DB
 *  the same way the id-preferred matchers already fall back to. Only ever
 *  fills in a currently-unset id — never overwrites an existing one — so
 *  it's safe to call on every launch and is a cheap no-op once everything's
 *  already resolved (or genuinely unresolvable — a manually-typed team with
 *  no matching Team DB record stays without an id, same as always). Returns
 *  how many rows were updated, for a console log. */
export function backfillTeamIds(): { matches: number; results: number } {
  const { matches, updateMatch } = useMatchScheduleStore.getState();
  let matchCount = 0;
  for (const m of matches) {
    const patch: { teamAId?: string; teamBId?: string } = {};
    if (!m.teamAId) {
      const id = resolveTeamId(m.tournamentId, m.category, m.teamAName, m.teamAShortName);
      if (id) patch.teamAId = id;
    }
    if (!m.teamBId && m.teamBName) {
      const id = resolveTeamId(m.tournamentId, m.category, m.teamBName, m.teamBShortName);
      if (id) patch.teamBId = id;
    }
    if (Object.keys(patch).length > 0) {
      updateMatch(m.id, patch);
      matchCount++;
    }
  }

  const { results, updateResult } = useMatchResultsStore.getState();
  let resultCount = 0;
  for (const r of results) {
    const patch: { teamAId?: string; teamBId?: string } = {};
    if (!r.teamAId) {
      const id = resolveTeamId(r.tournamentId, r.category, r.teamAName, r.teamAShortName);
      if (id) patch.teamAId = id;
    }
    if (!r.teamBId) {
      const id = resolveTeamId(r.tournamentId, r.category, r.teamBName, r.teamBShortName);
      if (id) patch.teamBId = id;
    }
    if (Object.keys(patch).length > 0) {
      updateResult(r.id, patch);
      resultCount++;
    }
  }

  return { matches: matchCount, results: resultCount };
}
