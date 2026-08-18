import type { CanvasPage, CanvasWidget } from '../types/canvas';
import { formatTime } from '../stores/canvasStore';
import { periodLabel } from '../components/widgets/TimerWidget';
import { isDualPlayerList, resolvePlayerListRoster } from './playerListSquad';
import { autoLinkedWidget, autoLinkedWidgetPair } from './autoLink';
import { findTeamRecord } from './teamForm';
import { useTeamDbStore } from '../stores/teamDbStore';
import { useTournamentStore } from '../stores/tournamentStore';
import { useAppSettings } from '../stores/appSettingsStore';
import { simplifyPlayerName } from './simpleName';
import { SPORT_DEFAULTS } from '../types/tournament';

export interface CompanionAppTextField {
  widgetId: string;
  widgetType: string;
  /** 1-based index among widgets of the same type on the canvas — used to
   *  build a stable, readable variable id (e.g. "timer1_time") without
   *  leaking widget uuids into it. */
  typeIndex: number;
  widgetLabel: string;
  fieldName: string;
  value: string;
}

// Human-friendly section name per widget type, in the fixed order they're
// collected — this is what makes the flat Companion dropdown/variable list
// read as grouped "sections" (Companion has no native dropdown grouping).
const TYPE_SECTIONS: { type: string; label: string }[] = [
  { type: 'timer', label: 'Timer' },
  { type: 'pomodoro', label: 'Custom Timer' },
  { type: 'label', label: 'Label' },
  { type: 'file-path', label: 'File Path' },
  { type: 'player-list', label: 'Player List' },
  { type: 'player-list-next', label: 'Player List' },
  { type: 'player-lower-third', label: 'Player Lower Third' },
  { type: 'player-stats', label: 'Player Stats' },
  { type: 'player-h2h', label: 'Head to Head' },
  { type: 'rugby-lineup', label: 'Rugby Lineup' },
  { type: 'timeline', label: 'Timeline' },
  { type: 'score-lower-third', label: 'Score Lower Third' },
  { type: 'sin-bin-lower-third', label: 'Sin Bin Lower Third' },
  { type: 'card-lower-third', label: 'Card Lower Third' },
  { type: 'card-display', label: 'Card Display' },
];
const TYPE_DISPLAY: Record<string, string> = Object.fromEntries(TYPE_SECTIONS.map(s => [s.type, s.label]));

const STAT_KEYS = ['appearances', 'tries', 'conversions', 'penalties', 'dropGoals', 'yellowCards', 'redCards'] as const;
const STAT_LABELS: Record<string, string> = {
  appearances: 'Appearances', tries: 'Tries', conversions: 'Conversions',
  penalties: 'Penalties', dropGoals: 'Drop Goals', yellowCards: 'Yellow Cards', redCards: 'Red Cards',
};

function cardTypeOf(cards: ('yellow' | 'orange' | 'red')[]): string {
  if (cards.includes('red')) return 'red';
  if (cards.includes('yellow')) return 'yellow';
  return 'orange';
}

// One-line text for a TimelineEvent, mirroring TimelineWidget.tsx's own
// renderHCard label logic (JSX there, plain string here).
function describeEvent(ev: any): string {
  const named = (name?: string, jersey?: string) => name ? `${jersey ? `#${jersey} ` : ''}${name}` : '';
  switch (ev.type) {
    case 'score': {
      const scoreLabel = ev.scoreA !== undefined ? ` [${ev.scoreA}-${ev.scoreB}]` : '';
      const player = named(ev.player, ev.jerseyNo);
      return `${ev.detail || 'Score'}${scoreLabel}${player ? ` — ${player}` : ''}`;
    }
    case 'yellow-card': return `Yellow Card${named(ev.player, ev.jerseyNo) ? ` — ${named(ev.player, ev.jerseyNo)}` : ''}`;
    case 'orange-card': return `Orange Card${named(ev.player, ev.jerseyNo) ? ` — ${named(ev.player, ev.jerseyNo)}` : ''}`;
    case 'red-card': return `Red Card${named(ev.player, ev.jerseyNo) ? ` — ${named(ev.player, ev.jerseyNo)}` : ''}`;
    case 'substitution': {
      const on = named(ev.player, ev.jerseyNo);
      const off = named(ev.playerOff, ev.jerseyNoOff);
      return [on && `On: ${on}`, off && `Off: ${off}`].filter(Boolean).join(' / ');
    }
    case 'custom': return ev.detail ?? '';
    default: return ev.detail || ev.type || '';
  }
}

