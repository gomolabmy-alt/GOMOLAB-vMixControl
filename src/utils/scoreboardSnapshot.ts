import { useMemo } from 'react';
import type { SavedMatchResult } from '../stores/matchResultsStore';
import { useTeamDbStore } from '../stores/teamDbStore';
import { useMatchScheduleStore, type ScheduledMatch } from '../stores/matchScheduleStore';
import { useCanvasStore } from '../stores/canvasStore';
import { computeShootoutStatus } from '../lib/shootout';

function formatTimeOfDay(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

// Parses "YYYY-MM-DD" + an optional loose time string ("20:30", "8:30 PM",
// "8:30pm") into a local-timezone epoch ms — shared by anything that needs
// to sort/compare fixtures or results by their actual scheduled kickoff
// instead of string-sorting the date/time fields separately.
export function parseScheduledDateTime(date: string | undefined, time?: string): number | null {
  const dm = date?.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!dm) return null;
  const [, y, mo, d] = dm;
  let hours = 0, minutes = 0;
  if (time) {
    const tm = time.trim().match(/^(\d{1,2}):(\d{2})\s*(AM|PM|am|pm)?$/);
    if (tm) {
      hours = parseInt(tm[1], 10);
      minutes = parseInt(tm[2], 10);
      const ampm = tm[3]?.toUpperCase();
      if (ampm === 'PM' && hours < 12) hours += 12;
      if (ampm === 'AM' && hours === 12) hours = 0;
    }
  }
  return new Date(Number(y), Number(mo) - 1, Number(d), hours, minutes, 0, 0).getTime();
}

// "37m" / "2h 14m" / "1d 3h" — how far past its scheduled time something
// is. Shared between MatchScheduleWidget and RundownWidget's late badges.
export function formatLate(ms: number): string {
  const totalMin = Math.max(0, Math.floor(ms / 60000));
  if (totalMin < 60) return `${totalMin}m`;
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h < 24) return `${h}h ${m}m`;
  const d = Math.floor(h / 24);
  return `${d}d ${h % 24}h`;
}

// Shared between ScoreboardWidget (its own "Save Result"/"Load Match") and
// MatchScheduleWidget ("Send to Scoreboard") so both paths protect against
// silently overwriting a match that hasn't been saved yet.

/** A cheap signature of "what result would be saved right now" — used to
 *  detect whether the board's current match matches what was last saved. */
export function computeMatchSignature(cfg: Record<string, any>): string {
  return [
    cfg.teamAName ?? '', cfg.teamBName ?? '',
    cfg.scoreA ?? 0, cfg.scoreB ?? 0,
    cfg.competition ?? '', cfg.subtitle ?? '',
  ].join('|');
}

export function hasScoreboardContent(cfg: Record<string, any>): boolean {
  return !!(cfg.teamAName || cfg.teamBName);
}

// Best-effort "how much game time was actually played" summary from a
// linked Timer widget's raw config at save time — mirrors the same fields
// TimerWidget.tsx's own accumulatedMs calc reads, but converts a countdown
// clock's *remaining* time into *elapsed* time (accumulatedMs returns the
// remaining value as-is for countdown, since that's what the on-screen
// display shows — not useful for "how long was played" after the fact).
// Deliberately simplified: doesn't replicate every overrun/continue-mode
// edge case TimerWidget's display logic handles, just regular periods +
// extra time + after-ET added together.
function computeTimerSummary(timerCfg: Record<string, any> | undefined): SavedMatchResult['timerSummary'] {
  if (!timerCfg) return undefined;
  const isCountdown = (timerCfg.mode ?? 'countdown') === 'countdown';
  const periods = timerCfg.periods ?? 1;
  const currentPeriod = Math.min(timerCfg.currentPeriod ?? 1, periods);
  const durationMs = timerCfg.durationMs ?? 0;

  const regularElapsedMs = isCountdown
    ? (currentPeriod - 1) * durationMs + Math.max(0, durationMs - (timerCfg.currentMs ?? 0))
    : (currentPeriod - 1) * durationMs + (timerCfg.currentMs ?? 0);

  const wentToExtraTime = !!timerCfg.inExtraTime || (timerCfg.etCurrentMs ?? 0) > 0;
  const wentToAfterEt = !!timerCfg.inAfterEt || (timerCfg.afterEtMode ?? 'none') !== 'none';
  const etElapsedMs = wentToExtraTime ? (timerCfg.etCurrentMs ?? 0) : 0;
  const afterEtElapsedMs = wentToAfterEt ? (timerCfg.afterEtCurrentMs ?? 0) : 0;

  return {
    elapsedMs: Math.max(0, regularElapsedMs) + etElapsedMs + afterEtElapsedMs,
    periodsPlayed: currentPeriod,
    wentToExtraTime,
    wentToAfterEt,
  };
}

