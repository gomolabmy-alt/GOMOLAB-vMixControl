import type { SavedMatchResult } from '../stores/matchResultsStore';
import { parseScheduledDateTime } from './scoreboardSnapshot';

export type ResultSortMode = 'matchId' | 'kickoff' | 'updated';

export const RESULT_SORT_LABELS: Record<ResultSortMode, string> = {
  matchId: 'Match ID',
  kickoff: 'Kickoff Time',
  updated: 'Last Updated',
};

// Same "trailing digits" convention as the public scoring page's own
// matchNumberValue — a match number like "MB12" sorts by 12, so venues
// numbered in parallel ("MB1, MC1, MB2, MC2…") interleave into one running
// order instead of sorting by venue letter first. No match number (or no
// linked fixture at all) sorts to the end.
function matchIdValue(r: SavedMatchResult, matchNumbers: Map<string, string>): number {
  const code = r.sourceScheduleId ? matchNumbers.get(r.sourceScheduleId) : undefined;
  const m = (code ?? '').match(/(\d+)(?!.*\d)/);
  return m ? parseInt(m[1], 10) : Number.MAX_SAFE_INTEGER;
}

function kickoffValue(r: SavedMatchResult): number {
  return parseScheduledDateTime(r.date, r.time) ?? Number.MAX_SAFE_INTEGER;
}

/** Orders saved results by the chosen mode — default display order should be
 *  the match running order (matchId) or actual kickoff time, NOT insertion/
 *  save order, since "most recently saved/edited" drifts out of match order
 *  the moment anything is corrected out of sequence. `updated` (savedAt,
 *  newest first) is kept as an explicit opt-in for whoever wants that. */
export function sortResults(results: SavedMatchResult[], mode: ResultSortMode, matchNumbers: Map<string, string>): SavedMatchResult[] {
  const sorted = [...results];
  if (mode === 'updated') {
    sorted.sort((a, b) => b.savedAt - a.savedAt);
  } else if (mode === 'kickoff') {
    sorted.sort((a, b) => kickoffValue(a) - kickoffValue(b));
  } else {
    sorted.sort((a, b) => matchIdValue(a, matchNumbers) - matchIdValue(b, matchNumbers));
  }
  return sorted;
}
