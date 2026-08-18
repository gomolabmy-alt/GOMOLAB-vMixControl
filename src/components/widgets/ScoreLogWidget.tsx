import { useEffect, useRef, useState, useContext } from 'react';
import { ArrowUp, Star } from 'lucide-react';
import { useCanvasStore } from '../../stores/canvasStore';
import { CanvasActionContext } from '../../lib/canvasContext';
import { useVmixStore } from '../../stores/vmixStore';
import { useTeamDbStore } from '../../stores/teamDbStore';
import { useAppSettings } from '../../stores/appSettingsStore';
import { useUndoStore } from '../../stores/undoStore';
import { buildActionSummary } from '../../utils/scoreActions';
import { autoLinkedWidget, autoLinkedWidgetId, autoLinkedWidgetPair } from '../../lib/autoLink';
import { resolvePlayerListRoster } from '../../lib/playerListSquad';
import { simplifyPlayerName, type SimpleNameOptions } from '../../lib/simpleName';

interface Props {
  widgetId: string;
  config: Record<string, any>;
  w: number;
  h: number;
}

interface LogEntry {
  id: string;
  timeStr: string;
  team: 'A' | 'B';
  teamName: string;
  scorer: string;
  jerseyNo: string;
  action: string;
  points: number;
}

interface SummaryRow {
  jerseyNo: string;
  scorer: string;
  team: 'A' | 'B';
  line: string;
  summary: string; // just the action counts part, e.g. "3 Try, 1 Conv"
}

// `scorer` stays the raw name (used elsewhere to match against the roster
// by exact name — see highlightPlayer's p.name === row.scorer lookup);
// only the display/vMix-facing `line` text goes through Simple Names.
function buildSummaryRows(log: LogEntry[], simpleNameOpts: SimpleNameOptions): SummaryRow[] {
  const players: Record<string, {
    jerseyNo: string;
    scorer: string;
    team: 'A' | 'B';
    actions: Record<string, { count: number }>;
  }> = {};

  for (const entry of log) {
    if (!entry.scorer && !entry.jerseyNo) continue;
    const key = `${entry.jerseyNo}|${entry.scorer}`;
    if (!players[key]) {
      players[key] = { jerseyNo: entry.jerseyNo, scorer: entry.scorer, team: entry.team, actions: {} };
    }
    if (!players[key].actions[entry.action]) players[key].actions[entry.action] = { count: 0 };
    players[key].actions[entry.action].count++;
  }

  return Object.values(players).map(p => {
    const name = [p.jerseyNo, p.scorer ? simplifyPlayerName(p.scorer, simpleNameOpts) : ''].filter(Boolean).join(' ');
    const actCounts: Record<string, number> = {};
    for (const [act, { count }] of Object.entries(p.actions)) actCounts[act] = count;
    const acts = buildActionSummary(actCounts);
    return { jerseyNo: p.jerseyNo, scorer: p.scorer, team: p.team, summary: acts, line: `${name}: ${acts}` };
  });
}

