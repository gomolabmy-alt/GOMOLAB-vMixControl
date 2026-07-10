import { useEffect, useContext, useState } from 'react';
import { useCanvasStore, formatTime } from '../../stores/canvasStore';
import { CanvasActionContext } from '../../lib/canvasContext';
import { useTournamentStore } from '../../stores/tournamentStore';
import { SPORT_DEFAULTS } from '../../types/tournament';


interface Props {
  widgetId: string;
  config: Record<string, any>;
  w: number;
  h: number;
}

function periodLabel(current: number, total: number): string {
  if (total === 2) return current === 1 ? '1st Half' : '2nd Half';
  if (total === 4) return `Q${current}`;
  return `P${current}/${total}`;
}

function breakLabel(total: number): string {
  return total === 2 ? 'Half Time' : 'Break';
}

export function TimerWidget({ widgetId, config, h }: Props) {
  const store = useCanvasStore();
  const ctx = useContext(CanvasActionContext);
  const { startWidgetTimer, pauseWidgetTimer, resetWidgetTimer, adjustWidgetTimer, skipWidgetBreak, endWidgetPeriod, jumpToPeriod, startFinalPlay, startExtraTime, startAfterEt, pages, executeAppFunction } = store;
  const updateWidgetConfig = ctx?.updateWidgetConfig ?? store.updateWidgetConfig;

  const { tournaments } = useTournamentStore();

  // Arms the same confirm prompt as a natural (automatic) period end — both
  // paths share one UI so "end period" always looks and behaves the same,
  // whether the operator clicked End or the clock ran out on its own.
  const [pendingEnd, setPendingEnd] = useState(false);

  // When linked, use the source timer's state for display
  const allWidgets = pages.flatMap(p => p.widgets);
  const sourceWidget = config.linkedTimerSourceId
    ? allWidgets.find(w => w.id === config.linkedTimerSourceId && w.type === 'timer')
    : null;
  const isLinked = !!sourceWidget;
  const dc: Record<string, any> = sourceWidget?.config ?? config;

  const tournament = config.linkedTournamentId
    ? tournaments.find(t => t.id === config.linkedTournamentId)
    : null;

  // Live-follow tournament settings when not running
  useEffect(() => {
    if (!tournament || config.running) return;
    const s = tournament.settings ?? SPORT_DEFAULTS[tournament.sport];
    if (!s || s.periodDurationMs === 0) return;
    const tMode = s.timerMode ?? 'countup';
    const needsSync =
      config.periods         !== s.periods            ||
      config.durationMs      !== s.periodDurationMs    ||
      config.breakDurationMs !== s.halfTimeDurationMs  ||
      config.mode            !== tMode;
    if (needsSync) {
      updateWidgetConfig(widgetId, {
        periods:         s.periods,
        durationMs:      s.periodDurationMs,
        currentMs:       tMode === 'countdown' ? s.periodDurationMs : 0,
        breakDurationMs: s.halfTimeDurationMs,
        mode:            tMode,
        currentPeriod: 1, periodStartMs: 0, inBreak: false,
        breakCurrentMs: 0, overrunning: false,
      });
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    tournament?.settings?.periods,
    tournament?.settings?.periodDurationMs,
    tournament?.settings?.halfTimeDurationMs,
  ]);

  // Display state — when linked, mirror the source timer; otherwise use own config
  const periods = dc.periods ?? 1;
  const currentPeriod = dc.currentPeriod ?? 1;
  const inBreak = dc.inBreak ?? false;
  const overrunning = dc.overrunning ?? false;
  const periodStartMs = dc.periodStartMs ?? 0;

  // Extra time state
  const inExtraTime = dc.inExtraTime ?? false;
  const etPeriods = dc.extraTimePeriods ?? 0;
  const etCurrentPeriod = dc.etCurrentPeriod ?? 1;
  const etInBreak = dc.etInBreak ?? false;
  const etOverrunning = dc.etOverrunning ?? false;
  const etDurationMs = dc.etDurationMs ?? 300000;

  // Final Play state
  const inFinalPlay = dc.inFinalPlay ?? false;

  // After-ET (Sudden Death / Golden Point) state
  const inAfterEt = dc.inAfterEt ?? false;
  const afterEtMode = dc.afterEtMode ?? 'none';
  const afterEtOverrunning = dc.afterEtOverrunning ?? false;
  const hasAfterEt = afterEtMode !== 'none';
  const afterEtLabel = afterEtMode === 'goldenPoint' ? 'Golden Point' : 'Sudden Death';
  const afterEtDurationMs = dc.afterEtDurationMs ?? 0;

  // Accumulated game time.
  // During countup overrun, show elapsed-since-overrun-start (i.e. from 00:00),
  // not the full accumulated period time.
  const accumulatedMs = (() => {
    const isCountdown = (dc.mode ?? 'countdown') === 'countdown';
    const isContinue  = (dc.periodMode ?? 'reset') === 'continue';

    if (isCountdown || isContinue) {
      // Countup+continue overrun: currentMs = periodStart + durationMs + elapsed → strip the offset
      if (!isCountdown && (dc.overrunning ?? false) && (dc.durationMs ?? 0) > 0) {
        return Math.max(0, (dc.currentMs ?? 0) - (dc.periodStartMs ?? 0) - dc.durationMs);
      }
      return dc.currentMs ?? 0;
    }
    // Countup+reset overrun: same strip
    if ((dc.overrunning ?? false) && (dc.durationMs ?? 0) > 0) {
      return Math.max(0, (dc.currentMs ?? 0) - (dc.periodStartMs ?? 0) - dc.durationMs);
    }
    const period = Math.min(dc.currentPeriod ?? 1, dc.periods ?? 1);
    return (period - 1) * (dc.durationMs ?? 0) + (dc.currentMs ?? 0);
  })();

  const displayMs = accumulatedMs;
  const mainDisplayMs = displayMs; // FP timer rendered separately; period time shown as shrinking ref

  const activeMs = inFinalPlay
    ? (dc.finalPlayMs ?? 0)
    : inAfterEt
      ? (dc.afterEtCurrentMs ?? 0)
      : inExtraTime
        ? (dc.etCurrentMs ?? 0)
        : inBreak
          ? (dc.breakCurrentMs ?? 0)
          : accumulatedMs;

  const breakMs = inFinalPlay
    ? displayMs
    : inAfterEt
      ? (dc.afterEtCurrentMs ?? 0)
      : inExtraTime
        ? (etInBreak ? (dc.etBreakCurrentMs ?? 0) : (dc.etCurrentMs ?? 0))
        : (dc.breakCurrentMs ?? 0);

  const breakDurMs = inFinalPlay
    ? 0
    : inAfterEt
      ? (dc.afterEtDurationMs ?? 0)
      : inExtraTime
        ? (etInBreak ? (dc.etBreakDurationMs ?? 0) : etDurationMs)
        : (dc.breakDurationMs ?? 0);

  const fpMiniLabel = periods === 2
    ? (Math.min(currentPeriod, periods) === 1 ? '1H' : '2H')
    : periods === 4 ? `Q${Math.min(currentPeriod, periods)}` : `P${Math.min(currentPeriod, periods)}`;
  const miniLabel = inFinalPlay
    ? fpMiniLabel
    : inAfterEt
      ? (afterEtMode === 'goldenPoint' ? 'GP' : 'SD')
      : etInBreak
        ? (etPeriods === 2 ? 'ET HT' : 'ET Brk')
        : inExtraTime
          ? (etPeriods === 2 ? `ET ${etCurrentPeriod === 1 ? '1H' : '2H'}` : 'ET')
          : (periods === 2 ? 'HT' : 'Break');

  const miniOverrunning = inFinalPlay ? false : inAfterEt ? afterEtOverrunning : inExtraTime ? etOverrunning : false;
  const miniPrefix = miniOverrunning && dc.mode === 'countdown' ? '+' : '';
  const showBreakTimer =
    (inBreak && (dc.breakDurationMs ?? 0) > 0) ||
    inExtraTime ||
    inAfterEt ||
    inFinalPlay;

  const activeOverrunning = inAfterEt ? afterEtOverrunning : inExtraTime ? etOverrunning : overrunning;
  const displayPrefix = !inFinalPlay && !inExtraTime && !inAfterEt && overrunning ? '+' : '';
  const display = displayPrefix + formatTime(mainDisplayMs, config.format ?? dc.format ?? 'mm:ss');

  // Progress fraction — always expressed as "how much of this phase has
  // elapsed", so the bar fills the same way (0% → 100%) whether the clock is
  // counting up (currentMs already is elapsed) or counting down (currentMs is
  // remaining, so elapsed = duration − currentMs). Previously this used
  // currentMs directly everywhere, which only happened to be right for
  // count-up mode — countdown timers showed the bar running backwards.
  const isCountdown = dc.mode === 'countdown';
  const cfgBreakCountUp = dc.breakCountMode === 'up';
  const pct = (() => {
    if (inAfterEt) {
      if (afterEtOverrunning) return 100;
      if (afterEtDurationMs <= 0) return 0;
      const elapsed = isCountdown ? afterEtDurationMs - (dc.afterEtCurrentMs ?? 0) : (dc.afterEtCurrentMs ?? 0);
      return Math.min(100, Math.max(0, (elapsed / afterEtDurationMs) * 100));
    }
    if (inExtraTime) {
      if (etInBreak) {
        const bd = dc.etBreakDurationMs ?? 0;
        if (bd <= 0) return 0;
        const elapsed = cfgBreakCountUp ? (dc.etBreakCurrentMs ?? 0) : bd - (dc.etBreakCurrentMs ?? 0);
        return Math.min(100, Math.max(0, (elapsed / bd) * 100));
      }
      if (etOverrunning) return 100;
      if (etDurationMs <= 0) return 0;
      const etCurrent = (dc.etCurrentMs ?? 0) - (dc.etPeriodStartMs ?? 0);
      const elapsed = isCountdown ? etDurationMs - etCurrent : etCurrent;
      return Math.min(100, Math.max(0, (elapsed / etDurationMs) * 100));
    }
    if (inBreak && (dc.breakDurationMs ?? 0) > 0) {
      const elapsed = cfgBreakCountUp ? (dc.breakCurrentMs ?? 0) : dc.breakDurationMs - (dc.breakCurrentMs ?? 0);
      return Math.min(100, Math.max(0, (elapsed / dc.breakDurationMs) * 100));
    }
    if (dc.durationMs > 0 && !overrunning) {
      const current = (dc.currentMs ?? 0) - periodStartMs;
      const elapsed = isCountdown ? dc.durationMs - current : current;
      return Math.min(100, Math.max(0, (elapsed / dc.durationMs) * 100));
    }
    return overrunning ? 100 : 0;
  })();

  const barColor = activeOverrunning
    ? '#e74c3c'
    : (inBreak || etInBreak)
      ? '#e67e22'
      : dc.mode === 'countdown'
        ? (displayMs < (inExtraTime ? etDurationMs : dc.durationMs) * 0.2 ? '#e74c3c' : '#2ecc71')
        : '#3498db';

  const regularComplete = !inBreak && !overrunning && !inExtraTime && !inAfterEt && !inFinalPlay && currentPeriod > periods && periods > 1;
  const etComplete = inExtraTime && !etInBreak && !etOverrunning && !inAfterEt && etCurrentPeriod > etPeriods;
  const afterEtComplete = inAfterEt && !afterEtOverrunning && !dc.running;
  const canStartET = regularComplete && etPeriods > 0;
  const allPeriodsComplete = (regularComplete && etPeriods === 0 && !hasAfterEt) || (etComplete && !hasAfterEt) || afterEtComplete;

  const timeDisplay = formatTime(activeMs, config.format ?? dc.format ?? 'mm:ss');
  const endLabel = inFinalPlay
    ? '⏹ End Final Play'
    : periods > 1
      ? `⏹ End ${periodLabel(currentPeriod, periods)}`
      : '⏹ Full Time';

  const etEndLabel = etPeriods === 2
    ? `⏹ End ET ${etCurrentPeriod === 1 ? '1st Half' : '2nd Half'}`
    : '⏹ End ET';

  const etBadge = etComplete
    ? 'AET'
    : etInBreak
      ? 'ET Half Time'
      : etPeriods === 2
        ? (etCurrentPeriod === 1 ? 'ET 1st Half' : 'ET 2nd Half')
        : 'Extra Time';

  const autoPeriodLabel = inFinalPlay
    ? 'Final Play'
    : inBreak
      ? breakLabel(periods)
      : regularComplete
        ? 'Full Time'
        : periodLabel(currentPeriod, periods);

  // ── Responsive sizes from widget height ────────────────────────────────────
  const timeFontSize  = Math.max(18, Math.min(96, Math.floor(h * 0.27)));
  const playSize      = Math.max(32, Math.min(66, Math.floor(h * 0.24)));
  const playFontSize  = Math.max(12, Math.floor(playSize * 0.38));
  const iconSize      = Math.max(24, Math.min(52, Math.floor(h * 0.2)));
  const secSize       = Math.max(22, Math.min(44, Math.floor(h * 0.17)));
  const secFontSize   = Math.max(11, Math.floor(secSize * 0.44));

  // ── UI derived values for new card design ──────────────────────────────────

  // Header icon reflects current phase
  const headerIcon = allPeriodsComplete ? '✓'
    : inFinalPlay        ? '⚡'
    : inAfterEt          ? '⚔'
    : inExtraTime        ? '➕'
    : (inBreak || etInBreak) ? '☕'
    : '⏱';

  // Phase label shown in header
  const headerPhase = inAfterEt ? afterEtLabel
    : inExtraTime ? etBadge
    : autoPeriodLabel;

  // Subtitle: break mini-time when applicable, else duration hint.
  // During ET period / afterET the elapsed time is shown big (FP-style), so skip it here.
  const headerSub = showBreakTimer && (inFinalPlay || etInBreak)
    ? `${miniLabel} · ${miniPrefix}${formatTime(breakMs, config.format ?? dc.format ?? 'mm:ss')}`
    : !showBreakTimer && dc.durationMs > 0
      ? `${Math.round(dc.durationMs / 60000)}min${dc.breakDurationMs > 0 ? ` · ☕ ${Math.round(dc.breakDurationMs / 60000)}min` : ''}`
      : null;

  // Big play button
  type MainBtn =
    | { kind: 'done' }
    | { kind: 'start'; icon: string; lbl: string; color: string; fn: () => void }
    | { kind: 'play-pause'; color: string };

  const mainBtn: MainBtn = allPeriodsComplete
    ? { kind: 'done' }
    : regularComplete && canStartET
      ? { kind: 'start', icon: '▶', lbl: 'Start ET', color: '#9b59b6', fn: () => startExtraTime(widgetId) }
      : regularComplete && hasAfterEt
        ? { kind: 'start', icon: '▶', lbl: afterEtLabel, color: '#e67e22', fn: () => startAfterEt(widgetId) }
        : etComplete && hasAfterEt
          ? { kind: 'start', icon: '▶', lbl: afterEtLabel, color: '#e67e22', fn: () => startAfterEt(widgetId) }
          : {
              kind: 'play-pause',
              color: activeOverrunning ? '#e74c3c'
                : (inBreak || etInBreak) ? '#e67e22'
                : config.running ? '#2ecc71'
                : '#3498db',
            };

  const playLabel = mainBtn.kind === 'done'
    ? 'Done'
    : mainBtn.kind === 'start'
      ? mainBtn.lbl
      : config.running ? 'Pause' : (
          inFinalPlay ? 'Final Play' :
          inAfterEt ? afterEtLabel :
          inExtraTime ? 'Extra Time' :
          (inBreak || etInBreak) ? 'Resume' : 'Play'
        );

  // Secondary button (below big button)
  const secondaryBtn = (() => {
    if (mainBtn.kind !== 'play-pause') {
      if (regularComplete || etComplete || afterEtComplete) {
        return { icon: '↺', lbl: 'Reset', fn: () => resetWidgetTimer(widgetId), color: '#7b8cde' };
      }
      return null;
    }
    if (inBreak || etInBreak) return { icon: '⏭', lbl: 'Skip', fn: () => skipWidgetBreak(widgetId), color: '#e67e22' };
    return {
      icon: '⏹',
      lbl: (inAfterEt ? `End ${afterEtLabel}` : inExtraTime ? etEndLabel : endLabel).replace('⏹ ', ''),
      // Ending a regular period or an overrun manually cuts the clock short,
      // so it arms the same confirm prompt shown when the clock reaches the
      // end on its own (canvasStore.ts sets awaitingEndConfirm the same way)
      // — Final Play is already the "wrapping up" phase, so it ends immediately.
      // endWidgetPeriod already fires the period-end/final-play-end vMix
      // trigger internally — firing it again here sent every trigger twice,
      // which silently cancels out toggle-style vMix functions.
      fn: () => { if (inFinalPlay) endWidgetPeriod(widgetId); else setPendingEnd(true); },
      color: '#e74c3c',
    };
  })();

  const showEndConfirm = pendingEnd || !!config.awaitingEndConfirm;
  const confirmEnd = () => { endWidgetPeriod(widgetId); setPendingEnd(false); };
  const cancelEnd = () => {
    if (config.awaitingEndConfirm) updateWidgetConfig(widgetId, { awaitingEndConfirm: false });
    setPendingEnd(false);
  };

  // Adjust buttons
  const customBtns = (config.adjustButtons ?? []) as { id: string; label: string; deltaMs: number }[];
  const adjustBtns = customBtns.length > 0
    ? customBtns
    : [
        { id: '_m60', label: '−1m', deltaMs: -60000 },
        { id: '_m10', label: '−10s', deltaMs: -10000 },
        { id: '_p10', label: '+10s', deltaMs: 10000 },
        { id: '_p60', label: '+1m', deltaMs: 60000 },
      ];

  // ── Render ─────────────────────────────────────────────────────────────────

  const alertClass = inFinalPlay || (inExtraTime && etOverrunning) || (inAfterEt && afterEtOverrunning)
    ? ' wgt-tc--final-play'
    : activeOverrunning
      ? ' wgt-tc--overrun'
      : '';

  return (
    <div className={`wgt-tc${alertClass}`}>
      {/* ── Body: [label 1/3 + timer 2/3 + full-width bar] [buttons] ── */}
      <div className="wgt-tc-body">

        <div className="wgt-tc-main-area">
          <div className="wgt-tc-time-row">
            {/* Period label — 1/3 */}
            <div className="wgt-tc-label-col">
              <div className="wgt-tc-icon" style={{ width: iconSize, height: iconSize, fontSize: Math.floor(iconSize * 0.5) }}>{headerIcon}</div>
              {!inBreak && !inExtraTime && !inAfterEt && !inFinalPlay && periods > 1 ? (
                <select
                  className={`wgt-tc-phase wgt-tc-phase-select${activeOverrunning ? ' wgt-tc-phase--ot' : ''}`}
                  value={Math.min(currentPeriod, periods)}
                  title="Jump to a period"
                  onClick={e => e.stopPropagation()}
                  onChange={e => jumpToPeriod(widgetId, Number(e.target.value))}
                >
                  {Array.from({ length: periods }, (_, i) => i + 1).map(p => (
                    <option key={p} value={p}>{periodLabel(p, periods)}</option>
                  ))}
                </select>
              ) : (
                <span className={`wgt-tc-phase${activeOverrunning ? ' wgt-tc-phase--ot' : ''}`}>
                  {headerPhase}
                  {activeOverrunning && !inExtraTime && !inAfterEt && <span className="wgt-tc-ot-tag"> +OT</span>}
                </span>
              )}
              {headerSub && <span className="wgt-tc-sub">{headerSub}</span>}
              {isLinked && (
                <span className="wgt-tc-linked" title={`Linked to: ${sourceWidget?.label ?? sourceWidget?.id}`}>
                  ↗ {sourceWidget?.label ?? 'Linked'}
                </span>
              )}
            </div>
            {/* Main time — 2/3 */}
            {inFinalPlay || inExtraTime || inAfterEt || inBreak ? (
              <div className="wgt-tc-time-area wgt-tc-time-area--fp">
                {/* Period/base time shrinks to reference */}
                <div className="wgt-tc-fp-period" style={{ fontSize: Math.floor(timeFontSize * 0.36) }}>
                  {display}
                </div>
                {/* ET / afterET / FP / break counter — grows in beside the shrunk period reference */}
                <div className="wgt-tc-time wgt-tc-time--fp" style={{ fontSize: timeFontSize }}>
                  {formatTime(activeMs, config.format ?? dc.format ?? 'mm:ss')}
                </div>
              </div>
            ) : (
              <div className="wgt-tc-time-area">
                <div className={`wgt-tc-time${overrunning ? ' wgt-tc-time--overrun' : ''}`} style={{ fontSize: timeFontSize }}>
                  {display}
                </div>
              </div>
            )}
          </div>
          {(dc.durationMs > 0 || (inBreak && dc.breakDurationMs > 0) || inExtraTime || inAfterEt || periods > 1) && (() => {
            const overallFrac = periods > 1
              ? inBreak
                ? currentPeriod / periods
                : (inExtraTime || inAfterEt || allPeriodsComplete)
                  ? 1
                  : Math.min(currentPeriod - 1 + pct / 100, periods) / periods
              : pct / 100;
            const trackPct = Math.max(0, Math.min(100, overallFrac * 100));

            // Gradient: red bleeds in from right during last 30% of each period
            const completedFillPct = periods > 1 && trackPct > 0
              ? Math.min(100, (currentPeriod - 1) / periods * 10000 / trackPct)
              : 0;
            const warnContainerPct = ((currentPeriod - 1) + 0.7) / periods * 100;
            const warnFillPct = trackPct > 0 ? warnContainerPct * 100 / trackPct : 200;
            const fillBg = (overrunning || inBreak || etInBreak || allPeriodsComplete || warnFillPct >= 100)
              ? barColor
              : `linear-gradient(to right, ${barColor} ${completedFillPct.toFixed(1)}%, ${barColor} ${warnFillPct.toFixed(1)}%, #e74c3c 100%)`;

            return (
              <div className="wgt-tc-route" style={{ ['--rbc' as string]: barColor } as any}>
                <div className="wgt-tc-route-pill">
                  <div className="wgt-tc-route-track">
                    <div className="wgt-tc-route-fill" style={{ width: `${trackPct}%`, background: fillBg }} />
                    {periods > 1 && Array.from({ length: periods + 1 }, (_, i) => {
                      const pos = (i / periods) * 100;
                      return (
                        <div key={i} className={`wgt-tc-route-stn${pos < trackPct ? ' passed' : ''}`} style={{ left: `${pos}%` }} />
                      );
                    })}
                    <div className="wgt-tc-route-cursor" style={{ left: `${trackPct}%` }} />
                  </div>
                </div>
                {periods > 1 && (
                  <div className="wgt-tc-route-lbls">
                    {Array.from({ length: periods + 1 }, (_, i) => (
                      <span key={i} className="wgt-tc-route-lbl">
                        {i < periods
                          ? periods === 2 ? (i === 0 ? '1H' : '2H') : periods === 4 ? `Q${i + 1}` : `P${i + 1}`
                          : 'FT'}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            );
          })()}
        </div>

        {/* Right: play / secondary / reset buttons */}
        {!isLinked && (
          <div className="wgt-tc-btn-col">
            {showEndConfirm ? (
              // Same prompt whether the operator clicked End or the clock ran
              // out on its own (canvasStore.ts sets awaitingEndConfirm the
              // same way) — styled identically to the regular timer buttons
              // instead of a generic confirm bar, since it's replacing them.
              <>
                <button className="wgt-tc-play" style={{ fontSize: playFontSize, background: '#e74c3c', boxShadow: '0 3px 10px #e74c3c55' }} onClick={confirmEnd}>
                  <span className="wgt-tc-play-circle">✓</span>
                  <span className="wgt-tc-play-lbl">Confirm {secondaryBtn?.lbl ?? 'End Period'}</span>
                </button>
                <button className="wgt-tc-play" style={{ fontSize: playFontSize, background: '#8899aa', boxShadow: '0 3px 10px #8899aa44' }} onClick={cancelEnd}>
                  <span className="wgt-tc-play-circle">✕</span>
                  <span className="wgt-tc-play-lbl">Cancel</span>
                </button>
              </>
            ) : (
              <>
                {/* Play / Pause / Start / Done */}
                {mainBtn.kind === 'done' ? (
                  <div className="wgt-tc-play wgt-tc-play--done" style={{ fontSize: playFontSize }}>
                    <span className="wgt-tc-play-circle">✓</span>
                    <span className="wgt-tc-play-lbl">Done</span>
                  </div>
                ) : mainBtn.kind === 'start' ? (
                  <button className="wgt-tc-play" style={{ fontSize: playFontSize, background: mainBtn.color, boxShadow: `0 3px 10px ${mainBtn.color}55` }} onClick={mainBtn.fn}>
                    <span className="wgt-tc-play-circle">{mainBtn.icon}</span>
                    <span className="wgt-tc-play-lbl">{mainBtn.lbl}</span>
                  </button>
                ) : (
                  <button className="wgt-tc-play" style={{ fontSize: playFontSize, background: mainBtn.color, boxShadow: `0 3px 10px ${mainBtn.color}55` }}
                    onClick={() => config.running ? pauseWidgetTimer(widgetId) : startWidgetTimer(widgetId)}
                  >
                    <span className="wgt-tc-play-circle">{config.running ? '⏸' : '▶'}</span>
                    <span className="wgt-tc-play-lbl">{playLabel}</span>
                  </button>
                )}

                {/* Secondary (Break / Next Period) */}
                {secondaryBtn && (
                  <button className="wgt-tc-play" style={{ fontSize: playFontSize, background: secondaryBtn.color, boxShadow: `0 3px 10px ${secondaryBtn.color}55` }} onClick={secondaryBtn.fn}>
                    <span className="wgt-tc-play-circle">{secondaryBtn.icon}</span>
                    <span className="wgt-tc-play-lbl">{secondaryBtn.lbl}</span>
                  </button>
                )}

                {/* Reset */}
                <button className="wgt-tc-play" style={{ fontSize: playFontSize, background: '#8899aa', boxShadow: '0 3px 10px #8899aa44' }}
                  onClick={() => resetWidgetTimer(widgetId)}
                >
                  <span className="wgt-tc-play-circle">↺</span>
                  <span className="wgt-tc-play-lbl">Reset</span>
                </button>
              </>
            )}
          </div>
        )}
      </div>

      {/* ── Footer: adjust buttons + stats ── */}
      {!isLinked && (
        <div className="wgt-tc-footer">
          <div className="wgt-tc-stats">
            {dc.durationMs > 0 && <span>⏱ {Math.round(dc.durationMs / 60000)}min</span>}
            {dc.breakDurationMs > 0 && (
              <><span className="wgt-tc-dot">·</span><span>☕ {Math.round(dc.breakDurationMs / 60000)}min</span></>
            )}
          </div>
          <div className="wgt-tc-btns">
            {adjustBtns.map((btn) => (
              <button key={btn.id} className="wgt-tc-adj" onClick={() => adjustWidgetTimer(widgetId, btn.deltaMs)}>
                {btn.label}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
