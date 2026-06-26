import { useState, useRef, useCallback, useEffect } from 'react';
import { useCanvasStore } from '../stores/canvasStore';
import { useAppSettings, nearestScalePreset } from '../stores/appSettingsStore';
import { WidgetRenderer } from './widgets/index';
import { WidgetPalette } from './WidgetPalette';
import { WidgetConfigPanel } from './WidgetConfigPanel';
import { NotificationOverlay } from './NotificationOverlay';
import { syncClient } from '../lib/syncClient';

export function Canvas() {
  const {
    pages, activePageId, editMode, selectedWidgetId,
    addPage, deletePage, renamePage, setActivePage,
    setEditMode, selectWidget, syncReady,
  } = useCanvasStore();

  const { canvasWidth, canvasHeight, canvasScale, setCanvasScale } = useAppSettings();

  const [showPalette, setShowPalette] = useState(false);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [syncStatus, setSyncStatus] = useState(syncClient.status);
  const canvasRef = useRef<HTMLDivElement>(null);

  const isClientMode = !(typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window);
  const isReadOnly = syncClient.isReadOnly;

  // Auto-dismiss the loading overlay after 5 s even if FULL_STATE never arrives,
  // so the browser never shows a permanently blank page.
  const [timedOut, setTimedOut] = useState(false);
  useEffect(() => {
    if (!isClientMode || syncReady) return;
    const id = setTimeout(() => setTimedOut(true), 5000);
    return () => clearTimeout(id);
  }, [isClientMode, syncReady]);

  useEffect(() => syncClient.onStatus(setSyncStatus), []);

  // These hooks must be declared before any early return (Rules of Hooks)
  const handleCanvasClick = useCallback((e: React.MouseEvent) => {
    if (e.target === canvasRef.current || (e.target as HTMLElement).classList.contains('canvas-surface')) {
      selectWidget(null);
    }
  }, [selectWidget]);
  const lastPinchRef = useRef<number | null>(null);

  // Browsers show a connecting overlay until the app pushes its canvas via FULL_STATE
  if (isClientMode && !syncReady && !timedOut) {
    return (
      <div style={{
        display: 'flex', flexDirection: 'column', alignItems: 'center',
        justifyContent: 'center', height: '100vh', gap: 20,
        background: '#1a1a2e', color: '#fff',
      }}>
        <div style={{ fontSize: 36, fontWeight: 700, letterSpacing: 1 }}>GOMOLAB vMix Control</div>
        <div style={{
          display: 'flex', alignItems: 'center', gap: 10,
          padding: '10px 24px', borderRadius: 8,
          background: syncStatus === 'connected' ? 'rgba(0,200,100,0.15)' : 'rgba(255,200,0,0.15)',
          border: `1px solid ${syncStatus === 'connected' ? '#00c864' : '#ffc800'}`,
          color: syncStatus === 'connected' ? '#00c864' : '#ffc800',
          fontSize: 15,
        }}>
          <span style={{ fontSize: 10, borderRadius: '50%', width: 10, height: 10, display: 'inline-block',
            background: syncStatus === 'connected' ? '#00c864' : '#ffc800',
            boxShadow: `0 0 6px ${syncStatus === 'connected' ? '#00c864' : '#ffc800'}` }} />
          {syncStatus === 'disconnected' ? 'Connecting to app…' :
           syncStatus === 'connecting' ? 'Connecting…' :
           'Loading canvas…'}
        </div>
        <div style={{ fontSize: 12, color: 'rgba(255,255,255,0.4)', marginTop: 4 }}>
          {window.location.host}
        </div>
      </div>
    );
  }

  const activePage = pages.find((p) => p.id === activePageId) ?? pages[0];
  const selectedWidget = activePage?.widgets.find((w) => w.id === selectedWidgetId) ?? null;

  const startRename = (id: string, name: string) => {
    setRenamingId(id);
    setRenameValue(name);
  };

  const commitRename = () => {
    if (renamingId && renameValue.trim()) renamePage(renamingId, renameValue.trim());
    setRenamingId(null);
  };

  const handlePointerZoom = (e: React.WheelEvent) => {
    if (!e.ctrlKey && !e.metaKey) return;
    e.preventDefault();
    const delta = e.deltaY > 0 ? -0.05 : 0.05;
    setCanvasScale(canvasScale + delta);
  };

  return (
    <div className="canvas-page">
      {/* ── Page Tab Bar ──────────────────────────────────────────────── */}
      <div className="canvas-tab-bar">
        {pages.map((page) => (
          <div
            key={page.id}
            className={`canvas-tab ${page.id === activePageId ? 'canvas-tab--active' : ''}`}
            onClick={() => setActivePage(page.id)}
            onDoubleClick={() => startRename(page.id, page.name)}
          >
            {renamingId === page.id ? (
              <input
                className="canvas-tab-rename"
                autoFocus
                value={renameValue}
                onChange={(e) => setRenameValue(e.target.value)}
                onBlur={commitRename}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') commitRename();
                  if (e.key === 'Escape') setRenamingId(null);
                  e.stopPropagation();
                }}
                onClick={(e) => e.stopPropagation()}
              />
            ) : (
              page.name
            )}
            {editMode && pages.length > 1 && (
              <button
                className="canvas-tab-del"
                onClick={(e) => { e.stopPropagation(); deletePage(page.id); }}
                title="Delete page"
              >×</button>
            )}
          </div>
        ))}

        {editMode && (
          <button className="canvas-tab canvas-tab--add" onClick={addPage} title="Add page">+</button>
        )}

        {/* ── Zoom controls ────────────────────────────────────────── */}
        <div className="canvas-zoom-controls">
          <button
            className="canvas-zoom-btn"
            title="Zoom out"
            onClick={() => setCanvasScale(nearestScalePreset(canvasScale, -1))}
          >−</button>
          <button
            className="canvas-zoom-pct"
            title="Reset zoom to 100%"
            onClick={() => setCanvasScale(1)}
          >{Math.round(canvasScale * 100)}%</button>
          <button
            className="canvas-zoom-btn"
            title="Zoom in"
            onClick={() => setCanvasScale(nearestScalePreset(canvasScale, 1))}
          >+</button>
        </div>

      </div>

      {/* ── Canvas Area ───────────────────────────────────────────────── */}
      <div
        ref={canvasRef}
        className={`canvas-area ${editMode ? 'canvas-area--edit' : ''}`}
        onClick={handleCanvasClick}
        onWheel={handlePointerZoom}
      >
        {/* Outer div reserves layout space matching the scaled canvas dimensions */}
        <div style={{
          width: canvasWidth * canvasScale,
          height: canvasHeight * canvasScale,
          flexShrink: 0,
          position: 'relative',
        }}>
          <div
            className={`canvas-surface ${editMode ? 'canvas-surface--edit' : ''}`}
            style={{
              width: canvasWidth,
              height: canvasHeight,
              transform: `scale(${canvasScale})`,
              transformOrigin: 'top left',
            }}
          >
            {isReadOnly && <div className="canvas-readonly-overlay" />}
            {activePage?.widgets.map((widget) => (
              <WidgetRenderer key={widget.id} widget={widget} />
            ))}

            {activePage?.widgets.length === 0 && !editMode && (
              <div className="canvas-empty">
                {isClientMode ? (
                  <>
                    <div className={`canvas-empty-icon canvas-sync-dot canvas-sync-dot--${syncStatus}`}>
                      {syncStatus === 'connected' ? '✓' : syncStatus === 'connecting' ? '…' : '✗'}
                    </div>
                    <div className="canvas-empty-text">
                      {syncStatus === 'connected' ? 'Connected — waiting for layout' : syncStatus === 'connecting' ? 'Connecting to host…' : 'Disconnected — retrying…'}
                    </div>
                    <div className="canvas-empty-sub">
                      {syncStatus === 'connected'
                        ? 'The host has no widgets on this page yet'
                        : 'Make sure the host app is running on the same network'}
                    </div>
                  </>
                ) : (
                  <>
                    <div className="canvas-empty-icon">⬡</div>
                    <div className="canvas-empty-text">No widgets yet</div>
                    <div className="canvas-empty-sub">Tap <strong>✏ Edit</strong> then <strong>+ Add Widget</strong> to get started</div>
                  </>
                )}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* ── Add Widget FAB (edit mode) ────────────────────────────────── */}
      {editMode && (
        <button className="canvas-fab" onClick={() => setShowPalette(true)} title="Add widget">
          +
        </button>
      )}

      {/* ── Widget Palette ────────────────────────────────────────────── */}
      {showPalette && <WidgetPalette onClose={() => setShowPalette(false)} />}

      {/* ── Config Panel ──────────────────────────────────────────────── */}
      {editMode && selectedWidget && (
        <WidgetConfigPanel widget={selectedWidget} onClose={() => selectWidget(null)} />
      )}

      {/* ── Read-only Notification Overlay ───────────────────────────── */}
      {isReadOnly && <NotificationOverlay />}
    </div>
  );
}
