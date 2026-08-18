import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Monitor, ChevronDown, Copy, ArrowRight } from 'lucide-react';
import { useCanvasStore } from '../stores/canvasStore';
import { useTournamentStore } from '../stores/tournamentStore';

// A canvas is normally built for one specific tournament — this lets the
// operator bind the current canvas to a tournament (so its widgets can stop
// asking "which tournament" individually) and jump straight to whichever
// canvas is already bound to a given tournament, duplicating the current
// layout as a starting point for a new one when none exists yet.
export function CanvasTournamentPicker() {
  const { pages, activePageId, setActivePage, setPageTournament, setPageVenue, addPage, duplicatePage } = useCanvasStore();
  const { tournaments } = useTournamentStore();
  const [open, setOpen] = useState(false);
  // Rendered via a portal into document.body, positioned with fixed
  // coordinates: this button lives in the sidebar's own scroll container
  // (`.sb-scroll`, overflow-x: hidden), which would silently clip a wide
  // absolutely-positioned panel nested inside it once it grows past the
  // sidebar's ~250px width — a portal escapes that (same pattern as
  // TeamPicker.tsx).
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
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

  const toggle = () => {
    if (!open && anchorRef.current) {
      const r = anchorRef.current.getBoundingClientRect();
      const panelWidth = 300;
      setPos({ top: r.bottom + 6, left: Math.min(r.left, window.innerWidth - panelWidth - 12) });
    }
    setOpen(v => !v);
  };

  const activePage = pages.find(p => p.id === activePageId);
  const boundTournament = tournaments.find(t => t.id === activePage?.tournamentId);
  const venues = boundTournament?.venues ?? [];

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
    <div style={{ position: 'relative', width: '100%' }}>
      <button
        ref={anchorRef}
        className={`sb-row${open ? ' sb-row--active' : ''}`}
        onClick={toggle}
        title="Bind this canvas to a tournament + venue, or switch to another tournament's canvas"
      >
        <span className="sb-row-icon"><Monitor size={14} strokeWidth={2} /></span>
        <span className="sb-row-text">{boundTournament ? `${boundTournament.name}${activePage?.venue ? ` — ${activePage.venue}` : ''}` : 'Canvas'}</span>
        <span className="sb-row-chevron"><ChevronDown size={11} strokeWidth={2} /></span>
      </button>
      {open && pos && createPortal(
        <div ref={panelRef} className="canvas-tourn-panel" style={{ position: 'fixed', top: pos.top, left: pos.left }}>
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
            {boundTournament && (
              <>
                <div className="canvas-tourn-panel-label" style={{ marginTop: 8 }}>Venue:</div>
                <select
                  className="tm-input"
                  style={{ width: '100%' }}
                  value={activePage?.venue ?? ''}
                  disabled={venues.length === 0}
                  onChange={e => activePage && setPageVenue(activePage.id, e.target.value || undefined)}
                >
                  <option value="">All Venues</option>
                  {venues.map(v => <option key={v} value={v}>{v}</option>)}
                </select>
                {venues.length === 0 && <div className="sb-popover-hint">No venues set up — DB → Schedule tab</div>}
              </>
            )}
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
                        style={page.id === activePageId ? undefined : { display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 4 }}
                      >{page.id === activePageId ? 'Current' : <><ArrowRight size={12} strokeWidth={2} /> {page.name}</>}</button>
                    ) : (
                      <span style={{ display: 'flex', gap: 4 }}>
                        <button className="tm-io-btn" title="Create a blank canvas for this tournament" onClick={() => createForTournament(t.id)}>+ Blank</button>
                        <button className="tm-io-btn" title="Duplicate the current canvas's layout for this tournament" onClick={() => duplicateForTournament(t.id)} style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}><Copy size={12} strokeWidth={2} /> Duplicate</button>
                      </span>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>,
        document.body
      )}
    </div>
  );
}
