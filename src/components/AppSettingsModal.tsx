import { useState } from 'react';
import { useAppSettings, SCALE_PRESETS } from '../stores/appSettingsStore';

const DURATION_PRESETS = [2000, 3000, 5000, 8000, 10000, 15000, 20000, 30000];

interface Props {
  onClose: () => void;
}

const SIZE_PRESETS = [
  { label: '1920 × 1080', w: 1920, h: 1080 },
  { label: '2560 × 1440', w: 2560, h: 1440 },
  { label: '2000 × 1400', w: 2000, h: 1400 },
  { label: '1600 × 900',  w: 1600, h: 900  },
  { label: '1280 × 720',  w: 1280, h: 720  },
  { label: '1024 × 768',  w: 1024, h: 768  },
];

export function AppSettingsModal({ onClose }: Props) {
  const {
    canvasWidth, canvasHeight, canvasScale, setCanvasSize, setCanvasScale,
    notifyGoal, notifyCard, notifySub, notifyTimePause, notifyDurationMs,
    setNotifyGoal, setNotifyCard, setNotifySub, setNotifyTimePause, setNotifyDurationMs,
  } = useAppSettings();

  const [draftW, setDraftW] = useState(String(canvasWidth));
  const [draftH, setDraftH] = useState(String(canvasHeight));

  const applySize = () => {
    const w = parseInt(draftW, 10);
    const h = parseInt(draftH, 10);
    if (w > 0 && h > 0) setCanvasSize(w, h);
  };

  return (
    <div className="app-settings-backdrop" onPointerDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="app-settings-modal">
        <div className="app-settings-header">
          <span className="app-settings-title">⚙ App Settings</span>
          <button
            className="app-settings-close"
            onPointerDown={(e) => { e.stopPropagation(); e.currentTarget.setPointerCapture(e.pointerId); onClose(); }}
            onClick={(e) => e.stopPropagation()}
          >✕</button>
        </div>

        <div className="app-settings-body">

          {/* ── Canvas Size ─────────────────────────────────────────────── */}
          <div className="app-settings-section">
            <div className="app-settings-section-label">Canvas Size</div>
            <p className="app-settings-hint">
              The virtual canvas widgets are placed on. Match this to your content layout size.
            </p>

            <div className="app-settings-presets">
              {SIZE_PRESETS.map(p => (
                <button
                  key={p.label}
                  className={`app-settings-preset ${p.w === canvasWidth && p.h === canvasHeight ? 'app-settings-preset--active' : ''}`}
                  onPointerDown={(e) => { e.stopPropagation(); e.currentTarget.setPointerCapture(e.pointerId); setCanvasSize(p.w, p.h); setDraftW(String(p.w)); setDraftH(String(p.h)); }}
                  onClick={(e) => e.stopPropagation()}
                >{p.label}</button>
              ))}
            </div>

            <div className="app-settings-size-row">
              <div className="app-settings-field">
                <label className="app-settings-label">Width (px)</label>
                <input
                  type="number"
                  className="app-settings-input"
                  value={draftW}
                  min={400}
                  max={8000}
                  onChange={e => setDraftW(e.target.value)}
                  onBlur={applySize}
                  onKeyDown={e => e.key === 'Enter' && applySize()}
                />
              </div>
              <span className="app-settings-size-x">×</span>
              <div className="app-settings-field">
                <label className="app-settings-label">Height (px)</label>
                <input
                  type="number"
                  className="app-settings-input"
                  value={draftH}
                  min={300}
                  max={8000}
                  onChange={e => setDraftH(e.target.value)}
                  onBlur={applySize}
                  onKeyDown={e => e.key === 'Enter' && applySize()}
                />
              </div>
            </div>
            <div className="app-settings-current">
              Current: {canvasWidth} × {canvasHeight} px
            </div>
          </div>

          {/* ── Canvas Scale ─────────────────────────────────────────────── */}
          <div className="app-settings-section">
            <div className="app-settings-section-label">Canvas Zoom</div>
            <p className="app-settings-hint">
              Scale the canvas view to fit your screen. Widget positions are not affected.
            </p>

            <div className="app-settings-presets">
              {SCALE_PRESETS.map(s => (
                <button
                  key={s}
                  className={`app-settings-preset ${Math.abs(s - canvasScale) < 0.01 ? 'app-settings-preset--active' : ''}`}
                  onPointerDown={(e) => { e.stopPropagation(); e.currentTarget.setPointerCapture(e.pointerId); setCanvasScale(s); }}
                  onClick={(e) => e.stopPropagation()}
                >{Math.round(s * 100)}%</button>
              ))}
            </div>

            <div className="app-settings-scale-row">
              <input
                type="range"
                className="app-settings-slider"
                min={10}
                max={200}
                step={1}
                value={Math.round(canvasScale * 100)}
                onChange={e => setCanvasScale(Number(e.target.value) / 100)}
              />
              <span className="app-settings-scale-val">{Math.round(canvasScale * 100)}%</span>
            </div>
          </div>

          {/* ── Read-only Notifications ────────────────────────────────── */}
          <div className="app-settings-section">
            <div className="app-settings-section-label">Read-only Notifications</div>
            <p className="app-settings-hint">
              Show popup alerts on read-only (viewer) devices when key events happen.
            </p>

            <div className="app-settings-notif-toggles">
              {[
                { label: 'Goal / Score', value: notifyGoal, set: setNotifyGoal, color: '#2ecc71' },
                { label: 'Player Card', value: notifyCard, set: setNotifyCard, color: '#e74c3c' },
                { label: 'Substitution', value: notifySub, set: setNotifySub, color: '#3498db' },
                { label: 'Time Off (pause)', value: notifyTimePause, set: setNotifyTimePause, color: '#95a5a6' },
              ].map(({ label, value, set, color }) => (
                <label key={label} className="app-settings-notif-toggle">
                  <input
                    type="checkbox"
                    checked={value}
                    onChange={e => set(e.target.checked)}
                  />
                  <span className="app-settings-notif-dot" style={{ background: color }} />
                  <span>{label}</span>
                </label>
              ))}
            </div>

            <div className="app-settings-field" style={{ marginTop: 12 }}>
              <label className="app-settings-label">Display duration</label>
              <div className="app-settings-presets">
                {DURATION_PRESETS.map(d => (
                  <button
                    key={d}
                    className={`app-settings-preset ${notifyDurationMs === d ? 'app-settings-preset--active' : ''}`}
                    onPointerDown={(e) => { e.stopPropagation(); e.currentTarget.setPointerCapture(e.pointerId); setNotifyDurationMs(d); }}
                    onClick={(e) => e.stopPropagation()}
                  >{d / 1000}s</button>
                ))}
              </div>
              <div className="app-settings-scale-row" style={{ marginTop: 8 }}>
                <input
                  type="range"
                  className="app-settings-slider"
                  min={1000}
                  max={30000}
                  step={500}
                  value={notifyDurationMs}
                  onChange={e => setNotifyDurationMs(Number(e.target.value))}
                />
                <span className="app-settings-scale-val">{(notifyDurationMs / 1000).toFixed(1)}s</span>
              </div>
            </div>
          </div>

        </div>
      </div>
    </div>
  );
}
