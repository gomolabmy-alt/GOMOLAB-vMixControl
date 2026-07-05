import { useState, useEffect, useRef } from 'react';

interface Props {
  config: Record<string, any>;
  w: number;
  h: number;
}

type Phase = 'focus' | 'break';

export function PomodoroWidget({ config }: Props) {
  const focusMins: number = config.focusMins ?? 25;
  const breakMins: number = config.breakMins ?? 5;
  const totalCycles: number = config.totalCycles ?? 4;

  const [phase, setPhase] = useState<Phase>('focus');
  const [cycle, setCycle] = useState(1);
  const [currentMs, setCurrentMs] = useState(focusMins * 60 * 1000);
  const [running, setRunning] = useState(false);

  // Refs so interval can read latest values without stale closure
  const phaseRef = useRef<Phase>('focus');
  const focusMinsRef = useRef(focusMins);
  const breakMinsRef = useRef(breakMins);
  phaseRef.current = phase;
  focusMinsRef.current = focusMins;
  breakMinsRef.current = breakMins;

  // Tick interval
  useEffect(() => {
    if (!running) return;
    const id = setInterval(() => {
      setCurrentMs((prev) => Math.max(0, prev - 1000));
    }, 1000);
    return () => clearInterval(id);
  }, [running]);

  // Phase transition when time hits 0
  useEffect(() => {
    if (!running || currentMs > 0) return;
    setRunning(false);
    if (phaseRef.current === 'focus') {
      setPhase('break');
      setCurrentMs(breakMinsRef.current * 60 * 1000);
    } else {
      setPhase('focus');
      setCycle((c) => c + 1);
      setCurrentMs(focusMinsRef.current * 60 * 1000);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentMs, running]);

  const totalMs = phase === 'focus' ? focusMins * 60 * 1000 : breakMins * 60 * 1000;
  const pct = Math.min(100, ((totalMs - currentMs) / totalMs) * 100);

  const mins = Math.floor(currentMs / 60000);
  const secs = Math.floor((currentMs % 60000) / 1000);
  const timeStr = `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;

  const accent = phase === 'focus' ? '#f97316' : '#3b82f6';
  const phaseLabel = phase === 'focus' ? 'Focus' : 'Break';
  const icon = phase === 'focus' ? '💻' : '☕';

  const handlePlayPause = () => setRunning((r) => !r);

  const handleSkip = () => {
    setRunning(false);
    if (phase === 'focus') {
      setPhase('break');
      setCurrentMs(breakMins * 60 * 1000);
    } else {
      setPhase('focus');
      setCycle((c) => c + 1);
      setCurrentMs(focusMins * 60 * 1000);
    }
  };

  const handleAddMinute = () => setCurrentMs((prev) => prev + 60 * 1000);

  const handleReset = () => {
    setRunning(false);
    setPhase('focus');
    setCycle(1);
    setCurrentMs(focusMins * 60 * 1000);
  };

  return (
    <div className="wgt-pomo">
      {/* ── Header ── */}
      <div className="wgt-pomo-header">
        <div className="wgt-pomo-info">
          <div className="wgt-pomo-icon">{icon}</div>
          <div className="wgt-pomo-meta">
            <span className="wgt-pomo-phase">{phaseLabel}</span>
            <span className="wgt-pomo-cycle">Cycle {cycle} of {totalCycles}</span>
          </div>
          <span className="wgt-pomo-chevron">›</span>
        </div>
        <div className="wgt-pomo-actions">
          <button
            className="wgt-pomo-playpause"
            style={{ background: accent, boxShadow: `0 4px 14px ${accent}66` }}
            onClick={handlePlayPause}
            title={running ? 'Pause' : 'Start'}
          >
            {running ? '⏸' : '▶'}
          </button>
          <button className="wgt-pomo-settings" title="Settings (edit widget config)">
            ≡
          </button>
        </div>
      </div>

      {/* ── Time ── */}
      <div className="wgt-pomo-time">{timeStr}</div>

      {/* ── Progress bar ── */}
      <div className="wgt-pomo-bar">
        <div
          className="wgt-pomo-bar-fill"
          style={{ width: `${pct}%`, background: accent, transition: running ? 'width 0.9s linear' : 'none' }}
        />
      </div>

      {/* ── Footer ── */}
      <div className="wgt-pomo-footer">
        <div className="wgt-pomo-stats">
          <span>⚡ {focusMins}min</span>
          <span className="wgt-pomo-dot">·</span>
          <span>🌙 {breakMins}min</span>
        </div>
        <div className="wgt-pomo-controls">
          <button className="wgt-pomo-ctrl" onClick={handleSkip} title="Skip phase">⏭</button>
          <button className="wgt-pomo-ctrl" onClick={handleAddMinute} title="+1 minute">+</button>
          <button className="wgt-pomo-ctrl" onClick={handleReset} title="Reset">↺</button>
        </div>
      </div>
    </div>
  );
}
