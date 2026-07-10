import type { SavedMatchResult } from '../stores/matchResultsStore';
import { useTeamDbStore } from '../stores/teamDbStore';

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
  // Best-effort: tag the result with whichever tournament Team A belongs to,
  // so it shows up under that tournament's Results tab in the DB window.
  const savedTeamA = useTeamDbStore.getState().teams.find(
    t => t.name.trim().toLowerCase() === (cfg.teamAName ?? '').trim().toLowerCase()
  );
  return {
    date: dateStr,
    tournamentId: savedTeamA?.tournamentId,
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
 * Guards against losing the current scoreboard match when a new one is about
 * to replace it:
 * - No real content on the board yet → nothing to protect, proceeds silently.
 * - Content present but not yet saved → auto-saves it as a result, then proceeds.
 * - Content already saved (signature matches) → asks for confirmation before
 *   letting the caller overwrite, since there's nothing new to capture.
 * Returns true if the caller should proceed to apply the new match.
 */
export function guardScoreboardOverwrite(
  cfg: Record<string, any>,
  addResult: (r: Omit<SavedMatchResult, 'id' | 'savedAt'>) => void,
): boolean {
  if (!hasScoreboardContent(cfg)) return true;
  const currentSig = computeMatchSignature(cfg);
  if (currentSig === cfg.lastSavedSignature) {
    return confirm('This match was already saved to Latest Results. Load the new match and clear the scoreboard?');
  }
  addResult(buildResultFromConfig(cfg));
  return true;
}
