import { useEffect, useMemo, useRef } from 'react';
import { useCanvasStore } from '../../stores/canvasStore';
import { useVmixStore } from '../../stores/vmixStore';
import { useMatchResultsStore } from '../../stores/matchResultsStore';
import { useMatchScheduleStore } from '../../stores/matchScheduleStore';
import { mergeResultRows, mergeUpcomingRows, type ResultFormRow, type UpcomingFormRow } from '../../lib/teamForm';
import { TeamFormTable } from './TeamFormTable';

interface Props {
  widgetId: string;
  config: Record<string, any>;
  w: number;
  h: number;
}

function resultText(row: ResultFormRow, side: 'a' | 'b'): string | null {
  const entry = row[side];
  if (!entry) return null;
  const { r, side: s } = entry;
  const own = s === 'A' ? r.scoreA : r.scoreB;
  const opp = s === 'A' ? r.scoreB : r.scoreA;
  const oppName = s === 'A' ? (r.teamBShortName || r.teamBName) : (r.teamAShortName || r.teamAName);
  const outcome = own > opp ? 'W' : own < opp ? 'L' : 'D';
  return `${row.stage}: ${outcome} ${own}-${opp} v ${oppName}`;
}

function upcomingText(row: UpcomingFormRow, side: 'a' | 'b'): string | null {
  const entry = row[side];
  if (!entry) return null;
  const { m, side: s } = entry;
  const oppName = s === 'A' ? (m.teamBShortName || m.teamBName) : (m.teamAShortName || m.teamAName);
  return `${row.stage}: v ${oppName}${m.time ? ` (${m.time})` : ''}`;
}

// Round-aligned Form + Upcoming comparison for the two teams on a linked
// scoreboard, as its own standalone/positionable canvas widget — the same
// data HeadToHeadPanel already shows inline on the Scoreboard widget itself
// (via TeamFormTable, reused here unchanged), but addable independently and
// with its own vMix text-field output for a custom title template.
export function TeamFormWidget({ config }: Props) {
  const { pages, commentatorPages } = useCanvasStore();
  const { getClient, vmixSyncVersion } = useVmixStore();
  const { results } = useMatchResultsStore();
  const { matches } = useMatchScheduleStore();

  const allWidgets = useMemo(() => [...pages, ...commentatorPages].flatMap(p => p.widgets), [pages, commentatorPages]);
  const linkedScoreboard = allWidgets.find(w => w.id === config.linkedScoreboardId);
  const dc = linkedScoreboard?.config ?? {};

  const teamAName: string = dc.teamAName ?? 'Team A';
  const teamBName: string = dc.teamBName ?? 'Team B';
  const teamAShortName: string | undefined = dc.teamAShortName;
  const teamBShortName: string | undefined = dc.teamBShortName;
  const category: string | undefined = dc.category;
  const tournamentId: string | undefined = dc.linkedTournamentId;

  const resultRows = useMemo(
    () => mergeResultRows(results, { name: teamAName, shortName: teamAShortName }, { name: teamBName, shortName: teamBShortName }, category, tournamentId),
    [results, teamAName, teamAShortName, teamBName, teamBShortName, category, tournamentId]
  );
  const upcomingRows = useMemo(
    () => mergeUpcomingRows(matches, { name: teamAName, shortName: teamAShortName }, { name: teamBName, shortName: teamBShortName }, category, tournamentId),
    [matches, teamAName, teamAShortName, teamBName, teamBShortName, category, tournamentId]
  );

  const resultsAText = resultRows.map(r => resultText(r, 'a')).filter(Boolean).join(' | ');
  const resultsBText = resultRows.map(r => resultText(r, 'b')).filter(Boolean).join(' | ');
  const upcomingAText = upcomingRows.map(r => upcomingText(r, 'a')).filter(Boolean).join(' | ');
  const upcomingBText = upcomingRows.map(r => upcomingText(r, 'b')).filter(Boolean).join(' | ');

  const targets = [
    { inputKey: config.vmixResultsAInputKey, field: config.vmixResultsAField, text: resultsAText },
    { inputKey: config.vmixUpcomingAInputKey, field: config.vmixUpcomingAField, text: upcomingAText },
    { inputKey: config.vmixResultsBInputKey, field: config.vmixResultsBField, text: resultsBText },
    { inputKey: config.vmixUpcomingBInputKey, field: config.vmixUpcomingBField, text: upcomingBText },
  ];
  const hasAnyTarget = targets.some(t => t.inputKey && t.field);

  const sendAll = () => {
    const c = getClient();
    if (!c) return;
    for (const t of targets) {
      if (t.inputKey && t.field) c.setTextField(t.inputKey, t.field, t.text);
    }
  };

  const dataKey = targets.map(t => t.text).join('');
  const prevKeyRef = useRef('');
  useEffect(() => {
    if (!hasAnyTarget) return;
    if (dataKey === prevKeyRef.current && vmixSyncVersion === 0) return;
    prevKeyRef.current = dataKey;
    sendAll();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dataKey, hasAnyTarget, vmixSyncVersion]);

  return (
    <div className="wgt-team-form">
      {(config.linkedScoreboardId || hasAnyTarget) && (
        <div className="wgt-team-form-header">
          {hasAnyTarget && (
            <button className="wgt-team-form-send-btn" onClick={sendAll} disabled={!getClient()} title="Send all four fields to vMix now">
              ↑ Send
            </button>
          )}
        </div>
      )}
      {!config.linkedScoreboardId ? (
        <div className="wgt-team-form-empty">Link a scoreboard in settings</div>
      ) : (
        <TeamFormTable
          teamAName={teamAName} teamAShortName={teamAShortName}
          teamBName={teamBName} teamBShortName={teamBShortName}
          category={category} tournamentId={tournamentId}
        />
      )}
    </div>
  );
}
