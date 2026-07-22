import { useState, useRef, useEffect, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { useMatchScheduleStore, type ScheduledMatch } from '../stores/matchScheduleStore';
import { useAppSettings } from '../stores/appSettingsStore';
import { resolveImageUrl } from '../lib/imageUrl';

interface Props {
  onPick: (match: ScheduledMatch) => void;
  /** Overrides the title bar 🏟 picker's tournament scope — typically the
   *  canvas's own bound tournament (a canvas is normally dedicated to one),
   *  so this picker doesn't need its own separate tournament selector. */
  tournamentId?: string;
}

// Popup listing upcoming scheduled matches — picking one fills in both
// teams' name/short name/color/logo plus competition/round on the scoreboard
// in one click. Rendered via a portal (same reasoning as TeamPicker): the
// scoreboard's team column has overflow:hidden, which would clip a nested
// absolutely-positioned popup.
export function MatchSchedulePicker({ onPick, tournamentId }: Props) {
  const { matches: allMatches, deleteMatch } = useMatchScheduleStore();
  const { canvasTournamentId, canvasVenue } = useAppSettings();
  const effTournamentId = tournamentId || canvasTournamentId;
  // Scoped to this canvas's tournament, or (if unbound) this install's
  // selected tournament/venue (title bar 🏟 picker) — so a venue operator
  // can't accidentally load another venue's fixture.
  const matches = useMemo(
    () => allMatches.filter(m =>
      (!effTournamentId || m.tournamentId === effTournamentId) &&
      (!canvasVenue || m.venue === canvasVenue)
    ),
    [allMatches, effTournamentId, canvasVenue]
  );
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ left: number; bottom: number } | null>(null);
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

  const toggle = () => {
    if (!open && anchorRef.current) {
      const r = anchorRef.current.getBoundingClientRect();
      setPos({ left: r.left, bottom: window.innerHeight - r.top + 6 });
    }
    setOpen(v => !v);
  };

  return (
    <>
      <button
        ref={anchorRef}
        className="wgt-score-save-btn"
        style={{ background: '#3498db', color: '#fff' }}
        title="Load a scheduled match into this scoreboard"
        onPointerDown={e => { e.stopPropagation(); e.currentTarget.setPointerCapture(e.pointerId); toggle(); }}
        onClick={e => e.stopPropagation()}
      >📅 Load Match</button>
      {open && pos && createPortal(
        <div
          ref={popupRef}
          onClick={e => e.stopPropagation()}
          style={{
            position: 'fixed', left: pos.left, bottom: pos.bottom, zIndex: 10000,
            minWidth: 260, maxWidth: 320, maxHeight: 320, overflowY: 'auto',
            background: 'var(--bg-1)', border: '1px solid var(--border)',
            borderRadius: 6, boxShadow: '0 -4px 16px rgba(0,0,0,.5)',
          }}
        >
          <div style={{ padding: '6px 8px', borderBottom: '1px solid var(--border)',
            fontSize: 11, fontWeight: 600, color: 'var(--text-secondary)' }}>
            Scheduled Matches
          </div>
          {matches.length === 0 ? (
            <div style={{ padding: '10px 12px', fontSize: 12, color: 'var(--text-muted)' }}>
              {allMatches.length > 0 && (canvasTournamentId || canvasVenue)
                ? 'No fixtures for the selected tournament/venue — check the 🏟 picker in the title bar'
                : 'No scheduled matches yet — add some in 🏆 DB → Schedule'}
            </div>
          ) : (
            matches.map(m => (
              <div
                key={m.id}
                onClick={() => { onPick(m); setOpen(false); }}
                style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '6px 8px',
                  cursor: 'pointer', borderBottom: '1px solid var(--border)', opacity: m.sentAt ? 0.45 : 1 }}
                className="team-picker-item"
              >
                <div style={{ fontSize: 9, color: 'var(--text-muted)', width: 44, flexShrink: 0, lineHeight: 1.2 }}>
                  {m.sentAt ? '✓ sent' : (<>{m.date}{m.time ? <><br />{m.time}</> : null}</>)}
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 1, flex: 1, minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 4, minWidth: 0 }}>
                    {m.teamALogo
                      ? <img src={resolveImageUrl(m.teamALogo)} alt="" style={{ width: 18, height: 18, objectFit: 'contain', borderRadius: 3, background: '#111', flexShrink: 0 }} />
                      : <div style={{ width: 18, height: 18, borderRadius: 3, background: m.teamAColor, flexShrink: 0 }} />}
                    <span style={{ fontSize: 11, color: 'var(--text-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {m.teamAShortName || m.teamAName}
                    </span>
                    <span style={{ fontSize: 9, color: 'var(--text-muted)', flexShrink: 0 }}>vs</span>
                    <span style={{ fontSize: 11, color: 'var(--text-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {m.teamBShortName || m.teamBName}
                    </span>
                    {m.teamBLogo
                      ? <img src={resolveImageUrl(m.teamBLogo)} alt="" style={{ width: 18, height: 18, objectFit: 'contain', borderRadius: 3, background: '#111', flexShrink: 0 }} />
                      : <div style={{ width: 18, height: 18, borderRadius: 3, background: m.teamBColor, flexShrink: 0 }} />}
                  </div>
                  {/* Round/stage — for a Cup/Plate/Bowl/Shield tournament this
                      is where the tier shows (e.g. "Cup · Quarterfinal 1"),
                      otherwise there was no way to tell which fixture is
                      which beyond the two team names. */}
                  {m.round && (
                    <span style={{ fontSize: 9, color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {m.round}
                    </span>
                  )}
                </div>
                <button
                  title="Delete scheduled match"
                  onClick={e => { e.stopPropagation(); deleteMatch(m.id); }}
                  style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', fontSize: 13, padding: '0 2px', flexShrink: 0 }}
                >×</button>
              </div>
            ))
          )}
        </div>,
        document.body
      )}
    </>
  );
}
