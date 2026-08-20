import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Download, RefreshCw } from 'lucide-react';

// A minimal "Update" shape covering just what this component reads —
// avoids a hard import-time dependency on @tauri-apps/plugin-updater's own
// type (the module itself is still only ever loaded dynamically, and only
// inside a Tauri window — see isTauri below).
interface UpdateHandle {
  version: string;
  body?: string;
  downloadAndInstall: (onEvent: (event: { event: string; data?: any }) => void) => Promise<void>;
}

type Phase = 'idle' | 'checking' | 'available' | 'downloading' | 'ready' | 'error';

// Silently checks once on launch (see the GitHub Actions release workflow —
// a tag push builds + signs Mac and Windows bundles and drafts a GitHub
// Release; publishing that draft is what actually makes `latest.json`
// resolvable, which is what this polls). Says nothing when already
// up to date; surfaces a small pill next to the build number in the
// sidebar only once there's something to actually do.
export function UpdateChecker() {
  const isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
  const [phase, setPhase] = useState<Phase>('idle');
  const [update, setUpdate] = useState<UpdateHandle | null>(null);
  const [progress, setProgress] = useState<{ downloaded: number; total: number } | null>(null);
  const [error, setError] = useState('');
  const [panelOpen, setPanelOpen] = useState(false);
  const checkingManually = useRef(false);

  const runCheck = useCallback(async (silent: boolean) => {
    if (!isTauri || phase === 'checking' || phase === 'downloading') return;
    setPhase('checking');
    checkingManually.current = !silent;
    try {
      const { check } = await import('@tauri-apps/plugin-updater');
      const found = await check();
      if (found) {
        setUpdate(found as unknown as UpdateHandle);
        setPhase('available');
        setPanelOpen(true);
      } else {
        setPhase('idle');
        if (!silent) { setPanelOpen(true); setTimeout(() => setPanelOpen(false), 2500); }
      }
    } catch (e: any) {
      setError(e?.message ? String(e.message) : String(e));
      setPhase('error');
      if (!silent) setPanelOpen(true);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isTauri]);

  // One silent check shortly after launch — not immediately, so it never
  // competes with the splash/startup sequence for attention.
  useEffect(() => {
    if (!isTauri) return;
    const t = setTimeout(() => runCheck(true), 4000);
    return () => clearTimeout(t);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isTauri]);

  const downloadAndInstall = useCallback(async () => {
    if (!update) return;
    setPhase('downloading');
    setProgress(null);
    let downloaded = 0;
    let total = 0;
    try {
      await update.downloadAndInstall(event => {
        if (event.event === 'Started') { total = event.data?.contentLength ?? 0; setProgress({ downloaded: 0, total }); }
        else if (event.event === 'Progress') { downloaded += event.data?.chunkLength ?? 0; setProgress({ downloaded, total }); }
      });
      setPhase('ready');
    } catch (e: any) {
      setError(e?.message ? String(e.message) : String(e));
      setPhase('error');
    }
  }, [update]);

  const restartNow = useCallback(async () => {
    const { relaunch } = await import('@tauri-apps/plugin-process');
    relaunch();
  }, []);

  if (!isTauri) return null;

  const pillLabel =
    phase === 'checking' ? 'Checking…' :
    phase === 'available' ? `Update available · v${update?.version}` :
    phase === 'downloading' ? 'Downloading update…' :
    phase === 'ready' ? 'Restart to update' :
    phase === 'error' ? 'Update check failed' :
    'Check for Updates';

  return (
    <>
      <button
        className={`sb-update-pill${phase === 'available' || phase === 'ready' ? ' sb-update-pill--active' : ''}${phase === 'error' ? ' sb-update-pill--error' : ''}`}
        onClick={() => (phase === 'idle' || phase === 'error') ? runCheck(false) : setPanelOpen(true)}
        title={pillLabel}
      >{pillLabel}</button>

      {panelOpen && createPortal(
        <div className="modal-overlay" onClick={() => phase !== 'downloading' && setPanelOpen(false)}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <h3 className="modal-title">
              {phase === 'available' && `Update available: v${update?.version}`}
              {phase === 'downloading' && 'Downloading update…'}
              {phase === 'ready' && 'Update ready'}
              {phase === 'error' && 'Update check failed'}
              {phase === 'idle' && "You're up to date"}
              {phase === 'checking' && 'Checking for updates…'}
            </h3>
            {phase === 'available' && update?.body && (
              <p style={{ fontSize: 12, color: 'var(--text-secondary)', margin: 0, lineHeight: 1.5, whiteSpace: 'pre-line', maxHeight: 180, overflowY: 'auto' }}>
                {update.body}
              </p>
            )}
            {phase === 'downloading' && (
              <div className="sb-update-progress">
                <div className="sb-update-progress-bar" style={{ width: progress && progress.total > 0 ? `${Math.min(100, (progress.downloaded / progress.total) * 100)}%` : '30%' }} />
              </div>
            )}
            {phase === 'ready' && (
              <p style={{ fontSize: 13, color: 'var(--text-secondary)', margin: 0, lineHeight: 1.4 }}>
                Downloaded and installed — restart GOMOLAB vMix Control to finish updating.
              </p>
            )}
            {phase === 'error' && (
              <p style={{ fontSize: 12, color: 'var(--danger, #e74c3c)', margin: 0, lineHeight: 1.4 }}>{error}</p>
            )}
            <div className="modal-actions">
              {phase === 'available' && (
                <>
                  <button className="btn btn--ghost btn--small" onClick={() => setPanelOpen(false)}>Later</button>
                  <button className="btn btn--primary btn--small" onClick={downloadAndInstall} style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                    <Download size={12} strokeWidth={2} /> Download &amp; Install
                  </button>
                </>
              )}
              {phase === 'ready' && (
                <button className="btn btn--primary btn--small" onClick={restartNow} style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                  <RefreshCw size={12} strokeWidth={2} /> Restart Now
                </button>
              )}
              {(phase === 'error' || phase === 'idle' || phase === 'checking') && (
                <button className="btn btn--ghost btn--small" onClick={() => setPanelOpen(false)}>Close</button>
              )}
            </div>
          </div>
        </div>,
        document.body
      )}
    </>
  );
}