// Resolves the SavedTeam behind a Player List widget's own roster — reuses
// the same `resolvedTeamId` cache that widget already writes back onto its
// own config for every OTHER consumer needing its roster (Card Display,
// Timeline highlight, etc. — see PlayerListWidget.tsx's own comment on
// resolvedAId/resolvedBId) instead of re-deriving team resolution here too.
// Falls back to a directly-picked team (linkedTeamId) for a widget in that
// simpler mode, where no scoreboard-follow resolution ever ran.
function resolveRosterTeam(plwCfg: Record<string, any>) {
  const teamId = plwCfg.resolvedTeamId || plwCfg.linkedTeamId;
  return teamId ? useTeamDbStore.getState().teams.find(t => t.id === teamId) : undefined;
}

export function buildResultFromConfig(cfg: Record<string, any>, timerCfg?: Record<string, any>): Omit<SavedMatchResult, 'id' | 'savedAt'> {
  const today = new Date();
  const dateStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  // Prefer the explicit tournament link, set when a scheduled fixture was
  // loaded onto this scoreboard (Load Match / Send to Scoreboard) — reliable
  // regardless of team naming. Falls back to matching Team A's name against
  // a saved team for scoreboards filled in manually with no fixture link.
  const tournamentId = cfg.linkedTournamentId || useTeamDbStore.getState().teams.find(
    t => t.name.trim().toLowerCase() === (cfg.teamAName ?? '').trim().toLowerCase()
  )?.tournamentId;
  // Kickoff = the moment the linked timer actually started running (captured
  // by ScoreboardWidget), not the pre-scheduled fixture time — falls back to
  // the fixture's scheduled time if the timer was never started.
  const time = cfg.actualKickoffAt
    ? formatTimeOfDay(cfg.actualKickoffAt)
    : cfg.linkedScheduleMatchId
      ? useMatchScheduleStore.getState().matches.find(m => m.id === cfg.linkedScheduleMatchId)?.time
      : undefined;
  return {
    date: dateStr,
    time,
    tournamentId,
    competition: cfg.competition || undefined,
    round: cfg.subtitle || undefined,
    group: cfg.group || undefined,
    tier: cfg.tier || undefined,
    category: cfg.category || undefined,
    teamAId: cfg.teamAId || undefined,
    teamAName: cfg.teamAName || 'Team A',
    teamAShortName: cfg.teamAShortName || undefined,
    teamALogo: cfg.teamALogo || undefined,
    teamAColor: cfg.teamAColor ?? '#e74c3c',
    scoreA: cfg.scoreA ?? 0,
    teamBId: cfg.teamBId || undefined,
    teamBName: cfg.teamBName || 'Team B',
    teamBShortName: cfg.teamBShortName || undefined,
    teamBLogo: cfg.teamBLogo || undefined,
    teamBColor: cfg.teamBColor ?? '#3498db',
    scoreB: cfg.scoreB ?? 0,
    matchType: cfg.matchType || undefined,
    walkoverLoser: cfg.walkoverLoser || undefined,
    sourceScheduleId: cfg.linkedScheduleMatchId || undefined,
    scoreLog: (cfg.scoreLog ?? []).length > 0
      ? (cfg.scoreLog as any[]).map(e => ({
          team: e.team, action: e.action, points: e.points,
          scorer: e.scorer || undefined, jerseyNo: e.jerseyNo || undefined, timeStr: e.timeStr,
          period: e.period ?? undefined,
        }))
      : undefined,
    shootout: (() => {
      const kicks = cfg.shootoutKicks ?? [];
      if (kicks.length === 0) return undefined;
      const status = computeShootoutStatus(kicks, cfg.shootoutKicksPerRound ?? 5);
      return status.decided ? { kicks, scoreA: status.scoreA, scoreB: status.scoreB, winner: status.winner! } : undefined;
    })(),
    cards: (() => {
      const allWidgets = [...useCanvasStore.getState().pages, ...useCanvasStore.getState().commentatorPages].flatMap(p => p.widgets);
      const cardsFor = (linkedId: string | undefined, side: 'A' | 'B') => {
        const plw = linkedId ? allWidgets.find(w => w.id === linkedId && w.type === 'player-list') : undefined;
        if (!plw) return [];
        const pc = plw.config as Record<string, any>;
        const playerCards: Record<string, ('yellow' | 'orange' | 'red')[]> = pc.playerCards ?? {};
        const team = resolveRosterTeam(pc);
        const playerById = new Map((team?.players ?? []).map((p: any) => [p.id, p]));
        return Object.entries(playerCards).flatMap(([playerId, types]) => {
          const p: any = playerById.get(playerId);
          return types.map(type => ({
            team: side, type, playerId,
            jerseyNo: p?.jerseyNo || undefined, playerName: p?.name || undefined,
          }));
        });
      };
      const cards = [...cardsFor(cfg.linkedPlayerListA, 'A'), ...cardsFor(cfg.linkedPlayerListB, 'B')];
      return cards.length > 0 ? cards : undefined;
    })(),
    lineup: (() => {
      const allWidgets = [...useCanvasStore.getState().pages, ...useCanvasStore.getState().commentatorPages].flatMap(p => p.widgets);
      const lineupFor = (linkedId: string | undefined, side: 'A' | 'B') => {
        const plw = linkedId ? allWidgets.find(w => w.id === linkedId && w.type === 'player-list') : undefined;
        if (!plw) return [];
        const pc = plw.config as Record<string, any>;
        const team = resolveRosterTeam(pc);
        if (!team) return [];
        const playerById = new Map((team.players ?? []).map((p: any) => [p.id, p]));
        const subbedOnPlayers: string[] = pc.subbedOnPlayers ?? [];
        const seen = new Set<string>();
        const out: NonNullable<SavedMatchResult['lineup']> = [];
        const add = (id: string, section: 'starter' | 'sub') => {
          if (!id || seen.has(id)) return;
          const p: any = playerById.get(id);
          if (!p) return;
          seen.add(id);
          out.push({ team: side, playerId: id, jerseyNo: p.jerseyNo || '', name: p.name || '', section, subbedOn: section === 'sub' && subbedOnPlayers.includes(id) });
        };
        (pc.starters ?? []).forEach((id: string) => add(id, 'starter'));
        (pc.subs ?? []).forEach((id: string) => add(id, 'sub'));
        return out;
      };
      const lineup = [...lineupFor(cfg.linkedPlayerListA, 'A'), ...lineupFor(cfg.linkedPlayerListB, 'B')];
      return lineup.length > 0 ? lineup : undefined;
    })(),
    timerSummary: computeTimerSummary(timerCfg),
  };
}