// Surfaces what the controller app itself is currently showing — not vMix's
// raw input state — for every widget type where "what's displayed" is
// reasonably derivable from widget.config (+ small store lookups already
// used elsewhere in the app, e.g. resolvePlayerListRoster/findTeamRecord).
// Grouped into sections by widget type (TYPE_SECTIONS above), in a fixed
// order, so the flat list Companion works with still reads as organized.
//
// Deliberately NOT covered (see companion-module/README.md for the reasons):
//   - tbar, volume, overlay, input-tally, transitions — their live state is
//     entirely vMix-state, not config, so out of scope for an app-display
//     (not vMix-state) feature.
//   - substitution, ndi-input, panel, vmix-titles, title-field — their
//     interesting "currently shown" values live in local React useState,
//     never written to widget.config, so nothing outside React can see
//     them without those widgets being refactored to persist that state.
//   - recent-matches, match-schedule, standings, bracket, team-form — their
//     content is computed live from matchResultsStore/matchScheduleStore/
//     tournamentStore, not widget.config; a real port needs its own
//     collector reading those stores, not a config read (a bigger,
//     separate follow-up).
export function collectCompanionAppText(pages: CanvasPage[]): CompanionAppTextField[] {
  const out: CompanionAppTextField[] = [];
  const teams = useTeamDbStore.getState().teams;
  const tournaments = useTournamentStore.getState().tournaments;
  const { simplifyMuhammadNames, simplifyFirstNameOnly, removeBinMarkers, truncateAtBinMarker } = useAppSettings.getState();
  const disp = (name: string) => simplifyPlayerName(name, { simplifyMuhammad: simplifyMuhammadNames, firstNameOnly: simplifyFirstNameOnly, removeBinMarkers, truncateAtBinMarker });

  const push = (idx: number, w: CanvasWidget, label: string, fieldName: string, value: string) =>
    out.push({ widgetId: w.id, widgetType: w.type, typeIndex: idx, widgetLabel: label, fieldName, value });

  const widgetsOfType = (type: string): { page: CanvasPage; w: CanvasWidget }[] => {
    const found: { page: CanvasPage; w: CanvasWidget }[] = [];
    for (const page of pages) for (const w of page.widgets) if (w.type === type) found.push({ page, w });
    return found;
  };

  const tournamentIdFor = (w: CanvasWidget, page: CanvasPage, cfg: any): string | undefined =>
    cfg.linkedTournamentId || page.tournamentId;

  const scoreboardOf = (w: CanvasWidget, cfg: any) => autoLinkedWidget(pages, w.id, cfg.linkedScoreboardId, 'scoreboard');

  for (const section of TYPE_SECTIONS) {
    const widgets = widgetsOfType(section.type);
    widgets.forEach(({ page, w }, i) => {
      const idx = i + 1;
      const cfg: any = w.config ?? {};
      const label = w.label || `${section.label} ${idx}`;

      switch (w.type) {
        case 'timer': {
          const periods = cfg.periods ?? 1;
          const currentPeriod = cfg.currentPeriod ?? 1;
          const etPeriods = cfg.extraTimePeriods ?? 0;
          const etCurrentPeriod = cfg.etCurrentPeriod ?? 1;
          const inBreak = !!cfg.inBreak;
          const inExtraTime = !!cfg.inExtraTime;
          const etInBreak = !!cfg.etInBreak;
          const inAfterEt = !!cfg.inAfterEt;
          const inFinalPlay = !!cfg.inFinalPlay;
          const fmt = cfg.format ?? 'mm:ss';
          const time = (ms: number) => formatTime(ms ?? 0, fmt, cfg);

          // Mirrors TimerWidget.tsx's own activeMs phase-selection — so
          // "Time" always matches whatever the widget itself is showing
          // right now, instead of freezing on the main clock during a
          // break/ET/after-ET/Final Play (the bug this fixes).
          const activeMs = inFinalPlay ? (cfg.finalPlayMs ?? 0)
            : inAfterEt ? (cfg.afterEtCurrentMs ?? 0)
            : inExtraTime ? (etInBreak ? (cfg.etBreakCurrentMs ?? 0) : (cfg.etCurrentMs ?? 0))
            : inBreak ? (cfg.breakCurrentMs ?? 0)
            : (cfg.currentMs ?? 0);

          const stage = inFinalPlay ? 'Final Play'
            : inAfterEt ? (cfg.afterEtMode === 'goldenPoint' ? 'Golden Point' : 'Sudden Death')
            : inExtraTime ? (etInBreak ? 'ET Break' : (etPeriods > 1 ? `Extra Time ${etCurrentPeriod}` : 'Extra Time'))
            : inBreak ? 'Half Time'
            : periods > 1 ? periodLabel(Math.min(currentPeriod, periods), periods) : 'Regulation';

          push(idx, w, label, 'Time', time(activeMs));
          push(idx, w, label, 'Stage', stage);
          push(idx, w, label, 'Period', periods > 1 ? periodLabel(Math.min(currentPeriod, periods), periods) : '');
          push(idx, w, label, 'Status', cfg.running ? 'Running' : 'Paused');
          // Dedicated per-phase fields — always that phase's own time
          // regardless of which one is currently active, for a button that
          // should always show (e.g.) Final Play time specifically.
          push(idx, w, label, 'Main Clock Time', time(cfg.currentMs));
          push(idx, w, label, 'Half Time', time(cfg.breakCurrentMs));
          push(idx, w, label, 'Extra Time', time(cfg.etCurrentMs));
          push(idx, w, label, 'ET Break', time(cfg.etBreakCurrentMs));
          push(idx, w, label, 'After ET', time(cfg.afterEtCurrentMs));
          push(idx, w, label, 'Final Play', time(cfg.finalPlayMs));
          break;
        }

        case 'pomodoro': {
          push(idx, w, label, 'Time', formatTime(cfg.currentMs ?? 0, 'mm:ss'));
          push(idx, w, label, 'Status', cfg.running ? 'Running' : 'Paused');
          break;
        }

        case 'label': {
          push(idx, w, label, 'Text', cfg.text ?? '');
          break;
        }

        case 'file-path': {
          push(idx, w, label, 'Path', cfg.currentPath ?? '');
          break;
        }

        case 'player-list':
        case 'player-list-next': {
          const tournamentId = tournamentIdFor(w, page, cfg);
          const tournament = tournaments.find(t => t.id === tournamentId);
          const settings = tournament ? (tournament.settings ?? SPORT_DEFAULTS[tournament.sport]) : undefined;
          const maxOnField = settings?.maxOnField ?? 11;
          const maxSubs = settings?.maxSubs ?? 7;
          const dual = isDualPlayerList(w);
          const sides: ('A' | 'B')[] = dual ? ['A', 'B'] : ['A'];

          for (const side of sides) {
            const { team, starters, subs } = resolvePlayerListRoster(w, side, teams);
            const playerById = Object.fromEntries((team?.players ?? []).map(p => [p.id, p]));
            const sidePrefix = dual ? `${side} — ` : '';
            for (let s = 0; s < maxOnField; s++) {
              const player = starters[s] ? playerById[starters[s]] : undefined;
              push(idx, w, label, `${sidePrefix}Starter ${s + 1}`, player?.jerseyNo || '-');
            }
            for (let s = 0; s < maxSubs; s++) {
              const player = subs[s] ? playerById[subs[s]] : undefined;
              push(idx, w, label, `${sidePrefix}Sub ${s + 1}`, player?.jerseyNo || '-');
            }
          }
          break;
        }

        case 'player-lower-third': {
          push(idx, w, label, 'Name', cfg.highlightedName ?? '');
          push(idx, w, label, 'Jersey', cfg.highlightedJersey ?? '');
          push(idx, w, label, 'Position', cfg.highlightedPosition ?? '');
          push(idx, w, label, 'Team', cfg.highlightedTeam ?? '');
          push(idx, w, label, 'Score Summary', cfg.highlightedScoreSummary ?? '');
          break;
        }

        case 'player-stats':
        case 'player-h2h': {
          const linkedScoreboard = scoreboardOf(w, cfg);
          const dc = linkedScoreboard?.config ?? {};
          const teamAName = dc.teamAName || 'Team A';
          const teamBName = dc.teamBName || 'Team B';
          const category = dc.category;
          const tournamentId = dc.linkedTournamentId || tournamentIdFor(w, page, cfg);

          const pushPlayerStats = (prefix: string, teamName: string, playerId: string | undefined) => {
            const teamRecord = findTeamRecord(teams, teamName, category, tournamentId);
            const player = teamRecord?.players.find(p => p.id === playerId);
            push(idx, w, label, `${prefix}Name`, player ? disp(player.name) : '');
            push(idx, w, label, `${prefix}Jersey`, player?.jerseyNo ?? '');
            push(idx, w, label, `${prefix}Team`, player ? teamName : '');
            for (const key of STAT_KEYS) push(idx, w, label, `${prefix}${STAT_LABELS[key]}`, player ? String((player as any)[key] ?? 0) : '');
          };

          if (w.type === 'player-stats') {
            const side: 'A' | 'B' = cfg.teamSide === 'B' ? 'B' : 'A';
            pushPlayerStats('', side === 'A' ? teamAName : teamBName, cfg.playerId);
          } else {
            pushPlayerStats('Player A — ', teamAName, cfg.playerAId);
            pushPlayerStats('Player B — ', teamBName, cfg.playerBId);
          }
          break;
        }

        case 'rugby-lineup': {
          const linkedTeam = teams.find(t => t.id === cfg.linkedTeamId);
          push(idx, w, label, 'Team', linkedTeam?.name ?? cfg.teamName ?? '');
          const players = (cfg.players?.length === 15) ? cfg.players : [];
          for (let p = 0; p < 15; p++) {
            const rp = players[p];
            push(idx, w, label, `Position ${p + 1}`, rp?.name ? `#${rp.jerseyNo ?? ''} ${disp(rp.name)}`.trim() : '-');
          }
          break;
        }

        case 'timeline': {
          // Mirrors TimelineWidget.tsx's own allEvents: its own config.events
          // (cards/custom notes — addTimelineEvent writes these) merged with
          // score events derived live from the linked Scoreboard's scoreLog
          // (never stored in the Timeline's own config at all) — missing the
          // second source was exactly why "latest event" went stale whenever
          // the most recent thing that happened was a score.
          const linkedScoreboard = scoreboardOf(w, cfg);
          const sbCfg = linkedScoreboard?.config ?? {};
          const scoreEvents = ((sbCfg.scoreLog ?? []) as any[]).map(e => ({
            type: 'score', timeStr: e.timeStr ?? '', timeMs: e.timeMs ?? 0,
            player: e.scorer ? disp(e.scorer) : undefined, jerseyNo: e.jerseyNo || undefined,
            detail: e.action, scoreA: e.scoreA, scoreB: e.scoreB,
          }));
          const ownEvents: any[] = Array.isArray(cfg.events) ? cfg.events : [];
          const allEvents = [...ownEvents, ...scoreEvents].sort((a, b) => (b.timeMs ?? 0) - (a.timeMs ?? 0));

          const pushLatest = (fieldName: string, ev: any | undefined) => {
            push(idx, w, label, fieldName, ev ? describeEvent(ev) : '');
            push(idx, w, label, `${fieldName} Time`, ev?.timeStr ?? '');
          };
          // Separate per-type fields — not just one generic "latest" — so a
          // Companion button/variable can pick exactly the kind of event it
          // cares about (e.g. "Latest Card" even if a score happened after).
          pushLatest('Latest Event', allEvents[0]);
          pushLatest('Latest Score', allEvents.find(e => e.type === 'score'));
          pushLatest('Latest Card', allEvents.find(e => e.type === 'yellow-card' || e.type === 'orange-card' || e.type === 'red-card'));
          pushLatest('Latest Substitution', allEvents.find(e => e.type === 'substitution'));
          break;
        }

        case 'score-lower-third': {
          const linkedScoreboard = scoreboardOf(w, cfg);
          const sbCfg = linkedScoreboard?.config ?? {};
          const log: any[] = sbCfg.scoreLog ?? [];
          const filter: 'A' | 'B' | 'all' = cfg.teamFilter ?? 'all';
          const entry = log.find(e => filter === 'all' || e.team === filter);
          push(idx, w, label, 'Team', entry?.teamName ?? '');
          push(idx, w, label, 'Scorer', entry?.scorer ? disp(entry.scorer) : '');
          push(idx, w, label, 'Jersey', entry?.jerseyNo ?? '');
          push(idx, w, label, 'Action', entry?.action ?? '');
          push(idx, w, label, 'Time', entry?.timeStr ?? '');
          break;
        }

        case 'sin-bin-lower-third': {
          const plw = autoLinkedWidget(pages, w.id, cfg.linkedPlayerListId, 'player-list');
          const plCfg = plw?.config ?? {};
          const side: 'A' | 'B' = plCfg.teamSide === 'B' ? 'B' : 'A';
          const { team } = resolvePlayerListRoster(plw, side, teams);
          const sinBinEntries: Record<string, number> = plCfg.sinBinEntries ?? {};
          const names = Object.keys(sinBinEntries)
            .map(pid => team?.players.find(p => p.id === pid))
            .filter(Boolean)
            .map(p => `#${p!.jerseyNo || '-'} ${disp(p!.name)}`);
          push(idx, w, label, 'Sin Binned', names.join(', ') || '-');
          break;
        }

        case 'card-lower-third':
        case 'card-display': {
          const { a: playerListA, b: playerListB } = autoLinkedWidgetPair(
            pages, w.id, cfg.linkedPlayerListA, cfg.linkedPlayerListB, 'player-list',
          );
          const sideText = (plw: CanvasWidget | undefined, side: 'A' | 'B') => {
            const { team, playerCards } = resolvePlayerListRoster(plw, side, teams);
            const names = Object.entries(playerCards)
              .map(([pid, cards]) => {
                const player = team?.players.find(p => p.id === pid);
                if (!player) return null;
                return `#${player.jerseyNo || '-'} ${disp(player.name)} (${cardTypeOf(cards as any)})`;
              })
              .filter(Boolean);
            return names.join(', ') || '-';
          };
          push(idx, w, label, 'Team A Carded', sideText(playerListA, 'A'));
          push(idx, w, label, 'Team B Carded', sideText(playerListB, 'B'));
          break;
        }

        default:
          break;
      }
    });
  }

  return out;
}

