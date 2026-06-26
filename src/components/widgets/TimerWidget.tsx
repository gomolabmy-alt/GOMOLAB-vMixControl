import { useEffect } from 'react';
import { useCanvasStore, formatTime } from '../../stores/canvasStore';
import { useTournamentStore } from '../../stores/tournamentStore';
import { useVmixStore } from '../../stores/vmixStore';
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

export function TimerWidget({ widgetId, config }: Props) {
  const { startWidgetTimer, pauseWidgetTimer, resetWidgetTimer, adjustWidgetTimer, skipWidgetBreak, endWidgetPeriod, startFinalPlay, startExtraTime, startAfterEt, updateWidgetConfig, pages, executeAppFunction } = useCanvasStore();
  const { sendFunction } = useVmixStore();

  const { tournaments } = useTournamentStore();

  const fireTrigger = (fnKey: string, inputKey: string, selectedName: string, value: string) => {
    if (!fnKey) return;
    const params: Record<string, string> = {};
    if (inputKey)     params.Input        = inputKey;
    if (selectedName) params.SelectedName = selectedName;
    if (value)        params.Value        = value;
    sendFunction(fnKey, params);
  };

  const fireFinalPlayEnd = () => {
    if (!config.finalPlayEndTriggerEnabled) return;
    fireTrigger(
      config.finalPlayEndTriggerFn      ?? '',
      config.finalPlayEndTriggerInput   ?? '',
      config.finalPlayEndTriggerSelectedName ?? '',
      config.finalPlayEndTriggerValue   ?? '',
    );
  };

  const firePeriodEnd = () => {
    if (!config.periodEndTriggerEnabled) return;
    fireTrigger(
      config.periodEndTriggerFn      ?? '',
      config.periodEndTriggerInput   ?? '',
      config.periodEndTriggerSelectedName ?? '',
      config.periodEndTriggerValue   ?? '',
    );
  };

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

  // Accumulated game time: count-up + reset mode accumulates previous periods
  // (continue mode already carries currentMs forward; countdown resets to durationMs each period)
  const accumulatedMs = (() => {
    if ((dc.mode ?? 'countdown') === 'countdown' || (dc.periodMode ?? 'reset') === 'continue') {
      return dc.currentMs ?? 0;
    }
    const period = Math.min(dc.currentPeriod ?? 1, dc.periods ?? 1);
    return (period - 1) * (dc.durationMs ?? 0) + (dc.currentMs ?? 0);
  })();

  // Main display: game time normally; swapped to FP count-up when in Final Play
  const displayMs = accumulatedMs;
  const mainDisplayMs = inFinalPlay ? (dc.finalPlayMs ?? 0) : displayMs;

  // Active time used for button labels (reflects current running phase)
  const activeMs = inFinalPlay
    ? (dc.finalPlayMs ?? 0)
    : inAfterEt
      ? (dc.afterEtCurrentMs ?? 0)
      : inExtraTime
        ? (dc.etCurrentMs ?? 0)
        : accumulatedMs;

  // Secondary mini: frozen game time during FP, break/ET/GP time otherwise
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

  // Mini label: when in FP, label the frozen game clock shown in mini
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
  // Main display prefix: only for regular period overrun (not during Final Play)
  const displayPrefix = !inFinalPlay && overrunning && dc.mode === 'countdown' ? '+' : '';
  const display = displayPrefix + formatTime(mainDisplayMs, config.format ?? dc.format ?? 'mm:ss');

  const pct = (() => {
    if (inAfterEt) {
      if (afterEtOverrunning) return 100;
      return afterEtDurationMs > 0
        ? Math.min(100, ((dc.afterEtCurrentMs ?? 0) / afterEtDurationMs) * 100)
        : 0;
    }
    if (inExtraTime) {
      if (etInBreak) {
        const bd = dc.etBreakDurationMs ?? 0;
        return bd > 0 ? Math.min(100, ((dc.etBreakCurrentMs ?? 0) / bd) * 100) : 0;
      }
      if (etOverrunning) return 100;
      return etDurationMs > 0
        ? Math.min(100, (((dc.etCurrentMs ?? 0) - (dc.etPeriodStartMs ?? 0)) / etDurationMs) * 100)
        : 0;
    }
    if (inBreak && (dc.breakDurationMs ?? 0) > 0)
      return Math.min(100, ((dc.breakCurrentMs ?? 0) / dc.breakDurationMs) * 100);
    if (dc.durationMs > 0 && !overrunning)
      return Math.min(100, (((dc.currentMs ?? 0) - periodStartMs) / dc.durationMs) * 100);
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

  return (
    <div className="wgt-timer">
      {!isLinked && (
        <button className="wgt-timer-reset-top" title="Reset timer" onClick={() => resetWidgetTimer(widgetId)}>↺</button>
      )}
      {isLinked && (
        <div className="wgt-timer-linked-badge" title={`Linked to: ${sourceWidget?.label ?? sourceWidget?.id}`}>↗ {sourceWidget?.label ?? 'Linked'}</div>
      )}

      {(periods > 1 || inExtraTime || inAfterEt || inFinalPlay) && (
        <div className={`wgt-timer-period ${(inBreak || etInBreak) ? 'wgt-timer-period--break' : ''} ${activeOverrunning ? 'wgt-timer-period--overrun' : ''}`}>
          {inAfterEt ? afterEtLabel : inExtraTime ? etBadge : autoPeriodLabel}
          {activeOverrunning && <span className="wgt-timer-ot"> +OT</span>}
        </div>
      )}

      <div className="wgt-timer-display-row">
        <div
          className={`wgt-timer-display ${inBreak ? 'wgt-timer-display--break' : ''} ${overrunning ? 'wgt-timer-display--overrun' : ''}`}
          style={{ fontSize: config.timerFontSize ?? 28 }}
        >
          {display}
        </div>
        {showBreakTimer && (
          <div className="wgt-timer-break-mini">
            <span className="wgt-timer-break-mini-label">{miniLabel}</span>
            <span className="wgt-timer-break-mini-time" style={{ fontSize: Math.round((config.timerFontSize ?? 28) * 0.48) }}>
              {miniPrefix}{formatTime(breakMs, config.format ?? dc.format ?? 'mm:ss')}
            </span>
          </div>
        )}
      </div>

      {(dc.durationMs > 0 || (inBreak && dc.breakDurationMs > 0) || inExtraTime) && (
        <div className="wgt-timer-bar">
          <div className="wgt-timer-bar-fill" style={{ width: `${pct}%`, background: barColor }} />
        </div>
      )}

      {!isLinked && !inBreak && !overrunning && !etInBreak && !etOverrunning && (
        <div className="wgt-timer-adjust">
          <button className="wgt-timer-adj" onClick={() => adjustWidgetTimer(widgetId, -60000)}>–1m</button>
          <button className="wgt-timer-adj" onClick={() => adjustWidgetTimer(widgetId, -10000)}>–10s</button>
          <button className="wgt-timer-adj" onClick={() => adjustWidgetTimer(widgetId, 10000)}>+10s</button>
          <button className="wgt-timer-adj" onClick={() => adjustWidgetTimer(widgetId, 60000)}>+1m</button>
        </div>
      )}

      {!isLinked && (
        <div className="wgt-timer-controls" style={{ fontSize: config.btnFontSize ?? 13 }}>
          {/* ── Done states ── */}
          {regularComplete ? (
            <>
              <button className="wgt-timer-btn wgt-timer-btn--end">⏹ Full Time</button>
              {etPeriods > 0 && (
                <button className="wgt-timer-btn wgt-timer-btn--et" onClick={() => startExtraTime(widgetId)}>
                  ▶ Start ET
                </button>
              )}
              {etPeriods === 0 && hasAfterEt && (
                <button className="wgt-timer-btn wgt-timer-btn--et" onClick={() => startAfterEt(widgetId)}>
                  ▶ {afterEtLabel}
                </button>
              )}
              <button className="wgt-timer-btn wgt-timer-btn--reset" onClick={() => resetWidgetTimer(widgetId)}>↺ Reset</button>
            </>
          ) : etComplete ? (
            <>
              <button className="wgt-timer-btn wgt-timer-btn--end">⏹ AET</button>
              {hasAfterEt && (
                <button className="wgt-timer-btn wgt-timer-btn--et" onClick={() => startAfterEt(widgetId)}>
                  ▶ {afterEtLabel}
                </button>
              )}
              <button className="wgt-timer-btn wgt-timer-btn--reset" onClick={() => resetWidgetTimer(widgetId)}>↺ Reset</button>
            </>
          ) : afterEtComplete ? (
            <>
              <button className="wgt-timer-btn wgt-timer-btn--end">⏹ {afterEtLabel}</button>
              <button className="wgt-timer-btn wgt-timer-btn--reset" onClick={() => resetWidgetTimer(widgetId)}>↺ Reset</button>
            </>
          ) : (inBreak || etInBreak) ? (
            /* ── Break state ── */
            <>
              {config.running ? (
                <button className="wgt-timer-btn wgt-timer-btn--pause" onClick={() => pauseWidgetTimer(widgetId)}>
                  ⏸ Pause Break
                </button>
              ) : (
                <button className="wgt-timer-btn wgt-timer-btn--start" onClick={() => startWidgetTimer(widgetId)}>
                  {etInBreak ? '▶ Resume ET Break' : '▶ Resume Break'}
                </button>
              )}
              <button className="wgt-timer-btn wgt-timer-btn--skip" onClick={() => skipWidgetBreak(widgetId)}>⏭ Skip</button>
              <button className="wgt-timer-btn wgt-timer-btn--reset" onClick={() => resetWidgetTimer(widgetId)}>↺ Reset</button>
            </>
          ) : (
            /* ── Active play (normal + overrun, regular + ET + afterEt) ── */
            <>
              <button className="wgt-timer-btn wgt-timer-btn--end" onClick={() => {
                endWidgetPeriod(widgetId);
                if (inFinalPlay) fireFinalPlayEnd();
                else if (!inExtraTime && !inAfterEt) firePeriodEnd();
              }}>
                {inAfterEt ? `⏹ ${afterEtLabel}` : inExtraTime ? etEndLabel : endLabel}
              </button>
              {config.running ? (
                <button className="wgt-timer-btn wgt-timer-btn--pause" onClick={() => pauseWidgetTimer(widgetId)}>⏸ Pause</button>
              ) : (
                <button className="wgt-timer-btn wgt-timer-btn--start" onClick={() => startWidgetTimer(widgetId)}>
                  {inFinalPlay
                    ? '▶ Resume Final Play'
                    : inAfterEt
                      ? `▶ ${afterEtLabel}`
                      : inExtraTime
                        ? etPeriods === 2
                          ? `▶ Start ET ${etCurrentPeriod === 1 ? '1st Half' : '2nd Half'}`
                          : '▶ Start Extra Time'
                        : periods > 1 && currentPeriod > 1
                          ? `▶ Start ${periodLabel(currentPeriod, periods)}`
                          : '▶ Start'}
                </button>
              )}
              <button className="wgt-timer-btn wgt-timer-btn--reset" onClick={() => resetWidgetTimer(widgetId)}>↺ Reset</button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
