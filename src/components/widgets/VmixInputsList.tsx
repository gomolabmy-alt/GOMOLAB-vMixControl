import { useState, useEffect, useRef } from 'react';
import { useVmixStore } from '../../stores/vmixStore';

export interface VmixInputBinding {
  id: string;
  inputKey: string;
  label?: string;
  fieldName?: string; // if set, shows a text field row
}

interface Props {
  items: VmixInputBinding[];
}

export function VmixInputsList({ items }: Props) {
  const { vmixState, setPreview, setActive, setTextField } = useVmixStore();
  const [textValues, setTextValues] = useState<Record<string, string>>({});
  const initRef = useRef<Set<string>>(new Set());

  // Seed text values from live vMix state (once per binding id)
  useEffect(() => {
    if (!vmixState) return;
    const updates: Record<string, string> = {};
    for (const item of items) {
      if (!item.fieldName || !item.inputKey) continue;
      if (initRef.current.has(item.id)) continue;
      const inp = vmixState.inputs.find(i => i.key === item.inputKey);
      if (!inp) continue;
      const tf = inp.textFields?.find(f => f.name === item.fieldName);
      if (tf !== undefined) {
        updates[item.id] = tf.value;
        initRef.current.add(item.id);
      }
    }
    if (Object.keys(updates).length > 0) {
      setTextValues(prev => ({ ...prev, ...updates }));
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vmixState]);

  if (!items || items.length === 0) return null;

  return (
    <div className="wgt-vil">
      <div className="wgt-vil-divider" />
      {items.map(item => {
        const inp      = vmixState?.inputs.find(i => i.key === item.inputKey);
        const isActive = !!inp && vmixState!.active  === inp.number;
        const isPrv    = !!inp && vmixState!.preview === inp.number;
        const label    = item.label || inp?.title || '—';
        const connected = !!vmixState;

        return (
          <div key={item.id} className="wgt-vil-item">
            {/* Tally row */}
            <div className={`wgt-vil-row${isActive ? ' wgt-vil-row--pgm' : isPrv ? ' wgt-vil-row--prv' : ''}`}>
              <span className={`wgt-vil-dot${isActive ? ' pgm' : isPrv ? ' prv' : ''}`} />
              <span className="wgt-vil-name" title={label}>{label}</span>
              <div className="wgt-vil-btns">
                <button
                  className={`wgt-vil-btn prv${isPrv ? ' active' : ''}`}
                  disabled={!connected || !item.inputKey}
                  onClick={() => item.inputKey && setPreview(item.inputKey)}
                >PRV</button>
                <button
                  className={`wgt-vil-btn pgm${isActive ? ' active' : ''}`}
                  disabled={!connected || !item.inputKey}
                  onClick={() => item.inputKey && setActive(item.inputKey)}
                >PGM</button>
              </div>
            </div>

            {/* Optional text field */}
            {item.fieldName && (
              <div className="wgt-vil-text-row">
                <span className="wgt-vil-field-label">
                  {item.fieldName.replace(/\.Text$/i, '').replace(/\./g, ' ')}
                </span>
                <input
                  className="wgt-vil-text-inp"
                  value={textValues[item.id] ?? ''}
                  placeholder="Value…"
                  disabled={!connected || !item.inputKey}
                  onChange={e => setTextValues(v => ({ ...v, [item.id]: e.target.value }))}
                  onKeyDown={e => {
                    if (e.key === 'Enter') setTextField(item.inputKey, item.fieldName!, textValues[item.id] ?? '');
                    e.stopPropagation();
                  }}
                />
                <button
                  className="wgt-vil-send"
                  disabled={!connected || !item.inputKey}
                  onClick={() => setTextField(item.inputKey, item.fieldName!, textValues[item.id] ?? '')}
                  title="Send to vMix"
                >→</button>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
