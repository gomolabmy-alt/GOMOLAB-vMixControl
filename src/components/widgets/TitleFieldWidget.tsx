import { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { useVmixStore } from '../../stores/vmixStore';
import { LogoUrlPicker } from '../LogoUrlPicker';

type FieldEntry = string | { name: string; type: 'source' };
const fName = (f: FieldEntry): string => typeof f === 'string' ? f : f.name;
const fType = (f: FieldEntry): 'text' | 'source' => typeof f === 'string' ? 'text' : (f.type ?? 'text');

interface InputGroup { inputKey: string; inputTitle?: string; fields: FieldEntry[]; }
interface Props { config: Record<string, any>; w: number; h: number; }

export function TitleFieldWidget({ config }: Props) {
  const { getClient, vmixState } = useVmixStore();

  const groups: InputGroup[] = useMemo(() =>
    config.inputs ?? (
      config.inputKey
        ? [{ inputKey: config.inputKey, inputTitle: config.inputTitle, fields: config.fields ?? [config.fieldName ?? 'Title.Text'] }]
        : [{ inputKey: '', fields: ['Title.Text'] }]
    ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [config.inputs, config.inputKey, config.inputTitle, config.fieldName]
  );

  const autoSend: boolean = config.autoSend ?? false;
  const delayMs: number  = config.autoSendDelayMs ?? 400;

  // Per-field values keyed by `${inputKey}::${fieldName}`
  const [values, setValues] = useState<Record<string, string>>({});
  const timers  = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  const initRef = useRef<Set<string>>(new Set());

  // Initialise each field once from vMix state (never overrides user edits)
  useEffect(() => {
    const updates: Record<string, string> = {};
    for (const grp of groups) {
      if (!grp.inputKey) continue;
      const gVmixState = vmixState;
      if (!gVmixState) continue;
      const inp = gVmixState.inputs.find(i => i.key === grp.inputKey);
      if (!inp) continue;
      for (const field of grp.fields) {
        const fname = fName(field);
        const key = `${grp.inputKey}::${fname}`;
        if (initRef.current.has(key)) continue;
        const tf = inp.textFields.find(f => f.name === fname);
        if (tf !== undefined) {
          updates[key] = tf.value;
          initRef.current.add(key);
        }
      }
    }
    if (Object.keys(updates).length > 0) {
      setValues(prev => ({ ...prev, ...updates }));
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vmixState]);

  const sendField = useCallback((inputKey: string, field: FieldEntry, val: string) => {
    if (!inputKey) return;
    const client = getClient();
    const name = fName(field);
    if (!name) return;
    if (fType(field) === 'source') {
      client?.setImageField(inputKey, name, val);
    } else {
      client?.setTextField(inputKey, name, val);
    }
  }, [getClient]);

  const sendAll = useCallback(() => {
    const c = getClient();
    for (const grp of groups) {
      if (!grp.inputKey) continue;
      for (const field of grp.fields) {
        const name = fName(field);
        const val = values[`${grp.inputKey}::${name}`] ?? '';
        if (fType(field) === 'source') {
          c?.setImageField(grp.inputKey, name, val);
        } else {
          c?.setTextField(grp.inputKey, name, val);
        }
      }
    }
  }, [groups, values, getClient]);

  const handleChange = (inputKey: string, field: FieldEntry, val: string) => {
    const key = `${inputKey}::${fName(field)}`;
    setValues(prev => ({ ...prev, [key]: val }));
    if (autoSend) {
      clearTimeout(timers.current[key]);
      timers.current[key] = setTimeout(() => sendField(inputKey, field, val), delayMs);
    }
  };

  // Lookup input title from live vMix state (fallback to stored inputTitle)
  const getInputTitle = (grp: InputGroup): string => {
    const gVmixState = vmixState;
    if (gVmixState) {
      const found = gVmixState.inputs.find(i => i.key === grp.inputKey);
      if (found) return `${found.number}. ${found.title}`;
    }
    return grp.inputTitle || grp.inputKey || '—';
  };

  const configured = groups.some(g => g.inputKey);

  // Flatten to all field entries for "Send All"
  const allFields = groups.flatMap(g => g.fields.map(f => ({ inputKey: g.inputKey, field: f })));
  const allTextFields = allFields.filter(({ field }) => fType(field) === 'text');

  return (
    <div className="wgt-tf-multi">
      {autoSend && <span className="wgt-tf-auto-dot" title="Auto-send on" />}

      <div className="wgt-tf-fields">
        {!configured && (
          <div className="wgt-tf-row" style={{ padding: '8px', justifyContent: 'center', opacity: 0.5, fontSize: 11 }}>
            Set inputs in ⚙
          </div>
        )}

        {groups.map((grp, gi) => (
          <div key={gi} className="wgt-tf-group">
            {/* Show input name header when multiple groups */}
            {groups.length > 1 && grp.inputKey && (
              <div className="wgt-tf-group-header">{getInputTitle(grp)}</div>
            )}

            {grp.fields.map((field, fi) => {
              const fname = fName(field);
              const ftype = fType(field);
              const key   = `${grp.inputKey}::${fname}`;
              const val   = values[key] ?? '';
              const label = fname.replace(/\.(Text|Source)$/i, '').replace(/\./g, ' ');

              return (
                <div key={fi} className="wgt-tf-row">
                  <span className="wgt-tf-field-label" title={fname}>{label}</span>
                  {ftype === 'source' ? (
                    <LogoUrlPicker
                      compact
                      value={val}
                      onChange={v => {
                        handleChange(grp.inputKey, field, v);
                        sendField(grp.inputKey, field, v);
                      }}
                    />
                  ) : (
                    <>
                      <input
                        className={`wgt-tf-input${autoSend ? ' wgt-tf-input--auto' : ''}`}
                        value={val}
                        disabled={!grp.inputKey}
                        onChange={e => handleChange(grp.inputKey, field, e.target.value)}
                        onKeyDown={e => {
                          if (e.key === 'Enter' && !autoSend) sendField(grp.inputKey, field, val);
                        }}
                        placeholder={autoSend ? 'Auto-send…' : 'Enter…'}
                      />
                      {!autoSend && (
                        <button
                          className="wgt-tf-send"
                          disabled={!grp.inputKey}
                          title="Send to vMix"
                          onClick={() => sendField(grp.inputKey, field, val)}
                        >→</button>
                      )}
                    </>
                  )}
                </div>
              );
            })}
          </div>
        ))}
      </div>

      {/* Send All button — manual mode, multiple text fields */}
      {!autoSend && configured && allTextFields.length > 1 && (
        <button className="wgt-tf-send-all-btn" onClick={sendAll}>
          Send All
        </button>
      )}
    </div>
  );
}
