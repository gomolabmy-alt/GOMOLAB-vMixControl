import { useEffect, useRef, useState } from 'react';
import { useUndoStore } from '../stores/undoStore';

const TOAST_DURATION_MS = 8000;

// Brief pop-up shown right after any undoable delete/reset/clear — the
// persistent StatusBar `UndoControl` covers the same entry afterward, this
// is just the "you probably want to see this immediately" nudge.
export function UndoToast() {
  const history = useUndoStore(s => s.history);
  const removeEntry = useUndoStore(s => s.removeEntry);
  const [visibleId, setVisibleId] = useState<string | null>(null);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastSeenId = useRef<string | null>(null);

  useEffect(() => {
    const top = history[0];
    if (top && top.id !== lastSeenId.current) {
      lastSeenId.current = top.id;
      setVisibleId(top.id);
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
      timeoutRef.current = setTimeout(() => setVisibleId(null), TOAST_DURATION_MS);
    }
  }, [history]);

  useEffect(() => () => { if (timeoutRef.current) clearTimeout(timeoutRef.current); }, []);

  const entry = visibleId ? history.find(e => e.id === visibleId) : undefined;
  if (!entry) return null;

  return (
    <div className="undo-toast-overlay">
      <div className="undo-toast-card">
        <span className="undo-toast-label">{entry.label}</span>
        <div className="undo-toast-actions">
          <button
            className="undo-toast-btn"
            onClick={() => { entry.undo(); removeEntry(entry.id); setVisibleId(null); }}
          >Undo</button>
          <button className="undo-toast-close" onClick={() => setVisibleId(null)} title="Dismiss">✕</button>
        </div>
      </div>
    </div>
  );
}
