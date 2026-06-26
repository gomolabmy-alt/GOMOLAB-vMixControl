import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import type { Tournament, Team, Player, StaffMember, SportType, TournamentSettings } from '../types/tournament';
import { SPORT_DEFAULTS } from '../types/tournament';
import { syncClient } from '../lib/syncClient';

interface TournamentStore {
  tournaments: Tournament[];
  activeTournamentId: string;

  addTournament: (data: {
    name: string;
    sport: SportType;
    teamAName?: string;
    teamBName?: string;
    teamAColor?: string;
    teamBColor?: string;
  }) => string;
  updateTournament: (id: string, patch: Partial<Pick<Tournament, 'name' | 'sport'>>) => void;
  deleteTournament: (id: string) => void;

  updateTeam: (tournamentId: string, side: 'A' | 'B', patch: Partial<Omit<Team, 'players'>>) => void;
  updateStaffMember: (tournamentId: string, side: 'A' | 'B', staffId: string, name: string) => void;

  addPlayer: (tournamentId: string, side: 'A' | 'B', player: Omit<Player, 'id'>) => string;
  updatePlayer: (tournamentId: string, side: 'A' | 'B', playerId: string, patch: Partial<Omit<Player, 'id'>>) => void;
  deletePlayer: (tournamentId: string, side: 'A' | 'B', playerId: string) => void;
  replaceTeamPlayers: (tournamentId: string, side: 'A' | 'B', players: Omit<Player, 'id'>[]) => void;

  updateTournamentSettings: (id: string, patch: Partial<TournamentSettings>) => void;
  setActiveTournament: (id: string) => void;
  restoreTournaments: (tournaments: unknown[], activeTournamentId: string) => void;
}

const blankTeam = (name: string, color: string): Team => ({ name, color, players: [] });

export const useTournamentStore = create<TournamentStore>()(
  persist(
    (set) => ({
      tournaments: [],
      activeTournamentId: '',

      addTournament: ({ name, sport, teamAName = 'Team A', teamBName = 'Team B', teamAColor = '#e74c3c', teamBColor = '#3498db' }) => {
        const id = crypto.randomUUID();
        set(s => ({
          tournaments: [...s.tournaments, {
            id,
            name,
            sport,
            teamA: blankTeam(teamAName, teamAColor),
            teamB: blankTeam(teamBName, teamBColor),
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

      updateTeam: (tournamentId, side, patch) => {
        set(s => ({
          tournaments: s.tournaments.map(t => {
            if (t.id !== tournamentId) return t;
            return side === 'A'
              ? { ...t, teamA: { ...t.teamA, ...patch } }
              : { ...t, teamB: { ...t.teamB, ...patch } };
          }),
        }));
        syncClient.send({ type: 'ACTION', store: 'tournament', fn: 'updateTeam', args: [tournamentId, side, patch] });
      },

      updateStaffMember: (tournamentId, side, staffId, name) => {
        set(s => ({
          tournaments: s.tournaments.map(t => {
            if (t.id !== tournamentId) return t;
            const team = side === 'A' ? t.teamA : t.teamB;
            const next: StaffMember[] = (team.staff ?? []).map(s => s.id === staffId ? { ...s, name } : s);
            return side === 'A'
              ? { ...t, teamA: { ...t.teamA, staff: next } }
              : { ...t, teamB: { ...t.teamB, staff: next } };
          }),
        }));
        syncClient.send({ type: 'ACTION', store: 'tournament', fn: 'updateStaffMember', args: [tournamentId, side, staffId, name] });
      },

      addPlayer: (tournamentId, side, player) => {
        const playerId = crypto.randomUUID();
        set(s => ({
          tournaments: s.tournaments.map(t => {
            if (t.id !== tournamentId) return t;
            const newPlayer = { ...player, id: playerId };
            return side === 'A'
              ? { ...t, teamA: { ...t.teamA, players: [...t.teamA.players, newPlayer] } }
              : { ...t, teamB: { ...t.teamB, players: [...t.teamB.players, newPlayer] } };
          }),
        }));
        return playerId;
      },

      updatePlayer: (tournamentId, side, playerId, patch) => set(s => ({
        tournaments: s.tournaments.map(t => {
          if (t.id !== tournamentId) return t;
          const upd = (ps: Player[]) => ps.map(p => p.id === playerId ? { ...p, ...patch } : p);
          return side === 'A'
            ? { ...t, teamA: { ...t.teamA, players: upd(t.teamA.players) } }
            : { ...t, teamB: { ...t.teamB, players: upd(t.teamB.players) } };
        }),
      })),

      deletePlayer: (tournamentId, side, playerId) => set(s => ({
        tournaments: s.tournaments.map(t => {
          if (t.id !== tournamentId) return t;
          const del = (ps: Player[]) => ps.filter(p => p.id !== playerId);
          return side === 'A'
            ? { ...t, teamA: { ...t.teamA, players: del(t.teamA.players) } }
            : { ...t, teamB: { ...t.teamB, players: del(t.teamB.players) } };
        }),
      })),

      replaceTeamPlayers: (tournamentId, side, players) => set(s => ({
        tournaments: s.tournaments.map(t => {
          if (t.id !== tournamentId) return t;
          const withIds: Player[] = players.map(p => ({ ...p, id: crypto.randomUUID() }));
          return side === 'A'
            ? { ...t, teamA: { ...t.teamA, players: withIds } }
            : { ...t, teamB: { ...t.teamB, players: withIds } };
        }),
      })),

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
    }
  )
);

export function initTournamentSync() {
  syncClient.onMessage((msg) => {
    if (msg.type === 'FULL_STATE') {
      const isHost = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
      if (!isHost && msg.tournament) {
        useTournamentStore.setState({
          tournaments: msg.tournament.tournaments,
          activeTournamentId: msg.tournament.activeTournamentId,
        });
      }
      return;
    }
    if (msg.type !== 'ACTION' || msg.store !== 'tournament') return;
    const store = useTournamentStore.getState();
    switch (msg.fn) {
      case 'updateTeam':
        store.updateTeam(msg.args[0], msg.args[1], msg.args[2]);
        break;
      case 'updateStaffMember':
        store.updateStaffMember(msg.args[0], msg.args[1], msg.args[2], msg.args[3]);
        break;
      case 'updateTournamentSettings':
        store.updateTournamentSettings(msg.args[0], msg.args[1]);
        break;
    }
  });
}
