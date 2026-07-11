import { useState, useRef, useEffect, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { resolveImageUrl } from '../lib/imageUrl';
import { useMatchResultsStore } from '../stores/matchResultsStore';
import { useMatchScheduleStore } from '../stores/matchScheduleStore';

interface Props {
  teamName: string;
  teamShortName?: string;
  logo?: string;
  color: string;
}

const norm = (s?: string) => (s ?? '').trim().toLowerCase();

// Wraps a scoreboard's team logo (used on the commentator canvas, where the
// scoreboard is a read-only mirror) so clicking it surfaces that team's full
// match history — finished results and anything still upcoming — without
// needing to open the Tournament Database.
//
// Portal-based for the same reason as TeamPicker/MatchSchedulePicker: the
// scoreboard's team column has overflow:hidden, which would clip a nested
// absolutely-positioned popup.
export function TeamMatchHistoryButton({ teamName, teamShortName, logo, color }: Props) {
  const { results } = useMatchResultsStore();
  const { matches } = useMatchScheduleStore();
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

  const nameKey = norm(teamName);
  const shortKey = norm(teamShortName);
  const isThisTeam = (n?: string, s?: string) =>
    !!nameKey && (norm(n) === nameKey || (!!shortKey && norm(s) === shortKey));

  const ended = useMemo(() => {
    return results
      .map(r => {
        const side = isThisTeam(r.teamAName, r.teamAShortName) ? 'A' as const
          : isThisTeam(r.teamBName, r.teamBShortName) ? 'B' as const : null;
        return side ? { r, side } : null;
      })
      .filter((x): x is { r: typeof results[number]; side: 'A' | 'B' } => x !== null)
      .sort((a, b) => b.r.savedAt - a.r.savedAt);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [results, nameKey, shortKey]);

  const upcoming = useMemo(() => {
    return matches
      .filter(m => !m.completedAt)
      .map(m => {
        const side = isThisTeam(m.teamAName, m.teamAShortName) ? 'A' as const
          : isThisTeam(m.teamBName, m.teamBShortName) ? 'B' as const : null;
        return side ? { m, side } : null;
      })
      .filter((x): x is { m: typeof matches[number]; side: 'A' | 'B' } => x !== null)
      .sort((a, b) => (a.m.date || '').localeCompare(b.m.date || ''));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [matches, nameKey, shortKey]);

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
        className="wgt-score-logo-hist-btn"
        title={`${teamName} — match history`}
        onClick={e => { e.stopPropagation(); toggle(); }}
      >
        {logo
          ? <img className="wgt-score-mlogo" src={resolveImageUrl(logo)} alt="" />
          : <div className="wgt-score-mlogo-ph" style={{ background: color }} />}
      </button>
      {open && pos && createPortal(
        <div
          ref={popupRef}
          className="team-hist-popup"
          onClick={e => e.stopPropagation()}
          style={{ position: 'fixed', left: pos.left, top: pos.top, zIndex: 10000 }}
        >
          <div className="team-hist-title">
            {logo
              ? <img className="team-hist-title-logo" src={resolveImageUrl(logo)} alt="" />
              : <div className="team-hist-title-logo team-hist-title-logo--ph" style={{ background: color }} />}
            {teamName}
          </div>

          {upcoming.length > 0 && (
            <div className="team-hist-section">
              <div className="team-hist-section-label">Upcoming</div>
              {upcoming.map(({ m, side }) => {
                const oppLogo = side === 'A' ? m.teamBLogo : m.teamALogo;
                const oppColor = side === 'A' ? m.teamBColor : m.teamAColor;
                const oppName = side === 'A' ? (m.teamBShortName || m.teamBName) : (m.teamAShortName || m.teamAName);
                return (
                  <div key={m.id} className="team-hist-row-wrap">
                    <div className="team-hist-row">
                      <span className="team-hist-date">{m.time || '—'}</span>
                      <span className="team-hist-vs">v</span>
                      {oppLogo
                        ? <img className="team-hist-opp-logo" src={resolveImageUrl(oppLogo)} alt="" />
                        : <div className="team-hist-opp-logo team-hist-opp-logo--ph" style={{ background: oppColor }} />}
                      <span className="team-hist-opp">{oppName}</span>
                      {m.matchType && <span className="team-hist-type-badge">{m.matchType === 'bye' ? 'BYE' : 'W/O'}</span>}
                      {m.competition && <span className="team-hist-comp">{m.competition}</span>}
                    </div>
                    {m.round && <div className="team-hist-round">{m.round}</div>}
                  </div>
                );
              })}
            </div>
          )}

          <div className="team-hist-section">
            <div className="team-hist-section-label">Results</div>
            {ended.length === 0 ? (
              <div className="team-hist-empty">No finished matches yet</div>
            ) : ended.map(({ r, side }) => {
              const own = side === 'A' ? r.scoreA : r.scoreB;
              const opp = side === 'A' ? r.scoreB : r.scoreA;
              const oppLogo = side === 'A' ? r.teamBLogo : r.teamALogo;
              const oppColor = side === 'A' ? r.teamBColor : r.teamAColor;
              const oppName = side === 'A' ? (r.teamBShortName || r.teamBName) : (r.teamAShortName || r.teamAName);
              const outcome = own > opp ? 'W' : own < opp ? 'L' : 'D';
              return (
                <div key={r.id} className="team-hist-row-wrap">
                  <div className="team-hist-row">
                    <span className={`team-hist-outcome team-hist-outcome--${outcome}`}>{outcome}</span>
                    <span className="team-hist-date">{r.time || '—'}</span>
                    <span className="team-hist-vs">v</span>
                    {oppLogo
                      ? <img className="team-hist-opp-logo" src={resolveImageUrl(oppLogo)} alt="" />
                      : <div className="team-hist-opp-logo team-hist-opp-logo--ph" style={{ background: oppColor }} />}
                    <span className="team-hist-opp">{oppName}</span>
                    {r.matchType && <span className="team-hist-type-badge">{r.matchType === 'bye' ? 'BYE' : 'W/O'}</span>}
                    <span className="team-hist-score">{own} - {opp}</span>
                  </div>
                  {r.round && <div className="team-hist-round">{r.round}</div>}
                </div>
              );
            })}
          </div>
        </div>,
        document.body
      )}
    </>
  );
}
