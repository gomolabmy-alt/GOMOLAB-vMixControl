import { useMemo } from 'react';
import { resolveImageUrl } from '../../lib/imageUrl';
import { useMatchResultsStore } from '../../stores/matchResultsStore';
import { useMatchScheduleStore } from '../../stores/matchScheduleStore';
import { mergeResultRows, mergeUpcomingRows, type ResultFormRow, type UpcomingFormRow } from '../../lib/teamForm';

interface Props {
  teamAName: string;
  teamAShortName?: string;
  teamBName: string;
  teamBShortName?: string;
  category?: string;
  tournamentId?: string;
}

function oppLogoEl(logo: string | undefined, color: string) {
  return logo
    ? <img className="wgt-h2h-form-opp-logo" src={resolveImageUrl(logo)} alt="" />
    : <span className="wgt-h2h-form-opp-logo wgt-h2h-form-opp-logo--ph" style={{ background: color }} />;
}

function resultCell(entry: ResultFormRow['a']) {
  if (!entry) return null;
  const { r, side } = entry;
  const own = side === 'A' ? r.scoreA : r.scoreB;
  const opp = side === 'A' ? r.scoreB : r.scoreA;
  const oppName = side === 'A' ? (r.teamBShortName || r.teamBName) : (r.teamAShortName || r.teamAName);
  const oppLogo = side === 'A' ? r.teamBLogo : r.teamALogo;
  const oppColor = side === 'A' ? r.teamBColor : r.teamAColor;
  const outcome = own > opp ? 'W' : own < opp ? 'L' : 'D';
  return (
    <>
      <span className={`wgt-h2h-form-outcome wgt-h2h-form-outcome--${outcome}`}>{outcome}</span>
      <span className="wgt-h2h-form-score">{own}-{opp}</span>
      {oppLogoEl(oppLogo, oppColor)}
      <span className="wgt-h2h-form-opp">{oppName}</span>
    </>
  );
}

function upcomingCell(entry: UpcomingFormRow['a']) {
  if (!entry) return null;
  const { m, side } = entry;
  const oppName = side === 'A' ? (m.teamBShortName || m.teamBName) : (m.teamAShortName || m.teamAName);
  const oppLogo = side === 'A' ? m.teamBLogo : m.teamALogo;
  const oppColor = side === 'A' ? m.teamBColor : m.teamAColor;
  return (
    <>
      <span className="wgt-h2h-form-time">{m.time || '—'}</span>
      {oppLogoEl(oppLogo, oppColor)}
      <span className="wgt-h2h-form-opp">v {oppName}</span>
    </>
  );
}

// Round-aligned Upcoming + Results comparison for the two teams currently
// loaded on the scoreboard — one row per stage ("Round 1", "Quarterfinal 2",
// etc.), each team's own match for that stage shown side by side, blank when
// a team has no match recorded for it. Distinct from TeamHistoryList (used
// by the logo-click popup), which shows one team's own chronological list.
export function TeamFormTable({ teamAName, teamAShortName, teamBName, teamBShortName, category, tournamentId }: Props) {
  const { results } = useMatchResultsStore();
  const { matches } = useMatchScheduleStore();

  const upcomingRows = useMemo(
    () => mergeUpcomingRows(matches, { name: teamAName, shortName: teamAShortName }, { name: teamBName, shortName: teamBShortName }, category, tournamentId),
    [matches, teamAName, teamAShortName, teamBName, teamBShortName, category, tournamentId]
  );
  const resultRows = useMemo(
    () => mergeResultRows(results, { name: teamAName, shortName: teamAShortName }, { name: teamBName, shortName: teamBShortName }, category, tournamentId),
    [results, teamAName, teamAShortName, teamBName, teamBShortName, category, tournamentId]
  );

  return (
    <>
      {upcomingRows.length > 0 && (
        <table className="wgt-h2h-form-table">
          <thead><tr className="wgt-h2h-group-row"><td colSpan={3}>Upcoming</td></tr></thead>
          <tbody>
            {upcomingRows.map(row => (
              <tr key={row.stage} className="wgt-h2h-form-tr">
                <td className="wgt-h2h-form-cell wgt-h2h-form-cell--a">{upcomingCell(row.a)}</td>
                <td className="wgt-h2h-form-stage">{row.stage}</td>
                <td className="wgt-h2h-form-cell wgt-h2h-form-cell--b">{upcomingCell(row.b)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <table className="wgt-h2h-form-table">
        <thead><tr className="wgt-h2h-group-row"><td colSpan={3}>Results</td></tr></thead>
        <tbody>
          {resultRows.length === 0 ? (
            <tr><td colSpan={3} className="wgt-h2h-empty">No finished matches yet</td></tr>
          ) : resultRows.map(row => (
            <tr key={row.stage} className="wgt-h2h-form-tr">
              <td className="wgt-h2h-form-cell wgt-h2h-form-cell--a">{resultCell(row.a)}</td>
              <td className="wgt-h2h-form-stage">{row.stage}</td>
              <td className="wgt-h2h-form-cell wgt-h2h-form-cell--b">{resultCell(row.b)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}
