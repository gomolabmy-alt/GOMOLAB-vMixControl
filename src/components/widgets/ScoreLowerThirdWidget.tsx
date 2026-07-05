import { useEffect, useRef, useState } from 'react';
import { useCanvasStore } from '../../stores/canvasStore';
import { useVmixStore } from '../../stores/vmixStore';
import { useTournamentStore } from '../../stores/tournamentStore';

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

interface VmixInput {
  id: string;
  actionLabel: string;
  vmixInputKey: string;
  vmixInputTitle?: string;
  fieldTeam: string;
  fieldScorer: string;
  fieldJersey: string;
  fieldAction: string;
}

function resolveInput(vmixInputs: VmixInput[], actionLabel: string): VmixInput | null {
  if (!vmixInputs?.length) return null;
  const match = vmixInputs.find(i => i.actionLabel && i.actionLabel === actionLabel);
  if (match) return match;
  return vmixInputs.find(i => !i.actionLabel) ?? vmixInputs[0];
}

interface Player { id: string; name: string; jerseyNo: string; }

export function ScoreLowerThirdWidget({ config }: Props) {
  const { pages, patchScoreLogEntry } = useCanvasStore();
  const { tournaments } = useTournamentStore();
  const { getClient, vmixState, overlayIn, overlayOut, vmixSyncVersion } = useVmixStore();

  const allWidgets = pages.flatMap(p => p.widgets);
  const linkedScoreboard = allWidgets.find(w => w.id === config.linkedScoreboardId);
  const sbCfg = linkedScoreboard?.config ?? {};
  const fullLog: LogEntry[] = sbCfg.scoreLog ?? [];

  const teamFilter: 'all' | 'A' | 'B' = config.teamFilter ?? 'all';
  const log = teamFilter === 'all' ? fullLog : fullLog.filter(e => e.team === teamFilter);
  const last = log[0] ?? null;

  const vmixInputs: VmixInput[] = config.vmixInputs ?? [];
  const activeInput = last ? resolveInput(vmixInputs, last.action) : (vmixInputs[0] ?? null);

  const teamAColor = sbCfg.teamAColor ?? '#e74c3c';
  const teamBColor = sbCfg.teamBColor ?? '#3498db';
  const teamColor = last ? (last.team === 'A' ? teamAColor : teamBColor) : '#888';
  const filterDotColor = teamFilter === 'A' ? teamAColor : teamFilter === 'B' ? teamBColor : undefined;

  const ch = config.overlayChannel ?? 1;
  const overlay = vmixState?.overlays?.find((o: any) => o.number === ch);
  const overlayActive = !!(overlay && overlay.key !== '');

  // ── Player picker for unassigned entries ─────────────────────────────────
  const [pickerEntryId, setPickerEntryId] = useState<string | null>(null);

  // Resolve squad from linked player list widgets on the scoreboard
  function resolveSquad(linkedId: string): Player[] {
    const plw = allWidgets.find(w => w.id === linkedId);
    if (!plw) return [];
    const plCfg = plw.config;
    const t = tournaments.find(t2 => t2.id === plCfg.linkedTournamentId);
    const side: 'A' | 'B' = plCfg.teamSide ?? 'A';
    const team = side === 'A' ? t?.teamA : t?.teamB;
    const players = team?.players ?? [];
    const assigned = new Set(
      [...(plCfg.starters ?? []), ...(plCfg.subs ?? [])].filter(Boolean) as string[]
    );
    return players
      .filter((p: any) => assigned.has(p.id))
      .sort((a: any, b: any) => (parseInt(a.jerseyNo) || 999) - (parseInt(b.jerseyNo) || 999));
  }

  const squadA: Player[] = resolveSquad(sbCfg.linkedPlayerListA ?? '');
  const squadB: Player[] = resolveSquad(sbCfg.linkedPlayerListB ?? '');

  const pickerEntry = pickerEntryId ? fullLog.find(e => e.id === pickerEntryId) ?? null : null;
  const pickerSquad = pickerEntry ? (pickerEntry.team === 'A' ? squadA : squadB) : [];
  const pickerTeamColor = pickerEntry ? (pickerEntry.team === 'A' ? teamAColor : teamBColor) : '#888';
  const pickerTeamName = pickerEntry ? pickerEntry.teamName : '';

  // Auto-open picker when newest entry has no scorer and squad is available
  useEffect(() => {
    if (!last) return;
    if (last.scorer || last.jerseyNo) return;
    const squad = last.team === 'A' ? squadA : squadB;
    if (squad.length === 0) return;
    setPickerEntryId(last.id);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [last?.id]);

  const sendToVmixEntry = (entry: LogEntry) => {
    const c = getClient();
    if (!c || !activeInput?.vmixInputKey) return;
    const key = activeInput.vmixInputKey;
    if (activeInput.fieldTeam)   c.setTextField(key, activeInput.fieldTeam,   entry.teamName ?? '');
    if (activeInput.fieldScorer) c.setTextField(key, activeInput.fieldScorer, entry.scorer ?? '');
    if (activeInput.fieldJersey) c.setTextField(key, activeInput.fieldJersey, entry.jerseyNo ?? '');
    if (activeInput.fieldAction) c.setTextField(key, activeInput.fieldAction, entry.action ?? '');
  };

  const sendToVmix = () => { if (last) sendToVmixEntry(last); };

  const lastIdRef = useRef<string | null>(null);
  useEffect(() => {
    if (!config.autoSend || !last) return;
    if (last.id === lastIdRef.current) return;
    // Delay auto-send until scorer is assigned (or no squad to pick from)
    const squad = last.team === 'A' ? squadA : squadB;
    if (!last.scorer && !last.jerseyNo && squad.length > 0) return;
    lastIdRef.current = last.id;
    sendToVmixEntry(last);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [last?.id, last?.scorer, last?.jerseyNo, config.autoSend]);

  // Re-push on reconnect
  useEffect(() => {
    if (!config.autoSend || !last) return;
    sendToVmixEntry(last);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vmixSyncVersion]);

  const confirmPicker = (player: Player | null) => {
    if (!pickerEntryId || !linkedScoreboard) return;
    const patch = player
      ? { scorer: player.name, jerseyNo: player.jerseyNo }
      : { scorer: '', jerseyNo: '' };
    patchScoreLogEntry(linkedScoreboard.id, pickerEntryId, patch);
    setPickerEntryId(null);
    // If this was the last entry and autoSend is on, trigger send after patch
    if (config.autoSend && last?.id === pickerEntryId && getClient() && activeInput?.vmixInputKey) {
      const updated = { ...last, ...patch };
      setTimeout(() => sendToVmixEntry(updated), 50);
    }
  };


  const hasInput = !!activeInput?.vmixInputKey;

  // Entries without a scorer that have an available squad
  const unassigned = fullLog.filter(e => {
    if (e.scorer || e.jerseyNo) return false;
    const squad = e.team === 'A' ? squadA : squadB;
    return squad.length > 0;
  });

  return (
    <div className="wgt-slt">

      {/* ── Player picker overlay ──────────────────────────────────────── */}
      {pickerEntry && (
        <div className="wgt-slt-picker" style={{ borderTopColor: pickerTeamColor }}>
          <div className="wgt-slt-picker-hdr" style={{ borderBottomColor: pickerTeamColor }}>
            <span className="wgt-slt-picker-dot" style={{ background: pickerTeamColor }} />
            <span className="wgt-slt-picker-team">{pickerTeamName}</span>
            <span className="wgt-slt-picker-action">{pickerEntry.action}</span>
            <button
              className="wgt-slt-picker-close"
              onPointerDown={(e) => { e.stopPropagation(); e.currentTarget.setPointerCapture(e.pointerId); setPickerEntryId(null); }}
              onClick={(e) => e.stopPropagation()}
            >✕</button>
          </div>
          <div className="wgt-slt-picker-list">
            {pickerSquad.map(p => (
              <button
                key={p.id}
                className="wgt-slt-picker-opt"
                onPointerDown={(e) => { e.stopPropagation(); e.currentTarget.setPointerCapture(e.pointerId); confirmPicker(p); }}
                onClick={(e) => e.stopPropagation()}
              >
                {p.jerseyNo && <span className="wgt-slt-picker-no">{p.jerseyNo}</span>}
                <span className="wgt-slt-picker-name">{p.name}</span>
              </button>
            ))}
          </div>
          <button
            className="wgt-slt-picker-skip"
            onPointerDown={(e) => { e.stopPropagation(); e.currentTarget.setPointerCapture(e.pointerId); confirmPicker(null); }}
            onClick={(e) => e.stopPropagation()}
          >— Keep no scorer</button>
        </div>
      )}

      <div className="wgt-slt-preview">
        {filterDotColor && <span className="wgt-slt-dot" style={{ background: filterDotColor, alignSelf: 'center' }} />}
        {last ? (
          <div className="wgt-slt-info">
            <div className="wgt-slt-team" style={{ color: teamColor }}>{last.teamName}</div>
            <div className="wgt-slt-scorer">
              {last.jerseyNo && <span className="wgt-slt-jersey">#{last.jerseyNo}</span>}
              {last.scorer && <span className="wgt-slt-name">{last.scorer}</span>}
              {!last.scorer && !last.jerseyNo && (
                <button
                  className="wgt-slt-assign-btn"
                  onPointerDown={(e) => { e.stopPropagation(); e.currentTarget.setPointerCapture(e.pointerId); setPickerEntryId(last.id); }}
                  onClick={(e) => e.stopPropagation()}
                >+ Assign scorer</button>
              )}
            </div>
            <div className="wgt-slt-action">
              <span className="wgt-slt-action-tag">{last.action}</span>
              &nbsp;&middot;&nbsp;{last.timeStr}
              {activeInput?.actionLabel && (
                <span className="wgt-slt-input-badge" title={`Input: ${activeInput.vmixInputKey}`}>
                  ↗ {activeInput.actionLabel}
                </span>
              )}
            </div>
          </div>
        ) : (
          <span className="wgt-slt-empty">{config.linkedScoreboardId ? 'No scores yet' : 'Link a scoreboard in settings'}</span>
        )}
      </div>

      {/* Unassigned entries badge */}
      {unassigned.length > 0 && !pickerEntry && (
        <div className="wgt-slt-unassigned">
          {unassigned.slice(0, 3).map(e => (
            <button
              key={e.id}
              className="wgt-slt-unassigned-btn"
              title={`${e.teamName} · ${e.action} · ${e.timeStr}`}
              onPointerDown={(e2) => { e2.stopPropagation(); e2.currentTarget.setPointerCapture(e2.pointerId); setPickerEntryId(e.id); }}
              onClick={(e2) => e2.stopPropagation()}
            >
              <span style={{ color: e.team === 'A' ? teamAColor : teamBColor }}>●</span>
              &nbsp;{e.action}&nbsp;{e.timeStr}
            </button>
          ))}
        </div>
      )}

      <div className="wgt-slt-actions">
        <button
          className="wgt-slt-btn wgt-slt-btn--send"
          onPointerDown={(e) => { e.stopPropagation(); e.currentTarget.setPointerCapture(e.pointerId); sendToVmix(); }}
          onClick={(e) => e.stopPropagation()}
          disabled={!getClient() || !hasInput || !last}
          title="Send last score data to vMix title"
        >
          ↑ Send
        </button>
        <button
          className={`wgt-slt-btn wgt-slt-btn--show${overlayActive ? ' wgt-slt-btn--active' : ''}`}
          onPointerDown={(e) => { e.stopPropagation(); e.currentTarget.setPointerCapture(e.pointerId); overlayIn(ch, activeInput?.vmixInputKey || undefined); }}
          onClick={(e) => e.stopPropagation()}
          disabled={!vmixState || !hasInput}
          title="Show on overlay"
        >▶ Show</button>
        <button
          className={`wgt-slt-btn wgt-slt-btn--hide${!overlayActive ? ' wgt-slt-btn--active' : ''}`}
          onPointerDown={(e) => { e.stopPropagation(); e.currentTarget.setPointerCapture(e.pointerId); overlayOut(ch); }}
          onClick={(e) => e.stopPropagation()}
          disabled={!vmixState || !hasInput}
          title="Hide from overlay"
        >■ Hide</button>
      </div>
    </div>
  );
}
