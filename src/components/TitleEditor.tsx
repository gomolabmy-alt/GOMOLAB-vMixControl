import { useState, useEffect, useRef } from 'react';
import { useVmixStore } from '../stores/vmixStore';
import type { VmixTextField } from '../types/vmix';

function TextField({
  field,
  inputKey,
}: {
  field: VmixTextField;
  inputKey: string;
}) {
  const { setTextField } = useVmixStore();
  const [localValue, setLocalValue] = useState(field.value);
  const [isDirty, setIsDirty] = useState(false);
  const [isSending, setIsSending] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Keep local value in sync when remote value changes (only if not dirty)
  useEffect(() => {
    if (!isDirty) {
      setLocalValue(field.value);
    }
  }, [field.value, isDirty]);

  const handleChange = (val: string) => {
    setLocalValue(val);
    setIsDirty(true);

    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(async () => {
      setIsSending(true);
      try {
        await setTextField(inputKey, field.name, val);
      } finally {
        setIsSending(false);
        setIsDirty(false);
      }
    }, 400);
  };

  const handleBlur = () => {
    if (isDirty) {
      if (debounceRef.current) clearTimeout(debounceRef.current);
      setIsSending(true);
      setTextField(inputKey, field.name, localValue).finally(() => {
        setIsSending(false);
        setIsDirty(false);
      });
    }
  };

  const displayName = field.name
    .replace(/\.(Text|Image|Source)$/, '')
    .replace(/([A-Z])/g, ' $1')
    .trim();

  const isMultiLine = localValue.includes('\n') || localValue.length > 60;

  return (
    <div className="text-field">
      <div className="text-field-header">
        <label className="text-field-label">{displayName}</label>
        <div className="text-field-indicators">
          {isSending && <span className="text-field-sending">●</span>}
          {isDirty && !isSending && <span className="text-field-dirty">○</span>}
        </div>
      </div>
      {isMultiLine ? (
        <textarea
          className="text-field-input text-field-input--multi"
          value={localValue}
          onChange={(e) => handleChange(e.target.value)}
          onBlur={handleBlur}
          rows={3}
        />
      ) : (
        <input
          className="text-field-input"
          type="text"
          value={localValue}
          onChange={(e) => handleChange(e.target.value)}
          onBlur={handleBlur}
        />
      )}
    </div>
  );
}

export function TitleEditor() {
  const { vmixState, selectedInputKey } = useVmixStore();

  if (!vmixState || !selectedInputKey) {
    return (
      <main className="detail-panel detail-panel--empty">
        <div className="detail-empty-state">
          <div className="detail-empty-icon">⬡</div>
          <p>Select an input to edit</p>
        </div>
      </main>
    );
  }

  const input = vmixState.inputs.find((i) => i.key === selectedInputKey);
  if (!input) return null;

  const isTitle = input.type === 'GT' || input.type === 'Xaml';
  const titleFields = input.textFields.filter(
    (f) => !f.name.toLowerCase().includes('image') && !f.name.toLowerCase().includes('source'),
  );

  return (
    <main className="detail-panel">
      <div className="panel-header">
        <div>
          <h2 className="panel-title">{input.title || `Input ${input.number}`}</h2>
          <span className="panel-subtitle">{input.type} · #{input.number}</span>
        </div>
      </div>

      <div className="detail-body">
        {isTitle && titleFields.length > 0 ? (
          <div className="text-fields">
            {titleFields.map((field) => (
              <TextField key={field.name} field={field} inputKey={input.key} />
            ))}
          </div>
        ) : input.textFields.length > 0 ? (
          <div className="text-fields">
            {input.textFields.map((field) => (
              <TextField key={field.name} field={field} inputKey={input.key} />
            ))}
          </div>
        ) : (
          <div className="detail-no-fields">
            <p>No editable text fields for this input type.</p>
            <p className="detail-no-fields-hint">
              Use the PRV / PGM buttons in the input list to route this input.
            </p>
          </div>
        )}

        <div className="detail-meta">
          <div className="meta-row">
            <span className="meta-key">State</span>
            <span className="meta-value">{input.state || 'Paused'}</span>
          </div>
          <div className="meta-row">
            <span className="meta-key">Volume</span>
            <span className="meta-value">{input.volume}%</span>
          </div>
          {input.duration > 0 && (
            <div className="meta-row">
              <span className="meta-key">Duration</span>
              <span className="meta-value">
                {Math.floor(input.duration / 1000 / 60)}:
                {String(Math.floor((input.duration / 1000) % 60)).padStart(2, '0')}
              </span>
            </div>
          )}
        </div>
      </div>
    </main>
  );
}
