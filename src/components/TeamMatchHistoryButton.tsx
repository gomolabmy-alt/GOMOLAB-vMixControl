import { useState, useRef, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { resolveImageUrl } from '../lib/imageUrl';
import { TeamHistoryList } from './TeamHistoryList';

interface Props {
  teamName: string;
  teamShortName?: string;
  logo?: string;
  color: string;
  /** Tournament category (e.g. "Men", "Women") of the fixture currently
   *  loaded on this scoreboard — used to disambiguate when the SAME team
   *  name is entered in more than one category (a club entering both a
   *  Men's and Women's side, for instance), so history/upcoming only shows
   *  matches from the category actually being commentated on. */
  category?: string;
  /** Tournament this fixture belongs to — same disambiguation purpose, for
   *  a team name reused across different tournaments/competitions. */
  tournamentId?: string;
}

// Wraps a scoreboard's team logo (used on the commentator canvas, where the
// scoreboard is a read-only mirror) so clicking it surfaces that team's full
// match history — finished results and anything still upcoming — without
// needing to open the Tournament Database.
//
// Portal-based for the same reason as TeamPicker/MatchSchedulePicker: the
// scoreboard's team column has overflow:hidden, which would clip a nested
// absolutely-positioned popup.
export function TeamMatchHistoryButton({ teamName, teamShortName, logo, color, category, tournamentId }: Props) {
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

          <TeamHistoryList teamName={teamName} teamShortName={teamShortName} category={category} tournamentId={tournamentId} />
        </div>,
        document.body
      )}
    </>
  );
}
