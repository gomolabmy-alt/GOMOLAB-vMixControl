import { useEffect, useRef, useState } from 'react';
import { useCanvasStore } from '../stores/canvasStore';
import { useAppSettings } from '../stores/appSettingsStore';
import { WidgetRenderer } from './widgets/index';
import { ConfirmModal } from './ConfirmModal';
import { syncClient } from '../lib/syncClient';

// Root component for a popped-out canvas page (a second native Tauri
// window, `?popoutPage=<id>` in its URL — see main.tsx). Renders exactly
// one page's widgets, no tab bar/Sidebar/mode-toggle, plus a small toolbar
// with a "Merge back" control. This window is a sync CLIENT, not a host —
// it shares the exact same local WebSocket sync mechanism a browser-based
// commentator/remote client already uses (see syncClient.ts), so widget
// edits made here reach the main window (and vice versa) the same way they
// already do for any other client today.
export function PopoutPage({ pageId }: { pageId: string }) {
  const { pages } = useCanvasStore();
  const { canvasWidth, canvasHeight, canvasScale } = useAppSettings();
  const page = pages.find((p) => p.id === pageId);

  const [syncStatus, setSyncStatus] = useState(syncClient.status);
  const [confirmClose, setConfirmClose] = useState(false);
  // Set right before we actually close the window ourselves (merge-back or
  // a confirmed close) so onCloseRequested's own listener doesn't loop back
  // and re-show the confirmation on its own close.
  const closingRef = useRef(false);

  useEffect(() => syncClient.onStatus(setSyncStatus), []);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    (async () => {
      const { getCurrentWindow } = await import('@tauri-apps/api/window');
      const fn = await getCurrentWindow().onCloseRequested((event) => {
        if (closingRef.current) return;
        event.preventDefault();
        setConfirmClose(true);
      });
      if (cancelled) fn();
      else unlisten = fn;
    })();
    return () => { cancelled = true; unlisten?.(); };
  }, []);

  // Merge-back and a confirmed OS-close both do the same thing: tell the
  // main window this page is a tab again, then close this window. Never
  // touches page data — closing this window only ever un-detaches the
  // page, deleting it is a fully separate, explicit action in the tab bar.
  const mergeBack = async () => {
    closingRef.current = true;
    const { emit } = await import('@tauri-apps/api/event');
    await emit('page-popin', { pageId });
    const { getCurrentWindow } = await import('@tauri-apps/api/window');
    await getCurrentWindow().close();
  };

  if (!page) {
    return (
      <div className="popout-page popout-page--loading">
        <div className="popout-loading-text">
          {syncStatus === 'connected' ? 'Loading page…' : syncStatus === 'connecting' ? 'Connecting…' : 'Reconnecting…'}
        </div>
      </div>
    );
  }

  return (
    <div className="popout-page">
      <div className="popout-toolbar">
        <span className="popout-toolbar-name">{page.name}</span>
        <button className="popout-merge-btn" onClick={mergeBack} title="Bring this page back as a tab in the main window">
          Merge back to tab
        </button>
      </div>
      <div className="popout-canvas-area">
        <div style={{ width: canvasWidth * canvasScale, height: canvasHeight * canvasScale, flexShrink: 0, position: 'relative' }}>
          <div
            className="canvas-surface"
            style={{ width: canvasWidth, height: canvasHeight, transform: `scale(${canvasScale})`, transformOrigin: 'top left' }}
          >
            {page.widgets.map((widget) => <WidgetRenderer key={widget.id} widget={widget} />)}
          </div>
        </div>
      </div>
      {confirmClose && (
        <ConfirmModal
          title="Close window?"
          message={`Close "${page.name}"? It will merge back into the main window's tabs.`}
          confirmLabel="Close"
          onConfirm={() => { setConfirmClose(false); mergeBack(); }}
          onCancel={() => setConfirmClose(false)}
        />
      )}
    </div>
  );
}
