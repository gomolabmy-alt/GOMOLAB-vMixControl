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

export function buildResultFromConfig(cfg: Record<string, any>): Omit<SavedMatchResult, 'id' | 'savedAt'> {
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
    category: cfg.category || undefined,
    teamAName: cfg.teamAName || 'Team A',
    teamAShortName: cfg.teamAShortName || undefined,
    teamALogo: cfg.teamALogo || undefined,
    teamAColor: cfg.teamAColor ?? '#e74c3c',
    scoreA: cfg.scoreA ?? 0,
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
        const playerCards: Record<string, ('yellow' | 'orange' | 'red')[]> = plw?.config?.playerCards ?? {};
        return Object.values(playerCards).flat().map(type => ({ team: side, type }));
      };
      const cards = [...cardsFor(cfg.linkedPlayerListA, 'A'), ...cardsFor(cfg.linkedPlayerListB, 'B')];
      return cards.length > 0 ? cards : undefined;
    })(),
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
    group: m.group ?? '', scheduledTime: m.time ?? '',
    teamAName: m.teamAName, teamAShortName: m.teamAShortName ?? '', teamAColor: m.teamAColor, teamALogo: m.teamALogo ?? '',
    teamBName: m.teamBName, teamBShortName: m.teamBShortName ?? '', teamBColor: m.teamBColor, teamBLogo: m.teamBLogo ?? '',
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
): boolean {
  if (!hasScoreboardContent(cfg)) return true;
  const currentSig = computeMatchSignature(cfg);
  if (currentSig === cfg.lastSavedSignature) return true;
  addResult(buildResultFromConfig(cfg));
  // The outgoing match is being replaced — if it came from the Schedule tab,
  // mark that fixture completed now that its result has been captured.
  if (cfg.linkedScheduleMatchId) {
    useMatchScheduleStore.getState().markCompleted(cfg.linkedScheduleMatchId);
  }
  return true;
}

/**
 * The set of fixture ids currently loaded live on some scoreboard widget
 * right now (not yet saved/completed) — scans every scoreboard on both the
 * main canvas and the commentator canvas, resolving mirrored boards
 * (`linkedScoreboardSourceId`) back to their source's config so a
 * commentator-side mirror still counts. Used to highlight a fixture as
 * "on air" in the Schedule tab / Upcoming Matches widget.
 */
export function useLiveFixtureIds(): Set<string> {
  const pages = useCanvasStore(s => s.pages);
  const commentatorPages = useCanvasStore(s => s.commentatorPages);
  const matches = useMatchScheduleStore(s => s.matches);
  return useMemo(() => {
    const allWidgets = [...pages, ...commentatorPages].flatMap(p => p.widgets);
    const completedIds = new Set(matches.filter(m => m.completedAt).map(m => m.id));
    const ids = new Set<string>();
    for (const w of allWidgets) {
      if (w.type !== 'scoreboard') continue;
      const cfg = w.config;
      const dc = cfg.linkedScoreboardSourceId
        ? allWidgets.find(x => x.id === cfg.linkedScoreboardSourceId && x.type === 'scoreboard')?.config ?? cfg
        : cfg;
      const fixtureId = dc.linkedScheduleMatchId;
      if (fixtureId && !completedIds.has(fixtureId)) ids.add(fixtureId);
    }
    return ids;
  }, [pages, commentatorPages, matches]);
}
