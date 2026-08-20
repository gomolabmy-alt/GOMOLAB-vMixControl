import { useContext, useEffect, useRef } from 'react';
import { ArrowUp, Eye, EyeOff } from 'lucide-react';
import { useCanvasStore } from '../../stores/canvasStore';
import { useVmixStore } from '../../stores/vmixStore';
import { useTeamDbStore } from '../../stores/teamDbStore';
import { useMatchResultsStore } from '../../stores/matchResultsStore';
import { CanvasActionContext } from '../../lib/canvasContext';
import { findTeamRecord } from '../../lib/teamForm';
import { resolveImageUrl, transparentLogoUrl } from '../../lib/imageUrl';
import { getPlayerMatchHistory, summarizeActions } from '../../lib/localPlayerStats';
import { autoLinkedWidget } from '../../lib/autoLink';
import { useAppSettings } from '../../stores/appSettingsStore';
import { simplifyPlayerName } from '../../lib/simpleName';

interface Props {
  widgetId: string;
  config: Record<string, any>;
  w: number;
  h: number;
}

const STAT_FIELDS: { key: 'tries' | 'conversions' | 'penalties' | 'dropGoals' | 'yellowCards' | 'redCards' | 'appearances'; label: string }[] = [
  { key: 'appearances', label: 'Appearances' },
  { key: 'tries', label: 'Tries' },
  { key: 'conversions', label: 'Conversions' },
  { key: 'penalties', label: 'Penalties' },
  { key: 'dropGoals', label: 'Drop Goals' },
  { key: 'yellowCards', label: 'Yellow Cards' },
  { key: 'redCards', label: 'Red Cards' },
];