/**
 * Finds an already-saved result for the same fixture, so saving again can
 * update it in place instead of creating a duplicate entry. Prefers the
 * reliable `sourceScheduleId` link (set whenever the board had a fixture
 * loaded via Load Match/Send to Scoreboard); falls back to matching
 * tournament + round + the same two teams (either side) for a scoreboard
 * filled in manually with no linked fixture.
 */
export function findDuplicateResult(results: SavedMatchResult[], cfg: Record<string, any>): SavedMatchResult | undefined {
  if (cfg.linkedScheduleMatchId) {
    return results.find(r => r.sourceScheduleId === cfg.linkedScheduleMatchId);
  }
  const tournamentId = cfg.linkedTournamentId || useTeamDbStore.getState().teams.find(
    t => t.name.trim().toLowerCase() === (cfg.teamAName ?? '').trim().toLowerCase()
  )?.tournamentId;
  if (!tournamentId) return undefined;
  const round = cfg.subtitle || undefined;
  const a = (cfg.teamAName ?? '').trim().toLowerCase();
  const b = (cfg.teamBName ?? '').trim().toLowerCase();
  if (!a && !b) return undefined;
  return results.find(r => {
    if (r.tournamentId !== tournamentId || (r.round || undefined) !== round) return false;
    const ra = r.teamAName.trim().toLowerCase();
    const rb = r.teamBName.trim().toLowerCase();
    return (ra === a && rb === b) || (ra === b && rb === a);
  });
}

/**
 * Builds the config patch that puts a scheduled fixture onto a scoreboard —
 * shared by ScoreboardWidget's "Load Match", MatchScheduleWidget's "Send to
 * Scoreboard", and the Tournament DB Schedule tab's "Send" button, so all
 * three stay in sync. Resets score/log/cards and clears `actualKickoffAt` so
 * the next timer start is captured as this match's real kickoff.
 */
export function buildLoadMatchPatch(m: ScheduledMatch): Record<string, any> {
  return {
    competition: m.competition ?? '', subtitle: m.round ?? '', category: m.category ?? '',
    group: m.group ?? '', tier: m.tier ?? '', scheduledTime: m.time ?? '',
    teamAId: m.teamAId, teamAName: m.teamAName, teamAShortName: m.teamAShortName ?? '', teamAColor: m.teamAColor, teamALogo: m.teamALogo ?? '',
    teamBId: m.teamBId, teamBName: m.teamBName, teamBShortName: m.teamBShortName ?? '', teamBColor: m.teamBColor, teamBLogo: m.teamBLogo ?? '',
    // A bye/walkover never gets "played" on the clock — carry over whatever
    // scoreline the operator already set on the fixture instead of resetting
    // to 0-0, since there's no live match to score it during.
    scoreA: m.matchType ? (m.scoreA ?? 0) : 0,
    scoreB: m.matchType ? (m.scoreB ?? 0) : 0,
    scoreLog: [], cardsA: [], cardsB: [],
    shootoutKicks: [], shootoutOpen: false,
    lastSavedSignature: '',
    actualKickoffAt: undefined,
    linkedTournamentId: m.tournamentId ?? '',
    linkedScheduleMatchId: m.id,
    matchType: m.matchType || '',
    walkoverLoser: m.walkoverLoser || '',
  };
}

