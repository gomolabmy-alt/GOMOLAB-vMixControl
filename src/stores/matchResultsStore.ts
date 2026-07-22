import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import { useUndoStore } from './undoStore';

// A saved snapshot of a finished match, captured from a scoreboard widget's
// current state at the moment "Save Result" is pressed — powers the
// "recent-matches" widget's results list.
export interface SavedMatchResult {
  id: string;
  /** Which tournament/competition this result belongs to (teamDbStore-scoped). */
  tournamentId?: string;
  date: string; // e.g. "2026-07-09"
  /** Scheduled kickoff time, carried over from the fixture this result came
   *  from (e.g. "20:30") — distinct from savedAt, which is when the result
   *  was actually recorded/the match ended. */
  time?: string;
  competition?: string;
  round?: string;
  /** Tournament category (e.g. "Men", "U21") this result belongs to — carried
   *  over from the originating fixture so a same-named team entered in
   *  multiple categories doesn't get its stats/history mixed together. */
  category?: string;
  teamAName: string;
  teamAShortName?: string;
  teamALogo?: string;
  teamAColor: string;
  scoreA: number;
  teamBName: string;
  teamBShortName?: string;
  teamBLogo?: string;
  teamBColor: string;
  scoreB: number;
  /** 'bye' = no opponent that round; 'walkover' = one side forfeited a
   *  fixtured match — neither was actually played, carried over from the
   *  originating Schedule fixture so Results/standings can badge it. */
  matchType?: 'bye' | 'walkover';
  walkoverLoser?: 'A' | 'B';
  /** The ScheduledMatch this result came from, when there was one (bye/walkover
   *  auto-generated results, or a normal result saved from a scoreboard that
   *  had a fixture loaded onto it via Load Match/Send to Scoreboard) — lets a
   *  future save for the same fixture find-and-update this result instead of
   *  creating a duplicate. Unset for results entered with no linked fixture. */
  sourceScheduleId?: string;
  /** Trimmed snapshot of the scoreboard's live scoreLog at save time — every
   *  score event that made up the final score (e.g. Try/Conversion/Penalty),
   *  not just the total. Powers head-to-head breakdowns. Absent for
   *  bye/walkover results (no live match ever ran) and any result saved
   *  before this field existed. */
  scoreLog?: { team: 'A' | 'B'; action: string; points: number; scorer?: string; jerseyNo?: string; timeStr?: string }[];
  /** Kick-by-kick decider recorded when a match stayed level and a shootout
   *  was used to decide it — soccer penalty shootout, rugby place-kick
   *  competition, or any sport's equivalent. Does NOT change scoreA/scoreB
   *  (which stay as the tied regulation score); only decides the winner for
   *  bracket advancement/standings. Absent for any match not decided by one. */
  shootout?: {
    kicks: { a?: boolean; b?: boolean }[]; // chronological rounds, regulation + sudden death
    scoreA: number; // total makes by A across all rounds
    scoreB: number;
    winner: 'A' | 'B';
  };
  /** Cards given during the match, captured from the linked Player Picker
   *  lists at save time (mirrors the scoreLog capture above). Absent when no
   *  Player Picker was linked or no cards were given. */
  cards?: { team: 'A' | 'B'; type: 'yellow' | 'orange' | 'red' }[];
  /** Which physical venue pushed this result, for multi-venue cloud sync
   *  (see src/lib/cloudSync.ts) — same convention as ScheduledMatch.venueLabel. */
  venueLabel?: string;
  savedAt: number;
}

interface MatchResultsStore {
  results: SavedMatchResult[];
  /** Result ids deleted locally since the last successful cloud push — read
   *  and cleared by cloudSync.ts so a deletion actually removes the record
   *  from the cloud too, instead of leaving a stale copy behind that a push
   *  only ever upserts and never removes on its own. */
  pendingDeletedIds: string[];
  addResult: (result: Omit<SavedMatchResult, 'id' | 'savedAt'>) => string;
  updateResult: (id: string, patch: Partial<Omit<SavedMatchResult, 'id' | 'savedAt'>>) => void;
  deleteResult: (id: string) => void;
  clearResults: () => void;
  restoreResults: (results: unknown[]) => void;
  /** Consumes (removes) the given ids from pendingDeletedIds — called by
   *  cloudSync.ts once they've actually been pushed to the cloud. */
  clearPendingDeletedIds: (ids: string[]) => void;
}

export const useMatchResultsStore = create<MatchResultsStore>()(
  persist(
    (set, get) => ({
      results: [],
      pendingDeletedIds: [],

      addResult: (result) => {
        const id = crypto.randomUUID();
        set(s => ({ results: [{ ...result, id, savedAt: Date.now() }, ...s.results] }));
        return id;
      },

      updateResult: (id, patch) => set(s => ({
        results: s.results.map(r => r.id === id ? { ...r, ...patch } : r),
      })),

      deleteResult: (id) => {
        const result = get().results.find(r => r.id === id);
        set(s => ({ results: s.results.filter(r => r.id !== id), pendingDeletedIds: [...s.pendingDeletedIds, id] }));
        if (result) useUndoStore.getState().pushUndo(`Deleted result "${result.teamAName} vs ${result.teamBName}"`, () =>
          useMatchResultsStore.setState(s => ({
            results: [result, ...s.results],
            pendingDeletedIds: s.pendingDeletedIds.filter(x => x !== id),
          })));
      },

      clearResults: () => {
        const removed = get().results.slice();
        const removedIds = removed.map(r => r.id);
        set(s => ({ results: [], pendingDeletedIds: [...s.pendingDeletedIds, ...removedIds] }));
        if (removed.length > 0) useUndoStore.getState().pushUndo(`Cleared ${removed.length} result${removed.length === 1 ? '' : 's'}`, () =>
          useMatchResultsStore.setState(s => ({
            results: [...removed, ...s.results],
            pendingDeletedIds: s.pendingDeletedIds.filter(x => !removedIds.includes(x)),
          })));
      },

      restoreResults: (results) => set({ results: results as SavedMatchResult[] }),

      clearPendingDeletedIds: (ids) => set(s => ({ pendingDeletedIds: s.pendingDeletedIds.filter(id => !ids.includes(id)) })),
    }),
    {
      name: 'gomolab-match-results-v1',
      storage: createJSONStorage(() =>
        typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
          ? localStorage
          : sessionStorage
      ),
      // Remote/browser clients always load the host's live data via
      // FULL_STATE — never persist locally, or a reload could show stale
      // data before (or instead of) the synced copy.
      partialize: (s) => (typeof window !== 'undefined' && !('__TAURI_INTERNALS__' in window)) ? {} : { results: s.results, pendingDeletedIds: s.pendingDeletedIds },
    }
  )
);
