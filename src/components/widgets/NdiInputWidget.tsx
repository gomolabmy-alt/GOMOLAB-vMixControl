import { useState, useEffect, useRef, useContext } from 'react';
import { useCanvasStore } from '../../stores/canvasStore';
import { CanvasActionContext } from '../../lib/canvasContext';
import { useVmixStore } from '../../stores/vmixStore';
import { ndiRuntimeAvailable, ndiPreviewStart, ndiPreviewStop } from '../../lib/ndiPreview';

interface Props {
  widgetId: string;
  config: Record<string, any>;
}

interface NdiSource {
  id: string;
  name: string;
}

export function NdiInputWidget({ widgetId, config: cfg }: Props) {
  const store = useCanvasStore();
  const ctx = useContext(CanvasActionContext);
  const updateWidgetConfig = ctx?.updateWidgetConfig ?? store.updateWidgetConfig;
  const { getClient, vmixState, connection, activeConnection } = useVmixStore();
  const connEntry = connection;
  const conn = connEntry ?? activeConnection;
  const connVmixState = connEntry?.vmixState ?? vmixState;
  const c = getClient();

  const [newName, setNewName]           = useState('');
  const [scanning, setScanning]         = useState(false);
  const [discovered, setDiscovered]     = useState<string[]>([]);
  const [scanError, setScanError]       = useState<string | null>(null);
  const [busy, setBusy]                 = useState<Record<string, boolean>>({});
  const [selectedNumber, setSelectedNumber] = useState<number | null>(null);
  const [thumbTs, setThumbTs]           = useState(Date.now());

  // Real live NDI preview — receives actual video frames directly from the
  // network (independent of vMix), so any discovered/saved source can be
  // previewed even before it's added as a vMix input.
  const [ndiAvailable, setNdiAvailable] = useState(false);
  const [previewName, setPreviewName]   = useState<string | null>(null);
  const [previewUrl, setPreviewUrl]     = useState<string | null>(null);
  const [previewErr, setPreviewErr]     = useState<string | null>(null);
  const [previewTs, setPreviewTs]       = useState(Date.now());

  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const previewTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const saved: NdiSource[] = cfg.sources ?? [];
  const connected = !!connVmixState;
  const canScan = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

  const ndiInVmix = connVmixState?.inputs.filter(i => i.type === 'NDI') ?? [];

  // Build the thumbnail URL for a given input number
  const thumbUrl = (number: number) =>
    conn
      ? `http://${conn.host}:${conn.port}/thumbnail?Input=${number}&t=${thumbTs}`
      : null;

  // Auto-refresh the vMix-thumbnail fallback every 500 ms — only needed when
  // the real NDI preview below isn't available (no NDI runtime installed).
  useEffect(() => {
    if (selectedNumber !== null && !ndiAvailable) {
      timerRef.current = setInterval(() => setThumbTs(Date.now()), 500);
    }
    return () => { if (timerRef.current) clearInterval(timerRef.current); };
  }, [selectedNumber, ndiAvailable]);

  // Deselect if input disappears from vMix
  useEffect(() => {
    if (selectedNumber !== null && !ndiInVmix.some(i => i.number === selectedNumber)) {
      setSelectedNumber(null);
    }
  }, [ndiInVmix, selectedNumber]);

  // Detect once whether this Mac has the NDI runtime installed (NDI Tools /
  // Redistributable) — determines whether real live preview is possible.
  useEffect(() => {
    if (!canScan) return;
    ndiRuntimeAvailable().then(setNdiAvailable);
  }, [canScan]);

  // Start/stop a real NDI receiver session whenever the previewed source
  // changes, so exactly one background receiver thread runs at a time.
  useEffect(() => {
    if (!previewName || !ndiAvailable) { setPreviewUrl(null); setPreviewErr(null); return; }
    let alive = true;
    let sessionId: string | null = null;
    setPreviewErr(null);
    ndiPreviewStart(previewName, {
      lowBandwidth: !!cfg.ndiLowBandwidth,
      fps: cfg.ndiFps ?? 15,
      quality: cfg.ndiQuality ?? 75,
    }).then(
      ({ id, url }) => {
        if (!alive) { ndiPreviewStop(id); return; }
        sessionId = id;
        setPreviewUrl(url);
      },
      (e) => { if (alive) setPreviewErr('Preview failed: ' + String(e)); },
    );
    return () => {
      alive = false;
      setPreviewUrl(null);
      if (sessionId) ndiPreviewStop(sessionId);
    };
  }, [previewName, ndiAvailable, cfg.ndiLowBandwidth, cfg.ndiFps, cfg.ndiQuality]);

  // Poll the latest-frame endpoint on a plain <img> refresh, like the vMix-
  // thumbnail fallback above. WKWebView (Tauri's engine on macOS) doesn't
  // reliably render multipart/x-mixed-replace streams, so the backend serves
  // one JPEG per request and we cache-bust it on an interval instead.
  useEffect(() => {
    if (previewTimerRef.current) { clearInterval(previewTimerRef.current); previewTimerRef.current = null; }
    if (!previewUrl) return;
    const intervalMs = Math.max(33, Math.round(1000 / (cfg.ndiFps ?? 15)));
    previewTimerRef.current = setInterval(() => setPreviewTs(Date.now()), intervalMs);
    return () => { if (previewTimerRef.current) clearInterval(previewTimerRef.current); };
  }, [previewUrl, cfg.ndiFps]);

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
      if (results.length === 0) {
        // scan_ndi degrades to an empty result both when the runtime is
        // missing AND when it's genuinely just found nothing — without
        // checking ndiAvailable first, a missing-runtime install (the far
        // more common cause, especially on a fresh Windows machine) would
        // read as "no sources found," pointing the operator at the wrong
        // problem entirely (a network/source issue instead of an install one).
        setScanError(ndiAvailable
          ? 'No NDI sources found on network.'
          : 'NDI runtime not found on this device — install NDI Tools or the NDI Runtime from ndi.video, then restart the app.');
      }
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
    const isPreviewing = previewName === name;
    return (
      <div
        key={name}
        className={`wgt-ndi-row${inVmix ? ' wgt-ndi-row--active' : ''}${isPreviewing ? ' wgt-ndi-row--sel' : ''}`}
        onClick={() => setPreviewName(isPreviewing ? null : name)}
        style={{ cursor: ndiAvailable ? 'pointer' : undefined }}
      >
        <span className={`wgt-ndi-dot${inVmix ? ' wgt-ndi-dot--active' : ''}`} />
        <span className="wgt-ndi-title" title={name}>{name}</span>
        <div className="wgt-ndi-btns" onClick={e => e.stopPropagation()}>
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
      {previewName !== null && (
        <div className="wgt-ndi-preview">
          {ndiAvailable && previewUrl ? (
            <>
              <img
                className="wgt-ndi-preview-img"
                src={`${previewUrl}?t=${previewTs}`}
                alt="NDI preview"
                onError={e => { (e.currentTarget as HTMLImageElement).style.display = 'none'; }}
                onLoad={e  => { (e.currentTarget as HTMLImageElement).style.display = 'block'; }}
              />
              <span className="wgt-ndi-live-badge">● LIVE</span>
            </>
          ) : ndiAvailable ? (
            <div className="wgt-ndi-empty">{previewErr ?? 'Connecting…'}</div>
          ) : selectedNumber !== null && thumbUrl(selectedNumber) ? (
            <img
              className="wgt-ndi-preview-img"
              src={thumbUrl(selectedNumber)!}
              alt="NDI preview"
              onError={e => { (e.currentTarget as HTMLImageElement).style.display = 'none'; }}
              onLoad={e  => { (e.currentTarget as HTMLImageElement).style.display = 'block'; }}
            />
          ) : (
            <div className="wgt-ndi-empty">Install NDI Tools (or the NDI Runtime) on this device for live preview.</div>
          )}
          <button
            className="wgt-ndi-preview-close"
            onClick={() => { setPreviewName(null); setSelectedNumber(null); }}
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
          const isPreviewing = previewName === src.name;
          return (
            <div
              key={src.id}
              className={`wgt-ndi-row${inVmix ? ' wgt-ndi-row--active' : ''}${isPreviewing ? ' wgt-ndi-row--sel' : ''}`}
              onClick={() => setPreviewName(isPreviewing ? null : src.name)}
              style={{ cursor: ndiAvailable ? 'pointer' : undefined }}
            >
              <span className={`wgt-ndi-dot${inVmix ? ' wgt-ndi-dot--active' : ''}`} />
              <span className="wgt-ndi-title" title={src.name}>{src.name}</span>
              <div className="wgt-ndi-btns" onClick={e => e.stopPropagation()}>
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
              const isSelected = selectedNumber === inp.number || previewName === inp.title;
              return (
                <div
                  key={inp.key}
                  className={`wgt-ndi-row${isActive ? ' wgt-ndi-row--pgm' : isPreview ? ' wgt-ndi-row--prv' : isSelected ? ' wgt-ndi-row--sel' : ''}`}
                  onClick={() => {
                    setSelectedNumber(isSelected ? null : inp.number);
                    setPreviewName(isSelected ? null : inp.title);
                  }}
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
