import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import type { Tournament, SportType, TournamentSettings } from '../types/tournament';
import { SPORT_DEFAULTS } from '../types/tournament';
import { syncClient } from '../lib/syncClient';
import { useTeamDbStore } from './teamDbStore';
import { useMatchScheduleStore } from './matchScheduleStore';
import { useMatchResultsStore } from './matchResultsStore';

interface TournamentStore {
  tournaments: Tournament[];
  activeTournamentId: string;

  addTournament: (data: { name: string; sport: SportType }) => string;
  updateTournament: (id: string, patch: Partial<Pick<Tournament, 'name' | 'sport'>>) => void;
  deleteTournament: (id: string) => void;

  updateTournamentSettings: (id: string, patch: Partial<TournamentSettings>) => void;
  setActiveTournament: (id: string) => void;
  restoreTournaments: (tournaments: unknown[], activeTournamentId: string) => void;
}

export const useTournamentStore = create<TournamentStore>()(
  persist(
    (set) => ({
      tournaments: [],
      activeTournamentId: '',

      addTournament: ({ name, sport }) => {
        const id = crypto.randomUUID();
        set(s => ({
          tournaments: [...s.tournaments, {
            id,
            name,
            sport,
            settings: { ...SPORT_DEFAULTS[sport] },
            createdAt: Date.now(),
          }],
          activeTournamentId: s.activeTournamentId || id,
        }));
        return id;
      },

      updateTournament: (id, patch) => set(s => ({
        tournaments: s.tournaments.map(t => {
          if (t.id !== id) return t;
          // When sport changes, reset settings to new sport defaults
          const sportChanged = patch.sport && patch.sport !== t.sport;
          return {
            ...t,
            ...patch,
            settings: sportChanged ? { ...SPORT_DEFAULTS[patch.sport!] } : t.settings,
          };
        }),
      })),

      updateTournamentSettings: (id, patch) => {
        set(s => ({
          tournaments: s.tournaments.map(t =>
            t.id === id ? { ...t, settings: { ...(t.settings ?? SPORT_DEFAULTS[t.sport]), ...patch } } : t
          ),
        }));
        syncClient.send({ type: 'ACTION', store: 'tournament', fn: 'updateTournamentSettings', args: [id, patch] });
      },

      deleteTournament: (id) => set(s => {
        const remaining = s.tournaments.filter(t => t.id !== id);
        return {
          tournaments: remaining,
          activeTournamentId: s.activeTournamentId === id ? (remaining[0]?.id ?? '') : s.activeTournamentId,
        };
      }),

      setActiveTournament: (id) => set({ activeTournamentId: id }),

      restoreTournaments: (tournaments, activeTournamentId) =>
        set({ tournaments: tournaments as Tournament[], activeTournamentId: activeTournamentId as string }),
    }),
    {
      name: 'gomolab-tournament-v1',
      storage: createJSONStorage(() =>
        typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
          ? localStorage
          : sessionStorage
      ),
      // Remote/browser clients always load the host's live data via
      // FULL_STATE — never persist locally, or a reload could show stale
      // data before (or instead of) the synced copy.
      partialize: (s) => (typeof window !== 'undefined' && !('__TAURI_INTERNALS__' in window))
        ? {}
        : { tournaments: s.tournaments, activeTournamentId: s.activeTournamentId },
    }
  )
);

export function initTournamentSync() {
  syncClient.onMessage((msg) => {
    if (msg.type === 'FULL_STATE') {
      const isHost = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
      // Remote/browser clients (any non-host — plain remote-control, readonly,
      // or commentator) previously never received the team database, match
      // schedule, or results — only canvas/tournament were synced, so the
      // Tournament Database window showed empty/stale local data over a
      // remote IP connection instead of the host's actual data.
      if (!isHost) {
        if (msg.tournament) {
          useTournamentStore.setState({
            tournaments: msg.tournament.tournaments,
            activeTournamentId: msg.tournament.activeTournamentId,
          });
        }
        if (msg.teamDb) useTeamDbStore.getState().restoreTeams(msg.teamDb.teams);
        if (msg.matchSchedule) useMatchScheduleStore.getState().restoreMatches(msg.matchSchedule.matches);
        if (msg.matchResults) useMatchResultsStore.getState().restoreResults(msg.matchResults.results);
      }
      return;
    }
    if (msg.type !== 'ACTION' || msg.store !== 'tournament') return;
    const store = useTournamentStore.getState();
    switch (msg.fn) {
      case 'updateTournamentSettings':
        store.updateTournamentSettings(msg.args[0], msg.args[1]);
        break;
    }
  });
}
