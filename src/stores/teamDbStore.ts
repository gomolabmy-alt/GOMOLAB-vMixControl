import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import type { Player, StaffMember } from '../types/tournament';

// Reusable team profiles — the source of truth for team identity (name,
// short name, color, logo), roster (players) and staff. A team optionally
// belongs to a Tournament (tournamentId) which now acts as a competition/
// league container that can hold any number of teams; widgets reference a
// specific team by id rather than a fixed "Team A / Team B" slot.
export interface SavedTeam {
  id: string;
  name: string;
  shortName?: string;
  color: string;
  logo?: string;
  players: Player[];
  staff?: StaffMember[];
  tournamentId?: string;
}

interface TeamDbStore {
  teams: SavedTeam[];
  addTeam: (team: Omit<SavedTeam, 'id' | 'players'>) => string;
  updateTeam: (id: string, patch: Partial<Omit<SavedTeam, 'id' | 'players'>>) => void;
  deleteTeam: (id: string) => void;

  addPlayer: (teamId: string, player: Omit<Player, 'id'>) => string;
  updatePlayer: (teamId: string, playerId: string, patch: Partial<Omit<Player, 'id'>>) => void;
  deletePlayer: (teamId: string, playerId: string) => void;
  replaceTeamPlayers: (teamId: string, players: Omit<Player, 'id'>[]) => void;
  updateStaffMember: (teamId: string, staffId: string, name: string) => void;
}

export const useTeamDbStore = create<TeamDbStore>()(
  persist(
    (set) => ({
      teams: [],

      addTeam: (team) => {
        const id = crypto.randomUUID();
        set(s => ({ teams: [...s.teams, { ...team, id, players: [] }] }));
        return id;
      },

      updateTeam: (id, patch) => set(s => ({
        teams: s.teams.map(t => t.id === id ? { ...t, ...patch } : t),
      })),

      deleteTeam: (id) => set(s => ({ teams: s.teams.filter(t => t.id !== id) })),

      addPlayer: (teamId, player) => {
        const playerId = crypto.randomUUID();
        set(s => ({
          teams: s.teams.map(t => t.id === teamId
            ? { ...t, players: [...t.players, { ...player, id: playerId }] }
            : t),
        }));
        return playerId;
      },

      updatePlayer: (teamId, playerId, patch) => set(s => ({
        teams: s.teams.map(t => t.id === teamId
          ? { ...t, players: t.players.map(p => p.id === playerId ? { ...p, ...patch } : p) }
          : t),
      })),

      deletePlayer: (teamId, playerId) => set(s => ({
        teams: s.teams.map(t => t.id === teamId
          ? { ...t, players: t.players.filter(p => p.id !== playerId) }
          : t),
      })),

      replaceTeamPlayers: (teamId, players) => set(s => ({
        teams: s.teams.map(t => t.id === teamId
          ? { ...t, players: players.map(p => ({ ...p, id: crypto.randomUUID() })) }
          : t),
      })),

      updateStaffMember: (teamId, staffId, name) => set(s => ({
        teams: s.teams.map(t => {
          if (t.id !== teamId) return t;
          const next: StaffMember[] = (t.staff ?? []).map(m => m.id === staffId ? { ...m, name } : m);
          return { ...t, staff: next };
        }),
      })),
    }),
    {
      name: 'gomolab-teamdb-v1',
      storage: createJSONStorage(() =>
        typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
          ? localStorage
          : sessionStorage
      ),
    }
  )
);
