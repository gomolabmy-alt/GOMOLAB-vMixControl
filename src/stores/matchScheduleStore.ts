import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';

// Upcoming fixtures — separate from matchResultsStore (completed matches with
// a final score). A scheduled match has no score; picking one from the
// scoreboard's "Load Match" picker fills in the matchup details (teams,
// logos, competition, round) so the operator doesn't retype them per game.
export interface ScheduledMatch {
  id: string;
  /** Which tournament/competition this fixture belongs to (teamDbStore-scoped). */
  tournamentId?: string;
  date: string; // "2026-08-17"
  time?: string; // "20:30"
  competition?: string;
  round?: string;
  venue?: string;
  broadcaster?: string;
  teamAName: string;
  teamAShortName?: string;
  teamALogo?: string;
  teamAColor: string;
  teamBName: string;
  teamBShortName?: string;
  teamBLogo?: string;
  teamBColor: string;
  /** Set when this fixture has been sent to a scoreboard — used to grey it
   *  out and auto-advance the schedule widget's carousel past it. */
  sentAt?: number;
  /** Set when a result has been saved for this fixture (the scoreboard it was
   *  sent to had "💾 Save Result" pressed, or auto-saved on overwrite) — marks
   *  it fully completed, distinct from just having been sent. */
  completedAt?: number;
}

interface MatchScheduleStore {
  matches: ScheduledMatch[];
  addMatch: (match: Omit<ScheduledMatch, 'id'>) => string;
  updateMatch: (id: string, patch: Partial<Omit<ScheduledMatch, 'id'>>) => void;
  deleteMatch: (id: string) => void;
  markSent: (id: string) => void;
  unmarkSent: (id: string) => void;
  markCompleted: (id: string) => void;
  resetAllSent: () => void;
  clearMatches: () => void;
  restoreMatches: (matches: unknown[]) => void;
}

export const useMatchScheduleStore = create<MatchScheduleStore>()(
  persist(
    (set) => ({
      matches: [],

      addMatch: (match) => {
        const id = crypto.randomUUID();
        set(s => ({ matches: [...s.matches, { ...match, id }].sort((a, b) => a.date.localeCompare(b.date)) }));
        return id;
      },

      updateMatch: (id, patch) => set(s => ({
        matches: s.matches.map(m => m.id === id ? { ...m, ...patch } : m)
          .sort((a, b) => a.date.localeCompare(b.date)),
      })),

      deleteMatch: (id) => set(s => ({ matches: s.matches.filter(m => m.id !== id) })),

      markSent: (id) => set(s => ({
        matches: s.matches.map(m => m.id === id ? { ...m, sentAt: Date.now() } : m),
      })),

      unmarkSent: (id) => set(s => ({
        matches: s.matches.map(m => m.id === id ? { ...m, sentAt: undefined } : m),
      })),

      markCompleted: (id) => set(s => ({
        matches: s.matches.map(m => m.id === id ? { ...m, completedAt: Date.now() } : m),
      })),

      resetAllSent: () => set(s => ({
        matches: s.matches.map(m => ({ ...m, sentAt: undefined, completedAt: undefined })),
      })),

      clearMatches: () => set({ matches: [] }),

      restoreMatches: (matches) => set({ matches: matches as ScheduledMatch[] }),
    }),
    {
      name: 'gomolab-match-schedule-v1',
      storage: createJSONStorage(() =>
        typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
          ? localStorage
          : sessionStorage
      ),
    }
  )
);
