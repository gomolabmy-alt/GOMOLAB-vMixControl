import { useState } from 'react';
import { useVmixStore } from '../../stores/vmixStore';

interface Props {
  config: Record<string, any>;
  w: number;
  h: number;
}

export function OverlayWidget({ config }: Props) {
  const { getClientById, vmixState, connections } = useVmixStore();
  const connVmixState = config.vmixClientId
    ? connections.find(c => c.id === config.vmixClientId)?.vmixState ?? vmixState
    : vmixState;
  const c = getClientById(config.vmixClientId);
  const [selectedKey, setSelectedKey] = useState('');

  const ch = config.channel ?? 1;
  const overlay = connVmixState?.overlays.find((o) => o.number === ch);
  const isActive = overlay && overlay.key !== '';
  const inputs = connVmixState?.inputs ?? [];

  const handleToggle = () => {
    if (isActive) c?.overlayOut(ch);
    else c?.overlayIn(ch, selectedKey || undefined);
  };

  return (
    <div className="wgt-overlay">
      <div className="wgt-overlay-title">Overlay {ch}</div>

      <select
        className="wgt-overlay-select"
        value={selectedKey}
        onChange={(e) => setSelectedKey(e.target.value)}
        disabled={!connVmixState}
      >
        <option value="">— select input —</option>
        {inputs.map((i) => (
          <option key={i.key} value={i.key}>{i.number}. {i.title}</option>
        ))}
      </select>

      <button
        className={`wgt-overlay-btn ${isActive ? 'wgt-overlay-btn--on' : ''}`}
        onClick={handleToggle}
        disabled={!connVmixState}
      >
        {isActive ? `ON  (${overlay?.inputNumber})` : 'OFF'}
      </button>
    </div>
  );
}
