import type { ExternalRosterSource, Player } from '../types/tournament';
import { useTeamDbStore } from '../stores/teamDbStore';
import { useTournamentStore } from '../stores/tournamentStore';

const isTauriApp = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

export interface ExternalTeamSummary {
  id: string;
  name: string;
  slug: string;
  logoUrl?: string;
}

// Always goes through the Rust side (see fetch_public_json in commands.rs) —
// a plain browser fetch() would depend on the source site's CORS policy, and
// this feature is desktop-app-only anyway (roster management, not the live
// scoreboard remote-control views).
async function fetchJson<T>(url: string): Promise<T> {
  if (!isTauriApp) throw new Error('Roster API import is only available in the desktop app.');
  const { invoke } = await import('@tauri-apps/api/core');
  const text = await invoke<string>('fetch_public_json', { url });
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error('The source site did not return valid JSON for that link.');
  }
}

// Accepts either a team link (.../api/public/teams/{slug}) or a tournament
// link (.../api/public/tournaments/{id}) — whatever the user happens to have
// copied — and resolves it down to a linkable, cached ExternalRosterSource.
export async function resolveExternalRosterLink(pastedUrl: string): Promise<ExternalRosterSource> {
  let parsed: URL;
  try {
    parsed = new URL(pastedUrl.trim());
  } catch {
    throw new Error("That doesn't look like a valid URL.");
  }
  const baseUrl = parsed.origin;
  const tournamentMatch = parsed.pathname.match(/\/api\/public\/tournaments\/([^/]+)/);
  const teamMatch = parsed.pathname.match(/\/api\/public\/teams\/([^/]+)/);

  let tournamentId: string;
  if (tournamentMatch) {
    tournamentId = tournamentMatch[1];
  } else if (teamMatch) {
    const team = await fetchJson<{ tournaments?: { id: string }[] }>(`${baseUrl}/api/public/teams/${teamMatch[1]}`);
    const tid = team.tournaments?.[0]?.id;
    if (!tid) throw new Error("That team isn't linked to a tournament on the source site.");
    tournamentId = tid;
  } else {
    throw new Error('Paste a team or tournament link from the roster site (a /api/public/teams/… or /api/public/tournaments/… URL).');
  }

  const tournament = await fetchJson<{ name?: string }>(`${baseUrl}/api/public/tournaments/${tournamentId}`);
  return { baseUrl, tournamentId, tournamentName: tournament.name };
}

export async function fetchExternalTeams(source: ExternalRosterSource): Promise<ExternalTeamSummary[]> {
  const data = await fetchJson<{ teams?: ExternalTeamSummary[] }>(`${source.baseUrl}/api/public/tournaments/${source.tournamentId}`);
  return data.teams ?? [];
}

export interface ExternalMatchSummary {
  code: string;
  homeTeamName: string;
  awayTeamName: string;
  matchDate?: string;
  matchTime?: string;
  status: string;
}

// The tournament-wide match list — fetched once per sync cycle (not once per
// team) and shared, since it's the same 80-100 rows regardless of which
// team's lineup we're about to look up within it.
export async function fetchExternalMatches(source: ExternalRosterSource): Promise<ExternalMatchSummary[]> {
  return fetchJson<ExternalMatchSummary[]>(`${source.baseUrl}/api/public/tournaments/${source.tournamentId}/matches`);
}

interface ExternalLineupPlayer { playerName: string; jerseyNumber?: number | null }
interface ExternalLineupsRaw { homeLineup?: ExternalLineupPlayer[]; awayLineup?: ExternalLineupPlayer[] }

// The team roster endpoint's own jerseyNumber field is usually null on this
// source — the numbers that actually get assigned live per-MATCH instead, as
// a starting-lineup/bench team sheet (/api/public/matches/{code}/lineups).
// Falls back to the most recently played COMPLETED match involving this team
// as a best-effort snapshot — jersey numbers can in principle vary match to
// match, so this is "what they wore last time", not a guaranteed-current number.
async function fetchLatestLineupJerseys(source: ExternalRosterSource, teamName: string, matches: ExternalMatchSummary[]): Promise<Map<string, number>> {
  const teamMatches = matches
    .filter(m => m.status === 'COMPLETED' && (m.homeTeamName === teamName || m.awayTeamName === teamName))
    .sort((a, b) => `${b.matchDate ?? ''}T${b.matchTime ?? ''}`.localeCompare(`${a.matchDate ?? ''}T${a.matchTime ?? ''}`));
  const latest = teamMatches[0];
  if (!latest) return new Map();
  const lineups = await fetchJson<ExternalLineupsRaw>(`${source.baseUrl}/api/public/matches/${latest.code}/lineups`);
  const lineup = latest.homeTeamName === teamName ? lineups.homeLineup : lineups.awayLineup;
  const map = new Map<string, number>();
  for (const p of lineup ?? []) {
    if (typeof p.jerseyNumber === 'number') map.set(p.playerName.trim().toLowerCase(), p.jerseyNumber);
  }
  return map;
}

