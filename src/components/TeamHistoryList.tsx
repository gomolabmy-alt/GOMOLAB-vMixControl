import { useMemo } from 'react';
import { resolveImageUrl } from '../lib/imageUrl';
import { useMatchResultsStore } from '../stores/matchResultsStore';
import { useMatchScheduleStore } from '../stores/matchScheduleStore';

interface Props {
  teamName: string;
  teamShortName?: string;
  /** Tournament category (e.g. "Men", "Women") — used to disambiguate when
   *  the SAME team name is entered in more than one category, so
   *  history/upcoming only shows matches from the category actually being
   *  commentated on. */
  category?: string;
  /** Tournament this fixture belongs to — same disambiguation purpose, for
   *  a team name reused across different tournaments/competitions. */
  tournamentId?: string;
}

const norm = (s?: string) => (s ?? '').trim().toLowerCase();

// The "Upcoming" + "Results" list for a single team — extracted out of
// TeamMatchHistoryButton's popup so it can also be embedded directly (no
// click needed) in the Head-to-Head panel, side by side for both teams.
export function TeamHistoryList({ teamName, teamShortName, category, tournamentId }: Props) {
  const { results } = useMatchResultsStore();
  const { matches } = useMatchScheduleStore();

  const nameKey = norm(teamName);
  const shortKey = norm(teamShortName);
  // A result/fixture's category may only live in the `round` prefix ("Men ·
  // Quarterfinal 2") on data generated before the dedicated category field
  // existed.
  const effectiveCat = (c?: string, round?: string) => c ?? (round?.includes(' · ') ? round.split(' · ')[0] : undefined);
  // A club entering multiple categories (or the same team name reused across
  // tournaments) can legitimately share a name — only reject on an ACTUAL
  // conflicting category/tournament tag. A record with no category/tournament
  // info at all (legacy data, or a plain round with no "Category · " prefix)
  // stays a match — same "untagged = visible everywhere" convention used for
  // team disambiguation elsewhere in this app.
  const isThisTeam = (n?: string, s?: string, recCategory?: string, recRound?: string, recTournamentId?: string) => {
    if (!nameKey || !n) return false;
    const nameOk = norm(n) === nameKey || (!!shortKey && norm(s) === shortKey);
    if (!nameOk) return false;
    if (tournamentId && recTournamentId && recTournamentId !== tournamentId) return false;
    if (!category) return true;
    const recCat = effectiveCat(recCategory, recRound);
    return !recCat || recCat === category;
  };

  const ended = useMemo(() => {
    return results
      .map(r => {
        const side = isThisTeam(r.teamAName, r.teamAShortName, r.category, r.round, r.tournamentId) ? 'A' as const
          : isThisTeam(r.teamBName, r.teamBShortName, r.category, r.round, r.tournamentId) ? 'B' as const : null;
        return side ? { r, side } : null;
      })
      .filter((x): x is { r: typeof results[number]; side: 'A' | 'B' } => x !== null)
      .sort((a, b) => b.r.savedAt - a.r.savedAt);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [results, nameKey, shortKey, category, tournamentId]);

  const upcoming = useMemo(() => {
    return matches
      .filter(m => !m.completedAt)
      .map(m => {
        const side = isThisTeam(m.teamAName, m.teamAShortName, m.category, m.round, m.tournamentId) ? 'A' as const
          : isThisTeam(m.teamBName, m.teamBShortName, m.category, m.round, m.tournamentId) ? 'B' as const : null;
        return side ? { m, side } : null;
      })
      .filter((x): x is { m: typeof matches[number]; side: 'A' | 'B' } => x !== null)
      .sort((a, b) => (a.m.date || '').localeCompare(b.m.date || ''));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [matches, nameKey, shortKey, category, tournamentId]);

  return (
    <>
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
    </>
  );
}
