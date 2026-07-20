import { useMemo, useState, useEffect, useRef, useContext } from 'react';
import { useCanvasStore } from '../../stores/canvasStore';
import { useMatchScheduleStore } from '../../stores/matchScheduleStore';
import { useMatchResultsStore } from '../../stores/matchResultsStore';
import { useAppSettings } from '../../stores/appSettingsStore';
import { resolveImageUrl } from '../../lib/imageUrl';
import { guardScoreboardOverwrite, buildLoadMatchPatch, useLiveFixtureIds, findDuplicateResult } from '../../utils/scoreboardSnapshot';
import { ConfirmButton } from '../ConfirmButton';
import { ConfirmModal } from '../ConfirmModal';
import { CanvasActionContext } from '../../lib/canvasContext';

interface Props {
  widgetId: string;
  config: Record<string, any>;
  w: number;
  h: number;
}

// Parses "YYYY-MM-DD" + an optional loose time string ("20:30", "8:30 PM", "8:30pm")
// into a local-timezone epoch ms, so lateness compares against the local system clock.
function parseScheduledDateTime(date: string, time?: string): number | null {
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

function formatLate(ms: number): string {
  const totalMin = Math.max(0, Math.floor(ms / 60000));
  if (totalMin < 60) return `${totalMin}m`;
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h < 24) return `${h}h ${m}m`;
  const d = Math.floor(h / 24);
  return `${d}d ${h % 24}h`;
}

