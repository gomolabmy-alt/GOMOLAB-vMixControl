import { useEffect, useRef, useState } from 'react';
import { useCanvasStore } from '../stores/canvasStore';
import { useTournamentStore } from '../stores/tournamentStore';

// A canvas is normally built for one specific tournament — this lets the
// operator bind the current canvas to a tournament (so its widgets can stop
// asking "which tournament" individually) and jump straight to whichever
// canvas is already bound to a given tournament, duplicating the current
// layout as a starting point for a new one when none exists yet.
export function CanvasTournamentPicker() {
  const { pages, activePageId, setActivePage, setPageTournament, addPage, duplicatePage } = useCanvasStore();
  const { tournaments } = useTournamentStore();
  const [open, setOpen] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);
  const anchorRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (panelRef.current && !panelRef.current.contains(e.target as Node) &&
          anchorRef.current && !anchorRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  const activePage = pages.find(p => p.id === activePageId);
  const boundTournament = tournaments.find(t => t.id === activePage?.tournamentId);

  const pageForTournament = (tournamentId: string) => pages.find(p => p.tournamentId === tournamentId);

  const createForTournament = (tournamentId: string) => {
    const id = addPage();
    setPageTournament(id, tournamentId);
    setOpen(false);
  };

  const duplicateForTournament = (tournamentId: string) => {
    if (!activePage) return;
    const t = tournaments.find(tt => tt.id === tournamentId);
    duplicatePage(activePage.id, { name: t ? `${t.name} Canvas` : undefined, tournamentId });
    setOpen(false);
  };

  return (
    <div style={{ position: 'relative', display: 'inline-flex' }}>
      <button
        ref={anchorRef}
        className={`status-btn${open ? ' status-btn--edit-active' : ''}`}
        onClick={() => setOpen(v => !v)}
        title="Bind this canvas to a tournament, or switch to another tournament's canvas"
      >
        🖥 {boundTournament ? boundTournament.name : 'Canvas'} ▾
      </button>
      {open && (
        <div ref={panelRef} className="canvas-tourn-panel">
          <div className="canvas-tourn-panel-section">
            <div className="canvas-tourn-panel-label">This canvas ({activePage?.name}) is for:</div>
            <select
              className="tm-input"
              style={{ width: '100%' }}
              value={activePage?.tournamentId ?? ''}
              onChange={e => activePage && setPageTournament(activePage.id, e.target.value || undefined)}
            >
              <option value="">— Unbound (no specific tournament) —</option>
              {tournaments.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
          </div>

          {tournaments.length > 0 && (
            <div className="canvas-tourn-panel-section">
              <div className="canvas-tourn-panel-label">Switch to a tournament's canvas:</div>
              {tournaments.map(t => {
                const page = pageForTournament(t.id);
                return (
                  <div key={t.id} className="canvas-tourn-row">
                    <span className="canvas-tourn-row-name">{t.name}</span>
                    {page ? (
                      <button
                        className="tm-io-btn"
                        disabled={page.id === activePageId}
                        onClick={() => { setActivePage(page.id); setOpen(false); }}
                      >{page.id === activePageId ? 'Current' : `→ ${page.name}`}</button>
                    ) : (
                      <span style={{ display: 'flex', gap: 4 }}>
                        <button className="tm-io-btn" title="Create a blank canvas for this tournament" onClick={() => createForTournament(t.id)}>+ Blank</button>
                        <button className="tm-io-btn" title="Duplicate the current canvas's layout for this tournament" onClick={() => duplicateForTournament(t.id)}>⧉ Duplicate</button>
                      </span>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
