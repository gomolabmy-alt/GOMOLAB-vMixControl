import { useState, useEffect, useRef, useContext } from 'react';
import { useCanvasStore } from '../../stores/canvasStore';
import { useUndoStore } from '../../stores/undoStore';
import { CanvasActionContext } from '../../lib/canvasContext';

interface Props {
  widgetId: string;
  config: Record<string, any>;
  w: number;
  h: number;
}

type TimerMode = 'countdown' | 'countup';
type ClockFormat = '12h' | '24h';

function fmtDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

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

  const [showSettings, setShowSettings] = useState(false);
  const [now, setNow] = useState(() => new Date());

  // Live wall-clock tick — only runs while the clock readout is actually shown.
  useEffect(() => {
    if (!showClock) return;
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, [showClock]);

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
  const setMode = (mode: TimerMode) => up({ timerMode: mode, running: false, currentMs: mode === 'countdown' ? durationMs : 0 });

  const isDone = timerMode === 'countdown' && currentMs === 0 && !running;
  const totalMs = durationMs || 1;
  const pct = timerMode === 'countdown'
    ? Math.min(100, ((totalMs - currentMs) / totalMs) * 100)
    : Math.min(100, (currentMs / totalMs) * 100);
  const accent = isDone ? '#2ecc71' : '#6366f1';

  return (
    <div className="wgt-ctimer">
      <div className="wgt-ctimer-header">
        <div className="wgt-ctimer-info">
          <div className="wgt-ctimer-icon">⏲</div>
          <div className="wgt-ctimer-meta">
            <span className="wgt-ctimer-label">{label}</span>
            <span className="wgt-ctimer-sub">{timerMode === 'countdown' ? 'Countdown' : 'Count Up'}{isDone ? ' · Done' : ''}</span>
          </div>
        </div>
        <div className="wgt-ctimer-actions">
          <button
            className="wgt-ctimer-playpause"
            style={{ background: accent, boxShadow: `0 4px 14px ${accent}66` }}
            onClick={handlePlayPause}
            title={running ? 'Pause' : 'Start'}
          >
            {running ? '⏸' : '▶'}
          </button>
          <button
            className={`wgt-ctimer-settings-btn${showSettings ? ' wgt-ctimer-settings-btn--active' : ''}`}
            onClick={() => setShowSettings(v => !v)}
            title="Settings"
          >⚙</button>
        </div>
      </div>

      <div className="wgt-ctimer-time">{fmtDuration(currentMs)}</div>

      <div className="wgt-ctimer-bar">
        <div
          className="wgt-ctimer-bar-fill"
          style={{ width: `${pct}%`, background: accent, transition: running ? 'width 0.9s linear' : 'none' }}
        />
      </div>

      <div className="wgt-ctimer-footer">
        <div className="wgt-ctimer-stats">
          {showClock
            ? <span className="wgt-ctimer-clock">🕐 {fmtClock(now, clockFormat)}</span>
            : <span>{timerMode === 'countdown' ? `Set ${fmtDuration(durationMs)}` : `Target ${fmtDuration(durationMs)}`}</span>}
        </div>
        <div className="wgt-ctimer-controls">
          <button className="wgt-ctimer-ctrl" onClick={handleSubMinute} title="-1 minute">−</button>
          <button className="wgt-ctimer-ctrl" onClick={handleAddMinute} title="+1 minute">+</button>
          <button className="wgt-ctimer-ctrl" onClick={handleReset} title="Reset">↺</button>
        </div>
      </div>

      {showSettings && (
        <div className="wgt-ctimer-settings-panel" onClick={e => e.stopPropagation()}>
          <div className="wgt-ctimer-settings-header">
            <span>Timer Settings</span>
            <button className="wgt-ctimer-settings-close" onClick={() => setShowSettings(false)} title="Close">✕</button>
          </div>

          <label className="wgt-ctimer-settings-row">
            <span>Label</span>
            <input className="wgt-ctimer-settings-input" value={label} onChange={e => up({ label: e.target.value })} />
          </label>

          <label className="wgt-ctimer-settings-row">
            <span>Mode</span>
            <select className="wgt-ctimer-settings-input" value={timerMode} onChange={e => setMode(e.target.value as TimerMode)}>
              <option value="countdown">Countdown</option>
              <option value="countup">Count Up</option>
            </select>
          </label>

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

          <label className="wgt-ctimer-settings-row wgt-ctimer-settings-row--check">
            <span>Show Clock</span>
            <input type="checkbox" checked={showClock} onChange={e => up({ showClock: e.target.checked })} />
          </label>

          {showClock && (
            <label className="wgt-ctimer-settings-row">
              <span>Clock Format</span>
              <select className="wgt-ctimer-settings-input" value={clockFormat} onChange={e => up({ clockFormat: e.target.value })}>
                <option value="24h">24-hour</option>
                <option value="12h">12-hour (AM/PM)</option>
              </select>
            </label>
          )}
        </div>
      )}
    </div>
  );
}
