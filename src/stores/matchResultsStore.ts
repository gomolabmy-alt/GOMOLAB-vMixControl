import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';

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
  savedAt: number;
}

interface MatchResultsStore {
  results: SavedMatchResult[];
  addResult: (result: Omit<SavedMatchResult, 'id' | 'savedAt'>) => string;
  updateResult: (id: string, patch: Partial<Omit<SavedMatchResult, 'id' | 'savedAt'>>) => void;
  deleteResult: (id: string) => void;
  clearResults: () => void;
  restoreResults: (results: unknown[]) => void;
}

export const useMatchResultsStore = create<MatchResultsStore>()(
  persist(
    (set) => ({
      results: [],

      addResult: (result) => {
        const id = crypto.randomUUID();
        set(s => ({ results: [{ ...result, id, savedAt: Date.now() }, ...s.results] }));
        return id;
      },

      updateResult: (id, patch) => set(s => ({
        results: s.results.map(r => r.id === id ? { ...r, ...patch } : r),
      })),

      deleteResult: (id) => set(s => ({ results: s.results.filter(r => r.id !== id) })),

      clearResults: () => set({ results: [] }),

      restoreResults: (results) => set({ results: results as SavedMatchResult[] }),
    }),
    {
      name: 'gomolab-match-results-v1',
      storage: createJSONStorage(() =>
        typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
          ? localStorage
          : sessionStorage
      ),
    }
  )
);
