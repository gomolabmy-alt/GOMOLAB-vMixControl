import type { ScheduledMatch } from '../stores/matchScheduleStore';
import { sortRundownSegments, deriveRundownStatus, type RundownSegment } from '../stores/rundownStore';
import { parseScheduledDateTime } from '../utils/scoreboardSnapshot';

// Shared with CustomTimerWidget.tsx's own on-screen render AND the headless
// background vMix pusher (countdownVmixSync.ts) — a single source of truth
// for "what does this countdown widget's config currently mean" so the two
// can never drift out of sync with each other.

export function fmtCountdownDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const d = Math.floor(total / 86400);
  const h = Math.floor((total % 86400) / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (d > 0) return `${d}d ${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

export interface CountdownComputeCtx {
  scheduleMatches: ScheduledMatch[];
  rundownSegments: RundownSegment[];
  /** The canvas page this widget lives on, if it has its own bound tournament. */
  pageTournamentId?: string;
  /** App Settings' title-bar tournament picker — last fallback. */
  canvasTournamentId: string;
}

export interface CountdownState {
  timerMode: 'countdown' | 'countup' | 'target';
  linkSource: 'none' | 'match' | 'rundown';
  displayMs: number;
  timeText: string;
  isOverrun: boolean;
  overrunMs: number;
  targetRemainingMs: number;
  targetUnresolved: boolean;
  effectiveTargetTs: number | null;
  nextScheduledMatch: ScheduledMatch | undefined;
  nextRundownSegment: RundownSegment | undefined;
  /** What's being counted down to, as plain text — matchup for a
   *  match-linked countdown, the segment's own title for a rundown-linked
   *  one, blank (nothing to push) otherwise. */
  linkedTitleText: string;
}

/** Pure function: given one countdown widget's config and the live data it
 *  might be linked to, resolves everything needed to display or push it —
 *  no React, no store subscriptions, safe to call from a plain interval. */
export function computeCountdownState(
  config: Record<string, any>,
  nowMs: number,
  ctx: CountdownComputeCtx,
): CountdownState {
  const timerMode: CountdownState['timerMode'] = config.timerMode ?? 'countdown';
  const durationMs: number = config.durationMs ?? 10 * 60 * 1000;
  const currentMs: number = config.currentMs ?? (timerMode === 'countdown' ? durationMs : 0);

  if (timerMode !== 'target') {
    return {
      timerMode, linkSource: 'none', displayMs: currentMs, timeText: fmtCountdownDuration(currentMs),
      isOverrun: false, overrunMs: 0, targetRemainingMs: 0, targetUnresolved: false, effectiveTargetTs: null,
      nextScheduledMatch: undefined, nextRundownSegment: undefined, linkedTitleText: '',
    };
  }

  const targetTimestamp: number = config.targetTimestamp ?? nowMs + 60 * 60 * 1000;
  // Migrates the old boolean config field (scheduleLinked) transparently.
  const linkSource: CountdownState['linkSource'] = config.linkSource ?? (config.scheduleLinked ? 'match' : 'none');
  const isMatchLinked = linkSource === 'match';
  const isRundownLinked = linkSource === 'rundown';

  const filterTournamentId: string = config.filterTournamentId ?? '';
  const effectiveTournamentId = filterTournamentId || ctx.pageTournamentId || ctx.canvasTournamentId;

  const nextScheduledMatch = isMatchLinked
    ? ctx.scheduleMatches.find(m => (!effectiveTournamentId || m.tournamentId === effectiveTournamentId) && !m.sentAt)
    : undefined;
  const matchById = new Map(ctx.scheduleMatches.map(m => [m.id, m]));
  const nextRundownSegment = isRundownLinked
    ? [...ctx.rundownSegments].sort(sortRundownSegments).find(seg =>
        deriveRundownStatus(seg, seg.linkedScheduleMatchId ? matchById.get(seg.linkedScheduleMatchId) : undefined) === 'upcoming')
    : undefined;

  const scheduleTargetTs = isMatchLinked
    ? (nextScheduledMatch ? parseScheduledDateTime(nextScheduledMatch.date, nextScheduledMatch.time) : null)
    : isRundownLinked
      ? (nextRundownSegment ? parseScheduledDateTime(nextRundownSegment.date, nextRundownSegment.time) : null)
      : undefined;

  const effectiveTargetTs: number | null = linkSource !== 'none' ? (scheduleTargetTs ?? null) : targetTimestamp;
  const targetUnresolved = linkSource !== 'none' && effectiveTargetTs == null;
  const targetRemainingMs = effectiveTargetTs != null ? Math.max(0, effectiveTargetTs - nowMs) : 0;
  const overrunMs = effectiveTargetTs != null ? Math.max(0, nowMs - effectiveTargetTs) : 0;
  const isOverrun = (!!nextScheduledMatch || !!nextRundownSegment) && overrunMs > 0;
  const displayMs = isOverrun ? overrunMs : targetRemainingMs;
  const timeText = targetUnresolved ? '—:—:—' : `${isOverrun ? '+' : ''}${fmtCountdownDuration(displayMs)}`;

  const linkedTitleText = isMatchLinked && nextScheduledMatch
    ? `${nextScheduledMatch.teamAName} vs ${nextScheduledMatch.teamBName}`
    : isRundownLinked && nextRundownSegment
      ? nextRundownSegment.title
      : '';

  return {
    timerMode, linkSource, displayMs, timeText, isOverrun, overrunMs, targetRemainingMs, targetUnresolved,
    effectiveTargetTs, nextScheduledMatch, nextRundownSegment, linkedTitleText,
  };
}

export interface CountdownVmixPush {
  field: string;
  value: string;
}

/** Resolves which vMix text field(s) to write and what to write into them —
 *  either the time and title as two separate fields (the default, for a GT
 *  title with two named fields), or combined into just the Time Field when
 *  vmixMergeFields is on (for a title that only has one generic text
 *  field). Shared by CustomTimerWidget.tsx's manual "Send Now" and the
 *  background pusher (countdownVmixSync.ts) so both always agree on what
 *  "the current push" means. */
export function buildCountdownVmixPushes(
  config: Record<string, any>,
  state: Pick<CountdownState, 'timeText' | 'linkedTitleText'>,
): CountdownVmixPush[] {
  const vmixFieldName: string = config.vmixFieldName ?? 'Countdown.Text';
  const vmixTitleField: string = config.vmixTitleField ?? '';
  if (!vmixFieldName && !vmixTitleField) return [];

  if (config.vmixMergeFields) {
    const merged = state.linkedTitleText ? `${state.linkedTitleText} — ${state.timeText}` : state.timeText;
    return vmixFieldName ? [{ field: vmixFieldName, value: merged }] : [];
  }

  const pushes: CountdownVmixPush[] = [];
  if (vmixFieldName) pushes.push({ field: vmixFieldName, value: state.timeText });
  if (vmixTitleField && state.linkedTitleText) pushes.push({ field: vmixTitleField, value: state.linkedTitleText });
  return pushes;
}
