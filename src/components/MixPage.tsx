import { useState, useRef, useCallback } from 'react';
import { useVmixStore } from '../stores/vmixStore';

// ─── T-Bar ─────────────────────────────────────────────────────────────────

function TBarFader() {
  const { tBarValue, setTBar, vmixState } = useVmixStore();
  const [dragging, setDragging] = useState(false);
  const trackRef = useRef<HTMLDivElement>(null);

  const valueFromEvent = useCallback((clientX: number) => {
    const rect = trackRef.current?.getBoundingClientRect();
    if (!rect) return tBarValue;
    const pct = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    return Math.round(pct * 255);
  }, [tBarValue]);

  const onPointerDown = (e: React.PointerEvent) => {
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    setDragging(true);
    setTBar(valueFromEvent(e.clientX));
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (dragging) setTBar(valueFromEvent(e.clientX));
  };
  const onPointerUp = () => setDragging(false);

  const pct = (tBarValue / 255) * 100;

  return (
    <div className="tbar-section">
      <div className="mix-section-title">T-Bar  <span className="tbar-value">{tBarValue}</span></div>
      <div className="tbar-labels">
        <span>PRV {vmixState?.preview ?? '–'}</span>
        <span>PGM {vmixState?.active ?? '–'}</span>
      </div>
      <div
        className={`tbar-track ${dragging ? 'tbar-track--dragging' : ''}`}
        ref={trackRef}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
      >
        <div className="tbar-fill" style={{ width: `${pct}%` }} />
        <div className="tbar-thumb" style={{ left: `${pct}%` }} />
      </div>
      <button className="btn btn--ghost btn--small" onClick={() => setTBar(0)} style={{ alignSelf: 'flex-start' }}>
        Reset
      </button>
    </div>
  );
}

// ─── Overlays ──────────────────────────────────────────────────────────────

function OverlayChannel({ channel }: { channel: number }) {
  const { vmixState, overlayIn, overlayOut } = useVmixStore();
  const overlay = vmixState?.overlays.find((o) => o.number === channel);
  const isActive = !!overlay?.key;
  const assignedInput = vmixState?.inputs.find((i) => i.key === overlay?.key);
  const [selectedKey, setSelectedKey] = useState('');

  const handleToggle = async () => {
    if (isActive) {
      await overlayOut(channel);
    } else {
      await overlayIn(channel, selectedKey || undefined);
    }
  };

  return (
    <div className={`overlay-channel ${isActive ? 'overlay-channel--active' : ''}`}>
      <div className="overlay-channel-header">
        <span className="overlay-num">OVL {channel}</span>
        {assignedInput && (
          <span className="overlay-input-name">{assignedInput.title}</span>
        )}
        <button
          className={`overlay-toggle ${isActive ? 'overlay-toggle--on' : ''}`}
          onClick={handleToggle}
        >
          {isActive ? 'OUT' : 'IN'}
        </button>
      </div>
      <select
        className="overlay-select field-input"
        value={selectedKey}
        onChange={(e) => setSelectedKey(e.target.value)}
        disabled={!vmixState}
      >
        <option value="">— select input —</option>
        {vmixState?.inputs.map((inp) => (
          <option key={inp.key} value={inp.key}>
            {inp.number}. {inp.title}
          </option>
        ))}
      </select>
    </div>
  );
}

// ─── Outputs ───────────────────────────────────────────────────────────────

function OutputControls() {
  const { vmixState, toggleExternal, toggleMultiCorder, toggleFullscreen } = useVmixStore();

  const outputs = [
    { label: 'External', active: vmixState?.external, fn: toggleExternal },
    { label: 'MultiCorder', active: vmixState?.multiCorder, fn: toggleMultiCorder },
    { label: 'Fullscreen', active: vmixState?.fullscreen, fn: toggleFullscreen },
  ];

  return (
    <div className="output-controls">
      <div className="mix-section-title">Outputs</div>
      <div className="output-grid">
        {outputs.map((o) => (
          <button
            key={o.label}
            className={`output-btn ${o.active ? 'output-btn--active' : ''}`}
            onClick={o.fn}
            disabled={!vmixState}
          >
            <span className="output-indicator" />
            {o.label}
          </button>
        ))}
      </div>
    </div>
  );
}

// ─── Replay ────────────────────────────────────────────────────────────────

function ReplayControls() {
  const { replayMarkIn, replayMarkOut, replayPlay, replayPause, replayNow, replayLive, vmixState } = useVmixStore();
  return (
    <div className="replay-controls">
      <div className="mix-section-title">Replay</div>
      <div className="replay-grid">
        <button className="replay-btn" onClick={replayMarkIn}  disabled={!vmixState}>Mark In</button>
        <button className="replay-btn" onClick={replayMarkOut} disabled={!vmixState}>Mark Out</button>
        <button className="replay-btn replay-btn--play" onClick={replayPlay}  disabled={!vmixState}>▶ Play</button>
        <button className="replay-btn" onClick={replayPause} disabled={!vmixState}>⏸ Pause</button>
        <button className="replay-btn replay-btn--now"  onClick={replayNow}  disabled={!vmixState}>Replay Now</button>
        <button className="replay-btn replay-btn--live" onClick={replayLive} disabled={!vmixState}>Go Live</button>
      </div>
    </div>
  );
}

// ─── Snapshot ──────────────────────────────────────────────────────────────

function SnapshotControl() {
  const { sendFunction, vmixState } = useVmixStore();
  return (
    <div className="output-controls">
      <div className="mix-section-title">Snapshot</div>
      <div className="output-grid">
        <button className="output-btn" onClick={() => sendFunction('Snapshot')} disabled={!vmixState}>
          📷 Snapshot
        </button>
      </div>
    </div>
  );
}

// ─── Mix Page ──────────────────────────────────────────────────────────────

export function MixPage() {
  return (
    <div className="mix-page page-scroll">
      <TBarFader />

      <div className="mix-section-title" style={{ padding: '12px 12px 0' }}>Overlays</div>
      <div className="overlays-grid">
        {[1, 2, 3, 4].map((ch) => <OverlayChannel key={ch} channel={ch} />)}
      </div>

      <OutputControls />
      <ReplayControls />
      <SnapshotControl />
    </div>
  );
}