// vMix merge composer (WidgetConfigPanel's 'player-stats' case) — resolves
// one named piece of the player/team's own data, same values the
// individual per-field pushes below use.
type PlayerStatsMergeKey = 'name' | 'jersey' | 'position' | 'team' | typeof STAT_FIELDS[number]['key'];
function resolvePlayerStatsMergePart(player: any, teamName: string, key: PlayerStatsMergeKey, dispName: (n: string) => string): string {
  if (key === 'name') return dispName(player.name ?? '');
  if (key === 'jersey') return player.jerseyNo ?? '';
  if (key === 'position') return player.position ?? '';
  if (key === 'team') return teamName;
  return String(player[key] ?? 0);
}

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
  const { getClient, vmixState, overlayIn, overlayOut, vmixSyncVersion } = useVmixStore();
  const { teams } = useTeamDbStore();
  const { results } = useMatchResultsStore();
  const { simplifyMuhammadNames, simplifyFirstNameOnly, removeBinMarkers, truncateAtBinMarker } = useAppSettings();
  const disp = (name: string) => simplifyPlayerName(name, { simplifyMuhammad: simplifyMuhammadNames, firstNameOnly: simplifyFirstNameOnly, removeBinMarkers, truncateAtBinMarker });

  const allPages = [...pages, ...commentatorPages];
  // Falls back to the sole Scoreboard widget on this page when nothing's
  // been explicitly linked in settings — an explicit pick always wins.
  const linkedScoreboard = autoLinkedWidget(allPages, widgetId, config.linkedScoreboardId, 'scoreboard');
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
  // Also falls back to the page's own tournament (same convention as
  // Scoreboard/Timer/Player List) when the linked scoreboard hasn't set one
  // either.
  const pageTournamentId = allPages.find(p => p.widgets.some(w => w.id === widgetId))?.tournamentId;
  const tournamentId: string | undefined = dc.linkedTournamentId || pageTournamentId;

  const teamRecord = findTeamRecord(teams, teamName, category, tournamentId);
  const player = teamRecord?.players.find(p => p.id === config.playerId);
  // Every saved match this player actually scored in, newest first — pulled
  // straight from this team's saved match history (see localPlayerStats.ts),
  // same data source as the "Counted by this app" stats option, but shown
  // as a per-match log here regardless of which stats source the team uses.
  const history = (player && teamRecord) ? getPlayerMatchHistory(player, teamRecord, results) : [];

  const sendToVmix = () => {
    const c = getClient();
    if (!c || !config.vmixInputKey || !player) return;
    const key = config.vmixInputKey;
    const set = (field: string | undefined, value: string | number | undefined) => {
      if (field && value !== undefined && value !== '') c.setTextField(key, field, String(value));
    };
    set(config.fieldName, disp(player.name));
    set(config.fieldJersey, player.jerseyNo);
    set(config.fieldPosition, player.position);
    set(config.fieldTeam, teamName);
    // Raw stored URL, not resolveImageUrl(teamLogo) — that substitution is
    // only for this app's own webview to reach the local image server;
    // vMix fetches the image itself and needs the real LAN-reachable address.
    if (config.fieldTeamLogo) c.setImageField(key, config.fieldTeamLogo, teamLogo || transparentLogoUrl());
    for (const f of STAT_FIELDS) set(config[`field${f.key.charAt(0).toUpperCase()}${f.key.slice(1)}`], player[f.key]);
    if (config.mergedPrefix && config.mergedParts?.length) {
      set(config.mergedPrefix, config.mergedParts.map((k: PlayerStatsMergeKey) => resolvePlayerStatsMergePart(player, teamName, k, disp)).join(config.mergedSeparator ?? ' '));
    }
  };

  const dataKey = player ? [player.id, teamName, teamLogo, ...STAT_FIELDS.map(f => player[f.key])].join(',') : '';
  const prevKeyRef = useRef('');
  useEffect(() => {
    if (!player || !config.vmixInputKey || !config.vmixAutoSync) return;
    if (dataKey === prevKeyRef.current && vmixSyncVersion === 0) return;
    prevKeyRef.current = dataKey;
    sendToVmix();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dataKey, vmixSyncVersion, config.vmixAutoSync]);

  if (!linkedScoreboard) {
    return <div className="wgt-p-stats"><div className="wgt-p-stats-empty">Link a scoreboard in settings</div></div>;
  }

  const ch = config.overlayChannel ?? 1;
  const overlay = vmixState?.overlays?.find((o: any) => o.number === ch);
  const overlayActive = !!(overlay && overlay.key !== '');

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
          {(teamRecord?.players ?? []).map(p => <option key={p.id} value={p.id}>{`#${p.jerseyNo || '—'} `}{disp(p.name)}</option>)}
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
                <span className="wgt-p-stats-jersey">#{player.jerseyNo || '—'}</span> {disp(player.name)}
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
              <div key={f.key} className={`wgt-p-stats-stat${f.key === 'tries' ? ' wgt-p-stats-stat--tries' : ''}`}>
                <span className="wgt-p-stats-stat-val">{player[f.key] ?? 0}</span>
                <span className="wgt-p-stats-stat-label">{f.label}</span>
              </div>
            ))}
          </div>
          {history.length > 0 && (
            <div className="wgt-p-stats-history">
              <div className="wgt-p-stats-history-hdr">Match History</div>
              <div className="wgt-p-stats-history-list">
                {history.map(h => (
                  <div key={h.resultId} className="wgt-p-stats-history-row">
                    <span className="wgt-p-stats-history-date">{h.date}</span>
                    <span className="wgt-p-stats-history-opp">vs {h.opponent}</span>
                    <span className="wgt-p-stats-history-pts">{h.totalPoints}pt</span>
                    <span className="wgt-p-stats-history-detail">{summarizeActions(h.actions)}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
          {config.vmixInputKey && (
            <div className="wgt-p-stats-actions">
              <button className="wgt-p-stats-send-btn" onClick={sendToVmix} disabled={!getClient()} title="Send this player's data to vMix now">
                <ArrowUp size={12} strokeWidth={2} /> Send
              </button>
              <button
                className={`wgt-p-stats-send-btn${overlayActive ? ' wgt-p-stats-send-btn--active' : ''}`}
                onClick={() => overlayIn(ch, config.vmixInputKey)}
                disabled={!vmixState}
                title="Show overlay"
              ><Eye size={12} strokeWidth={2} /> Show</button>
              <button
                className={`wgt-p-stats-send-btn${!overlayActive ? ' wgt-p-stats-send-btn--active' : ''}`}
                onClick={() => overlayOut(ch)}
                disabled={!vmixState}
                title="Hide overlay"
              ><EyeOff size={12} strokeWidth={2} /> Hide</button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