export interface CompanionTimerStage {
  widgetId: string;
  widgetLabel: string;
  periods: number;
  currentPeriod: number;
  inBreak: boolean;
  inExtraTime: boolean;
  etCurrentPeriod: number;
  etPeriods: number;
  etInBreak: boolean;
  inAfterEt: boolean;
  inFinalPlay: boolean;
  running: boolean;
}

// Per-Timer-widget stage state, for a "Timer stage active" feedback —
// separate from collectCompanionAppText's plain display strings because a
// feedback needs to compare structured state (which period, which special
// stage), not just show text. Numbers timers in the same order
// collectCompanionAppText does, so `Timer N` labels line up between the two.
export function collectCompanionTimerStages(pages: CanvasPage[]): CompanionTimerStage[] {
  const out: CompanionTimerStage[] = [];
  let idx = 0;
  for (const page of pages) {
    for (const w of page.widgets) {
      if (w.type !== 'timer') continue;
      idx++;
      const cfg: any = w.config ?? {};
      out.push({
        widgetId: w.id,
        widgetLabel: w.label || `${TYPE_DISPLAY.timer} ${idx}`,
        periods: cfg.periods ?? 1,
        currentPeriod: cfg.currentPeriod ?? 1,
        inBreak: !!cfg.inBreak,
        inExtraTime: !!cfg.inExtraTime,
        etCurrentPeriod: cfg.etCurrentPeriod ?? 1,
        etPeriods: cfg.extraTimePeriods ?? 0,
        etInBreak: !!cfg.etInBreak,
        inAfterEt: !!cfg.inAfterEt,
        inFinalPlay: !!cfg.inFinalPlay,
        running: !!cfg.running,
      });
    }
  }
  return out;
}