export function ScoreLogWidget({ widgetId, config }: Props) {
  const store = useCanvasStore();
  const ctx = useContext(CanvasActionContext);
  const { pages } = store;
  const updateWidgetConfig = ctx?.updateWidgetConfig ?? store.updateWidgetConfig;
  const { getClient, vmixSyncVersion } = useVmixStore();
  const { teams: teamDbTeams } = useTeamDbStore();
  const { simplifyMuhammadNames, simplifyFirstNameOnly, removeBinMarkers, truncateAtBinMarker } = useAppSettings();
  const simpleNameOpts: SimpleNameOptions = { simplifyMuhammad: simplifyMuhammadNames, firstNameOnly: simplifyFirstNameOnly, removeBinMarkers, truncateAtBinMarker };
  const disp = (name: string) => simplifyPlayerName(name, simpleNameOpts);
  const [activeHighlightKey, setActiveHighlightKey] = useState('');

  const allWidgets = pages.flatMap(p => p.widgets);
  // Falls back to the sole Scoreboard widget on this page when nothing's
  // been explicitly linked in settings — an explicit pick always wins.
  const linkedScoreboard = autoLinkedWidget(pages, widgetId, config.linkedScoreboardId, 'scoreboard');
  const log: LogEntry[] = linkedScoreboard?.config.scoreLog ?? [];

  const teamFilter: 'A' | 'all' | 'B' = config.teamFilter ?? 'all';
  const filteredLog = teamFilter === 'all' ? log : log.filter(e => e.team === teamFilter);

  const teamAColor = linkedScoreboard?.config.teamAColor ?? '#e74c3c';
  const teamBColor = linkedScoreboard?.config.teamBColor ?? '#3498db';
  const teamAShort = linkedScoreboard?.config.teamAShortName || linkedScoreboard?.config.teamAName || 'A';
  const teamBShort = linkedScoreboard?.config.teamBShortName || linkedScoreboard?.config.teamBName || 'B';
  const dotColor = teamFilter === 'A' ? teamAColor : teamFilter === 'B' ? teamBColor : undefined;

  const clearLog = () => {
    if (!linkedScoreboard) return;
    const before = log;
    updateWidgetConfig(linkedScoreboard.id, { scoreLog: [] });
    useUndoStore.getState().pushUndo('Cleared score log', () => updateWidgetConfig(linkedScoreboard.id, { scoreLog: before }));
  };

  // vMix summary output
  const hasSummaryTarget = !!(config.vmixSummaryInputKey && config.vmixSummaryField);
  const summaryRows = filteredLog.length > 0 ? buildSummaryRows(filteredLog, simpleNameOpts) : [];

  const sendSummary = () => {
    const c = getClient();
    if (!c || !config.vmixSummaryInputKey || !config.vmixSummaryField) return;
    c.setTextField(config.vmixSummaryInputKey, config.vmixSummaryField, summaryRows.map(r => r.line).join(' | '));
  };

  const prevLogKeyRef = useRef('');
  const logKey = filteredLog.map(e => e.id).join(',');
  useEffect(() => {
    if (!hasSummaryTarget) return;
    if (logKey === prevLogKeyRef.current && vmixSyncVersion === 0) return;
    prevLogKeyRef.current = logKey;
    sendSummary();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [logKey, hasSummaryTarget, vmixSyncVersion]);

  // Player highlight — falls back to the sole Player Highlight widget on
  // this page when nothing's been explicitly linked in settings.
  const highlightTargetId: string = autoLinkedWidgetId(pages, widgetId, config.linkedPlayerHighlightId, 'player-lower-third') ?? '';

  const highlightPlayer = (row: SummaryRow) => {
    if (!highlightTargetId) return;
    const sbCfg = linkedScoreboard?.config ?? {};
    // Resolved the same way the scoreboard itself would (explicit link, or
    // the two Player List widgets on its page assigned by teamSide/position).
    const { a: plA, b: plB } = linkedScoreboard
      ? autoLinkedWidgetPair(pages, linkedScoreboard.id, sbCfg.linkedPlayerListA, sbCfg.linkedPlayerListB, 'player-list')
      : {};
    const plWidget = row.team === 'A' ? plA : plB;
    const side: 'A' | 'B' = row.team;
    const { team: teamData } = resolvePlayerListRoster(plWidget, side, teamDbTeams);
    const player = teamData?.players?.find(
      (p: any) => (row.jerseyNo && p.jerseyNo === row.jerseyNo) || (row.scorer && p.name === row.scorer)
    );
    const rowId = `${row.jerseyNo}|${row.scorer}`;
    setActiveHighlightKey(rowId);
    updateWidgetConfig(highlightTargetId, {
      highlightedPlayerId:    player?.id ?? rowId,
      highlightedName:        disp(player?.name ?? row.scorer),
      highlightedJersey:      player?.jerseyNo ?? row.jerseyNo,
      highlightedPosition:    player?.position ?? '',
      highlightedTeam:        teamData?.name ?? row.scorer,
      highlightedTeamColor:   teamData?.color ?? (row.team === 'A' ? teamAColor : teamBColor),
      highlightedSide:        side,
      highlightedScoreSummary: row.summary,
    });
  };

  return (
    <div className="wgt-score-log-widget">
      <div className="wgt-score-log">
        <div className="wgt-score-log-header">
          {dotColor && <span className="wgt-score-log-team-dot" style={{ background: dotColor }} />}
          <div style={{ display: 'flex', gap: 4, marginLeft: 'auto' }}>
            {hasSummaryTarget && (
              <button
                className="wgt-score-log-clr"
                style={{ color: 'var(--accent)', display: 'inline-flex', alignItems: 'center', gap: 3 }}
                onClick={sendSummary}
                disabled={!getClient()}
                title="Send summary to vMix"
              ><ArrowUp size={11} strokeWidth={2} /> Send</button>
            )}
            {log.length > 0 && (
              <button className="wgt-score-log-clr" onClick={clearLog}>Clear</button>
            )}
          </div>
        </div>

        {summaryRows.length > 0 && (
          <div className="wgt-score-log-summary">
            {summaryRows.map((row, i) => {
              const rowId = `${row.jerseyNo}|${row.scorer}`;
              return (
                <div key={i} className="wgt-score-log-summary-row">
                  <span className="wgt-score-log-summary-dot"
                    style={{ background: row.team === 'A' ? teamAColor : teamBColor }} />
                  <span className="wgt-score-log-summary-text">{row.line}</span>
                  {highlightTargetId && (
                    <button
                      className={`wgt-score-log-summary-hl${activeHighlightKey === rowId ? ' wgt-score-log-summary-hl--active' : ''}`}
                      title="Highlight player"
                      onClick={() => highlightPlayer(row)}
                    ><Star size={11} strokeWidth={2} /></button>
                  )}
                </div>
              );
            })}
          </div>
        )}

        <div className="wgt-score-log-entries">
          {!linkedScoreboard && (
            <div className="wgt-score-log-empty">Link a scoreboard in settings</div>
          )}
          {linkedScoreboard && filteredLog.length === 0 && (
            <div className="wgt-score-log-empty">No scores yet</div>
          )}
          {filteredLog.map(entry => (
            <div key={entry.id} className="wgt-score-log-entry">
              <span className="wgt-score-log-dot"
                style={{ background: entry.team === 'A' ? teamAColor : teamBColor }} />
              <span className="wgt-score-log-time">{entry.timeStr}</span>
              <span className="wgt-score-log-text">
                {entry.team === 'A' ? teamAShort : teamBShort}
                {entry.scorer ? ` · ${entry.jerseyNo ? '#' + entry.jerseyNo + ' ' : ''}${disp(entry.scorer)}` : ''} — {entry.action}
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
