import { useMemo, useState, useEffect, useRef, useCallback, useContext } from 'react';
import { RotateCcw, ChevronRight, ArrowRight, Check, AlarmClock, Send } from 'lucide-react';
import { useCanvasStore } from '../../stores/canvasStore';
import { useMatchScheduleStore, type ScheduledMatch } from '../../stores/matchScheduleStore';
import { useMatchResultsStore } from '../../stores/matchResultsStore';
import { useAppSettings } from '../../stores/appSettingsStore';
import { useVmixStore } from '../../stores/vmixStore';
import { resolveImageUrl } from '../../lib/imageUrl';
import { guardScoreboardOverwrite, buildLoadMatchPatch, useLiveFixtureIds, findDuplicateResult, parseScheduledDateTime, formatLate } from '../../utils/scoreboardSnapshot';
import { useMatchNumbers } from '../../utils/matchNumber';
import { ConfirmButton } from '../ConfirmButton';
import { ConfirmModal } from '../ConfirmModal';
import { CanvasActionContext } from '../../lib/canvasContext';
import { autoLinkedWidget, autoLinkedWidgetId } from '../../lib/autoLink';

/** One vMix input's fixture-list field mapping — every prefix is optional
 *  (blank = don't push that field); indices are 1-based per fixture row,
 *  e.g. teamAPrefix "TeamA" → TeamA1.Text, TeamA2.Text, ... */
// "Team A/B" already falls back to the short name whenever one's set, which
// is the same result "Short Name" would give in the common case — a
// separate short-name-only field was redundant with it, so there's just
// this (short-preferred) and "Full Name" (never substituted) now, not three.
type FixturePart = 'teamA' | 'teamB' | 'fullTeamA' | 'fullTeamB' | 'date' | 'time' | 'round' | 'venue' | 'group' | 'matchId';

interface FixtureVmixTarget {
  id: string;
  inputKey: string;
  inputTitle?: string;
  teamAPrefix?: string;
  teamBPrefix?: string;
  /** Full team name ONLY, never substituted with the short name — separate
   *  from teamAPrefix/teamBPrefix above, which already fall back to the
   *  short name when set. */
  fullTeamAPrefix?: string;
  fullTeamBPrefix?: string;
  datePrefix?: string;
  timePrefix?: string;
  roundPrefix?: string;
  venuePrefix?: string;
  /** Draw group (pool stage) or stage name (knockout — see
   *  ScheduledMatch.group's own doc comment: already holds the literal
   *  stage label like "Quarterfinal" once a fixture leaves group play). */
  groupPrefix?: string;
  matchIdPrefix?: string;
  logoAPrefix?: string;
  logoBPrefix?: string;
  autoSync?: boolean;
  /** Combines any of the fields above into ONE string on a single field
   *  instead of separate ones (see WidgetConfigPanel's drag-to-reorder
   *  merge composer) — logos aren't mergeable text, so not included here. */
  mergedPrefix?: string;
  mergedParts?: FixturePart[];
  mergedSeparator?: string;
}

function resolveFixturePart(m: ScheduledMatch, part: FixturePart, matchNumbers: Map<string, string>): string {
  switch (part) {
    case 'teamA': return m.teamAShortName || m.teamAName;
    case 'teamB': return m.teamBShortName || m.teamBName;
    case 'fullTeamA': return m.teamAName ?? '';
    case 'fullTeamB': return m.teamBName ?? '';
    case 'date':  return m.date ?? '';
    case 'time':  return m.time ?? '';
    case 'round': return m.round ?? '';
    case 'venue': return m.venue ?? '';
    case 'group': return m.group ?? '';
    case 'matchId': return matchNumbers.get(m.id) ?? '';
  }
}

interface Props {
  widgetId: string;
  config: Record<string, any>;
  w: number;
  h: number;
}

