import { useEffect, useState } from 'react';
import { X, AlertTriangle } from 'lucide-react';
import { buildAccelerator, hotkeyLabel } from '../lib/hotkeyFormat';
import type { HotkeyBinding } from '../lib/hotkeyBindings';

interface Props {
  value: string;
  onChange: (accelerator: string) => void;
  // Every other hotkey currently bound in the project, for an inline
  // duplicate-accelerator warning — recording still works either way, this
  // is advisory only (the registry itself doesn't refuse duplicates).
  allBindings?: HotkeyBinding[];
}

// Click to "listen", press the physical key combo, done — same recorder used
// for a Button widget's own hotkey field and any widget's Hotkeys section.
export function HotkeyRecorder({ value, onChange, allBindings }: Props) {
  const [listening, setListening] = useState(false);

  useEffect(() => {
    if (!listening) return;
    const onKeyDown = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === 'Escape') { setListening(false); return; }
      const accelerator = buildAccelerator(e);
      if (accelerator) {
        onChange(accelerator);
        setListening(false);
      }
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [listening, onChange]);

  const duplicate = value && allBindings?.some(b => b.accelerator === value && b.source);
  const dupCount = value ? (allBindings?.filter(b => b.accelerator === value).length ?? 0) : 0;

  return (
    <div className="hotkey-recorder">
      <button
        type="button"
        className={`hotkey-recorder-btn ${listening ? 'hotkey-recorder-btn--listening' : ''}`}
        onClick={() => setListening(l => !l)}
      >
        {listening ? 'Press a key…' : value ? hotkeyLabel(value) : '— set hotkey —'}
      </button>
      {value && (
        <button type="button" className="hotkey-recorder-clear" title="Clear hotkey" onClick={() => onChange('')}><X size={14} strokeWidth={2} /></button>
      )}
      {duplicate && dupCount > 1 && (
        <span className="hotkey-recorder-warning" title="This key combo is already bound elsewhere" style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}><AlertTriangle size={12} strokeWidth={2} /> in use</span>
      )}
    </div>
  );
}
