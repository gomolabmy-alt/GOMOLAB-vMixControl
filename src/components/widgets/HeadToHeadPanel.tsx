import type { ReactNode } from 'react';
import type { HeadToHeadStats } from '../../lib/headToHead';
import type { TeamTournamentStats } from '../../lib/teamTournamentStats';
import { resolveImageUrl } from '../../lib/imageUrl';
import { TeamFormTable } from './TeamFormTable';

interface Props {
  stats: HeadToHeadStats;
  aTeamStats: TeamTournamentStats;
  bTeamStats: TeamTournamentStats;
  teamAName: string;
  teamBName: string;
  teamAShortName?: string;
  teamBShortName?: string;
  teamALogo?: string;
  teamBLogo?: string;
  teamAColor: string;
  teamBColor: string;
  category?: string;
  tournamentId?: string;
  /** The scoreboard's own configured point-type labels (e.g. "Try",
   *  "Conversion", "Drop Goal" for rugby; "+2"/"+3" for a plain point sport)
   *  — shown as breakdown rows even at zero, so the full set of scoring
   *  categories is always visible, not just whichever ones happen to have
   *  been used already. */
  pointTypeLabels?: string[];
  showRecord?: boolean;
  showMeetings?: boolean;
  maxMeetings?: number;
  showBreakdown?: boolean;
  showTeamStats?: boolean;
  showForm?: boolean;
}

function recordLine(stats: HeadToHeadStats, teamAName: string, teamBName: string): string {
  const { aWins, bWins, draws } = stats;
  if (aWins === 0 && bWins === 0 && draws === 0) return 'No previous meetings';
  const record = `${aWins}-${bWins}-${draws}`;
  if (aWins > bWins) return `${teamAName} lead ${record}`;
  if (bWins > aWins) return `${teamBName} lead ${record}`;
  return `Even ${record}`;
}

/** Merges two independently-keyed breakdown maps into aligned rows (a label
 *  present on only one side still gets a row, with 0 on the other) so both
 *  teams' numbers sit on the same line instead of two separately-sorted
 *  lists that may not line up. `order` (the board's configured point types)
 *  is listed first, even at 0-0, so the full set of scoring categories is
 *  always visible — any other label seen in the data but not in `order`
 *  (e.g. an old/renamed increment) is appended after, sorted by count. */
function mergeRows(a: Record<string, number>, b: Record<string, number>, order: string[] = []): { label: string; a: number; b: number }[] {
  const seen = new Set<string>();
  const rows: { label: string; a: number; b: number }[] = [];
  for (const label of order) {
    if (seen.has(label)) continue;
    seen.add(label);
    rows.push({ label, a: a[label] ?? 0, b: b[label] ?? 0 });
  }
  const leftover = new Set([...Object.keys(a), ...Object.keys(b)].filter(l => !seen.has(l)));
  const leftoverRows = Array.from(leftover)
    .map(label => ({ label, a: a[label] ?? 0, b: b[label] ?? 0 }))
    .sort((x, y) => (y.a + y.b) - (x.a + x.b));
  return [...rows, ...leftoverRows];
}

function GroupRow({ label }: { label: string }) {
  return (
    <tr className="wgt-h2h-group-row"><td colSpan={3}>{label}</td></tr>
  );
}

function StatRow({ label, aVal, bVal, aColor, bColor }: { label: string; aVal: ReactNode; bVal: ReactNode; aColor: string; bColor: string }) {
  return (
    <tr className="wgt-h2h-row">
      <td className="wgt-h2h-cell--a" style={{ color: aColor }}>{aVal}</td>
      <td className="wgt-h2h-cell--label">{label}</td>
      <td className="wgt-h2h-cell--b" style={{ color: bColor }}>{bVal}</td>
    </tr>
  );
}