export function MatchScheduleWidget({ widgetId, config }: Props) {
  // CanvasActionContext is only provided on the commentator canvas — a
  // commentator shouldn't be able to wipe/reset the tournament's schedule.
  const isCommentator = !!useContext(CanvasActionContext);
  const { pages, updateWidgetConfig, resetWidgetTimer } = useCanvasStore();
  const { matches: allMatches, markSent, unmarkSent, resetAllSent } = useMatchScheduleStore();
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
  // falls back to the canvas's own bound tournament+venue (a canvas is
  // normally dedicated to one tournament), then the title bar's 🏟 picker —
  // this install's shared default scope.
  const owningPage = pages.find(p => p.widgets.some(w => w.id === widgetId));
  const pageTournamentId = owningPage?.tournamentId;
  const pageVenue = owningPage?.venue;
  const effectiveTournamentId: string = config.filterTournamentId || pageTournamentId || canvasTournamentId;
  const effectiveVenue: string = config.filterTournamentId ? (config.filterVenue ?? '') : (pageVenue || canvasVenue);
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
  // Falls back to the sole Scoreboard widget on this page when nothing's
  // been explicitly linked in settings — an explicit pick always wins.
  const targetScoreboard = autoLinkedWidget(pages, widgetId, config.linkedScoreboardId, 'scoreboard') ?? null;

  const sentCount = matches.filter(m => m.sentAt).length;
  const liveFixtureIds = useLiveFixtureIds();
  const matchNumbers = useMatchNumbers();

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

  // ── vMix live sync — two independent targets ────────────────────────
  // "Full Schedule" pushes every currently-filtered fixture; "Next
  // Fixture(s)" pushes just the next N not-yet-sent ones (N configurable —
  // a "coming up" graphic wants 1-3, a full-day ticker wants everything).
  // matches is already kept in sortMatches order by the store itself (every
  // add/update re-sorts it), so slicing straight off it is safe.
  const { getClient, vmixState, vmixSyncVersion } = useVmixStore();
  const scheduleVmixTargets: FixtureVmixTarget[] = config.scheduleVmixInputs ?? [];
  const nextVmixTargets: FixtureVmixTarget[] = config.nextVmixInputs ?? [];
  const nextFixtureCount: number = config.nextFixtureCount || 1;
  const nextFixtures = useMemo(() => matches.filter(m => !m.sentAt).slice(0, nextFixtureCount), [matches, nextFixtureCount]);

  const pushFixturesToTargets = useCallback((targets: FixtureVmixTarget[], fixtures: ScheduledMatch[], reservedSlots: number) => {
    const c = getClient();
    if (!c) return;
    for (const t of targets) {
      if (!t.inputKey) continue;
      const prefixes = [t.teamAPrefix, t.teamBPrefix, t.fullTeamAPrefix, t.fullTeamBPrefix, t.datePrefix, t.timePrefix, t.roundPrefix, t.venuePrefix, t.groupPrefix, t.matchIdPrefix, t.mergedPrefix];
      fixtures.forEach((m, i) => {
        const idx = i + 1;
        if (t.teamAPrefix) c.setTextField(t.inputKey, `${t.teamAPrefix}${idx}.Text`, m.teamAShortName || m.teamAName);
        if (t.teamBPrefix) c.setTextField(t.inputKey, `${t.teamBPrefix}${idx}.Text`, m.teamBShortName || m.teamBName);
        if (t.fullTeamAPrefix) c.setTextField(t.inputKey, `${t.fullTeamAPrefix}${idx}.Text`, m.teamAName ?? '');
        if (t.fullTeamBPrefix) c.setTextField(t.inputKey, `${t.fullTeamBPrefix}${idx}.Text`, m.teamBName ?? '');
        if (t.datePrefix)  c.setTextField(t.inputKey, `${t.datePrefix}${idx}.Text`, m.date ?? '');
        if (t.timePrefix)  c.setTextField(t.inputKey, `${t.timePrefix}${idx}.Text`, m.time ?? '');
        if (t.roundPrefix) c.setTextField(t.inputKey, `${t.roundPrefix}${idx}.Text`, m.round ?? '');
        if (t.venuePrefix) c.setTextField(t.inputKey, `${t.venuePrefix}${idx}.Text`, m.venue ?? '');
        if (t.groupPrefix) c.setTextField(t.inputKey, `${t.groupPrefix}${idx}.Text`, m.group ?? '');
        if (t.matchIdPrefix) c.setTextField(t.inputKey, `${t.matchIdPrefix}${idx}.Text`, matchNumbers.get(m.id) ?? '');
        if (t.logoAPrefix && m.teamALogo) c.setImageField(t.inputKey, `${t.logoAPrefix}${idx}.Source`, m.teamALogo);
        if (t.logoBPrefix && m.teamBLogo) c.setImageField(t.inputKey, `${t.logoBPrefix}${idx}.Source`, m.teamBLogo);
        if (t.mergedPrefix && t.mergedParts?.length) {
          const merged = t.mergedParts.map(p => resolveFixturePart(m, p, matchNumbers)).join(t.mergedSeparator ?? ' ');
          c.setTextField(t.inputKey, `${t.mergedPrefix}${idx}.Text`, merged);
        }
      });
      // Clear any extra same-prefix fields beyond the reserved slot count,
      // e.g. leftover text from a previous, longer fixture list.
      const vmixInput = vmixState?.inputs?.find(inp => inp.key === t.inputKey);
      if (vmixInput) {
        for (const prefix of prefixes) {
          if (!prefix) continue;
          const esc = prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          const re = new RegExp(`^${esc}(\\d+)\\.Text$`, 'i');
          for (const field of vmixInput.textFields) {
            const fm = field.name.match(re);
            if (fm && parseInt(fm[1]) > reservedSlots) c.setTextField(t.inputKey, field.name, '');
          }
        }
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [getClient, vmixState, matchNumbers]);

  // "Fixtures per page" (optional) — when a vMix input's graphic template
  // only has room for so many rows, this splits the full list across the
  // configured targets IN ORDER instead of pushing the same complete list
  // to every one of them: target 1 gets fixtures 1-N, target 2 gets N+1 to
  // 2N, and so on, each restarting at row 1 on its own input ("page 2").
  // Left at 0/blank, every target keeps getting the whole list (original
  // behavior, e.g. for mirroring the same full schedule to two templates).
  const scheduleFixturesPerPage: number = config.scheduleFixturesPerPage || 0;
  const syncScheduleToVmix = useCallback(() => {
    if (scheduleFixturesPerPage > 0) {
      scheduleVmixTargets.forEach((t, i) => {
        const page = matches.slice(i * scheduleFixturesPerPage, (i + 1) * scheduleFixturesPerPage);
        pushFixturesToTargets([t], page, page.length);
      });
    } else {
      pushFixturesToTargets(scheduleVmixTargets, matches, matches.length);
    }
  }, [pushFixturesToTargets, scheduleVmixTargets, matches, scheduleFixturesPerPage]);
  // Clears by how many fixtures were ACTUALLY pushed, not the configured max
  // (nextFixtureCount) — when fewer unsent fixtures remain than the max, using
  // the max here would leave stale data sitting in the now-unfilled slots
  // instead of blanking them.
  const syncNextToVmix = useCallback(() =>
    pushFixturesToTargets(nextVmixTargets, nextFixtures, nextFixtures.length),
    [pushFixturesToTargets, nextVmixTargets, nextFixtures]
  );

  useEffect(() => {
    if (scheduleVmixTargets.some(t => t.inputKey && t.autoSync)) syncScheduleToVmix();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [matches, vmixSyncVersion]);
  useEffect(() => {
    if (nextVmixTargets.some(t => t.inputKey && t.autoSync)) syncNextToVmix();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nextFixtures, vmixSyncVersion]);

  const sendToScoreboard = (m: typeof matches[number]) => {
    if (!targetScoreboard) return;
    // A new match starting means the previous one's clock shouldn't carry
    // over — resolved the same way the scoreboard itself would (explicit
    // link, or the sole Timer on its page).
    const targetTimerId = autoLinkedWidgetId(pages, targetScoreboard.id, targetScoreboard.config.linkedTimerWidgetId, 'timer');
    const targetTimerCfg = allWidgets.find(w => w.id === targetTimerId)?.config;
    // Protects the outgoing match on the target scoreboard: auto-saves it if
    // it was never saved, or confirms before overwriting if it already was.
    if (!guardScoreboardOverwrite(targetScoreboard.config, addResult, targetTimerCfg)) return;
    updateWidgetConfig(targetScoreboard.id, buildLoadMatchPatch(m));
    if (targetTimerId) resetWidgetTimer(targetTimerId);
    markSent(m.id);
  };

  return (
    <div className="wgt-ms">
      <div className="wgt-ms-header">
        <span>{title}</span>
        {matches.length > 0 && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span className="wgt-ms-count">{sentCount}/{matches.length} sent</span>
            {scheduleVmixTargets.some(t => t.inputKey) && (
              <button className="wgt-ms-tool-btn" title="Push the full fixture list to vMix now" onClick={syncScheduleToVmix}>
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}><Send size={12} strokeWidth={2} /> Sync Schedule</span>
              </button>
            )}
            {nextVmixTargets.some(t => t.inputKey) && (
              <button className="wgt-ms-tool-btn" title={`Push the next ${nextFixtureCount} fixture(s) to vMix now`} onClick={syncNextToVmix}>
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}><Send size={12} strokeWidth={2} /> Sync Next</span>
              </button>
            )}
            {!isCommentator && (
              <ConfirmButton
                className="wgt-ms-tool-btn"
                label={<span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}><RotateCcw size={12} strokeWidth={2} /> Reset</span>}
                confirmLabel="Reset"
                message="Mark all fixtures as not sent?"
                onConfirm={() => resetAllSent(matches.map(m => m.id))}
              />
            )}
          </div>
        )}
      </div>
      {matches.length === 0 ? (
        <div className="wgt-ms-empty">
          {allMatches.length > 0 && (effectiveTournamentId || effectiveVenue || effectiveCategory || effectiveGroup)
            ? 'No fixtures match this filter — check this widget\'s Tournament/Venue/Category/Group settings (or the title bar picker)'
            : 'No scheduled matches yet — add fixtures in DB → Schedule'}
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
                  <span className="wgt-ms-date-group">
                    {matchNumbers.get(m.id) && <span className="wgt-match-id" title="Match ID — same as shown on the public scoring page">{matchNumbers.get(m.id)}</span>}
                    <span className="wgt-ms-date">{m.date}{m.time ? ` · ${m.time}` : ''}</span>
                  </span>
                  {m.competition && <span className="wgt-ms-comp">{m.competition}{m.round ? ` — ${m.round}` : ''}</span>}
                </div>

                {isLive && (
                  <div className="wgt-ms-live-badge" style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                    <svg width="8" height="8" viewBox="0 0 8 8"><circle cx="4" cy="4" r="4" fill="currentColor" /></svg>
                    LIVE — on scoreboard
                  </div>
                )}
                {isLate && !isLive && (
                  <div className="wgt-ms-late-badge" style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                    <AlarmClock size={12} strokeWidth={2} /> LATE — {lateStr} behind schedule
                  </div>
                )}
                {isNext && !isLate && !isLive && (
                  <div className="wgt-ms-next-badge" style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                    <ChevronRight size={12} strokeWidth={2} /> NEXT UP
                  </div>
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
                  <button className="wgt-ms-send wgt-ms-send--sent" onClick={() => handleUndoSent(m)} title="Mark as not sent" style={{ display: 'inline-flex', alignItems: 'center', gap: 4, justifyContent: 'center' }}>
                    <Check size={12} strokeWidth={2} /> Sent — click to undo
                  </button>
                ) : (
                  <button
                    className={`wgt-ms-send${isLate ? ' wgt-ms-send--late' : ''}`}
                    onClick={() => sendToScoreboard(m)}
                    disabled={!targetScoreboard}
                    title={targetScoreboard ? 'Send this matchup to the linked scoreboard' : 'Link a scoreboard in settings first'}
                    style={{ display: 'inline-flex', alignItems: 'center', gap: 4, justifyContent: 'center' }}
                  >
                    {targetScoreboard ? <><ArrowRight size={12} strokeWidth={2} /> Send to Scoreboard</> : 'No scoreboard linked'}
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
