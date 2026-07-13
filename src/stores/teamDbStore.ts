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
  /** Marks a team as sitting out ('bye') or withdrawn/forfeiting ('walkover')
   *  for the rest of the tournament — setting this auto-applies the same
   *  status to that team's not-yet-completed fixtures in the Schedule tab. */
  status?: 'bye' | 'walkover';
  /** Which preliminary-draw/pool group this team is in (e.g. "Pool A") —
   *  must match a name in Tournament.groups, or unset for no group. Set
   *  either manually or by the live draw (see Tournament.pots). */
  group?: string;
  /** Explicit 1-based slot within `group` (e.g. 2 → "A2") — optional; when
   *  unset the slot is auto-computed by list order. If two teams in the
   *  same group are both given the same explicit position, that slot is
   *  left blank in the group list push rather than guessing which wins. */
  groupPosition?: number;
  /** Seeding pot for the live draw (e.g. "Pot 1") — must match a name in
   *  Tournament.pots. Assigned before drawing; unrelated to `group`, which
   *  is the draw's OUTPUT. */
  pot?: string;
  /** Competition category (e.g. "Men", "Women", "U21") — must match a name
   *  in Tournament.categories, or unset for none. A club entering multiple
   *  categories gets a separate SavedTeam per category (see duplicateTeam)
   *  since each category's roster is independent. */
  category?: string;
}

interface TeamDbStore {
  teams: SavedTeam[];
  addTeam: (team: Omit<SavedTeam, 'id' | 'players'>) => string;
  updateTeam: (id: string, patch: Partial<Omit<SavedTeam, 'id' | 'players'>>) => void;
  deleteTeam: (id: string) => void;
  /** Copies a team's identity (name/short/color/logo) into a fresh team in
   *  the same tournament — empty roster/staff and no group/pot/category, so
   *  the same club can field a separate, independently-rostered entry in
   *  another category. Returns the new team's id, or undefined if not found. */
  duplicateTeam: (id: string) => string | undefined;

  addPlayer: (teamId: string, player: Omit<Player, 'id'>) => string;
  updatePlayer: (teamId: string, playerId: string, patch: Partial<Omit<Player, 'id'>>) => void;
  deletePlayer: (teamId: string, playerId: string) => void;
  replaceTeamPlayers: (teamId: string, players: Omit<Player, 'id'>[]) => void;
  updateStaffMember: (teamId: string, staffId: string, name: string) => void;
  restoreTeams: (teams: unknown[]) => void;
}

export const useTeamDbStore = create<TeamDbStore>()(
  persist(
    (set, get) => ({
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

      duplicateTeam: (id) => {
        const src = get().teams.find(t => t.id === id);
        if (!src) return undefined;
        const newId = crypto.randomUUID();
        set(s => ({
          teams: [...s.teams, {
            id: newId,
            name: src.name,
            shortName: src.shortName,
            color: src.color,
            logo: src.logo,
            players: [],
            staff: [],
            tournamentId: src.tournamentId,
          }],
        }));
        return newId;
      },

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

      restoreTeams: (teams) => set({ teams: teams as SavedTeam[] }),
    }),
    {
      name: 'gomolab-teamdb-v1',
      storage: createJSONStorage(() =>
        typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
          ? localStorage
          : sessionStorage
      ),
      // Remote/browser clients always load the host's live data via
      // FULL_STATE — never persist locally, or a reload could show stale
      // data before (or instead of) the synced copy.
      partialize: (s) => (typeof window !== 'undefined' && !('__TAURI_INTERNALS__' in window)) ? {} : { teams: s.teams },
    }
  )
);
