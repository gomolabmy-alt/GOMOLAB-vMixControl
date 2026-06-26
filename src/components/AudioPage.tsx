import { useRef, useState } from 'react';
import { useVmixStore } from '../stores/vmixStore';
import { AUDIO_BUS_NAMES } from '../types/vmix';

// ─── VU Meter ──────────────────────────────────────────────────────────────

function VuMeter({ f1, f2 }: { f1: number; f2: number }) {
  const toPercent = (v: number) => Math.min(100, Math.round(v * 100));
  const p1 = toPercent(f1);
  const p2 = toPercent(f2);
  const color = (p: number) => p > 85 ? '#e74c3c' : p > 60 ? '#f39c12' : '#2ecc71';
  return (
    <div className="vu-meter">
      <div className="vu-bar" style={{ height: `${p1}%`, background: color(p1) }} />
      <div className="vu-bar" style={{ height: `${p2}%`, background: color(p2) }} />
    </div>
  );
}

// ─── Volume Slider ─────────────────────────────────────────────────────────

function VolumeSlider({
  value, onChange, onRelease, vertical = false,
}: {
  value: number;
  onChange?: (v: number) => void;
  onRelease: (v: number) => void;
  vertical?: boolean;
}) {
  const [dragging, setDragging] = useState(false);
  const [localVal, setLocalVal] = useState(value);
  const display = dragging ? localVal : value;

  return (
    <input
      className={`vol-slider ${vertical ? 'vol-slider--vertical' : ''}`}
      type="range"
      min={0}
      max={100}
      value={display}
      onChange={(e) => {
        const v = Number(e.target.value);
        setLocalVal(v);
        onChange?.(v);
      }}
      onMouseDown={() => { setDragging(true); setLocalVal(value); }}
      onTouchStart={() => { setDragging(true); setLocalVal(value); }}
      onMouseUp={(e) => { setDragging(false); onRelease(Number((e.target as HTMLInputElement).value)); }}
      onTouchEnd={(e) => { setDragging(false); onRelease(Number((e.target as HTMLInputElement).value)); }}
    />
  );
}

// ─── Master Section ─────────────────────────────────────────────────────────

function MasterSection() {
  const { vmixState, setMasterVolume, toggleMasterMute, setHeadphones } = useVmixStore();
  const master = vmixState?.masterAudio;

  return (
    <div className="audio-master">
      <div className="audio-label">Master</div>
      <VuMeter f1={master?.meterF1 ?? 0} f2={master?.meterF2 ?? 0} />
      <VolumeSlider
        value={master?.volume ?? 100}
        onRelease={setMasterVolume}
        vertical
      />
      <div className="audio-vol-display">{master?.volume ?? 100}</div>
      <button
        className={`audio-mute-btn ${master?.muted ? 'audio-mute-btn--active' : ''}`}
        onClick={toggleMasterMute}
        disabled={!vmixState}
      >
        M
      </button>

      <div className="audio-label" style={{ marginTop: 8 }}>Headphones</div>
      <VolumeSlider
        value={master?.headphonesVolume ?? 74}
        onRelease={setHeadphones}
        vertical
      />
      <div className="audio-vol-display">{master?.headphonesVolume ?? 74}</div>
    </div>
  );
}

// ─── Bus Section ─────────────────────────────────────────────────────────────

function BusSection() {
  const { vmixState, setBusVolume, muteBus } = useVmixStore();
  const buses = vmixState?.audioBuses ?? [];

  return (
    <div className="audio-buses">
      {AUDIO_BUS_NAMES.map((busName) => {
        const bus = buses.find((b) => b.name === busName);
        if (!bus) return null;
        return (
          <div key={busName} className="audio-channel">
            <div className="audio-label">{busName}</div>
            <VuMeter f1={bus.meterF1} f2={bus.meterF2} />
            <VolumeSlider
              value={bus.volume}
              onRelease={(v) => setBusVolume(busName, v)}
              vertical
            />
            <div className="audio-vol-display">{bus.volume}</div>
            <button
              className={`audio-mute-btn ${bus.muted ? 'audio-mute-btn--active' : ''}`}
              onClick={() => bus.muted ? setBusVolume(busName, bus.volume) : muteBus(busName)}
              disabled={!vmixState}
            >
              M
            </button>
          </div>
        );
      })}
    </div>
  );
}

// ─── Per-Input Strip ──────────────────────────────────────────────────────────

function InputAudioStrip({ inputKey }: { inputKey: string }) {
  const { vmixState, setInputVolume, muteInput, unmuteInput, soloInput, setBusRouting } = useVmixStore();
  const input = vmixState?.inputs.find((i) => i.key === inputKey);
  if (!input) return null;

  const activeBuses = input.audioBusses.split('');
  const toggleBus = (bus: string) => {
    const on = activeBuses.includes(bus);
    setBusRouting(inputKey, bus, !on);
  };

  return (
    <div className="input-audio-strip">
      <div className="input-audio-name" title={input.title}>{input.title}</div>
      <VuMeter f1={input.meterF1} f2={input.meterF2} />
      <VolumeSlider
        value={input.volume}
        onRelease={(v) => setInputVolume(inputKey, v)}
        vertical
      />
      <div className="audio-vol-display">{input.volume}</div>
      <div className="input-audio-actions">
        <button
          className={`audio-mute-btn ${input.muted ? 'audio-mute-btn--active' : ''}`}
          onClick={() => input.muted ? unmuteInput(inputKey) : muteInput(inputKey)}
        >M</button>
        <button
          className={`audio-solo-btn ${input.solo ? 'audio-solo-btn--active' : ''}`}
          onClick={() => soloInput(inputKey)}
        >S</button>
      </div>
      <div className="bus-routing">
        {['M', 'A', 'B', 'C'].map((bus) => (
          <button
            key={bus}
            className={`bus-btn ${activeBuses.includes(bus) ? 'bus-btn--active' : ''}`}
            onClick={() => toggleBus(bus)}
          >
            {bus}
          </button>
        ))}
      </div>
    </div>
  );
}

// ─── Audio Page ───────────────────────────────────────────────────────────────

export function AudioPage() {
  const { vmixState } = useVmixStore();

  // Audio inputs: any input that has audio capability
  const audioInputs = vmixState?.inputs.filter(
    (i) => !['Colour', 'Image', 'Blank'].includes(i.type),
  ) ?? [];

  return (
    <div className="audio-page">
      <div className="audio-page-header">
        <div className="mix-section-title" style={{ padding: '10px 12px' }}>Audio Mixer</div>
      </div>

      <div className="audio-mixer">
        {/* Master + Buses */}
        <MasterSection />
        <div className="audio-separator" />
        <BusSection />
        <div className="audio-separator" />

        {/* Per-input strips */}
        {audioInputs.map((inp) => (
          <InputAudioStrip key={inp.key} inputKey={inp.key} />
        ))}

        {!vmixState && (
          <div className="audio-empty">Connect to vMix to see audio controls</div>
        )}
      </div>
    </div>
  );
}
