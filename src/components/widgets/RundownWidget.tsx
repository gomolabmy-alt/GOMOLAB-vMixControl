import { useMemo, useState, useEffect, useRef, useContext } from 'react';
import { RotateCcw, ChevronRight, Check, AlarmClock, Play, Link2, AlertTriangle } from 'lucide-react';
import { useRundownStore, sortRundownSegments, deriveRundownStatus, type RundownSegment } from '../../stores/rundownStore';
import { useMatchScheduleStore } from '../../stores/matchScheduleStore';
import { useMatchResultsStore } from '../../stores/matchResultsStore';
import { parseScheduledDateTime, formatLate, useLiveScoreboardConfigs } from '../../utils/scoreboardSnapshot';
import { ConfirmButton } from '../ConfirmButton';
import { CanvasActionContext } from '../../lib/canvasContext';

interface Props {
  config: Record<string, any>;
  w: number;
  h: number;
}

// Not tournament-scoped, not per-widget-instance-scoped — every Rundown
// widget on the canvas shows the same shared day plan (see rundownStore.ts's
// own comment on why). No widgetId needed: this widget never reads/writes
// anything beyond config.title, so it dispatches the same minimal way
// ButtonWidget does.
export function RundownWidget({ config }: Props) {
  const isCommentator = !!useContext(CanvasActionContext);
  const { segments: allSegments, markSent, unmarkSent, markCompleted, resetAllSent } = useRundownStore();
  const { matches } = useMatchScheduleStore();
  const { results } = useMatchResultsStore();
  const liveScoreboards = useLiveScoreboardConfigs();
  const title: string = config.title ?? 'Rundown';

  const segments = useMemo(() => [...allSegments].sort(sortRundownSegments), [allSegments]);
  const matchById = useMemo(() => new Map(matches.map(m => [m.id, m])), [matches]);
  const statusOf = (s: RundownSegment) =>
    deriveRundownStatus(s, s.linkedScheduleMatchId ? matchById.get(s.linkedScheduleMatchId) : undefined);

  const doneCount = segments.filter(s => statusOf(s) === 'done').length;

  // Ticks the "how late"/"how overrun" durations forward against the local clock.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30000);
    return () => clearInterval(id);
  }, []);

  // Auto-scrolls to the next not-yet-started segment — segments are already
  // sortIndex-sorted, so the first upcoming one is "up next".
  const nextSegmentId = useMemo(() => segments.find(s => statusOf(s) === 'upcoming')?.id, [segments, matchById]);
  const nextRowRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (nextSegmentId) nextRowRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, [nextSegmentId]);

  return (
    <div className="wgt-rd">
      <div className="wgt-rd-header">
        <span>{title}</span>
        {segments.length > 0 && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span className="wgt-rd-count">{doneCount}/{segments.length} done</span>
            {!isCommentator && (
              <ConfirmButton
                className="wgt-rd-tool-btn"
                label={<span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}><RotateCcw size={12} strokeWidth={2} /> Reset</span>}
                confirmLabel="Reset"
                message="Mark all freeform segments as not started? (Segments linked to a fixture follow that fixture and aren't affected.)"
                onConfirm={() => resetAllSent(segments.filter(s => !s.linkedScheduleMatchId).map(s => s.id))}
              />
            )}
          </div>
        )}
      </div>
      {segments.length === 0 ? (
        <div className="wgt-rd-empty">No rundown segments yet — add some in DB → Rundown</div>
      ) : (
        // fade-y: content dissolves into the top/bottom edge instead of
        // clipping abruptly, via a mask-image gradient on the scroll container.
        <div className="wgt-rd-list wgt-rd-fade-y">
          {segments.map(s => {
            const linkedMatch = s.linkedScheduleMatchId ? matchById.get(s.linkedScheduleMatchId) : undefined;
            const orphaned = !!s.linkedScheduleMatchId && !linkedMatch;
            const status = statusOf(s);
            const scheduledTs = parseScheduledDateTime(s.date, s.time);
            const isLate = status === 'upcoming' && scheduledTs !== null && now > scheduledTs;
            const lateStr = isLate ? formatLate(now - scheduledTs!) : null;
            const isNext = s.id === nextSegmentId;

            const startedAt = s.linkedScheduleMatchId ? linkedMatch?.sentAt : s.sentAt;
            const overrunMs = status === 'live' && s.durationMin && startedAt
              ? now - startedAt - s.durationMin * 60000
              : 0;

            const liveCfg = s.linkedScheduleMatchId ? liveScoreboards.get(s.linkedScheduleMatchId) : undefined;
            const finalResult = s.linkedScheduleMatchId ? results.find(r => r.sourceScheduleId === s.linkedScheduleMatchId) : undefined;

            return (
              <div
                key={s.id}
                ref={isNext ? nextRowRef : undefined}
                className={`wgt-rd-row${status === 'done' ? ' wgt-rd-row--done' : ''}${isLate ? ' wgt-rd-row--late' : ''}${isNext ? ' wgt-rd-row--next' : ''}${status === 'live' ? ' wgt-rd-row--live' : ''}`}
              >
                <div className="wgt-rd-row-meta">
                  <span className="wgt-rd-time">{s.time || '—'}</span>
                  {s.durationMin ? <span className="wgt-rd-duration">{s.durationMin}min</span> : null}
                </div>

                {status === 'live' && (
                  <div className="wgt-rd-live-badge">
                    <svg width="8" height="8" viewBox="0 0 8 8"><circle cx="4" cy="4" r="4" fill="currentColor" /></svg>
                    LIVE
                  </div>
                )}
                {overrunMs > 0 && (
                  <div className="wgt-rd-overrun-badge"><AlarmClock size={12} strokeWidth={2} /> OVERRUN — {formatLate(overrunMs)} over</div>
                )}
                {isLate && (
                  <div className="wgt-rd-late-badge"><AlarmClock size={12} strokeWidth={2} /> LATE — {lateStr} behind schedule</div>
                )}
                {isNext && !isLate && (
                  <div className="wgt-rd-next-badge"><ChevronRight size={12} strokeWidth={2} /> NEXT UP</div>
                )}

                <div className="wgt-rd-title-row">
                  <span className="wgt-rd-title">{s.title}</span>
                  {s.linkedScheduleMatchId && (
                    orphaned
                      ? <span className="wgt-rd-link-chip wgt-rd-link-chip--warn" title="Linked fixture was deleted — unlink it in DB → Rundown"><AlertTriangle size={11} strokeWidth={2} /> missing</span>
                      : <span className="wgt-rd-link-chip" title="Linked to a fixture — status follows it automatically"><Link2 size={11} strokeWidth={2} /></span>
                  )}
                </div>
                {s.notes && <div className="wgt-rd-notes">{s.notes}</div>}

                {linkedMatch && (
                  <div className="wgt-rd-fixture">
                    <span className="wgt-rd-fixture-team">{linkedMatch.teamAShortName || linkedMatch.teamAName}</span>
                    {status === 'live' && liveCfg ? (
                      <span className="wgt-rd-fixture-score">{liveCfg.scoreA ?? 0}–{liveCfg.scoreB ?? 0}</span>
                    ) : status === 'done' && finalResult ? (
                      <span className="wgt-rd-fixture-score">{finalResult.scoreA}–{finalResult.scoreB}</span>
                    ) : (
                      <span className="wgt-rd-vs">vs</span>
                    )}
                    <span className="wgt-rd-fixture-team">{linkedMatch.teamBShortName || linkedMatch.teamBName}</span>
                  </div>
                )}

                {!s.linkedScheduleMatchId && !isCommentator && (
                  status === 'upcoming' ? (
                    <button className="wgt-rd-action" onClick={() => markSent(s.id)}>
                      <Play size={12} strokeWidth={2} /> Start
                    </button>
                  ) : status === 'live' ? (
                    <div style={{ display: 'flex', gap: 6 }}>
                      <button className="wgt-rd-action" onClick={() => markCompleted(s.id)}>
                        <Check size={12} strokeWidth={2} /> Mark Done
                      </button>
                      <button className="wgt-rd-action wgt-rd-action--ghost" onClick={() => unmarkSent(s.id)} title="Undo start">
                        Undo
                      </button>
                    </div>
                  ) : (
                    <button className="wgt-rd-action wgt-rd-action--done" onClick={() => unmarkSent(s.id)} title="Mark as not done">
                      <Check size={12} strokeWidth={2} /> Done — click to undo
                    </button>
                  )
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
