import { useState } from 'react';
import { useVmixStore } from '../../stores/vmixStore';

interface Props {
  config: Record<string, any>;
}

export interface PanelItem {
  id: string;
  type: 'command' | 'input' | 'text';
  label?: string;
  // command
  fn?: string;
  fnValue?: string;
  color?: string;
  // input
  inputKey?: string;
  // text
  textInputKey?: string;
  fieldName?: string;
}

export function PanelWidget({ config: cfg }: Props) {
  const { getClient, vmixState } = useVmixStore();
  const connVmixState = vmixState;
  const c = getClient();
  const [textValues, setTextValues] = useState<Record<string, string>>({});
  const [firing, setFiring] = useState<Record<string, boolean>>({});

  const items: PanelItem[] = cfg.items ?? [];
  const connected = !!connVmixState;

  const fireCommand = async (item: PanelItem) => {
    if (!item.fn) return;
    setFiring(f => ({ ...f, [item.id]: true }));
    try {
      const params: Record<string, string> = {};
      if (item.fnValue) params.Value = item.fnValue;
      await c?.sendFunction(item.fn, params);
    } finally {
      setTimeout(() => setFiring(f => ({ ...f, [item.id]: false })), 120);
    }
  };

  const sendText = async (item: PanelItem) => {
    if (!item.textInputKey || !item.fieldName) return;
    await c?.setTextField(item.textInputKey, item.fieldName, textValues[item.id] ?? '');
  };

  if (items.length === 0) {
    return <div className="wgt-panel wgt-panel-empty">Add items in ⚙ config</div>;
  }

  return (
    <div className="wgt-panel">
      {items.map(item => {
        if (item.type === 'command') {
          return (
            <button
              key={item.id}
              className={`wgt-panel-cmd${firing[item.id] ? ' wgt-panel-cmd--fire' : ''}`}
              style={{ '--pc': item.color || '#3498db' } as React.CSSProperties}
              disabled={!connected || !item.fn}
              onClick={() => fireCommand(item)}
            >
              {item.label || item.fn || 'Command'}
            </button>
          );
        }

        if (item.type === 'input') {
          const inp = connVmixState?.inputs.find(i => i.key === item.inputKey);
          const isActive  = !!inp && connVmixState!.active  === inp.number;
          const isPreview = !!inp && connVmixState!.preview === inp.number;
          const displayLabel = item.label || inp?.title || item.inputKey || '—';
          return (
            <div key={item.id} className={`wgt-panel-inp-row${isActive ? ' wgt-panel-inp-row--pgm' : isPreview ? ' wgt-panel-inp-row--prv' : ''}`}>
              <span className={`wgt-panel-inp-dot${isActive ? ' pgm' : isPreview ? ' prv' : ''}`} />
              <span className="wgt-panel-inp-label" title={displayLabel}>{displayLabel}</span>
              <div className="wgt-panel-inp-btns">
                <button
                  className={`wgt-panel-tally-btn prv${isPreview ? ' active' : ''}`}
                  disabled={!connected || !item.inputKey}
                  onClick={() => item.inputKey && c?.setPreview(item.inputKey)}
                >PRV</button>
                <button
                  className={`wgt-panel-tally-btn pgm${isActive ? ' active' : ''}`}
                  disabled={!connected || !item.inputKey}
                  onClick={() => item.inputKey && c?.setActive(item.inputKey)}
                >PGM</button>
              </div>
            </div>
          );
        }

        if (item.type === 'text') {
          return (
            <div key={item.id} className="wgt-panel-txt-row">
              {item.label && <span className="wgt-panel-txt-label">{item.label}</span>}
              <input
                className="wgt-panel-txt-inp"
                placeholder={item.fieldName || 'Value…'}
                value={textValues[item.id] ?? ''}
                onChange={e => setTextValues(v => ({ ...v, [item.id]: e.target.value }))}
                onKeyDown={e => { if (e.key === 'Enter') sendText(item); e.stopPropagation(); }}
                disabled={!connected}
              />
              <button
                className="wgt-panel-txt-send"
                disabled={!connected || !item.textInputKey || !item.fieldName}
                onClick={() => sendText(item)}
                title="Send to vMix"
              >✓</button>
            </div>
          );
        }

        return null;
      })}
    </div>
  );
}