export interface ExternalPlayerInfo {
  name: string;
  jerseyNumber?: number;
  position?: string;
  tries?: number;
  conversions?: number;
  penalties?: number;
  dropGoals?: number;
  yellowCards?: number;
  redCards?: number;
  appearances?: number;
}

interface ExternalPlayerRaw {
  firstName?: string; lastName?: string; jerseyNumber?: number; position?: string;
  tries?: number; conversions?: number; penalties?: number; dropGoals?: number;
  yellowCards?: number; redCards?: number; appearances?: number;
}

// Name + jersey/position + the same cumulative-stat fields the source
// exposes (tries/conversions/penalties/dropGoals/cards/appearances) — this
// app's own Player type mirrors this exact field set for a direct, lossless
// pull. jerseyNumber is filled in from the roster's own field when present,
// else falls back to the team's most recent completed match's lineup (see
// fetchLatestLineupJerseys) — best-effort, so a lookup failure (offline, no
// matches played yet) just leaves those players without a number rather than
// failing the whole pull. `matches` lets a caller looping over many teams for
// the same tournament (auto-sync) pass in an already-fetched list instead of
// this refetching it per team.
export async function fetchExternalPlayers(source: ExternalRosterSource, teamSlug: string, matches?: ExternalMatchSummary[]): Promise<ExternalPlayerInfo[]> {
  const data = await fetchJson<{ name?: string; players?: ExternalPlayerRaw[] }>(`${source.baseUrl}/api/public/teams/${teamSlug}`);
  const players = (data.players ?? [])
    .map((p): ExternalPlayerInfo | null => {
      const name = [p.firstName, p.lastName].filter(Boolean).join(' ').trim();
      if (!name) return null;
      return {
        name, jerseyNumber: p.jerseyNumber ?? undefined, position: p.position ?? undefined,
        tries: p.tries ?? undefined, conversions: p.conversions ?? undefined, penalties: p.penalties ?? undefined,
        dropGoals: p.dropGoals ?? undefined, yellowCards: p.yellowCards ?? undefined,
        redCards: p.redCards ?? undefined, appearances: p.appearances ?? undefined,
      };
    })
    .filter((p): p is ExternalPlayerInfo => p !== null);

  if (data.name && players.some(p => p.jerseyNumber === undefined)) {
    try {
      const matchList = matches ?? await fetchExternalMatches(source);
      const lineupJerseys = await fetchLatestLineupJerseys(source, data.name, matchList);
      for (const p of players) {
        if (p.jerseyNumber === undefined) {
          const fromLineup = lineupJerseys.get(p.name.trim().toLowerCase());
          if (fromLineup !== undefined) p.jerseyNumber = fromLineup;
        }
      }
    } catch {
      // Lineup lookup is a best-effort supplement — roster names/stats still
      // come through fine even if this fails.
    }
  }
  return players;
}

// "Girls"/"Boys" (this app's usual youth-tournament wording) and "Women"/
// "Men" (what the source site used in the one tournament seen so far) refer
// to the same split — treated as synonyms so category-aware ranking below
// still works across that wording difference.
function categoryKeywords(category: string): string[] {
  const c = category.toLowerCase();
  const synonymGroups = [['girls', 'women', 'female'], ['boys', 'men', 'male']];
  for (const group of synonymGroups) {
    if (group.some(k => c.includes(k))) return group;
  }
  return [c];
}

// Best-effort ranking so the picker can default to the most likely match
// instead of an alphabetical dump of every team in the tournament — this
// app's teams are usually named just the state/club ("SARAWAK"), while the
// source site spells out the full entry name ("Sarawak U18 7s - Women"), so
// a substring match plus a category-keyword bonus gets close enough that the
// operator usually just has to confirm, not search.
export function rankExternalTeams(teams: ExternalTeamSummary[], localName: string, localCategory?: string): ExternalTeamSummary[] {
  const ln = localName.trim().toLowerCase();
  const catKeywords = localCategory ? categoryKeywords(localCategory) : [];
  const score = (t: ExternalTeamSummary) => {
    const n = t.name.toLowerCase();
    let s = 0;
    if (ln && (n.includes(ln) || ln.includes(n))) s += 2;
    if (catKeywords.some(k => n.includes(k))) s += 1;
    return s;
  };
  return [...teams].sort((a, b) => score(b) - score(a) || a.name.localeCompare(b.name));
}

