import { useEffect, useRef } from 'react';
import { useCanvasStore } from '../../stores/canvasStore';
import { useVmixStore } from '../../stores/vmixStore';
import { buildActionSummary } from '../../utils/scoreActions';

interface Props {
  widgetId: string;
  config: Record<string, any>;
  w: number;
  h: number;
}

export function PlayerLowerThirdWidget({ config }: Props) {
  const { pages } = useCanvasStore();
  const { getClientById, vmixState, overlayIn, overlayOut } = useVmixStore();

  const name         = config.highlightedName         ?? '';
  const jersey       = config.highlightedJersey       ?? '';
  const position     = config.highlightedPosition     ?? '';
  const teamName     = config.highlightedTeam         ?? '';
  const hasPlayer = !!(name || jersey);

  const allWidgets = pages.flatMap(p => p.widgets);

  // Resolve linked player list to get team color when available
  const linkedPl = allWidgets.find(w => w.id === config.linkedPlayerListId);
  const resolvedColor = config.highlightedTeamColor
    || (config.highlightedSide === 'A' ? linkedPl?.config.teamColor : undefined)
    || '#888';

  // Compute score summary live from linked scoreboard log
  const linkedScoreboard = allWidgets.find(w => w.id === config.linkedScoreboardId);
  const scoreLog: any[] = linkedScoreboard?.config.scoreLog ?? [];
  const scoreSummary = (() => {
    if (!hasPlayer || scoreLog.length === 0) return config.highlightedScoreSummary ?? '';
    const playerLog = scoreLog.filter(e =>
      (jersey && e.jerseyNo === jersey) || (name && e.scorer === name)
    );
    if (playerLog.length === 0) return config.highlightedScoreSummary ?? '';
    const actions: Record<string, number> = {};
    for (const e of playerLog) {
      actions[e.action] = (actions[e.action] ?? 0) + 1;
    }
    return buildActionSummary(actions);
  })();

  const ch = config.overlayChannel ?? 1;
  const overlay = vmixState?.overlays?.find((o: any) => o.number === ch);
  const overlayActive = !!(overlay && overlay.key !== '');
  const hasInput = !!config.vmixInputKey;

  const sendToVmix = () => {
    const c = getClientById(config.vmixClientId);
    if (!c || !hasInput || !hasPlayer) return;
    const key = config.vmixInputKey;
    if (config.fieldName         && name)         c.setTextField(key, config.fieldName,         name);
    if (config.fieldJersey       && jersey)       c.setTextField(key, config.fieldJersey,       jersey);
    if (config.fieldPosition     && position)     c.setTextField(key, config.fieldPosition,     position);
    if (config.fieldTeam         && teamName)     c.setTextField(key, config.fieldTeam,         teamName);
    if (config.fieldScoreSummary && scoreSummary) c.setTextField(key, config.fieldScoreSummary, scoreSummary);
  };

  const lastIdRef = useRef<string | null>(null);
  const prevSummaryRef = useRef<string>('');
  useEffect(() => {
    if (config.autoSend === false || !hasPlayer) return;
    const pid = config.highlightedPlayerId;
    if (!pid || pid === lastIdRef.current) return;
    lastIdRef.current = pid;
    prevSummaryRef.current = scoreSummary;
    sendToVmix();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config.highlightedPlayerId, config.autoSend]);

  useEffect(() => {
    if (config.autoSend === false || !hasPlayer || !scoreSummary) return;
    if (scoreSummary === prevSummaryRef.current) return;
    prevSummaryRef.current = scoreSummary;
    const c = getClientById(config.vmixClientId);
    if (!c || !config.vmixInputKey || !config.fieldScoreSummary) return;
    c.setTextField(config.vmixInputKey, config.fieldScoreSummary, scoreSummary);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scoreSummary]);

  return (
    <div className="wgt-slt">
      <div className="wgt-slt-preview">
        {hasPlayer ? (
          <div className="wgt-slt-info">
            <div className="wgt-slt-team" style={{ color: resolvedColor }}>{teamName || '—'}</div>
            <div className="wgt-slt-scorer">
              {jersey   && <span className="wgt-slt-jersey">#{jersey}</span>}
              {name     && <span className="wgt-slt-name">{name}</span>}
              {!name && !jersey && <span className="wgt-slt-empty">No player</span>}
            </div>
            {position && (
              <div className="wgt-slt-action">
                <span className="wgt-slt-action-tag">{position}</span>
              </div>
            )}
            {scoreSummary && (
              <div className="wgt-slt-score-summary">{scoreSummary}</div>
            )}
          </div>
        ) : (
          <span className="wgt-slt-empty">
            {config.linkedPlayerListId ? 'No player highlighted' : 'Link a player list in settings'}
          </span>
        )}
      </div>

      <div className="wgt-slt-actions">
        <button
          className="wgt-slt-btn wgt-slt-btn--send"
          onClick={sendToVmix}
          disabled={!getClientById(config.vmixClientId) || !hasInput || !hasPlayer}
          title="Send player data to vMix title"
        >
          ↑ Send
        </button>
        <button
          className={`wgt-slt-btn wgt-slt-btn--show${overlayActive ? ' wgt-slt-btn--active' : ''}`}
          onClick={() => overlayIn(ch, config.vmixInputKey || undefined)}
          disabled={!vmixState || !hasInput}
          title="Show on overlay"
        >▶ Show</button>
        <button
          className={`wgt-slt-btn wgt-slt-btn--hide${!overlayActive ? ' wgt-slt-btn--active' : ''}`}
          onClick={() => overlayOut(ch)}
          disabled={!vmixState || !hasInput}
          title="Hide from overlay"
        >■ Hide</button>
      </div>
    </div>
  );
}
