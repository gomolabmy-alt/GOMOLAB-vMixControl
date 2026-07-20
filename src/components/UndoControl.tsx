import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useUndoStore } from '../stores/undoStore';

function timeAgo(ts: number): string {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  return `${h}h ago`;
}

// Persistent "↩ Undo (N)" control for the StatusBar — a portal popup
// listing every entry in the shared undo history (deletes, resets, clears),
// each individually undoable. Stays available until the app closes, unlike
// the auto-fading UndoToast.
export function UndoControl() {
  const history = useUndoStore(s => s.history);
  const removeEntry = useUndoStore(s => s.removeEntry);
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const popupRef = useRef<HTMLDivElement>(null);
  const anchorRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (popupRef.current && !popupRef.current.contains(e.target as Node) &&
          anchorRef.current && !anchorRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  useEffect(() => {
    if (history.length === 0) setOpen(false);
  }, [history.length]);

  if (history.length === 0) return null;

  const toggle = () => {
    if (!open && anchorRef.current) {
      const r = anchorRef.current.getBoundingClientRect();
      setPos({ left: r.left, top: r.bottom + 6 });
    }
    setOpen(v => !v);
  };

  return (
    <>
      <button
        ref={anchorRef}
        className="status-btn undo-control-btn"
        title="Undo a recent delete/reset/clear"
        onClick={toggle}
      >↩ Undo ({history.length})</button>
      {open && pos && createPortal(
        <div
          ref={popupRef}
          className="undo-popup"
          style={{ position: 'fixed', left: pos.left, top: pos.top, zIndex: 10000 }}
        >
          <div className="undo-popup-title">Recent actions</div>
          {history.map(entry => (
            <div key={entry.id} className="undo-popup-row">
              <div className="undo-popup-row-text">
                <span className="undo-popup-label">{entry.label}</span>
                <span className="undo-popup-time">{timeAgo(entry.timestamp)}</span>
              </div>
              <button
                className="undo-popup-btn"
                onClick={() => { entry.undo(); removeEntry(entry.id); }}
              >Undo</button>
            </div>
          ))}
        </div>,
        document.body
      )}
    </>
  );
}
