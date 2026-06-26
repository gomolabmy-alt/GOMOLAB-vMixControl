import { useState, useEffect, useRef } from 'react';
import { useVmixStore } from '../../stores/vmixStore';

interface TitleInput {
  id: string;
  inputKey: string;
  label?: string;
  fields: string[];       // field names like "Title.Text"
  clientId?: string;
}

interface Props {
  config: Record<string, any>;
  w: number;
  h: number;
}

export function VmixTitlesWidget({ config: cfg }: Props) {
  const { getClientById, vmixState, connections, activeConnection } = useVmixStore();

  const showThumbs: boolean    = cfg.showThumbs ?? true;
  const autoSend: boolean      = cfg.autoSend   ?? false;
  const delayMs: number        = cfg.autoSendDelayMs ?? 400;
  const inputs: TitleInput[]   = cfg.inputs ?? [];

  // Local text values: `${inputKey}::${field}` → value
  const [values, setValues]  = useState<Record<string, string>>({});
  const [thumbTs, setThumbTs] = useState(Date.now());
  const timers  = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  const initRef = useRef<Set<string>>(new Set());

  // Refresh thumbnails every 800 ms when showThumbs is on
  useEffect(() => {
    if (!showThumbs) return;
    const id = setInterval(() => setThumbTs(Date.now()), 800);
    return () => clearInterval(id);
  }, [showThumbs]);

  // Seed text fields once from vMix state
  useEffect(() => {
    const updates: Record<string, string> = {};
    for (const grp of inputs) {
      if (!grp.inputKey) continue;
      const gVmixState = grp.clientId
        ? connections.find(c => c.id === grp.clientId)?.vmixState ?? vmixState
        : vmixState;
      if (!gVmixState) continue;
      const inp = gVmixState.inputs.find(i => i.key === grp.inputKey);
      if (!inp) continue;
      for (const field of grp.fields) {
        const key = `${grp.inputKey}::${field}`;
        if (initRef.current.has(key)) continue;
        const tf = inp.textFields?.find(f => f.name === field);
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
  }, [vmixState, connections]);

  const thumbUrl = (grp: TitleInput) => {
    if (!showThumbs) return null;
    const grpEntry = grp.clientId
      ? connections.find(c => c.id === grp.clientId)
      : connections[0];
    const grpConn = grpEntry ?? activeConnection;
    if (!grpConn) return null;
    const gVmixState = grpEntry?.vmixState ?? vmixState;
    const inp = gVmixState?.inputs.find(i => i.key === grp.inputKey);
    if (!inp) return null;
    return `http://${grpConn.host}:${grpConn.port}/thumbnail?Input=${inp.number}&t=${thumbTs}`;
  };

  const send = (grp: TitleInput, field: string, val: string) => {
    if (!grp.inputKey || !field) return;
    getClientById(grp.clientId)?.setTextField(grp.inputKey, field, val);
  };

  const handleChange = (grp: TitleInput, field: string, val: string) => {
    const key = `${grp.inputKey}::${field}`;
    setValues(prev => ({ ...prev, [key]: val }));
    if (autoSend) {
      clearTimeout(timers.current[key]);
      timers.current[key] = setTimeout(() => send(grp, field, val), delayMs);
    }
  };

  const sendAll = () => {
    for (const grp of inputs) {
      for (const field of grp.fields) {
        send(grp, field, values[`${grp.inputKey}::${field}`] ?? '');
      }
    }
  };

  const connected = !!vmixState;

  if (inputs.length === 0) {
    return <div className="wgt-vt wgt-vt-empty">Add inputs in ⚙ config</div>;
  }

  return (
    <div className="wgt-vt">
      {inputs.map(grp => {
        const gVmixState = grp.clientId
          ? connections.find(c => c.id === grp.clientId)?.vmixState ?? vmixState
          : vmixState;
        const liveInp  = gVmixState?.inputs.find(i => i.key === grp.inputKey);
        const label    = grp.label || liveInp?.title || grp.inputKey || '—';
        const url      = thumbUrl(grp);
        const isActive = !!liveInp && gVmixState!.active  === liveInp.number;
        const isPrv    = !!liveInp && gVmixState!.preview === liveInp.number;

        return (
          <div key={grp.id} className={`wgt-vt-card${isActive ? ' wgt-vt-card--pgm' : isPrv ? ' wgt-vt-card--prv' : ''}`}>
            {/* Thumbnail */}
            {showThumbs && url && (
              <div className="wgt-vt-thumb-wrap">
                <img
                  className="wgt-vt-thumb"
                  src={url}
                  alt={label}
                  onError={e => { (e.currentTarget as HTMLImageElement).style.opacity = '0'; }}
                  onLoad={e  => { (e.currentTarget as HTMLImageElement).style.opacity = '1'; }}
                />
                {isActive && <span className="wgt-vt-tally wgt-vt-tally--pgm">PGM</span>}
                {isPrv    && <span className="wgt-vt-tally wgt-vt-tally--prv">PRV</span>}
              </div>
            )}

            {/* Input name header */}
            <div className="wgt-vt-card-title" title={label}>{label}</div>

            {/* Text fields */}
            {grp.fields.map(field => {
              const key   = `${grp.inputKey}::${field}`;
              const val   = values[key] ?? '';
              const label2 = field.replace(/\.Text$/i, '').replace(/\./g, ' ');
              return (
                <div key={field} className="wgt-vt-row">
                  <span className="wgt-vt-field-label" title={field}>{label2}</span>
                  <input
                    className={`wgt-vt-input${autoSend ? ' wgt-vt-input--auto' : ''}`}
                    value={val}
                    disabled={!grp.inputKey || !connected}
                    placeholder={autoSend ? 'Auto…' : 'Value…'}
                    onChange={e => handleChange(grp, field, e.target.value)}
                    onKeyDown={e => {
                      if (e.key === 'Enter' && !autoSend) send(grp, field, val);
                      e.stopPropagation();
                    }}
                  />
                  {!autoSend && (
                    <button
                      className="wgt-vt-send"
                      disabled={!grp.inputKey || !connected}
                      onClick={() => send(grp, field, val)}
                      title="Send to vMix"
                    >→</button>
                  )}
                </div>
              );
            })}
          </div>
        );
      })}

      {/* Send All footer */}
      {!autoSend && inputs.length > 0 && (
        <button className="wgt-vt-send-all" onClick={sendAll} disabled={!connected}>
          Send All
        </button>
      )}
    </div>
  );
}
