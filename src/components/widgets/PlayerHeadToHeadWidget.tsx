import { useContext, useEffect, useRef } from 'react';
import { useCanvasStore } from '../../stores/canvasStore';
import { useVmixStore } from '../../stores/vmixStore';
import { useTeamDbStore } from '../../stores/teamDbStore';
import { CanvasActionContext } from '../../lib/canvasContext';
import { findTeamRecord } from '../../lib/teamForm';
import { resolveImageUrl } from '../../lib/imageUrl';

interface Props {
  widgetId: string;
  config: Record<string, any>;
  w: number;
  h: number;
}

const STAT_FIELDS: { key: 'tries' | 'conversions' | 'penalties' | 'dropGoals' | 'yellowCards' | 'redCards' | 'appearances'; label: string }[] = [
  { key: 'tries', label: 'Tries' },
  { key: 'conversions', label: 'Conversions' },
  { key: 'penalties', label: 'Penalties' },
  { key: 'dropGoals', label: 'Drop Goals' },
  { key: 'yellowCards', label: 'Yellow Cards' },
  { key: 'redCards', label: 'Red Cards' },
  { key: 'appearances', label: 'Appearances' },
];

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

// Head-to-head comparison of two individual players' cumulative stats (one
// per team on a linked scoreboard). Which two players — unlike the linked
// scoreboard itself (a one-time wiring choice, set in settings) — is picked
// right here on the widget, since swapping players is a frequent, live
// operator action, not a setup step.
export function PlayerHeadToHeadWidget({ widgetId, config }: Props) {
  const store = useCanvasStore();
  const ctx = useContext(CanvasActionContext);
  const updateWidgetConfig = ctx?.updateWidgetConfig ?? store.updateWidgetConfig;
  const { pages, commentatorPages } = store;
  const { getClient, vmixSyncVersion } = useVmixStore();
  const { teams } = useTeamDbStore();

  const allWidgets = [...pages, ...commentatorPages].flatMap(p => p.widgets);
  const linkedScoreboard = allWidgets.find(w => w.id === config.linkedScoreboardId);
  const dc = linkedScoreboard?.config ?? {};
  const teamAName: string = dc.teamAName ?? 'Team A';
  const teamBName: string = dc.teamBName ?? 'Team B';
  const teamAColor: string = dc.teamAColor ?? '#e74c3c';
  const teamBColor: string = dc.teamBColor ?? '#3498db';
  const category: string | undefined = dc.category;
  const tournamentId: string | undefined = dc.linkedTournamentId;

  const teamARecord = findTeamRecord(teams, teamAName, category, tournamentId);
  const teamBRecord = findTeamRecord(teams, teamBName, category, tournamentId);
  const playerA = teamARecord?.players.find(p => p.id === config.playerAId);
  const playerB = teamBRecord?.players.find(p => p.id === config.playerBId);
  const hasBoth = !!(playerA && playerB);

  const sendToVmix = () => {
    const c = getClient();
    if (!c || !config.vmixInputKey || !hasBoth) return;
    const key = config.vmixInputKey;
    const set = (field: string | undefined, value: string | number | undefined) => {
      if (field && value !== undefined && value !== '') c.setTextField(key, field, String(value));
    };
    set(config.fieldNameA, playerA!.name); set(config.fieldJerseyA, playerA!.jerseyNo); set(config.fieldPositionA, playerA!.position);
    set(config.fieldNameB, playerB!.name); set(config.fieldJerseyB, playerB!.jerseyNo); set(config.fieldPositionB, playerB!.position);
    for (const f of STAT_FIELDS) {
      set(config[`field${cap(f.key)}A`], playerA![f.key]);
      set(config[`field${cap(f.key)}B`], playerB![f.key]);
    }
  };

  const dataKey = hasBoth
    ? [playerA!.id, ...STAT_FIELDS.map(f => playerA![f.key]), playerB!.id, ...STAT_FIELDS.map(f => playerB![f.key])].join(',')
    : '';
  const prevKeyRef = useRef('');
  useEffect(() => {
    if (!hasBoth || !config.vmixInputKey) return;
    if (dataKey === prevKeyRef.current && vmixSyncVersion === 0) return;
    prevKeyRef.current = dataKey;
    sendToVmix();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dataKey, vmixSyncVersion]);

  if (!config.linkedScoreboardId) {
    return <div className="wgt-p-h2h"><div className="wgt-p-h2h-empty">Link a scoreboard in settings</div></div>;
  }

  return (
    <div className="wgt-p-h2h">
      <div className="wgt-p-h2h-pickers">
        <select className="wgt-p-h2h-picker" style={{ '--tc': teamAColor } as React.CSSProperties}
          value={config.playerAId ?? ''}
          onChange={e => updateWidgetConfig(widgetId, { playerAId: e.target.value })}>
          <option value="">{teamAName} — pick player</option>
          {(teamARecord?.players ?? []).map(p => <option key={p.id} value={p.id}>{`#${p.jerseyNo || '—'} `}{p.name}</option>)}
        </select>
        <select className="wgt-p-h2h-picker" style={{ '--tc': teamBColor } as React.CSSProperties}
          value={config.playerBId ?? ''}
          onChange={e => updateWidgetConfig(widgetId, { playerBId: e.target.value })}>
          <option value="">{teamBName} — pick player</option>
          {(teamBRecord?.players ?? []).map(p => <option key={p.id} value={p.id}>{`#${p.jerseyNo || '—'} `}{p.name}</option>)}
        </select>
      </div>
      {!hasBoth ? (
        <div className="wgt-p-h2h-empty">Pick a player for each side above</div>
      ) : (
        <>
          <table className="wgt-p-h2h-table">
            <thead>
              <tr>
                <th style={{ color: teamAColor }}>
                  {dc.teamALogo && <img className="wgt-p-h2h-logo" src={resolveImageUrl(dc.teamALogo)} alt="" />}
                  <div className="wgt-p-h2h-jersey">#{playerA!.jerseyNo || '—'}</div>
                  <div className="wgt-p-h2h-name">{playerA!.name}</div>
                  {playerA!.position && <div className="wgt-p-h2h-pos">{playerA!.position}</div>}
                </th>
                <th />
                <th style={{ color: teamBColor }}>
                  {dc.teamBLogo && <img className="wgt-p-h2h-logo" src={resolveImageUrl(dc.teamBLogo)} alt="" />}
                  <div className="wgt-p-h2h-jersey">#{playerB!.jerseyNo || '—'}</div>
                  <div className="wgt-p-h2h-name">{playerB!.name}</div>
                  {playerB!.position && <div className="wgt-p-h2h-pos">{playerB!.position}</div>}
                </th>
              </tr>
            </thead>
            <tbody>
              <tr className="wgt-p-h2h-row">
                <td className="wgt-p-h2h-cell--a" style={{ color: teamAColor }}>{playerA!.jerseyNo || '—'}</td>
                <td className="wgt-p-h2h-cell--label">Jersey No</td>
                <td className="wgt-p-h2h-cell--b" style={{ color: teamBColor }}>{playerB!.jerseyNo || '—'}</td>
              </tr>
              {STAT_FIELDS.map(f => (
                <tr key={f.key} className="wgt-p-h2h-row">
                  <td className="wgt-p-h2h-cell--a" style={{ color: teamAColor }}>{playerA![f.key] ?? 0}</td>
                  <td className="wgt-p-h2h-cell--label">{f.label}</td>
                  <td className="wgt-p-h2h-cell--b" style={{ color: teamBColor }}>{playerB![f.key] ?? 0}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {config.vmixInputKey && (
            <button className="wgt-p-h2h-send-btn" onClick={sendToVmix} disabled={!getClient()} title="Send both players' data to vMix now">
              ↑ Send
            </button>
          )}
        </>
      )}
    </div>
  );
}
