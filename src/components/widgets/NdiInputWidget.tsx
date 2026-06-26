import { useState, useEffect, useRef } from 'react';
import { useCanvasStore } from '../../stores/canvasStore';
import { useVmixStore } from '../../stores/vmixStore';

interface Props {
  widgetId: string;
  config: Record<string, any>;
}

interface NdiSource {
  id: string;
  name: string;
}

export function NdiInputWidget({ widgetId, config: cfg }: Props) {
  const { updateWidgetConfig } = useCanvasStore();
  const { getClientById, vmixState, connections, activeConnection } = useVmixStore();
  const connEntry = cfg.vmixClientId
    ? connections.find(c => c.id === cfg.vmixClientId)
    : connections[0];
  const conn = connEntry ?? activeConnection;
  const connVmixState = connEntry?.vmixState ?? vmixState;
  const c = getClientById(cfg.vmixClientId);

  const [newName, setNewName]           = useState('');
  const [scanning, setScanning]         = useState(false);
  const [discovered, setDiscovered]     = useState<string[]>([]);
  const [scanError, setScanError]       = useState<string | null>(null);
  const [busy, setBusy]                 = useState<Record<string, boolean>>({});
  const [selectedNumber, setSelectedNumber] = useState<number | null>(null);
  const [thumbTs, setThumbTs]           = useState(Date.now());

  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const saved: NdiSource[] = cfg.sources ?? [];
  const connected = !!connVmixState;
  const canScan = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

  const ndiInVmix = connVmixState?.inputs.filter(i => i.type === 'NDI') ?? [];

  // Build the thumbnail URL for a given input number
  const thumbUrl = (number: number) =>
    conn
      ? `http://${conn.host}:${conn.port}/thumbnail?Input=${number}&t=${thumbTs}`
      : null;

  // Auto-refresh the thumbnail every 500 ms while a source is selected
  useEffect(() => {
    if (selectedNumber !== null) {
      timerRef.current = setInterval(() => setThumbTs(Date.now()), 500);
    }
    return () => { if (timerRef.current) clearInterval(timerRef.current); };
  }, [selectedNumber]);

  // Deselect if input disappears from vMix
  useEffect(() => {
    if (selectedNumber !== null && !ndiInVmix.some(i => i.number === selectedNumber)) {
      setSelectedNumber(null);
    }
  }, [ndiInVmix, selectedNumber]);

  const isInVmix = (name: string) =>
    ndiInVmix.some(i => i.title.toLowerCase() === name.toLowerCase());

  // ── Saved source list ────────────────────────────────────────────────────
  const saveSource = (name: string) => {
    const trimmed = name.trim();
    if (!trimmed || saved.some(s => s.name === trimmed)) return;
    updateWidgetConfig(widgetId, {
      sources: [...saved, { id: crypto.randomUUID(), name: trimmed }],
    });
  };

  const removeSaved = (id: string) =>
    updateWidgetConfig(widgetId, { sources: saved.filter(s => s.id !== id) });

  // ── vMix actions ─────────────────────────────────────────────────────────
  const addToVmix = async (name: string) => {
    setBusy(b => ({ ...b, [name]: true }));
    try { await c?.sendFunction('AddInput', { Value: `NDI://${name}` }); }
    finally { setBusy(b => ({ ...b, [name]: false })); }
  };

  const removeFromVmix = (key: string, number: number) => {
    if (selectedNumber === number) setSelectedNumber(null);
    c?.sendFunction('RemoveInput', { Input: key });
  };

  // ── NDI network scan ─────────────────────────────────────────────────────
  const scanNetwork = async () => {
    setScanning(true);
    setScanError(null);
    setDiscovered([]);
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      const results = await invoke<string[]>('scan_ndi');
      setDiscovered(results);
      if (results.length === 0) setScanError('No NDI sources found on network.');
    } catch (e) {
      setScanError('Scan failed: ' + String(e));
    } finally {
      setScanning(false);
    }
  };

  // ── Network source row ───────────────────────────────────────────────────
  const renderNetworkRow = (name: string) => {
    const inVmix = isInVmix(name);
    const isSaved = saved.some(s => s.name === name);
    return (
      <div key={name} className={`wgt-ndi-row${inVmix ? ' wgt-ndi-row--active' : ''}`}>
        <span className={`wgt-ndi-dot${inVmix ? ' wgt-ndi-dot--active' : ''}`} />
        <span className="wgt-ndi-title" title={name}>{name}</span>
        <div className="wgt-ndi-btns">
          {inVmix
            ? <span className="wgt-ndi-in-label">In vMix</span>
            : (
              <button
                className="wgt-ndi-btn wgt-ndi-btn--add"
                disabled={!connected || busy[name]}
                onClick={() => addToVmix(name)}
              >{busy[name] ? '…' : '+ vMix'}</button>
            )
          }
          {!isSaved && (
            <button className="wgt-ndi-btn wgt-ndi-btn--save" onClick={() => saveSource(name)} title="Save">★</button>
          )}
        </div>
      </div>
    );
  };

  return (
    <div className="wgt-ndi">

      {/* ── Live video preview ── */}
      {selectedNumber !== null && thumbUrl(selectedNumber) && (
        <div className="wgt-ndi-preview">
          <img
            className="wgt-ndi-preview-img"
            src={thumbUrl(selectedNumber)!}
            alt="NDI preview"
            onError={e => { (e.currentTarget as HTMLImageElement).style.display = 'none'; }}
            onLoad={e  => { (e.currentTarget as HTMLImageElement).style.display = 'block'; }}
          />
          <button
            className="wgt-ndi-preview-close"
            onClick={() => setSelectedNumber(null)}
            title="Close preview"
          >×</button>
        </div>
      )}

      {/* ── Scan button ── */}
      {canScan && (
        <button
          className="wgt-ndi-scan-btn"
          onClick={scanNetwork}
          disabled={scanning}
        >
          {scanning ? <><span className="wgt-ndi-spinner" /> Scanning…</> : '⟳ Scan Network'}
        </button>
      )}

      {/* ── Discovered sources ── */}
      {(discovered.length > 0 || scanError) && (
        <>
          <div className="wgt-ndi-section-label">Discovered on network</div>
          {scanError && <div className="wgt-ndi-error">{scanError}</div>}
          <div className="wgt-ndi-list">{discovered.map(renderNetworkRow)}</div>
        </>
      )}

      {/* ── Saved sources ── */}
      <div className="wgt-ndi-section-label">Saved sources</div>
      <div className="wgt-ndi-add-row">
        <input
          className="wgt-ndi-source-inp"
          placeholder="MACHINE (Source Name)"
          value={newName}
          onChange={e => setNewName(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') { saveSource(newName); setNewName(''); } e.stopPropagation(); }}
        />
        <button
          className="wgt-ndi-add-btn"
          onClick={() => { saveSource(newName); setNewName(''); }}
          disabled={!newName.trim()}
        >Save</button>
      </div>
      <div className="wgt-ndi-list">
        {saved.length === 0 && (
          <div className="wgt-ndi-empty">
            {canScan ? 'Scan the network or type a source name above' : 'Type a source name above to save it'}
          </div>
        )}
        {saved.map(src => {
          const inVmix = isInVmix(src.name);
          return (
            <div key={src.id} className={`wgt-ndi-row${inVmix ? ' wgt-ndi-row--active' : ''}`}>
              <span className={`wgt-ndi-dot${inVmix ? ' wgt-ndi-dot--active' : ''}`} />
              <span className="wgt-ndi-title" title={src.name}>{src.name}</span>
              <div className="wgt-ndi-btns">
                {inVmix
                  ? <span className="wgt-ndi-in-label">In vMix</span>
                  : (
                    <button
                      className="wgt-ndi-btn wgt-ndi-btn--add"
                      disabled={!connected || busy[src.name]}
                      onClick={() => addToVmix(src.name)}
                    >{busy[src.name] ? '…' : '+ vMix'}</button>
                  )
                }
                <button className="wgt-ndi-btn wgt-ndi-btn--del" onClick={() => removeSaved(src.id)}>×</button>
              </div>
            </div>
          );
        })}
      </div>

      {/* ── NDI inputs in vMix (with preview tap) ── */}
      {ndiInVmix.length > 0 && (
        <>
          <div className="wgt-ndi-section-label">In vMix — tap to preview</div>
          <div className="wgt-ndi-list wgt-ndi-list--vmix">
            {ndiInVmix.map(inp => {
              const isActive   = connVmixState!.active  === inp.number;
              const isPreview  = connVmixState!.preview === inp.number;
              const isSelected = selectedNumber === inp.number;
              return (
                <div
                  key={inp.key}
                  className={`wgt-ndi-row${isActive ? ' wgt-ndi-row--pgm' : isPreview ? ' wgt-ndi-row--prv' : isSelected ? ' wgt-ndi-row--sel' : ''}`}
                  onClick={() => setSelectedNumber(isSelected ? null : inp.number)}
                  style={{ cursor: 'pointer' }}
                >
                  <span className={`wgt-ndi-dot${isActive ? ' wgt-ndi-dot--pgm' : isPreview ? ' wgt-ndi-dot--prv' : ''}`} />
                  <span className="wgt-ndi-title" title={inp.title}>{inp.title}</span>
                  <div className="wgt-ndi-btns" onClick={e => e.stopPropagation()}>
                    <button className={`wgt-ndi-btn wgt-ndi-btn--prv${isPreview ? ' active' : ''}`} onClick={() => c?.setPreview(inp.key)}>PRV</button>
                    <button className={`wgt-ndi-btn wgt-ndi-btn--pgm${isActive  ? ' active' : ''}`} onClick={() => c?.setActive(inp.key)}>PGM</button>
                    <button className="wgt-ndi-btn wgt-ndi-btn--del" onClick={() => removeFromVmix(inp.key, inp.number)}>×</button>
                  </div>
                </div>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}
