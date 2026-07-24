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

// One player's own cumulative stats. Which player — unlike the linked
// scoreboard itself (a one-time wiring choice, set in settings) — is picked
// right here on the widget in two steps: Home/Away first, then the Player
// dropdown populates from that team's roster, since swapping which player
// is shown is a frequent, live operator action, not a setup step.
export function PlayerStatsWidget({ widgetId, config }: Props) {
  const store = useCanvasStore();
  const ctx = useContext(CanvasActionContext);
  const updateWidgetConfig = ctx?.updateWidgetConfig ?? store.updateWidgetConfig;
  const { pages, commentatorPages } = store;
  const { getClient, vmixSyncVersion } = useVmixStore();
  const { teams } = useTeamDbStore();

  const allWidgets = [...pages, ...commentatorPages].flatMap(p => p.widgets);
  const linkedScoreboard = allWidgets.find(w => w.id === config.linkedScoreboardId);
  const dc = linkedScoreboard?.config ?? {};
  const side: 'A' | 'B' = config.teamSide === 'B' ? 'B' : 'A';
  const teamAName: string = dc.teamAName ?? 'Team A';
  const teamBName: string = dc.teamBName ?? 'Team B';
  const teamAColor: string = dc.teamAColor ?? '#e74c3c';
  const teamBColor: string = dc.teamBColor ?? '#3498db';
  const teamName = side === 'A' ? teamAName : teamBName;
  const teamColor = side === 'A' ? teamAColor : teamBColor;
  const teamLogo: string | undefined = side === 'A' ? dc.teamALogo : dc.teamBLogo;
  const category: string | undefined = dc.category;
  const tournamentId: string | undefined = dc.linkedTournamentId;

  const teamRecord = findTeamRecord(teams, teamName, category, tournamentId);
  const player = teamRecord?.players.find(p => p.id === config.playerId);

  const sendToVmix = () => {
    const c = getClient();
    if (!c || !config.vmixInputKey || !player) return;
    const key = config.vmixInputKey;
    const set = (field: string | undefined, value: string | number | undefined) => {
      if (field && value !== undefined && value !== '') c.setTextField(key, field, String(value));
    };
    set(config.fieldName, player.name);
    set(config.fieldJersey, player.jerseyNo);
    set(config.fieldPosition, player.position);
    set(config.fieldTeam, teamName);
    for (const f of STAT_FIELDS) set(config[`field${f.key.charAt(0).toUpperCase()}${f.key.slice(1)}`], player[f.key]);
  };

  const dataKey = player ? [player.id, teamName, ...STAT_FIELDS.map(f => player[f.key])].join(',') : '';
  const prevKeyRef = useRef('');
  useEffect(() => {
    if (!player || !config.vmixInputKey) return;
    if (dataKey === prevKeyRef.current && vmixSyncVersion === 0) return;
    prevKeyRef.current = dataKey;
    sendToVmix();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dataKey, vmixSyncVersion]);

  if (!config.linkedScoreboardId) {
    return <div className="wgt-p-stats"><div className="wgt-p-stats-empty">Link a scoreboard in settings</div></div>;
  }

  return (
    <div className="wgt-p-stats">
      <div className="wgt-p-stats-pickers">
        <div className="team-side-picker">
          {(['A', 'B'] as const).map(t => (
            <button
              key={t}
              className={`team-side-btn ${side === t ? 'team-side-btn--active' : ''}`}
              style={{ '--tc': t === 'A' ? teamAColor : teamBColor } as React.CSSProperties}
              onClick={() => updateWidgetConfig(widgetId, { teamSide: t, playerId: '' })}
            >
              <span className="team-side-dot" style={{ background: t === 'A' ? teamAColor : teamBColor }} />
              {t === 'A' ? teamAName : teamBName}
            </button>
          ))}
        </div>
        <select className="wgt-p-stats-picker" value={config.playerId ?? ''}
          onChange={e => updateWidgetConfig(widgetId, { playerId: e.target.value })}>
          <option value="">— pick player —</option>
          {(teamRecord?.players ?? []).map(p => <option key={p.id} value={p.id}>{`#${p.jerseyNo || '—'} `}{p.name}</option>)}
        </select>
      </div>
      {!player ? (
        <div className="wgt-p-stats-empty">Pick a player above</div>
      ) : (
        <>
          <div className="wgt-p-stats-header" style={{ '--tc': teamColor } as React.CSSProperties}>
            {teamLogo
              ? <img className="wgt-p-stats-logo" src={resolveImageUrl(teamLogo)} alt="" />
              : <span className="wgt-p-stats-logo wgt-p-stats-logo--ph" style={{ background: teamColor }} />}
            <div className="wgt-p-stats-id">
              <div className="wgt-p-stats-name">
                <span className="wgt-p-stats-jersey">#{player.jerseyNo || '—'}</span> {player.name}
              </div>
              <div className="wgt-p-stats-sub">{teamName}{player.position ? ` · ${player.position}` : ''}</div>
            </div>
          </div>
          <div className="wgt-p-stats-grid">
            <div className="wgt-p-stats-stat">
              <span className="wgt-p-stats-stat-val">{player.jerseyNo || '—'}</span>
              <span className="wgt-p-stats-stat-label">Jersey No</span>
            </div>
            {STAT_FIELDS.map(f => (
              <div key={f.key} className="wgt-p-stats-stat">
                <span className="wgt-p-stats-stat-val">{player[f.key] ?? 0}</span>
                <span className="wgt-p-stats-stat-label">{f.label}</span>
              </div>
            ))}
          </div>
          {config.vmixInputKey && (
            <button className="wgt-p-stats-send-btn" onClick={sendToVmix} disabled={!getClient()} title="Send this player's data to vMix now">
              ↑ Send
            </button>
          )}
        </>
      )}
    </div>
  );
}
