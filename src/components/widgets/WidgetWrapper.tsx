import { useRef, useState, useEffect, useContext } from 'react';
import { useCanvasStore } from '../../stores/canvasStore';
import type { CanvasWidget } from '../../types/canvas';
import { WIDGET_TYPE_LABELS } from '../../types/canvas';
import { CanvasActionContext } from '../../lib/canvasContext';
import { syncClient } from '../../lib/syncClient';
import { WidgetIcon } from './WidgetIcon';

interface Props {
  widget: CanvasWidget;
  children: React.ReactNode;
}

function lightenHex(hex: string, amount = 20): string {
  const n = parseInt(hex.replace('#', ''), 16);
  const r = Math.min(255, (n >> 16) + amount);
  const g = Math.min(255, ((n >> 8) & 0xff) + amount);
  const b = Math.min(255, (n & 0xff) + amount);
  return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`;
}

export function WidgetWrapper({ widget, children }: Props) {
  const store = useCanvasStore();
  const ctx = useContext(CanvasActionContext);

  const canEdit = store.editMode && !syncClient.isReadOnly;
  const selectedWidgetId = ctx?.selectedWidgetId ?? store.selectedWidgetId;
  const pages = ctx?.pages ?? store.pages;
  const activePageId = ctx?.activePageId ?? store.activePageId;
  const moveWidget = ctx?.moveWidget ?? store.moveWidget;
  const resizeWidget = ctx?.resizeWidget ?? store.resizeWidget;
  const selectWidget = ctx?.selectWidget ?? store.selectWidget;
  const deleteWidget = ctx?.deleteWidget ?? store.deleteWidget;
  const transferWidgetToPage = ctx?.transferWidgetToPage ?? store.transferWidgetToPage;
  const [showPageMenu, setShowPageMenu] = useState(false);
  const pageMenuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!showPageMenu) return;
    const handler = (e: MouseEvent) => {
      if (pageMenuRef.current && !pageMenuRef.current.contains(e.target as Node)) setShowPageMenu(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [showPageMenu]);
  const isSelected = selectedWidgetId === widget.id;

  const widgetTheme = widget.config.widgetTheme as 'dark' | 'light' | undefined;
  const widgetAccent = widget.config.widgetAccent as string | undefined;
  const accentVars = widgetAccent
    ? ({ '--accent': widgetAccent, '--accent-hover': lightenHex(widgetAccent) } as React.CSSProperties)
    : {};

  const dragRef = useRef<{ sx: number; sy: number; ox: number; oy: number } | null>(null);
  const resizeRef = useRef<{ sx: number; sy: number; ow: number; oh: number } | null>(null);

  // ── Drag ────────────────────────────────────────────────────────────────────
  const onDragDown = (e: React.PointerEvent) => {
    e.stopPropagation();
    e.preventDefault();
    selectWidget(widget.id);
    dragRef.current = { sx: e.clientX, sy: e.clientY, ox: widget.x, oy: widget.y };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };

  const onDragMove = (e: React.PointerEvent) => {
    if (!dragRef.current) return;
    const { sx, sy, ox, oy } = dragRef.current;
    const x = Math.max(0, Math.round((ox + (e.clientX - sx)) / 10) * 10);
    const y = Math.max(0, Math.round((oy + (e.clientY - sy)) / 10) * 10);
    moveWidget(widget.id, x, y);
  };

  const onDragUp = () => { dragRef.current = null; };

  // ── Resize ──────────────────────────────────────────────────────────────────
  const onResizeDown = (e: React.PointerEvent) => {
    e.stopPropagation();
    e.preventDefault();
    resizeRef.current = { sx: e.clientX, sy: e.clientY, ow: widget.w, oh: widget.h };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };

  const onResizeMove = (e: React.PointerEvent) => {
    if (!resizeRef.current) return;
    const { sx, sy, ow, oh } = resizeRef.current;
    const w = Math.max(60, Math.round((ow + (e.clientX - sx)) / 10) * 10);
    const h = Math.max(40, Math.round((oh + (e.clientY - sy)) / 10) * 10);
    resizeWidget(widget.id, w, h);
  };

  const onResizeUp = () => { resizeRef.current = null; };

  return (
    <div
      className={[
        'cw',
        canEdit ? 'cw--edit' : '',
        isSelected ? 'cw--selected' : '',
      ].filter(Boolean).join(' ')}
      data-theme={widgetTheme}
      style={{ left: widget.x, top: widget.y, width: widget.w, height: widget.h, ...accentVars }}
      onClick={canEdit ? (e) => { e.stopPropagation(); selectWidget(widget.id); } : undefined}
    >
      {canEdit && (
        <div
          className="cw-drag"
          onPointerDown={onDragDown}
          onPointerMove={onDragMove}
          onPointerUp={onDragUp}
        >
          <span className="cw-type-badge">
            <WidgetIcon type={widget.type} size={12} strokeWidth={2} />&nbsp;{WIDGET_TYPE_LABELS[widget.type]}
          </span>
          <div className="cw-page-menu-wrap" ref={pageMenuRef} onPointerDown={(e) => e.stopPropagation()}>
            <button
              className="cw-page-btn"
              onClick={(e) => { e.stopPropagation(); setShowPageMenu((v) => !v); }}
              title="Move / copy to page"
            >
              ⇄
            </button>
            {showPageMenu && (
              <div className="cw-page-dropdown">
                {pages.filter((p) => p.id !== activePageId).map((p) => (
                  <div key={p.id} className="cw-page-row">
                    <span className="cw-page-row-name">{p.name}</span>
                    <button
                      className="cw-page-action"
                      onClick={(e) => { e.stopPropagation(); transferWidgetToPage(widget.id, p.id, false); setShowPageMenu(false); }}
                    >Move</button>
                    <button
                      className="cw-page-action"
                      onClick={(e) => { e.stopPropagation(); transferWidgetToPage(widget.id, p.id, true); setShowPageMenu(false); }}
                    >Copy</button>
                  </div>
                ))}
                {pages.filter((p) => p.id !== activePageId).length === 0 && (
                  <div className="cw-page-empty">No other pages</div>
                )}
              </div>
            )}
          </div>
          <button
            className="cw-del"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => { e.stopPropagation(); deleteWidget(widget.id); }}
          >
            ×
          </button>
        </div>
      )}

      <div className={`cw-body ${canEdit ? 'cw-body--locked' : ''}`}>
        {children}
      </div>

      {widget.label && (
        <div className="cw-label">{widget.label}</div>
      )}

      {canEdit && (
        <div
          className="cw-resize"
          onPointerDown={onResizeDown}
          onPointerMove={onResizeMove}
          onPointerUp={onResizeUp}
        />
      )}
    </div>
  );
}
