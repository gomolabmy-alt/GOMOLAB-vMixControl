import type { CanvasPage, CanvasWidget } from '../types/canvas';
import { autoLinkedWidgetPair } from './autoLink';
import { resolvePlayerListRoster } from './playerListSquad';
import { useTeamDbStore } from '../stores/teamDbStore';
import { useTournamentStore } from '../stores/tournamentStore';
import { useAppSettings } from '../stores/appSettingsStore';
import { simplifyPlayerName } from './simpleName';
import { SPORT_DEFAULTS } from '../types/tournament';
import type { SavedTeam } from '../stores/teamDbStore';

export interface CompanionScorerChoice {
  jerseyNo: string;
  name: string;
}

export interface CompanionScoreSlot {
  section: 'starter' | 'sub';
  /** 0-based, matching the Player List's own starters/subs array index. */
  index: number;
  /** Empty when the slot currently has no player assigned. */
  jerseyNo: string;
  name: string;
}

export interface CompanionScoreTarget {
  /** `${widgetId}:score:${team}:${incrementIndex}` — distinct from button
   *  target ids (see hotkeyBindings.ts), so one COMPANION_TRIGGER handler
   *  can tell the two apart unambiguously. */
  id: string;
  label: string;
  widgetId: string;
  /** The Scoreboard widget's own label (or "Board N" if unset) — for
   *  labeling a score type by which board it belongs to, not which team,
   *  since a type like "Try" isn't owned by either team. */
  widgetLabel: string;
  team: 'A' | 'B';
  teamName: string;
  value: number;
  scoreLabel: string;
  /** The team's current on-field + bench roster (from whichever Player List
   *  widget this Scoreboard is linked/auto-paired to), sorted by jersey
   *  number — empty if no roster is linked, in which case scoring still
   *  works, just without a scorer recorded. */
  scorers: CompanionScorerChoice[];
  /** Every starter/sub slot of that same linked Player List, in original
   *  position order (including empty ones) — lets Companion target a
   *  *position* ("Starter 3") rather than a specific player, so whoever
   *  currently holds that slot scores, automatically following any
   *  substitution without the Companion button needing reconfiguring. */
  slots: CompanionScoreSlot[];
}

type Increment = number | { label: string; value: number };

function resolveInc(inc: Increment): { label: string; value: number } {
  if (typeof inc === 'number') return { label: `+${inc}`, value: inc };
  return { label: inc.label || `+${inc.value}`, value: inc.value };
}