export function HeadToHeadPanel({
  stats, aTeamStats, bTeamStats, teamAName, teamBName, teamAShortName, teamBShortName, teamALogo, teamBLogo, teamAColor, teamBColor,
  category, tournamentId, pointTypeLabels = [],
  showRecord = true, showMeetings = true, maxMeetings = 5, showBreakdown = true, showTeamStats = true, showForm = true,
}: Props) {
  const hasMeetings = stats.meetings.length > 0;
  const h2hRows = mergeRows(stats.aBreakdown, stats.bBreakdown, pointTypeLabels);
  const teamStatRows = mergeRows(aTeamStats.breakdown, bTeamStats.breakdown, pointTypeLabels);
  const showAnyH2H = showRecord || showMeetings || showBreakdown;
  const showH2HGroup = hasMeetings && (showRecord || showBreakdown);
  const showTable = showH2HGroup || showTeamStats;

  return (
    <div className="wgt-h2h">
      {showAnyH2H && !hasMeetings && (
        <div className="wgt-h2h-empty">No previous meetings</div>
      )}

      {hasMeetings && showRecord && (
        <div className="wgt-h2h-record">{recordLine(stats, teamAName, teamBName)}</div>
      )}

      {showTable && (
        <table className="wgt-h2h-table">
          <thead>
            <tr>
              <th style={{ color: teamAColor }}>
                <span className="wgt-h2h-table-team">
                  {teamALogo
                    ? <img className="wgt-h2h-table-logo" src={resolveImageUrl(teamALogo)} alt="" />
                    : <span className="wgt-h2h-table-logo wgt-h2h-table-logo--ph" style={{ background: teamAColor }} />}
                  {teamAName}
                </span>
              </th>
              <th />
              <th style={{ color: teamBColor }}>
                <span className="wgt-h2h-table-team">
                  {teamBLogo
                    ? <img className="wgt-h2h-table-logo" src={resolveImageUrl(teamBLogo)} alt="" />
                    : <span className="wgt-h2h-table-logo wgt-h2h-table-logo--ph" style={{ background: teamBColor }} />}
                  {teamBName}
                </span>
              </th>
            </tr>
          </thead>
          <tbody>
            {showH2HGroup && <GroupRow label="Head-to-Head" />}
            {hasMeetings && showRecord && (
              <StatRow label="Aggregate Score" aVal={stats.aTotalScore} bVal={stats.bTotalScore} aColor={teamAColor} bColor={teamBColor} />
            )}
            {hasMeetings && showBreakdown && h2hRows.map(row => (
              <StatRow key={`h2h-${row.label}`} label={row.label} aVal={row.a} bVal={row.b} aColor={teamAColor} bColor={teamBColor} />
            ))}

            {showTeamStats && <GroupRow label="This Tournament" />}
            {showTeamStats && (
              <>
                <StatRow label="Played" aVal={aTeamStats.played} bVal={bTeamStats.played} aColor={teamAColor} bColor={teamBColor} />
                <StatRow label="Points" aVal={aTeamStats.totalPoints} bVal={bTeamStats.totalPoints} aColor={teamAColor} bColor={teamBColor} />
                {teamStatRows.map(row => (
                  <StatRow key={`ts-${row.label}`} label={row.label} aVal={row.a} bVal={row.b} aColor={teamAColor} bColor={teamBColor} />
                ))}
                {(aTeamStats.cards.yellow + bTeamStats.cards.yellow) > 0 && (
                  <StatRow label="🟨 Yellow Cards" aVal={aTeamStats.cards.yellow} bVal={bTeamStats.cards.yellow} aColor={teamAColor} bColor={teamBColor} />
                )}
                {(aTeamStats.cards.orange + bTeamStats.cards.orange) > 0 && (
                  <StatRow label="🟧 Orange Cards" aVal={aTeamStats.cards.orange} bVal={bTeamStats.cards.orange} aColor={teamAColor} bColor={teamBColor} />
                )}
                {(aTeamStats.cards.red + bTeamStats.cards.red) > 0 && (
                  <StatRow label="🟥 Red Cards" aVal={aTeamStats.cards.red} bVal={bTeamStats.cards.red} aColor={teamAColor} bColor={teamBColor} />
                )}
              </>
            )}
          </tbody>
        </table>
      )}

      {hasMeetings && showMeetings && (
        <table className="wgt-h2h-meetings-table">
          <tbody>
            {stats.meetings.slice(0, maxMeetings).map(m => {
              const straight = m.teamAName.trim().toLowerCase() === teamAName.trim().toLowerCase();
              const aScore = straight ? m.scoreA : m.scoreB;
              const bScore = straight ? m.scoreB : m.scoreA;
              const badge = aScore > bScore ? 'W' : bScore > aScore ? 'L'
                : m.shootout ? ((straight ? m.shootout.winner === 'A' : m.shootout.winner === 'B') ? 'W' : 'L')
                : 'D';
              return (
                <tr key={m.id} className="wgt-h2h-meeting-tr">
                  <td className="wgt-h2h-meeting-date">{m.date}</td>
                  <td className="wgt-h2h-meeting-score">
                    <span style={{ color: teamAColor }}>{aScore}</span> – <span style={{ color: teamBColor }}>{bScore}</span>
                  </td>
                  <td className="wgt-h2h-meeting-badge-cell">
                    <span className={`wgt-h2h-meeting-badge wgt-h2h-meeting-badge--${badge}`}>{badge}</span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}

      {showForm && (
        <div className="wgt-h2h-form">
          <TeamFormTable
            teamAName={teamAName} teamAShortName={teamAShortName}
            teamBName={teamBName} teamBShortName={teamBShortName}
            category={category} tournamentId={tournamentId}
          />
        </div>
      )}
    </div>
  );
}