/**
 * Guards against losing the current scoreboard match when a new one is about
 * to replace it:
 * - No real content on the board yet → nothing to protect, proceeds silently.
 * - A bye/walkover that hasn't been confirmed via the Walkover Confirm
 *   popup yet → never auto-saved here, no matter how long it's sat on the
 *   board or how long past its scheduled date — it only ever becomes a
 *   Result through that explicit confirm (see ScoreboardWidget's
 *   commitWalkoverResult). Being silently overwritten by the next fixture
 *   must not complete it behind the operator's back.
 * - Content present but not yet saved → auto-saves it as a result, then proceeds.
 * - Content already saved (signature matches) → nothing new to capture, so it
 *   just proceeds too (native confirm() used to gate this, but it's proved
 *   unreliable in the packaged Tauri webview — it can silently no-op, which
 *   made "Send to Scoreboard"/"Load Match" look broken with zero feedback).
 * Always returns true — kept as a return value so callers don't need to change.
 */
export function guardScoreboardOverwrite(
  cfg: Record<string, any>,
  addResult: (r: Omit<SavedMatchResult, 'id' | 'savedAt'>) => void,
  timerCfg?: Record<string, any>,
): boolean {
  if (!hasScoreboardContent(cfg)) return true;
  const currentSig = computeMatchSignature(cfg);
  if (currentSig === cfg.lastSavedSignature) return true;
  if (cfg.matchType) {
    const fixture = cfg.linkedScheduleMatchId
      ? useMatchScheduleStore.getState().matches.find(m => m.id === cfg.linkedScheduleMatchId)
      : undefined;
    if (!fixture?.completedAt) return true; // unconfirmed bye/walkover — let it go, don't auto-complete it
  }
  addResult(buildResultFromConfig(cfg, timerCfg));
  // The outgoing match is being replaced — if it came from the Schedule tab,
  // mark that fixture completed now that its result has been captured.
  if (cfg.linkedScheduleMatchId) {
    useMatchScheduleStore.getState().markCompleted(cfg.linkedScheduleMatchId);
  }
  return true;
}

/**
 * Every scoreboard widget currently loaded live for a not-yet-completed
 * fixture, keyed by fixture id — scans both the main canvas and the
 * commentator canvas, resolving mirrored boards (`linkedScoreboardSourceId`)
 * back to their source's config so a commentator-side mirror still counts.
 * Shared base for useLiveFixtureIds (Schedule tab / Upcoming Matches "on
 * air" highlight) and useLiveScoreboardConfigs (Rundown widget's live
 * score display for a linked segment — a fixture's score lives on whatever
 * scoreboard has it loaded, not on the fixture itself).
 */
function useLiveScoreboardConfigMap(): Map<string, Record<string, any>> {
  const pages = useCanvasStore(s => s.pages);
  const commentatorPages = useCanvasStore(s => s.commentatorPages);
  const matches = useMatchScheduleStore(s => s.matches);
  return useMemo(() => {
    const allWidgets = [...pages, ...commentatorPages].flatMap(p => p.widgets);
    const completedIds = new Set(matches.filter(m => m.completedAt).map(m => m.id));
    const map = new Map<string, Record<string, any>>();
    for (const w of allWidgets) {
      if (w.type !== 'scoreboard') continue;
      const cfg = w.config;
      const dc = cfg.linkedScoreboardSourceId
        ? allWidgets.find(x => x.id === cfg.linkedScoreboardSourceId && x.type === 'scoreboard')?.config ?? cfg
        : cfg;
      const fixtureId = dc.linkedScheduleMatchId;
      if (fixtureId && !completedIds.has(fixtureId)) map.set(fixtureId, dc);
    }
    return map;
  }, [pages, commentatorPages, matches]);
}

export function useLiveFixtureIds(): Set<string> {
  return new Set(useLiveScoreboardConfigMap().keys());
}

/** Fixture id -> the live scoreboard config currently showing it — lets a
 *  linked Rundown segment display the actual live score while a match is
 *  in progress (score itself is never stored on the fixture, only on
 *  whichever scoreboard widget currently has it loaded). */
export function useLiveScoreboardConfigs(): Map<string, Record<string, any>> {
  return useLiveScoreboardConfigMap();
}
