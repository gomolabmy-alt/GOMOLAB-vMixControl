import type { SavedMatchResult } from '../stores/matchResultsStore';
import { useTeamDbStore } from '../stores/teamDbStore';
import { useMatchScheduleStore, type ScheduledMatch } from '../stores/matchScheduleStore';

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
  };
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
    competition: m.competition ?? '', subtitle: m.round ?? '',
    teamAName: m.teamAName, teamAShortName: m.teamAShortName ?? '', teamAColor: m.teamAColor, teamALogo: m.teamALogo ?? '',
    teamBName: m.teamBName, teamBShortName: m.teamBShortName ?? '', teamBColor: m.teamBColor, teamBLogo: m.teamBLogo ?? '',
    scoreA: 0, scoreB: 0,
    scoreLog: [], cardsA: [], cardsB: [],
    lastSavedSignature: '',
    actualKickoffAt: undefined,
    linkedTournamentId: m.tournamentId ?? '',
    linkedScheduleMatchId: m.id,
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
