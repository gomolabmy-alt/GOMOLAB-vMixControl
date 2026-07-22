import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import type { Tournament, SportType, TournamentSettings } from '../types/tournament';
import { SPORT_DEFAULTS } from '../types/tournament';
import { syncClient } from '../lib/syncClient';
import { useTeamDbStore } from './teamDbStore';
import { useMatchScheduleStore } from './matchScheduleStore';
import { useMatchResultsStore } from './matchResultsStore';
import { useAppSettings } from './appSettingsStore';
import { useUndoStore } from './undoStore';

/** True on the desktop host (Tauri), false on any browser/remote client. */
const isHostClient = () => typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

/** Remote client only: push the current local Team DB/Schedule/Results/
 *  Tournament state to the host, which adopts it and re-broadcasts to
 *  everyone else on its next FULL_STATE heartbeat. */
export function pushTournamentDataToHost() {
  if (isHostClient()) return;
  const t = useTournamentStore.getState();
  syncClient.send({
    type: 'PUSH_TOURNAMENT_DATA',
    teamDb: { teams: useTeamDbStore.getState().teams },
    matchSchedule: { matches: useMatchScheduleStore.getState().matches },
    matchResults: { results: useMatchResultsStore.getState().results },
    tournament: { tournaments: t.tournaments, activeTournamentId: t.activeTournamentId },
  });
}

interface TournamentStore {
  tournaments: Tournament[];
  activeTournamentId: string;
  /** Which tournament the Tournament Database window opens to by default —
   *  purely a local UI convenience, separate from `activeTournamentId`
   *  (which drives what remote/readonly/commentator clients see and must
   *  stay tied to sync). Empty = no default, falls back to the first
   *  tournament in the list. */
  defaultTournamentId: string;

  addTournament: (data: { name: string; sport: SportType }) => string;
  updateTournament: (id: string, patch: Partial<Pick<Tournament, 'name' | 'sport' | 'groups' | 'pots' | 'categories' | 'venues' | 'venuePrefixes' | 'matchNumberPrefix' | 'drawVmix' | 'drawTeamMode' | 'groupListVmix' | 'cloudSyncEnabled' | 'eventId' | 'eventName' | 'eventShareKey'>>) => void;
  deleteTournament: (id: string) => void;

  updateTournamentSettings: (id: string, patch: Partial<TournamentSettings>) => void;
  setActiveTournament: (id: string) => void;
  setDefaultTournament: (id: string) => void;
  restoreTournaments: (tournaments: unknown[], activeTournamentId: string) => void;
}

export const useTournamentStore = create<TournamentStore>()(
  persist(
    (set, get) => ({
      tournaments: [],
      activeTournamentId: '',
      defaultTournamentId: '',

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

      deleteTournament: (id) => {
        const prior = get();
        const tournament = prior.tournaments.find(t => t.id === id);
        const priorActiveId = prior.activeTournamentId;
        const priorDefaultId = prior.defaultTournamentId;
        set(s => {
          const remaining = s.tournaments.filter(t => t.id !== id);
          return {
            tournaments: remaining,
            activeTournamentId: s.activeTournamentId === id ? (remaining[0]?.id ?? '') : s.activeTournamentId,
            defaultTournamentId: s.defaultTournamentId === id ? '' : s.defaultTournamentId,
          };
        });
        if (tournament) useUndoStore.getState().pushUndo(`Deleted tournament "${tournament.name}"`, () =>
          useTournamentStore.setState(s => ({
            tournaments: [...s.tournaments, tournament],
            activeTournamentId: priorActiveId,
            defaultTournamentId: priorDefaultId,
          })));
      },

      setActiveTournament: (id) => set({ activeTournamentId: id }),
      setDefaultTournament: (id) => set(s => ({ defaultTournamentId: s.defaultTournamentId === id ? '' : id })),

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
        : { tournaments: s.tournaments, activeTournamentId: s.activeTournamentId, defaultTournamentId: s.defaultTournamentId },
      // v1: Tournament.groups changed from string[] to {name,prefix,capacity}[]
      // (added group prefix labels + per-group max team count).
      // v2: Tournament.pots changed from string[] to {name,category}[]
      // (added per-category draw scoping).
      // Both migrations convert any already-saved plain strings so old
      // tournaments don't crash the Teams/Standings/Draw tabs, which now
      // assume group/pot objects.
      version: 2,
      migrate: (persisted) => {
        const state = persisted as { tournaments?: Array<Omit<Tournament, 'groups' | 'pots'> & { groups?: unknown; pots?: unknown }> };
        if (state?.tournaments) {
          for (const t of state.tournaments) {
            if (Array.isArray(t.groups)) {
              t.groups = t.groups.map((g: unknown) =>
                typeof g === 'string' ? { name: g, prefix: g.charAt(0).toUpperCase() } : g
              );
            }
            if (Array.isArray(t.pots)) {
              t.pots = t.pots.map((p: unknown) => typeof p === 'string' ? { name: p } : p);
            }
          }
        }
        return state;
      },
    }
  )
);

export function initTournamentSync() {
  syncClient.onMessage((msg) => {
    if (msg.type === 'FULL_STATE') {
      // Remote/browser clients (any non-host — plain remote-control, readonly,
      // or commentator) previously never received the team database, match
      // schedule, or results — only canvas/tournament were synced, so the
      // Tournament Database window showed empty/stale local data over a
      // remote IP connection instead of the host's actual data.
      //
      // While remoteEditMode is on, a remote client is mid-edit locally —
      // skip applying the host's periodic re-broadcast so it doesn't clobber
      // those unsaved edits; "Save to Host" (pushTournamentDataToHost) is the
      // explicit, deliberate way those edits reach the host instead.
      if (!isHostClient() && !useAppSettings.getState().remoteEditMode) {
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
    if (msg.type === 'PUSH_TOURNAMENT_DATA') {
      // Only the host adopts a pushed edit — everyone else just gets it via
      // the host's normal FULL_STATE heartbeat afterward.
      if (isHostClient()) {
        useTeamDbStore.getState().restoreTeams(msg.teamDb.teams);
        useMatchScheduleStore.getState().restoreMatches(msg.matchSchedule.matches);
        useMatchResultsStore.getState().restoreResults(msg.matchResults.results);
        useTournamentStore.setState({
          tournaments: msg.tournament.tournaments,
          activeTournamentId: msg.tournament.activeTournamentId,
        });
        syncClient.sendFullState();
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
