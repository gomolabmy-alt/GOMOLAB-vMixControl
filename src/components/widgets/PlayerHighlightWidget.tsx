import { useContext, useEffect, useRef } from 'react';
import { ArrowUp } from 'lucide-react';
import { useCanvasStore } from '../../stores/canvasStore';
import { useVmixStore } from '../../stores/vmixStore';
import { useTeamDbStore } from '../../stores/teamDbStore';
import { useMatchResultsStore } from '../../stores/matchResultsStore';
import { CanvasActionContext } from '../../lib/canvasContext';
import { findTeamRecord } from '../../lib/teamForm';
import { resolveImageUrl } from '../../lib/imageUrl';
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

// Quick-pick chips for the highlight title — a live, frequent choice (which
// award this is, this match), not a one-time setup step, so it's picked
// right on the widget itself. Purely a text field underneath (highlightTitle
// on config), same "preset chips + still fully free text" pattern as the
// Rundown tab's "+ Add Segment" presets — clicking a chip is no different
// from typing it by hand.
const TITLE_PRESETS = ['MVP', 'Best Player', 'Player of the Match', 'Man of the Match', 'Star of the Match'];

// vMix merge composer (WidgetConfigPanel's 'player-highlight' case).
type PlayerHighlightMergeKey = 'title' | 'name' | 'jersey' | 'position' | 'team' | typeof STAT_FIELDS[number]['key'];
function resolvePlayerHighlightMergePart(player: any, teamName: string, title: string, key: PlayerHighlightMergeKey, dispName: (n: string) => string): string {
  if (key === 'title') return title;
  if (key === 'name') return dispName(player.name ?? '');
  if (key === 'jersey') return player.jerseyNo ?? '';
  if (key === 'position') return player.position ?? '';
  if (key === 'team') return teamName;
  return String(player[key] ?? 0);
}

// One player, called out with a title badge (MVP, Best Player, Player of
// the Match, or whatever this event calls it) — same player-picker/stats
// shape as PlayerStatsWidget, plus the title itself. Which player and which
// title are both picked right here on the widget (not settings) — live,
// frequent operator choices, not one-time setup.
export function PlayerHighlightWidget({ widgetId, config }: Props) {
  const store = useCanvasStore();
  const ctx = useContext(CanvasActionContext);
  const updateWidgetConfig = ctx?.updateWidgetConfig ?? store.updateWidgetConfig;
  const { pages, commentatorPages } = store;
  const { getClient, vmixSyncVersion } = useVmixStore();
  const { teams } = useTeamDbStore();
  const { results } = useMatchResultsStore();
  const { simplifyMuhammadNames, simplifyFirstNameOnly, removeBinMarkers, truncateAtBinMarker } = useAppSettings();
  const disp = (name: string) => simplifyPlayerName(name, { simplifyMuhammad: simplifyMuhammadNames, firstNameOnly: simplifyFirstNameOnly, removeBinMarkers, truncateAtBinMarker });

  const allPages = [...pages, ...commentatorPages];
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
  const pageTournamentId = allPages.find(p => p.widgets.some(w => w.id === widgetId))?.tournamentId;
  const tournamentId: string | undefined = dc.linkedTournamentId || pageTournamentId;

  const teamRecord = findTeamRecord(teams, teamName, category, tournamentId);
  const player = teamRecord?.players.find(p => p.id === config.playerId);
  const history = (player && teamRecord) ? getPlayerMatchHistory(player, teamRecord, results) : [];

  const highlightTitle: string = config.highlightTitle ?? 'MVP';
  const customTitles: string[] = config.customTitles ?? [];
  const addCustomTitle = () => {
    const t = highlightTitle.trim();
    if (!t || TITLE_PRESETS.includes(t) || customTitles.includes(t)) return;
    updateWidgetConfig(widgetId, { customTitles: [...customTitles, t] });
  };
  const removeCustomTitle = (t: string) => updateWidgetConfig(widgetId, { customTitles: customTitles.filter(x => x !== t) });

  const sendToVmix = () => {
    const c = getClient();
    if (!c || !config.vmixInputKey || !player) return;
    const key = config.vmixInputKey;
    const set = (field: string | undefined, value: string | number | undefined) => {
      if (field && value !== undefined && value !== '') c.setTextField(key, field, String(value));
    };
    set(config.fieldTitle, highlightTitle);
    set(config.fieldName, disp(player.name));
    set(config.fieldJersey, player.jerseyNo);
    set(config.fieldPosition, player.position);
    set(config.fieldTeam, teamName);
    if (config.fieldTeamLogo && teamLogo) c.setImageField(key, config.fieldTeamLogo, teamLogo);
    for (const f of STAT_FIELDS) set(config[`field${f.key.charAt(0).toUpperCase()}${f.key.slice(1)}`], player[f.key]);
    if (config.mergedPrefix && config.mergedParts?.length) {
      set(config.mergedPrefix, config.mergedParts.map((k: PlayerHighlightMergeKey) => resolvePlayerHighlightMergePart(player, teamName, highlightTitle, k, disp)).join(config.mergedSeparator ?? ' '));
    }
  };

  const dataKey = player ? [player.id, teamName, teamLogo, highlightTitle, ...STAT_FIELDS.map(f => player[f.key])].join(',') : '';
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

  return (
    <div className="wgt-p-stats wgt-p-hl">
      <div className="wgt-p-hl-title-row">
        {TITLE_PRESETS.map(t => (
          <button
            key={t}
            className={`wgt-p-hl-title-chip${highlightTitle === t ? ' wgt-p-hl-title-chip--active' : ''}`}
            onClick={() => updateWidgetConfig(widgetId, { highlightTitle: t })}
          >{t}</button>
        ))}
        {customTitles.map(t => (
          <span key={t} className="wgt-p-hl-title-chip-wrap">
            <button
              className={`wgt-p-hl-title-chip${highlightTitle === t ? ' wgt-p-hl-title-chip--active' : ''}`}
              onClick={() => updateWidgetConfig(widgetId, { highlightTitle: t })}
            >{t}</button>
            <button className="wgt-p-hl-title-chip-x" onClick={() => removeCustomTitle(t)} title="Remove this saved title">×</button>
          </span>
        ))}
        <input
          className="wgt-p-hl-title-input"
          value={highlightTitle}
          placeholder="Custom title"
          onChange={e => updateWidgetConfig(widgetId, { highlightTitle: e.target.value })}
        />
        <button className="wgt-p-hl-title-add-btn" onClick={addCustomTitle} title="Save this title as a reusable chip">+</button>
      </div>
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
          <div className="wgt-p-hl-badge" style={{ '--tc': teamColor } as React.CSSProperties}>{highlightTitle}</div>
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
            <button className="wgt-p-stats-send-btn" onClick={sendToVmix} disabled={!getClient()} title="Send this player's highlight to vMix now">
              <ArrowUp size={12} strokeWidth={2} /> Send
            </button>
          )}
        </>
      )}
    </div>
  );
}
