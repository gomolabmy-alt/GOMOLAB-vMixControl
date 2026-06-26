import { useVmixStore } from '../../stores/vmixStore';

interface Props {
  config: Record<string, any>;
  w: number;
  h: number;
}

export function VolumeWidget({ config }: Props) {
  const { getClientById, vmixState, connections } = useVmixStore();
  const connVmixState = config.vmixClientId
    ? connections.find(c => c.id === config.vmixClientId)?.vmixState ?? vmixState
    : vmixState;
  const c = getClientById(config.vmixClientId);

  let volume = 0;
  let muted = false;
  let meter1 = 0;
  let meter2 = 0;

  if (connVmixState) {
    if (config.target === 'master') {
      volume = connVmixState.masterAudio.volume;
      muted = connVmixState.masterAudio.muted;
      meter1 = connVmixState.masterAudio.meterF1;
      meter2 = connVmixState.masterAudio.meterF2;
    } else if (config.target === 'input' && config.inputKey) {
      const inp = connVmixState.inputs.find((i) => i.key === config.inputKey);
      if (inp) { volume = inp.volume; muted = inp.muted; meter1 = inp.meterF1; meter2 = inp.meterF2; }
    } else if (config.target === 'bus' && config.busName) {
      const bus = connVmixState.audioBuses.find((b) => b.name === config.busName);
      if (bus) { volume = bus.volume; muted = bus.muted; meter1 = bus.meterF1; meter2 = bus.meterF2; }
    }
  }

  const handleVolChange = (v: number) => {
    if (config.target === 'master') c?.setMasterVolume(v);
    else if (config.target === 'input' && config.inputKey) c?.setInputVolume(config.inputKey, v);
    else if (config.target === 'bus' && config.busName) c?.setBusVolume(config.busName, v);
  };

  const handleMuteToggle = () => {
    if (config.target === 'master') c?.toggleMasterMute();
    else if (config.target === 'input' && config.inputKey) {
      muted ? c?.unmuteInput(config.inputKey) : c?.muteInput(config.inputKey);
    } else if (config.target === 'bus' && config.busName) c?.muteBus(config.busName);
  };

  const m1pct = Math.min(100, meter1 * 100);
  const m2pct = Math.min(100, meter2 * 100);
  const meterColor = (pct: number) => pct > 90 ? '#e74c3c' : pct > 70 ? '#f39c12' : '#2ecc71';

  return (
    <div className="wgt-vol">
      <div className="wgt-vol-label">{config.label ?? 'Volume'}</div>

      <div className="wgt-vol-body">
        {/* VU Meters */}
        <div className="wgt-vol-meters">
          <div className="wgt-vol-meter">
            <div className="wgt-vol-meter-fill" style={{ height: `${m1pct}%`, background: meterColor(m1pct) }} />
          </div>
          <div className="wgt-vol-meter">
            <div className="wgt-vol-meter-fill" style={{ height: `${m2pct}%`, background: meterColor(m2pct) }} />
          </div>
        </div>

        {/* Volume slider */}
        <input
          type="range"
          className="wgt-vol-slider"
          min={0}
          max={100}
          value={volume}
          onChange={(e) => handleVolChange(Number(e.target.value))}
          disabled={!connVmixState}
          {...{ orient: 'vertical' } as any}
        />
      </div>

      {config.showMute !== false && (
        <button
          className={`wgt-vol-mute ${muted ? 'wgt-vol-mute--on' : ''}`}
          onClick={handleMuteToggle}
          disabled={!connVmixState}
        >
          {muted ? '🔇' : '🔊'}
        </button>
      )}

      <div className="wgt-vol-num">{volume}%</div>
    </div>
  );
}
