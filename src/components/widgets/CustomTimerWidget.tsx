import { useState, useEffect, useRef, useContext } from 'react';
import { Timer, Pause, Play, Settings, Clock, Minus, Plus, RotateCcw, X, AlarmClock } from 'lucide-react';
import { useCanvasStore } from '../../stores/canvasStore';
import { useUndoStore } from '../../stores/undoStore';
import { useVmixStore } from '../../stores/vmixStore';
import { useMatchScheduleStore } from '../../stores/matchScheduleStore';
import { useRundownStore } from '../../stores/rundownStore';
import { useTournamentStore } from '../../stores/tournamentStore';
import { useAppSettings } from '../../stores/appSettingsStore';
import { formatLate } from '../../utils/scoreboardSnapshot';
import { resolveImageUrl } from '../../lib/imageUrl';
import { computeCountdownState, buildCountdownVmixPushes, fmtCountdownDuration as fmtDuration } from '../../lib/countdownCompute';
import { CanvasActionContext } from '../../lib/canvasContext';

interface Props {
  widgetId: string;
  config: Record<string, any>;
  w: number;
  h: number;
}

type TimerMode = 'countdown' | 'countup' | 'target';
type ClockFormat = '12h' | '24h';

// datetime-local inputs use "YYYY-MM-DDTHH:mm" in local time (no timezone) —
// new Date(thatString) already parses it as local time, so fromInput is a
// direct pass-through; toInput just has to format the reverse.
function targetToInputValue(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function fmtTargetAbs(ts: number): string {
  return new Date(ts).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

const BOTTOM_CLOCK_ICON_SIZE: Record<'small' | 'medium' | 'large' | 'xlarge', number> = {
  small: 10, medium: 12, large: 16, xlarge: 20,
};

function fmtClock(d: Date, format: ClockFormat): string {
  let h = d.getHours();
  const m = String(d.getMinutes()).padStart(2, '0');
  const s = String(d.getSeconds()).padStart(2, '0');
  if (format === '12h') {
    const ampm = h >= 12 ? 'PM' : 'AM';
    h = h % 12 || 12;
    return `${h}:${m}:${s} ${ampm}`;
  }
  return `${String(h).padStart(2, '0')}:${m}:${s}`;
}

// A free-standing, general-purpose timer — not tied to focus/break cycles
// like the old Pomodoro widget was. Everything reads/writes through the
// canvas store's config instead of local component state, so Play/Pause,
// duration changes, and the running clock actually persist and sync across
// clients the same way every other widget in this app does.
export function CustomTimerWidget({ widgetId, config }: Props) {
  const store = useCanvasStore();
  const ctx = useContext(CanvasActionContext);
  const updateWidgetConfig = ctx?.updateWidgetConfig ?? store.updateWidgetConfig;
  const up = (patch: Record<string, any>) => updateWidgetConfig(widgetId, patch);

  const label: string = config.label ?? 'Custom Timer';
  const timerMode: TimerMode = config.timerMode ?? 'countdown';
  const durationMs: number = config.durationMs ?? 10 * 60 * 1000;
  const currentMs: number = config.currentMs ?? (timerMode === 'countdown' ? durationMs : 0);
  const running: boolean = !!config.running;
  const showClock: boolean = !!config.showClock;
  const clockFormat: ClockFormat = config.clockFormat ?? '24h';
  // Size of the small wall-clock readout in the footer — independent of
  // clockSize, which is the big countdown number above it.
  const bottomClockSize: 'small' | 'medium' | 'large' | 'xlarge' = config.bottomClockSize ?? 'medium';
  // Absolute date/time to count down to (epoch ms) — 'target' mode only,
  // manual entry. Kept even while link-source is set so switching the link
  // back to "none" restores whatever the operator last picked by hand.
  const targetTimestamp: number = config.targetTimestamp ?? Date.now() + 60 * 60 * 1000;
  // Tournament scoping (match link only — a rundown spans the whole day,
  // deliberately not scoped to one tournament, see rundownStore.ts): an
  // explicit pick here, else this canvas page's own bound tournament, else
  // the title bar's picker — same fallback chain every other schedule-aware
  // widget resolves through.
  const filterTournamentId: string = config.filterTournamentId ?? '';
  const { matches: scheduleMatches } = useMatchScheduleStore();
  const { segments: rundownSegments } = useRundownStore();
  const { tournaments } = useTournamentStore();
  const { canvasTournamentId } = useAppSettings();
  const owningPage = store.pages.find(p => p.widgets.some(w => w.id === widgetId));
  // How big the linked-item details card renders (logos/names/meta, or the
  // rundown title) — independent of the widget's own box size, since a
  // countdown might sit small in a corner or large as its own dedicated
  // graphic.
  const matchDetailsSize: 'small' | 'medium' | 'large' = config.matchDetailsSize ?? 'medium';
  // How big the big countdown number itself renders.
  const clockSize: 'small' | 'medium' | 'large' | 'xlarge' = config.clockSize ?? 'medium';
  // Optional: push the live countdown text into a vMix Title's text field
  // (e.g. a GT overlay) every time it changes, same setTextField call every
  // other vMix-aware widget in this app uses. vmixTitleField is a second,
  // optional field on the SAME input for what's being counted down to (team
  // matchup, or the rundown item's title) — most useful paired with a
  // linked countdown, but available in every mode. vmixMergeFields combines
  // both into the Time Field instead, for a title that only has one generic
  // text field rather than two separately named ones.
  const vmixInputKey: string = config.vmixInputKey ?? '';
  const vmixFieldName: string = config.vmixFieldName ?? 'Countdown.Text';
  const vmixTitleField: string = config.vmixTitleField ?? '';
  const vmixMergeFields: boolean = !!config.vmixMergeFields;
  const { getClient, vmixState } = useVmixStore();
  const vmixSelectedInput = vmixState?.inputs.find(inp => inp.key === vmixInputKey);

  const [showSettings, setShowSettings] = useState(false);
  const [now, setNow] = useState(() => new Date());

  // Live wall-clock tick — runs while the clock readout is shown, and always
  // in 'target' mode since its remaining time is derived from wall-clock
  // rather than ticked/persisted through config like the other two modes.
  useEffect(() => {
    if (!showClock && timerMode !== 'target') return;
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, [showClock, timerMode]);

  // Same computation the background vMix pusher (countdownVmixSync.ts) runs
  // on a plain interval independent of this component ever being mounted —
  // sharing it here means the on-screen display and whatever gets pushed to
  // vMix can never drift apart.
  const {
    linkSource, displayMs, timeText, isOverrun, overrunMs, targetRemainingMs, targetUnresolved,
    effectiveTargetTs, nextScheduledMatch, nextRundownSegment, linkedTitleText,
  } = computeCountdownState(config, now.getTime(), {
    scheduleMatches, rundownSegments, pageTournamentId: owningPage?.tournamentId, canvasTournamentId,
  });
  const isMatchLinked = linkSource === 'match';
  const isRundownLinked = linkSource === 'rundown';

  // Refs so the tick interval always reads the latest value without a stale
  // closure, without needing to tear down/recreate the interval every second.
  const currentMsRef = useRef(currentMs);
  const timerModeRef = useRef(timerMode);
  currentMsRef.current = currentMs;
  timerModeRef.current = timerMode;

  useEffect(() => {
    if (!running) return;
    const id = setInterval(() => {
      if (timerModeRef.current === 'countdown') {
        const next = Math.max(0, currentMsRef.current - 1000);
        if (next === 0) up({ currentMs: 0, running: false });
        else up({ currentMs: next });
      } else {
        up({ currentMs: currentMsRef.current + 1000 });
      }
    }, 1000);
    return () => clearInterval(id);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [running, widgetId]);

  const handlePlayPause = () => up({ running: !running });
  const handleReset = () => {
    const before = { running: config.running, currentMs: config.currentMs };
    up({ running: false, currentMs: timerMode === 'countdown' ? durationMs : 0 });
    useUndoStore.getState().pushUndo('Reset timer', () => up(before));
  };
  const handleAddMinute = () => up({ currentMs: currentMs + 60000 });
  const handleSubMinute = () => up({ currentMs: Math.max(0, currentMs - 60000) });

  const setDurationMins = (mins: number) => {
    const secs = Math.floor((durationMs % 60000) / 1000);
    const next = Math.max(0, mins) * 60000 + secs * 1000;
    up({ durationMs: next, ...(timerMode === 'countdown' && !running ? { currentMs: next } : {}) });
  };
  const setDurationSecs = (secs: number) => {
    const mins = Math.floor(durationMs / 60000);
    const next = mins * 60000 + Math.max(0, Math.min(59, secs)) * 1000;
    up({ durationMs: next, ...(timerMode === 'countdown' && !running ? { currentMs: next } : {}) });
  };
  const setMode = (mode: TimerMode) => up({
    timerMode: mode,
    running: false,
    currentMs: mode === 'countdown' ? durationMs : 0,
    ...(mode === 'target' && config.targetTimestamp == null ? { targetTimestamp } : {}),
  });
  const setTarget = (ts: number) => up({ targetTimestamp: ts });
  const setLinkSource = (v: 'none' | 'match' | 'rundown') => up({ linkSource: v });

  const isDone = timerMode === 'target'
    ? !targetUnresolved && targetRemainingMs === 0
    : timerMode === 'countdown' && currentMs === 0 && !running;
  const totalMs = durationMs || 1;
  const pct = timerMode === 'countdown'
    ? Math.min(100, ((totalMs - currentMs) / totalMs) * 100)
    : Math.min(100, (currentMs / totalMs) * 100);
  const accent = isOverrun ? '#e74c3c' : isDone ? '#2ecc71' : '#6366f1';

  // Automatic per-second pushing is handled globally by
  // countdownVmixSync.ts (independent of this component being mounted —
  // see its own comment for why that matters). This is just a manual
  // "test it right now" trigger for the Settings panel's Send Now button.
  const pushToVmix = () => {
    const c = getClient();
    if (!c || !vmixInputKey) return;
    for (const { field, value } of buildCountdownVmixPushes(config, { timeText, linkedTitleText })) {
      c.setTextField(vmixInputKey, field, value);
    }
  };

  return (
    <div className={`wgt-ctimer${isOverrun ? ' wgt-ctimer--overrun' : ''}`}>
      <div className="wgt-ctimer-header">
        <div className="wgt-ctimer-info">
          <div className="wgt-ctimer-icon"><Timer size={20} strokeWidth={1.75} /></div>
          <div className="wgt-ctimer-meta">
            <span className="wgt-ctimer-label">{label}</span>
            <span className="wgt-ctimer-sub">
              {timerMode === 'countdown' ? 'Countdown' : timerMode === 'countup' ? 'Count Up'
                : isMatchLinked ? 'Countdown to Next Match' : isRundownLinked ? 'Countdown to Next Rundown Item' : 'Countdown to Date/Time'}
              {targetUnresolved ? ` · No upcoming ${isRundownLinked ? 'item' : 'match'}` : isOverrun ? ' · Overrun' : isDone ? (timerMode === 'target' ? ' · Started' : ' · Done') : ''}
            </span>
          </div>
        </div>
        <div className="wgt-ctimer-actions">
          {timerMode !== 'target' && (
            <button
              className="wgt-ctimer-playpause"
              style={{ background: accent, boxShadow: `0 4px 14px ${accent}66` }}
              onClick={handlePlayPause}
              title={running ? 'Pause' : 'Start'}
            >
              {running ? <Pause size={18} strokeWidth={2} fill="currentColor" /> : <Play size={18} strokeWidth={2} fill="currentColor" />}
            </button>
          )}
          <button
            className={`wgt-ctimer-settings-btn${showSettings ? ' wgt-ctimer-settings-btn--active' : ''}`}
            onClick={() => setShowSettings(v => !v)}
            title="Settings"
          ><Settings size={16} strokeWidth={2} /></button>
        </div>
      </div>

      {isOverrun && (
        <div className="wgt-ctimer-overrun-badge" style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
          <AlarmClock size={12} strokeWidth={2} /> OVERRUN — {formatLate(overrunMs)} late
        </div>
      )}

      {timerMode === 'target' && isMatchLinked && nextScheduledMatch && (
        <div className={`wgt-ctimer-match wgt-ctimer-match--${matchDetailsSize}`}>
          {nextScheduledMatch.category && (
            <span className="wgt-ctimer-match-cat">{nextScheduledMatch.category}</span>
          )}
          <div className="wgt-ctimer-match-row">
            <div className="wgt-ctimer-match-team">
              {nextScheduledMatch.teamALogo
                ? <img className="wgt-ctimer-match-logo" src={resolveImageUrl(nextScheduledMatch.teamALogo)} alt="" />
                : <span className="wgt-ctimer-match-logo-ph" style={{ background: nextScheduledMatch.teamAColor }} />}
              <span className="wgt-ctimer-match-name">{nextScheduledMatch.teamAShortName || nextScheduledMatch.teamAName}</span>
            </div>
            <span className="wgt-ctimer-match-vs">vs</span>
            <div className="wgt-ctimer-match-team wgt-ctimer-match-team--b">
              <span className="wgt-ctimer-match-name">{nextScheduledMatch.teamBShortName || nextScheduledMatch.teamBName}</span>
              {nextScheduledMatch.teamBLogo
                ? <img className="wgt-ctimer-match-logo" src={resolveImageUrl(nextScheduledMatch.teamBLogo)} alt="" />
                : <span className="wgt-ctimer-match-logo-ph" style={{ background: nextScheduledMatch.teamBColor }} />}
            </div>
          </div>
          {(nextScheduledMatch.competition || nextScheduledMatch.round || nextScheduledMatch.venue) && (
            <div className="wgt-ctimer-match-meta">
              {[nextScheduledMatch.competition, nextScheduledMatch.round, nextScheduledMatch.venue].filter(Boolean).join(' · ')}
            </div>
          )}
        </div>
      )}

      {timerMode === 'target' && isRundownLinked && nextRundownSegment && (
        <div className={`wgt-ctimer-match wgt-ctimer-match--${matchDetailsSize}`}>
          <div className="wgt-ctimer-rundown-title">{nextRundownSegment.title}</div>
          {nextRundownSegment.notes && (
            <div className="wgt-ctimer-match-meta">{nextRundownSegment.notes}</div>
          )}
        </div>
      )}

      <div className={`wgt-ctimer-time wgt-ctimer-time--${clockSize}${isOverrun ? ' wgt-ctimer-time--overrun' : ''}`}>{timeText}</div>

      {timerMode !== 'target' && (
        <div className="wgt-ctimer-bar">
          <div
            className="wgt-ctimer-bar-fill"
            style={{ width: `${pct}%`, background: accent, transition: running ? 'width 0.9s linear' : 'none' }}
          />
        </div>
      )}

      <div className="wgt-ctimer-footer">
        <div className="wgt-ctimer-stats">
          {showClock
            ? <span className={`wgt-ctimer-clock wgt-ctimer-clock--${bottomClockSize}`} style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}><Clock size={BOTTOM_CLOCK_ICON_SIZE[bottomClockSize]} strokeWidth={2} /> {fmtClock(now, clockFormat)}</span>
            : timerMode === 'target'
              ? linkSource !== 'none'
                ? (nextScheduledMatch || nextRundownSegment)
                  ? <span>{effectiveTargetTs != null ? `${isOverrun ? 'Was due' : 'Until'} ${fmtTargetAbs(effectiveTargetTs)}` : `No date/time set for this ${isRundownLinked ? 'item' : 'match'}`}</span>
                  : <span>No upcoming {isRundownLinked ? 'rundown item' : 'match scheduled'}</span>
                : <span>Until {fmtTargetAbs(targetTimestamp)}</span>
              : <span>{timerMode === 'countdown' ? `Set ${fmtDuration(durationMs)}` : `Target ${fmtDuration(durationMs)}`}</span>}
        </div>
        {timerMode !== 'target' && (
          <div className="wgt-ctimer-controls">
            <button className="wgt-ctimer-ctrl" onClick={handleSubMinute} title="-1 minute"><Minus size={14} strokeWidth={2} /></button>
            <button className="wgt-ctimer-ctrl" onClick={handleAddMinute} title="+1 minute"><Plus size={14} strokeWidth={2} /></button>
            <button className="wgt-ctimer-ctrl" onClick={handleReset} title="Reset"><RotateCcw size={14} strokeWidth={2} /></button>
          </div>
        )}
      </div>

      {showSettings && (
        <div className="wgt-ctimer-settings-panel" onClick={e => e.stopPropagation()}>
          <div className="wgt-ctimer-settings-header">
            <span>Timer Settings</span>
            <button className="wgt-ctimer-settings-close" onClick={() => setShowSettings(false)} title="Close"><X size={14} strokeWidth={2} /></button>
          </div>

          <label className="wgt-ctimer-settings-row">
            <span>Label</span>
            <input className="wgt-ctimer-settings-input" value={label} onChange={e => up({ label: e.target.value })} />
          </label>

          <label className="wgt-ctimer-settings-row">
            <span>Mode</span>
            <select className="wgt-ctimer-settings-input" value={timerMode} onChange={e => setMode(e.target.value as TimerMode)}>
              <option value="countdown">Countdown (own duration)</option>
              <option value="countup">Count Up</option>
              <option value="target">Countdown to Date/Time</option>
            </select>
          </label>

          <label className="wgt-ctimer-settings-row">
            <span>Clock Size</span>
            <select className="wgt-ctimer-settings-input" value={clockSize} onChange={e => up({ clockSize: e.target.value })}>
              <option value="small">Small</option>
              <option value="medium">Medium</option>
              <option value="large">Large</option>
              <option value="xlarge">Extra Large</option>
            </select>
          </label>

          {timerMode === 'target' ? (
            <>
              <label className="wgt-ctimer-settings-row">
                <span>Link to</span>
                <select className="wgt-ctimer-settings-input" value={linkSource}
                  onChange={e => setLinkSource(e.target.value as 'none' | 'match' | 'rundown')}>
                  <option value="none">Manual date/time</option>
                  <option value="match">Next scheduled match</option>
                  <option value="rundown">Next rundown item</option>
                </select>
              </label>

              {isMatchLinked && (
                <>
                  <label className="wgt-ctimer-settings-row">
                    <span>Tournament</span>
                    <select className="wgt-ctimer-settings-input" value={filterTournamentId}
                      onChange={e => up({ filterTournamentId: e.target.value })}>
                      <option value="">{owningPage?.tournamentId ? '— Auto: this canvas —' : '— all tournaments —'}</option>
                      {tournaments.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
                    </select>
                  </label>
                  <label className="wgt-ctimer-settings-row">
                    <span>Details Size</span>
                    <select className="wgt-ctimer-settings-input" value={matchDetailsSize}
                      onChange={e => up({ matchDetailsSize: e.target.value })}>
                      <option value="small">Small</option>
                      <option value="medium">Medium</option>
                      <option value="large">Large</option>
                    </select>
                  </label>
                  <div className="wgt-ctimer-settings-row" style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                    {nextScheduledMatch
                      ? <span>Next: {nextScheduledMatch.teamAName} vs {nextScheduledMatch.teamBName}{effectiveTargetTs != null ? ` — ${fmtTargetAbs(effectiveTargetTs)}` : ' — no date/time set'}</span>
                      : <span>No upcoming match in the schedule right now.</span>}
                  </div>
                </>
              )}

              {isRundownLinked && (
                <>
                  <label className="wgt-ctimer-settings-row">
                    <span>Details Size</span>
                    <select className="wgt-ctimer-settings-input" value={matchDetailsSize}
                      onChange={e => up({ matchDetailsSize: e.target.value })}>
                      <option value="small">Small</option>
                      <option value="medium">Medium</option>
                      <option value="large">Large</option>
                    </select>
                  </label>
                  <div className="wgt-ctimer-settings-row" style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                    {nextRundownSegment
                      ? <span>Next: {nextRundownSegment.title}{effectiveTargetTs != null ? ` — ${fmtTargetAbs(effectiveTargetTs)}` : ' — no date/time set'}</span>
                      : <span>No upcoming item in the rundown right now.</span>}
                  </div>
                </>
              )}

              {linkSource === 'none' && (
                <label className="wgt-ctimer-settings-row">
                  <span>Count down to</span>
                  <input type="datetime-local" className="wgt-ctimer-settings-input"
                    value={targetToInputValue(targetTimestamp)}
                    onChange={e => { const ts = new Date(e.target.value).getTime(); if (!isNaN(ts)) setTarget(ts); }} />
                </label>
              )}
            </>
          ) : (
            <label className="wgt-ctimer-settings-row">
              <span>Duration</span>
              <div className="wgt-ctimer-settings-duration">
                <input type="number" min={0} className="wgt-ctimer-settings-input wgt-ctimer-settings-input--num"
                  value={Math.floor(durationMs / 60000)} onChange={e => setDurationMins(Number(e.target.value) || 0)} />
                <span>min</span>
                <input type="number" min={0} max={59} className="wgt-ctimer-settings-input wgt-ctimer-settings-input--num"
                  value={Math.floor((durationMs % 60000) / 1000)} onChange={e => setDurationSecs(Number(e.target.value) || 0)} />
                <span>sec</span>
              </div>
            </label>
          )}

          <label className="wgt-ctimer-settings-row wgt-ctimer-settings-row--check">
            <span>Show Clock</span>
            <input type="checkbox" checked={showClock} onChange={e => up({ showClock: e.target.checked })} />
          </label>

          {showClock && (
            <>
              <label className="wgt-ctimer-settings-row">
                <span>Clock Format</span>
                <select className="wgt-ctimer-settings-input" value={clockFormat} onChange={e => up({ clockFormat: e.target.value })}>
                  <option value="24h">24-hour</option>
                  <option value="12h">12-hour (AM/PM)</option>
                </select>
              </label>
              <label className="wgt-ctimer-settings-row">
                <span>Clock Size</span>
                <select className="wgt-ctimer-settings-input" value={bottomClockSize} onChange={e => up({ bottomClockSize: e.target.value })}>
                  <option value="small">Small</option>
                  <option value="medium">Medium</option>
                  <option value="large">Large</option>
                  <option value="xlarge">Extra Large</option>
                </select>
              </label>
            </>
          )}

          <div className="wgt-ctimer-settings-divider" />

          <label className="wgt-ctimer-settings-row">
            <span>vMix Input</span>
            <select className="wgt-ctimer-settings-input" value={vmixInputKey} onChange={e => up({ vmixInputKey: e.target.value })}>
              <option value="">— none —</option>
              {vmixState?.inputs.map(inp => (
                <option key={inp.key} value={inp.key}>{inp.number}. {inp.title}</option>
              ))}
            </select>
          </label>
          {vmixInputKey && (
            <>
              {linkSource !== 'none' && (
                <label className="wgt-ctimer-settings-row wgt-ctimer-settings-row--check">
                  <span>Merge into one field</span>
                  <input type="checkbox" checked={vmixMergeFields} onChange={e => up({ vmixMergeFields: e.target.checked })} />
                </label>
              )}
              <label className="wgt-ctimer-settings-row">
                <span>{vmixMergeFields ? 'Field' : 'Time Field'}</span>
                <input className="wgt-ctimer-settings-input" list="wgt-ctimer-vmix-fields" value={vmixFieldName}
                  onChange={e => up({ vmixFieldName: e.target.value })} placeholder="Countdown.Text" />
              </label>
              {linkSource !== 'none' && !vmixMergeFields && (
                <label className="wgt-ctimer-settings-row">
                  <span>Title Field</span>
                  <input className="wgt-ctimer-settings-input" list="wgt-ctimer-vmix-fields" value={vmixTitleField}
                    onChange={e => up({ vmixTitleField: e.target.value })} placeholder="Title.Text (optional)" />
                </label>
              )}
              {vmixMergeFields && (
                <p className="timer-db-hint" style={{ margin: '-2px 0 0' }}>
                  Sends "{'{title} — {time}'}" as one string to the field above — e.g. "Medal Ceremony — 05:23".
                </p>
              )}
              {/* Real field names on the chosen input — picking one here
                  avoids a mismatched/typo'd name silently no-oping in vMix
                  (SetText only updates a field that already exists on the
                  title by that exact name). Still a free-text input, so a
                  brand-new field name can be typed too. */}
              <datalist id="wgt-ctimer-vmix-fields">
                {vmixSelectedInput?.textFields.map(f => <option key={f.name} value={f.name} />)}
              </datalist>
              <button type="button" className="wgt-ctimer-vmix-send-btn" onClick={pushToVmix}>
                Send Now
              </button>
              {vmixSelectedInput && vmixFieldName && !vmixSelectedInput.textFields.some(f => f.name === vmixFieldName) && (
                <div className="wgt-ctimer-vmix-warning">
                  "{vmixFieldName}" isn't a known field on this input — check the exact name (case-sensitive) or pick one from the list.
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
