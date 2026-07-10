import { useState, useRef, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { useTeamDbStore, type SavedTeam } from '../stores/teamDbStore';
import { resolveImageUrl } from '../lib/imageUrl';

interface Props {
  onPick: (team: Omit<SavedTeam, 'id'>) => void;
  /** Current widget values, offered as a one-click "save current as new team". */
  current: { name?: string; shortName?: string; color?: string; logo?: string };
}

// Compact popup listing saved teams — picking one fills name + short name +
// color + logo together in a single click, instead of typing each field.
//
// Rendered via a portal into document.body, positioned above its anchor
// button with fixed coordinates: the scoreboard widget's team column has
// overflow:hidden (for the logo/name layout), which would silently clip an
// absolutely-positioned popup nested inside it — a portal escapes that.
export function TeamPicker({ onPick, current }: Props) {
  const { teams, addTeam, deleteTeam } = useTeamDbStore();
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
      // Open upward, anchored just above the button, so it's never hidden
      // behind the scoreboard's own layout regardless of where it sits on screen.
      setPos({ left: r.left, bottom: window.innerHeight - r.top + 6 });
    }
    setOpen(v => !v);
  };

  const saveCurrent = () => {
    if (!current.name?.trim()) return;
    addTeam({
      name: current.name.trim(),
      shortName: current.shortName,
      color: current.color ?? '#3498db',
      logo: current.logo,
    });
  };

  return (
    <>
      <button
        ref={anchorRef}
        className="btn btn--ghost btn--small"
        title="Pick a saved team"
        onClick={(e) => { e.stopPropagation(); toggle(); }}
        style={{ fontSize: 12, padding: '2px 5px' }}
      >👥</button>
      {open && pos && createPortal(
        <div
          ref={popupRef}
          className="team-picker-popup"
          onClick={e => e.stopPropagation()}
          style={{
            position: 'fixed', left: pos.left, bottom: pos.bottom, zIndex: 10000,
            minWidth: 200, maxWidth: 260, maxHeight: 300, overflowY: 'auto',
            background: 'var(--bg-1)', border: '1px solid var(--border)',
            borderRadius: 6, boxShadow: '0 -4px 16px rgba(0,0,0,.5)',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            padding: '6px 8px', borderBottom: '1px solid var(--border)' }}>
            <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-secondary)' }}>Saved Teams</span>
            <button
              className="btn btn--ghost btn--small"
              onClick={saveCurrent}
              disabled={!current.name?.trim()}
              title="Save the current name/short name/color/logo as a new team"
              style={{ fontSize: 10, padding: '1px 6px' }}
            >+ Save current</button>
          </div>
          {teams.length === 0 ? (
            <div style={{ padding: '10px 12px', fontSize: 12, color: 'var(--text-muted)' }}>
              No saved teams yet — fill in a team then "+ Save current"
            </div>
          ) : (
            teams.map(t => (
              <div
                key={t.id}
                onClick={() => { onPick(t); setOpen(false); }}
                style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 8px',
                  cursor: 'pointer', borderBottom: '1px solid var(--border)' }}
                className="team-picker-item"
              >
                {t.logo
                  ? <img src={resolveImageUrl(t.logo)} alt="" style={{ width: 26, height: 20, objectFit: 'contain',
                      border: '1px solid var(--border)', borderRadius: 3, background: '#111', flexShrink: 0 }} />
                  : <div style={{ width: 26, height: 20, borderRadius: 3, background: t.color, flexShrink: 0 }} />
                }
                <span style={{ fontSize: 12, color: 'var(--text-secondary)', flex: 1, minWidth: 0,
                  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.name}</span>
                {t.shortName && <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>{t.shortName}</span>}
                <button
                  title="Delete saved team"
                  onClick={e => { e.stopPropagation(); deleteTeam(t.id); }}
                  style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', fontSize: 13, padding: '0 2px' }}
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
