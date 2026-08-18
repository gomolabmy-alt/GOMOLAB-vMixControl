import { useContext, useEffect, useRef } from 'react';
import { ArrowUp, Eye, EyeOff } from 'lucide-react';
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

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

// vMix merge composer (WidgetConfigPanel's 'player-h2h' case) — resolves
// one named piece of a player's own data, same values the individual
// per-field pushes below use.
type PlayerMergeKey = 'name' | 'jersey' | 'position' | typeof STAT_FIELDS[number]['key'];
function resolvePlayerMergePart(p: any, key: PlayerMergeKey, dispName: (n: string) => string): string {
  if (key === 'name') return dispName(p.name ?? '');
  if (key === 'jersey') return p.jerseyNo ?? '';
  if (key === 'position') return p.position ?? '';
  return String(p[key] ?? 0);
}

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
  const teamAName: string = dc.teamAName ?? 'Team A';
  const teamBName: string = dc.teamBName ?? 'Team B';
  const teamAColor: string = dc.teamAColor ?? '#e74c3c';
  const teamBColor: string = dc.teamBColor ?? '#3498db';
  const category: string | undefined = dc.category;
  // Also falls back to the page's own tournament (same convention as
  // Scoreboard/Timer/Player List) when the linked scoreboard hasn't set one
  // either — so team lookups still scope correctly without every link in
  // the chain needing to be manually wired.
  const pageTournamentId = allPages.find(p => p.widgets.some(w => w.id === widgetId))?.tournamentId;
  const tournamentId: string | undefined = dc.linkedTournamentId || pageTournamentId;

  const teamARecord = findTeamRecord(teams, teamAName, category, tournamentId);
  const teamBRecord = findTeamRecord(teams, teamBName, category, tournamentId);
  const playerA = teamARecord?.players.find(p => p.id === config.playerAId);
  const playerB = teamBRecord?.players.find(p => p.id === config.playerBId);
  const hasBoth = !!(playerA && playerB);
  // Every saved match each player actually scored in, newest first (see
  // localPlayerStats.ts) — independent lists since the two players' own
  // match histories are against whichever opponents their own team played,
  // not necessarily each other.
  const historyA = (playerA && teamARecord) ? getPlayerMatchHistory(playerA, teamARecord, results) : [];
  const historyB = (playerB && teamBRecord) ? getPlayerMatchHistory(playerB, teamBRecord, results) : [];

  const sendToVmix = () => {
    const c = getClient();
    if (!c || !config.vmixInputKey || !hasBoth) return;
    const key = config.vmixInputKey;
    const set = (field: string | undefined, value: string | number | undefined) => {
      if (field && value !== undefined && value !== '') c.setTextField(key, field, String(value));
    };
    set(config.fieldNameA, disp(playerA!.name)); set(config.fieldJerseyA, playerA!.jerseyNo); set(config.fieldPositionA, playerA!.position);
    set(config.fieldNameB, disp(playerB!.name)); set(config.fieldJerseyB, playerB!.jerseyNo); set(config.fieldPositionB, playerB!.position);
    for (const f of STAT_FIELDS) {
      set(config[`field${cap(f.key)}A`], playerA![f.key]);
      set(config[`field${cap(f.key)}B`], playerB![f.key]);
    }
    if (config.fieldTeamLogoA && dc.teamALogo) c.setImageField(key, config.fieldTeamLogoA, dc.teamALogo);
    if (config.fieldTeamLogoB && dc.teamBLogo) c.setImageField(key, config.fieldTeamLogoB, dc.teamBLogo);
    if (config.mergedAPrefix && config.mergedAParts?.length) {
      set(config.mergedAPrefix, config.mergedAParts.map((k: PlayerMergeKey) => resolvePlayerMergePart(playerA, k, disp)).join(config.mergedASeparator ?? ' '));
    }
    if (config.mergedBPrefix && config.mergedBParts?.length) {
      set(config.mergedBPrefix, config.mergedBParts.map((k: PlayerMergeKey) => resolvePlayerMergePart(playerB, k, disp)).join(config.mergedBSeparator ?? ' '));
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

  if (!linkedScoreboard) {
    return <div className="wgt-p-h2h"><div className="wgt-p-h2h-empty">Link a scoreboard in settings</div></div>;
  }

  const ch = config.overlayChannel ?? 1;
  const overlay = vmixState?.overlays?.find((o: any) => o.number === ch);
  const overlayActive = !!(overlay && overlay.key !== '');

  return (
    <div className="wgt-p-h2h">
      <div className="wgt-p-h2h-pickers">
        <select className="wgt-p-h2h-picker" style={{ '--tc': teamAColor } as React.CSSProperties}
          value={config.playerAId ?? ''}
          onChange={e => updateWidgetConfig(widgetId, { playerAId: e.target.value })}>
          <option value="">{teamAName} — pick player</option>
          {(teamARecord?.players ?? []).map(p => <option key={p.id} value={p.id}>{`#${p.jerseyNo || '—'} `}{disp(p.name)}</option>)}
        </select>
        <select className="wgt-p-h2h-picker" style={{ '--tc': teamBColor } as React.CSSProperties}
          value={config.playerBId ?? ''}
          onChange={e => updateWidgetConfig(widgetId, { playerBId: e.target.value })}>
          <option value="">{teamBName} — pick player</option>
          {(teamBRecord?.players ?? []).map(p => <option key={p.id} value={p.id}>{`#${p.jerseyNo || '—'} `}{disp(p.name)}</option>)}
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
                  <div className="wgt-p-h2h-name">{disp(playerA!.name)}</div>
                  {playerA!.position && <div className="wgt-p-h2h-pos">{playerA!.position}</div>}
                </th>
                <th />
                <th style={{ color: teamBColor }}>
                  {dc.teamBLogo && <img className="wgt-p-h2h-logo" src={resolveImageUrl(dc.teamBLogo)} alt="" />}
                  <div className="wgt-p-h2h-jersey">#{playerB!.jerseyNo || '—'}</div>
                  <div className="wgt-p-h2h-name">{disp(playerB!.name)}</div>
                  {playerB!.position && <div className="wgt-p-h2h-pos">{playerB!.position}</div>}
                </th>
              </tr>
            </thead>
            <tbody>
              {STAT_FIELDS.map(f => (
                <tr key={f.key} className={`wgt-p-h2h-row${f.key === 'tries' ? ' wgt-p-h2h-row--tries' : ''}`}>
                  <td className="wgt-p-h2h-cell--a" style={{ color: teamAColor }}>{playerA![f.key] ?? 0}</td>
                  <td className="wgt-p-h2h-cell--label">{f.label}</td>
                  <td className="wgt-p-h2h-cell--b" style={{ color: teamBColor }}>{playerB![f.key] ?? 0}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {(historyA.length > 0 || historyB.length > 0) && (
            <div className="wgt-p-h2h-history">
              <div className="wgt-p-h2h-history-hdr">Match History</div>
              <div className="wgt-p-h2h-history-cols">
                {[{ list: historyA, color: teamAColor }, { list: historyB, color: teamBColor }].map((side, i) => (
                  <div key={i} className="wgt-p-h2h-history-col">
                    {side.list.length === 0 ? (
                      <div className="wgt-p-h2h-history-empty">No scored matches</div>
                    ) : side.list.map(h => (
                      <div key={h.resultId} className="wgt-p-h2h-history-row">
                        <div className="wgt-p-h2h-history-line">
                          <span className="wgt-p-h2h-history-date">{h.date}</span>
                          <span className="wgt-p-h2h-history-pts" style={{ color: side.color }}>{h.totalPoints}pt</span>
                        </div>
                        <div className="wgt-p-h2h-history-opp">vs {h.opponent}</div>
                        <div className="wgt-p-h2h-history-detail">{summarizeActions(h.actions)}</div>
                      </div>
                    ))}
                  </div>
                ))}
              </div>
            </div>
          )}
          {config.vmixInputKey && (
            <div className="wgt-p-h2h-actions">
              <button className="wgt-p-h2h-send-btn" onClick={sendToVmix} disabled={!getClient()} title="Send both players' data to vMix now">
                <ArrowUp size={12} strokeWidth={2} /> Send
              </button>
              <button
                className={`wgt-p-h2h-send-btn${overlayActive ? ' wgt-p-h2h-send-btn--active' : ''}`}
                onClick={() => overlayIn(ch, config.vmixInputKey)}
                disabled={!vmixState}
                title="Show overlay"
              ><Eye size={12} strokeWidth={2} /> Show</button>
              <button
                className={`wgt-p-h2h-send-btn${!overlayActive ? ' wgt-p-h2h-send-btn--active' : ''}`}
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
