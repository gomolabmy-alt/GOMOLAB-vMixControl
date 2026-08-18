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

// True when an already-set id doesn't actually belong to a team matching
// this side's own current name — e.g. a manual rename (the free-text
// Schedule tab field clears its own id now, but this catches anything
// saved before that fix, or from any other path that still only touches
// the name), or a cross-device sync merge that pushed a stale id from a
// device on an older build. An id that simply doesn't resolve to ANY
// current team (deleted since) is left alone here — that's not evidence
// it's wrong, just that the record is gone, and resolveTeamId below
// already handles it the same as a never-set id.
function idLooksStale(id: string | undefined, name: string | undefined, shortName: string | undefined): boolean {
  if (!id || !name) return false;
  const team = useTeamDbStore.getState().teams.find(t => t.id === id);
  if (!team) return false;
  const nameKey = norm(name);
  const shortKey = norm(shortName);
  return norm(team.name) !== nameKey && !(shortKey && norm(team.shortName) === shortKey);
}

/** One-time-per-launch backfill: fills in teamAId/teamBId on every existing
 *  fixture/result that doesn't have one yet, resolving against the Team DB
 *  the same way the id-preferred matchers already fall back to — and also
 *  RE-resolves one that's already set but no longer matches that side's own
 *  name (see idLooksStale), which a fill-only pass would leave silently
 *  wrong forever (this is what let a team show up as its own "upcoming
 *  opponent" on the public scoring page — its id pointed at a different
 *  team than its name said). Safe to call on every launch and a cheap
 *  no-op once everything's already resolved and consistent (or genuinely
 *  unresolvable — a manually-typed team with no matching Team DB record
 *  stays without an id, same as always). Returns how many rows were
 *  updated, for a console log. */
export function backfillTeamIds(): { matches: number; results: number } {
  const { matches, updateMatch } = useMatchScheduleStore.getState();
  let matchCount = 0;
  for (const m of matches) {
    const patch: { teamAId?: string; teamBId?: string } = {};
    if (!m.teamAId || idLooksStale(m.teamAId, m.teamAName, m.teamAShortName)) {
      const id = resolveTeamId(m.tournamentId, m.category, m.teamAName, m.teamAShortName);
      if (id && id !== m.teamAId) patch.teamAId = id;
    }
    if (m.teamBName && (!m.teamBId || idLooksStale(m.teamBId, m.teamBName, m.teamBShortName))) {
      const id = resolveTeamId(m.tournamentId, m.category, m.teamBName, m.teamBShortName);
      if (id && id !== m.teamBId) patch.teamBId = id;
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
    if (!r.teamAId || idLooksStale(r.teamAId, r.teamAName, r.teamAShortName)) {
      const id = resolveTeamId(r.tournamentId, r.category, r.teamAName, r.teamAShortName);
      if (id && id !== r.teamAId) patch.teamAId = id;
    }
    if (!r.teamBId || idLooksStale(r.teamBId, r.teamBName, r.teamBShortName)) {
      const id = resolveTeamId(r.tournamentId, r.category, r.teamBName, r.teamBShortName);
      if (id && id !== r.teamBId) patch.teamBId = id;
    }
    if (Object.keys(patch).length > 0) {
      updateResult(r.id, patch);
      resultCount++;
    }
  }

  return { matches: matchCount, results: resultCount };
}