// ── Periodic auto-sync ───────────────────────────────────────────────────────
// Only ever touches a team that already has `externalTeamSlug` set — i.e. one
// that's been through the manual "Pull from API" picker at least once (see
// ExternalRosterPicker.tsx). That's a deliberate choice: auto-syncing every
// team by re-running the name/category ranking unattended risks silently
// pulling the WRONG team's roster in in an ambiguous case nobody confirmed.
// Once linked, though, re-pulling the exact same external team on a timer is
// safe — this is how tries/cards/etc. actually stay live during a tournament
// instead of going stale the moment the manual pull button is clicked once.
const STAT_KEYS = ['tries', 'conversions', 'penalties', 'dropGoals', 'yellowCards', 'redCards', 'appearances'] as const;

// Stats the app can compute/track itself once a team is switched to
// statsSource:'local' — tries/conversions/penalties/dropGoals are recomputed
// from this team's saved match history (see localPlayerStats.ts), and
// yellowCards/redCards are incremented live the moment a card is given in
// the Player List widget (see giveCard in PlayerListWidget.tsx). Only
// appearances has no local source yet, so it's still API/manual-only.
const LOCAL_TRACKABLE_STAT_KEYS = ['tries', 'conversions', 'penalties', 'dropGoals', 'yellowCards', 'redCards'] as const;

function mergeExternalPlayersIntoTeam(teamId: string, externalPlayers: ExternalPlayerInfo[]) {
  const team = useTeamDbStore.getState().teams.find(t => t.id === teamId);
  if (!team) return;
  // Once local, the API sync must never overwrite the stats the app is now
  // responsible for — otherwise the next periodic sync would immediately
  // stomp a live-counted card or recomputed try tally back to whatever (or
  // however stale) the external source has.
  const skipStats = team.statsSource === 'local';
  const byName = new Map(team.players.map(p => [p.name.trim().toLowerCase(), p]));
  for (const ext of externalPlayers) {
    const existing = byName.get(ext.name.trim().toLowerCase());
    if (existing) {
      // Only ever sets a field the source actually has an opinion on — never
      // blanks out a locally-entered jersey/position/stat just because the
      // source doesn't track it (observed as null across the board today).
      const patch: Partial<Omit<Player, 'id'>> = {};
      if (ext.jerseyNumber !== undefined) patch.jerseyNo = String(ext.jerseyNumber);
      if (ext.position) patch.position = ext.position;
      for (const k of STAT_KEYS) {
        if (skipStats && (LOCAL_TRACKABLE_STAT_KEYS as readonly string[]).includes(k)) continue;
        if (ext[k] !== undefined) patch[k] = ext[k];
      }
      if (Object.keys(patch).length > 0) useTeamDbStore.getState().updatePlayer(teamId, existing.id, patch);
    } else {
      useTeamDbStore.getState().addPlayer(teamId, {
        name: ext.name,
        jerseyNo: ext.jerseyNumber !== undefined ? String(ext.jerseyNumber) : '',
        position: ext.position ?? '',
        tries: skipStats ? undefined : ext.tries, conversions: skipStats ? undefined : ext.conversions,
        penalties: skipStats ? undefined : ext.penalties, dropGoals: skipStats ? undefined : ext.dropGoals,
        yellowCards: skipStats ? undefined : ext.yellowCards, redCards: skipStats ? undefined : ext.redCards,
        appearances: ext.appearances,
      });
    }
  }
}

async function autoSyncRosters() {
  for (const t of useTournamentStore.getState().tournaments) {
    const source = t.externalRoster;
    if (!source) continue;
    const linkedTeams = useTeamDbStore.getState().teams.filter(tm => tm.tournamentId === t.id && tm.externalTeamSlug);
    if (linkedTeams.length === 0) continue;
    // Fetched once per tournament, not once per team — every linked team's
    // lineup lookup shares this same match list.
    const matches = await fetchExternalMatches(source).catch(() => undefined);
    for (const team of linkedTeams) {
      try {
        const players = await fetchExternalPlayers(source, team.externalTeamSlug!, matches);
        if (players.length > 0) mergeExternalPlayersIntoTeam(team.id, players);
      } catch {
        // Offline, or the source is briefly unreachable — just skip this
        // team this cycle, the next one retries.
      }
    }
  }
}

const ROSTER_AUTO_SYNC_INTERVAL_MS = 2 * 60 * 1000;
let rosterAutoSyncTimer: ReturnType<typeof setInterval> | null = null;

/** Starts the background roster refresh loop — call once from the desktop
 *  host (see cloudSync.ts's startCloudSync). No-ops if already running. */
export function startRosterAutoSync() {
  if (rosterAutoSyncTimer) return;
  autoSyncRosters();
  rosterAutoSyncTimer = setInterval(autoSyncRosters, ROSTER_AUTO_SYNC_INTERVAL_MS);
}

export function stopRosterAutoSync() {
  if (rosterAutoSyncTimer) clearInterval(rosterAutoSyncTimer);
  rosterAutoSyncTimer = null;
}