// Mirrors ScoreboardWidget.tsx's own resolveSquad/squadA/squadB useMemo
// logic (same autoLinkedWidgetPair + resolvePlayerListRoster calls), just
// outside of React so it can run from companionBridge.ts. Every Scoreboard
// widget on every page gets its own target set, keyed off its own linked
// roster — multiple Scoreboard widgets never share or clobber each other's
// scorer lists.
export function collectCompanionScoreTargets(pages: CanvasPage[]): CompanionScoreTarget[] {
  const out: CompanionScoreTarget[] = [];
  const teamDbTeams = useTeamDbStore.getState().teams;
  const tournaments = useTournamentStore.getState().tournaments;
  let boardIdx = 0;

  for (const page of pages) {
    for (const w of page.widgets) {
      if (w.type !== 'scoreboard') continue;
      boardIdx++;
      const widgetLabel = w.label || `Board ${boardIdx}`;
      const cfg: any = w.config ?? {};

      const increments = ((cfg.increments ?? [1, 2, 5, 10]) as Increment[])
        .map(resolveInc)
        .filter(i => i.value > 0);
      if (increments.length === 0) continue;

      const { a: playerListA, b: playerListB } = autoLinkedWidgetPair(
        pages, w.id, cfg.linkedPlayerListA, cfg.linkedPlayerListB, 'player-list',
      );

      const { simplifyMuhammadNames, simplifyFirstNameOnly, removeBinMarkers, truncateAtBinMarker } = useAppSettings.getState();
      const disp = (name: string) => simplifyPlayerName(name, { simplifyMuhammad: simplifyMuhammadNames, firstNameOnly: simplifyFirstNameOnly, removeBinMarkers, truncateAtBinMarker });

      const buildSquad = (plw: typeof playerListA, side: 'A' | 'B'): CompanionScorerChoice[] => {
        const { team, starters, subs } = resolvePlayerListRoster(plw, side, teamDbTeams);
        const players = team?.players ?? [];
        const assigned = new Set([...starters, ...subs].filter(Boolean));
        return players
          .filter(p => assigned.has(p.id))
          .sort((a, b) => (parseInt(a.jerseyNo) || 999) - (parseInt(b.jerseyNo) || 999))
          .map(p => ({ jerseyNo: p.jerseyNo || '', name: disp(p.name) }));
      };
      const squadA = buildSquad(playerListA, 'A');
      const squadB = buildSquad(playerListB, 'B');

      const tournamentId: string | undefined = cfg.linkedTournamentId || page.tournamentId;
      const tournament = tournaments.find(t => t.id === tournamentId);
      const settings = tournament ? (tournament.settings ?? SPORT_DEFAULTS[tournament.sport]) : undefined;
      const maxOnField = settings?.maxOnField ?? 11;
      const maxSubs = settings?.maxSubs ?? 7;

      const buildSlots = (plw: CanvasWidget | undefined, side: 'A' | 'B'): CompanionScoreSlot[] => {
        const { team, starters, subs } = resolvePlayerListRoster(plw, side, teamDbTeams);
        const playerById = Object.fromEntries((team?.players ?? []).map((p: SavedTeam['players'][number]) => [p.id, p]));
        const slots: CompanionScoreSlot[] = [];
        for (let i = 0; i < maxOnField; i++) {
          const p = starters[i] ? playerById[starters[i]] : undefined;
          slots.push({ section: 'starter', index: i, jerseyNo: p?.jerseyNo || '', name: p ? disp(p.name) : '' });
        }
        for (let i = 0; i < maxSubs; i++) {
          const p = subs[i] ? playerById[subs[i]] : undefined;
          slots.push({ section: 'sub', index: i, jerseyNo: p?.jerseyNo || '', name: p ? disp(p.name) : '' });
        }
        return slots;
      };
      const slotsA = buildSlots(playerListA, 'A');
      const slotsB = buildSlots(playerListB, 'B');

      const teamAName = cfg.teamAName || 'Team A';
      const teamBName = cfg.teamBName || 'Team B';

      increments.forEach((inc, i) => {
        out.push({ id: `${w.id}:score:A:${i}`, label: `${teamAName} — ${inc.label}`, widgetId: w.id, widgetLabel, team: 'A', teamName: teamAName, value: inc.value, scoreLabel: inc.label, scorers: squadA, slots: slotsA });
        out.push({ id: `${w.id}:score:B:${i}`, label: `${teamBName} — ${inc.label}`, widgetId: w.id, widgetLabel, team: 'B', teamName: teamBName, value: inc.value, scoreLabel: inc.label, scorers: squadB, slots: slotsB });
      });
    }
  }
  return out;
}

export interface CompanionLastScorer {
  scorer: string;
  jerseyNo: string;
  action: string;
}

export interface CompanionScoreboardStatus {
  widgetId: string;
  teamAName: string;
  teamBName: string;
  scoreA: number;
  scoreB: number;
  /** Most recent scoreLog entry for that team, whatever it was (a scorer
   *  isn't required to have been picked) — undefined only once that team
   *  has never scored at all this match. */
  lastA?: CompanionLastScorer;
  lastB?: CompanionLastScorer;
  /** Raw stored logo URL — same one vMix/PlayerStatsWidget fetch directly
   *  (already LAN-reachable, not the app-webview-only resolveImageUrl()
   *  substitution) — empty string if no logo is set for that team. */
  teamALogo: string;
  teamBLogo: string;
}

// One entry per Scoreboard widget on the canvas, carrying its live score
// and each team's most recent scoring event — feeds Companion Variables so
// a Stream Deck button's own text can show "who scored" without the module
// needing any separate polling of its own (see companionBridge.ts's
// COMPANION_FEEDBACK broadcast). scoreLog is stored most-recent-first (see
// scoreWidgetAction in canvasStore.ts), so the first matching entry per
// team is already the latest one.
export function collectCompanionScoreboardStatus(pages: CanvasPage[]): CompanionScoreboardStatus[] {
  const out: CompanionScoreboardStatus[] = [];
  for (const page of pages) {
    for (const w of page.widgets) {
      if (w.type !== 'scoreboard') continue;
      const cfg: any = w.config ?? {};
      const log: any[] = cfg.scoreLog ?? [];
      const lastA = log.find(e => e.team === 'A');
      const lastB = log.find(e => e.team === 'B');
      out.push({
        widgetId: w.id,
        teamAName: cfg.teamAName || 'Team A',
        teamBName: cfg.teamBName || 'Team B',
        scoreA: cfg.scoreA ?? 0,
        scoreB: cfg.scoreB ?? 0,
        lastA: lastA ? { scorer: lastA.scorer || '', jerseyNo: lastA.jerseyNo || '', action: lastA.action || '' } : undefined,
        lastB: lastB ? { scorer: lastB.scorer || '', jerseyNo: lastB.jerseyNo || '', action: lastB.action || '' } : undefined,
        teamALogo: cfg.teamALogo || '',
        teamBLogo: cfg.teamBLogo || '',
      });
    }
  }
  return out;
}