export function MatchScheduleWidget({ widgetId, config }: Props) {
  // CanvasActionContext is only provided on the commentator canvas — a
  // commentator shouldn't be able to wipe/reset the tournament's schedule.
  const isCommentator = !!useContext(CanvasActionContext);
  const { pages, updateWidgetConfig, resetWidgetTimer } = useCanvasStore();
  const { matches: allMatches, markSent, unmarkSent, resetAllSent, clearMatches } = useMatchScheduleStore();
  const { results: savedResults, addResult, deleteResult } = useMatchResultsStore();
  const [undoTarget, setUndoTarget] = useState<{ matchId: string; resultId: string } | null>(null);

  // Undoing "sent" would otherwise silently orphan an already-saved result —
  // confirm first when one exists; no result → just undo immediately.
  const handleUndoSent = (m: typeof allMatches[number]) => {
    const existing = findDuplicateResult(savedResults, {
      linkedScheduleMatchId: m.id, linkedTournamentId: m.tournamentId,
      subtitle: m.round, teamAName: m.teamAName, teamBName: m.teamBName,
    });
    if (existing) setUndoTarget({ matchId: m.id, resultId: existing.id });
    else unmarkSent(m.id);
  };
  const { canvasTournamentId, canvasVenue } = useAppSettings();
  const title: string = config.title ?? 'Upcoming Matches';

  // Scoping: a widget with its own Tournament picked in its config filters
  // independently (so several "Upcoming Matches" widgets on one canvas can
  // each pin to a different venue/category/group at once); otherwise it
  // falls back to the canvas's own bound tournament (a canvas is normally
  // dedicated to one tournament), then the title bar's 🏟 picker — this
  // install's shared default scope.
  const pageTournamentId = pages.find(p => p.widgets.some(w => w.id === widgetId))?.tournamentId;
  const effectiveTournamentId: string = config.filterTournamentId || pageTournamentId || canvasTournamentId;
  const effectiveVenue: string = config.filterTournamentId ? (config.filterVenue ?? '') : canvasVenue;
  const effectiveCategory: string = config.filterCategory ?? '';
  const effectiveGroup: string = config.filterGroup ?? '';
  const matches = useMemo(
    () => allMatches.filter(m =>
      (!effectiveTournamentId || m.tournamentId === effectiveTournamentId) &&
      (!effectiveVenue || m.venue === effectiveVenue) &&
      (!effectiveCategory || m.category === effectiveCategory) &&
      (!effectiveGroup || m.group === effectiveGroup)
    ),
    [allMatches, effectiveTournamentId, effectiveVenue, effectiveCategory, effectiveGroup]
  );

  const allWidgets = useMemo(() => pages.flatMap(p => p.widgets), [pages]);
  const targetScoreboard = config.linkedScoreboardId
    ? allWidgets.find(w => w.id === config.linkedScoreboardId && w.type === 'scoreboard')
    : null;

  const sentCount = matches.filter(m => m.sentAt).length;
  const liveFixtureIds = useLiveFixtureIds();

  // Ticks the "how late" durations forward against the local system clock.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30000);
    return () => clearInterval(id);
  }, []);

  // Auto-scrolls to the next fixture waiting to be sent — matches are already
  // date-sorted, so the first not-yet-sent one is "up next" in the queue.
  const nextMatchId = useMemo(() => matches.find(m => !m.sentAt)?.id, [matches]);
  const nextRowRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (nextMatchId) nextRowRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, [nextMatchId]);

  const sendToScoreboard = (m: typeof matches[number]) => {
    if (!targetScoreboard) return;
    // Protects the outgoing match on the target scoreboard: auto-saves it if
    // it was never saved, or confirms before overwriting if it already was.
    if (!guardScoreboardOverwrite(targetScoreboard.config, addResult)) return;
    updateWidgetConfig(targetScoreboard.id, buildLoadMatchPatch(m));
    // A new match starting means the previous one's clock shouldn't carry over.
    if (targetScoreboard.config.linkedTimerWidgetId) resetWidgetTimer(targetScoreboard.config.linkedTimerWidgetId);
    markSent(m.id);
  };

  return (
    <div className="wgt-ms">
      <div className="wgt-ms-header">
        <span>{title}</span>
        {matches.length > 0 && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span className="wgt-ms-count">{sentCount}/{matches.length} sent</span>
            {!isCommentator && (
              <>
                <ConfirmButton
                  className="wgt-ms-tool-btn"
                  label="↺ Reset"
                  confirmLabel="Reset"
                  message="Mark all fixtures as not sent?"
                  onConfirm={() => resetAllSent(matches.map(m => m.id))}
                />
                <ConfirmButton
                  className="wgt-ms-tool-btn wgt-ms-tool-btn--danger"
                  label="🗑 Clear"
                  confirmLabel="Delete all"
                  message="Delete all scheduled fixtures?"
                  onConfirm={() => clearMatches(matches.map(m => m.id))}
                />
              </>
            )}
          </div>
        )}
      </div>
      {matches.length === 0 ? (
        <div className="wgt-ms-empty">
          {allMatches.length > 0 && (effectiveTournamentId || effectiveVenue || effectiveCategory || effectiveGroup)
            ? 'No fixtures match this filter — check this widget\'s Tournament/Venue/Category/Group settings (or the title bar 🏟 picker)'
            : 'No scheduled matches yet — add fixtures in 🏆 DB → Schedule'}
        </div>
      ) : (
        // fade-y: content dissolves into the top/bottom edge instead of
        // clipping abruptly, via a mask-image gradient on the scroll container.
        <div className="wgt-ms-list wgt-ms-fade-y">
          {matches.map(m => {
            const scheduledTs = parseScheduledDateTime(m.date, m.time);
            const isLate = !m.sentAt && scheduledTs !== null && now > scheduledTs;
            const lateStr = isLate ? formatLate(now - scheduledTs!) : null;

            const isNext = m.id === nextMatchId;
            const isLive = liveFixtureIds.has(m.id);

            return (
              <div
                key={m.id}
                ref={isNext ? nextRowRef : undefined}
                className={`wgt-ms-row${m.sentAt ? ' wgt-ms-row--sent' : ''}${isLate ? ' wgt-ms-row--late' : ''}${isNext ? ' wgt-ms-row--next' : ''}${isLive ? ' wgt-ms-row--live' : ''}`}
              >
                <div className="wgt-ms-row-meta">
                  <span className="wgt-ms-date">{m.date}{m.time ? ` · ${m.time}` : ''}</span>
                  {m.competition && <span className="wgt-ms-comp">{m.competition}{m.round ? ` — ${m.round}` : ''}</span>}
                </div>

                {isLive && (
                  <div className="wgt-ms-live-badge">● LIVE — on scoreboard</div>
                )}
                {isLate && !isLive && (
                  <div className="wgt-ms-late-badge">⏰ LATE — {lateStr} behind schedule</div>
                )}
                {isNext && !isLate && !isLive && (
                  <div className="wgt-ms-next-badge">▶ NEXT UP</div>
                )}

                <div className="wgt-ms-row-matchup">
                  <div className="wgt-ms-team">
                    {m.teamALogo
                      ? <img className="wgt-ms-logo" src={resolveImageUrl(m.teamALogo)} alt="" />
                      : <div className="wgt-ms-logo-ph" style={{ background: m.teamAColor }} />}
                    <span className="wgt-ms-team-name">{m.teamAShortName || m.teamAName}</span>
                  </div>
                  <span className="wgt-ms-vs">{m.matchType ? (m.matchType === 'bye' ? 'BYE' : 'W/O') : 'vs'}</span>
                  <div className="wgt-ms-team wgt-ms-team--b">
                    <span className="wgt-ms-team-name">{m.teamBShortName || m.teamBName}</span>
                    {m.teamBLogo
                      ? <img className="wgt-ms-logo" src={resolveImageUrl(m.teamBLogo)} alt="" />
                      : <div className="wgt-ms-logo-ph" style={{ background: m.teamBColor }} />}
                  </div>
                </div>

                {(m.venue || m.group || m.category) && (
                  <div className="wgt-ms-footer">
                    {m.venue && <span>{m.venue}</span>}
                    {(m.category || m.group) && <span>{[m.category, m.group].filter(Boolean).join(' · ')}</span>}
                  </div>
                )}

                {m.sentAt ? (
                  <button className="wgt-ms-send wgt-ms-send--sent" onClick={() => handleUndoSent(m)} title="Mark as not sent">
                    ✓ Sent — click to undo
                  </button>
                ) : (
                  <button
                    className={`wgt-ms-send${isLate ? ' wgt-ms-send--late' : ''}`}
                    onClick={() => sendToScoreboard(m)}
                    disabled={!targetScoreboard}
                    title={targetScoreboard ? 'Send this matchup to the linked scoreboard' : 'Link a scoreboard in ⚙ config first'}
                  >
                    {targetScoreboard ? '→ Send to Scoreboard' : 'No scoreboard linked'}
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}
      {undoTarget && (
        <ConfirmModal
          title="Undo sent?"
          message="This fixture has a saved result. Undoing will remove that result and mark the fixture as not sent."
          confirmLabel="Undo & Remove Result"
          danger
          onConfirm={() => { deleteResult(undoTarget.resultId); unmarkSent(undoTarget.matchId); setUndoTarget(null); }}
          onCancel={() => setUndoTarget(null)}
        />
      )}
    </div>
  );
}
