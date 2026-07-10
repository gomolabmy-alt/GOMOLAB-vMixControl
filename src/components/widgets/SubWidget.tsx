import { useState, useMemo, useContext } from 'react';
import { useCanvasStore, formatTime } from '../../stores/canvasStore';
import { CanvasActionContext } from '../../lib/canvasContext';
import { useTeamDbStore } from '../../stores/teamDbStore';
import { useVmixStore } from '../../stores/vmixStore';
import type { Player } from '../../types/tournament';

interface Props {
  widgetId: string;
  config: Record<string, any>;
}

interface ConfirmState {
  outId: string;
  inId: string;
  nameOut: string;
  nameIn: string;
}

function wallClock(): string {
  const d = new Date();
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export function SubWidget({ widgetId, config: cfg }: Props) {
  const store = useCanvasStore();
  const ctx = useContext(CanvasActionContext);
  const { pages, addTimelineEvent } = store;
  const updateWidgetConfig = ctx?.updateWidgetConfig ?? store.updateWidgetConfig;
  const { teams: teamDbTeams } = useTeamDbStore();
  const { getClient } = useVmixStore();

  const [selOut, setSelOut] = useState<string | null>(null);
  const [selIn, setSelIn] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<ConfirmState | null>(null);
  const [lastSub, setLastSub] = useState<{ out: string; in: string } | null>(null);

  const side: 'A' | 'B' = cfg.teamSide ?? 'A';
  const team = teamDbTeams.find(t => t.id === cfg.linkedTeamId);
  const players: Player[] = team?.players ?? [];

  const playerListWidget = cfg.linkedPlayerListId
    ? pages.flatMap(p => p.widgets).find(w => w.id === cfg.linkedPlayerListId)
    : null;
  const plCfg = playerListWidget?.config ?? cfg;

  const timerWidget = cfg.linkedTimerWidgetId
    ? pages.flatMap(p => p.widgets).find(w => w.id === cfg.linkedTimerWidgetId)
    : null;
  const timerCfg = timerWidget?.config ?? null;
  const currentMs: number = timerCfg?.currentMs ?? 0;
  const timeFormat: string = timerCfg?.format ?? 'mm:ss';
  const timerDown = timerCfg?.mode === 'countdown';
  const elapsed = (entryMs: number) =>
    timerDown ? Math.max(0, entryMs - currentMs) : Math.max(0, currentMs - entryMs);

  const playerById = useMemo(() =>
    Object.fromEntries(players.map(p => [p.id, p])),
    [players]
  );

  const starterSlots: string[] = plCfg.starters ?? [];
  const subSlots: string[] = plCfg.subs ?? [];
  const onField: string[] = plCfg.onField ?? [];
  const entries: Record<string, number> = plCfg.entries ?? {};
  const accumulated: Record<string, number> = plCfg.accumulated ?? {};

  const onFieldPlayers = useMemo(() =>
    starterSlots.filter(id => id && onField.includes(id)).map(id => playerById[id]).filter(Boolean) as Player[],
    [starterSlots, onField, playerById]
  );

  const availableSubs = useMemo(() =>
    subSlots.filter(id => id && !onField.includes(id)).map(id => playerById[id]).filter(Boolean) as Player[],
    [subSlots, onField, playerById]
  );

  const cancelSelection = () => { setSelOut(null); setSelIn(null); setConfirm(null); };

  const openConfirm = (outId: string, inId: string) => {
    setConfirm({
      outId,
      inId,
      nameOut: playerById[outId]?.name ?? '',
      nameIn: playerById[inId]?.name ?? '',
    });
  };

  const handleSelectOut = (id: string) => {
    if (selOut === id) { setSelOut(null); return; }
    setSelOut(id);
    if (selIn) openConfirm(id, selIn);
  };

  const handleSelectIn = (id: string) => {
    if (selIn === id) { setSelIn(null); return; }
    setSelIn(id);
    if (selOut) openConfirm(selOut, id);
  };

  const executeSwap = (outId: string, inId: string, nameOut: string, nameIn: string) => {
    const outgoing = playerById[outId];
    const incoming = playerById[inId];
    if (!outgoing || !incoming) return;

    // Send names to vMix (all linked inputs)
    const subTargets: Array<{inputKey:string;vmixFieldOut?:string;vmixFieldIn?:string}> = cfg.vmixInputs?.length
      ? cfg.vmixInputs
      : cfg.vmixInputKey
        ? [{ inputKey: cfg.vmixInputKey, vmixFieldOut: cfg.vmixFieldOut, vmixFieldIn: cfg.vmixFieldIn }]
        : [];
    for (const t of subTargets) {
      if (!t.inputKey) continue;
      getClient()?.setTextField(t.inputKey, t.vmixFieldOut || 'PlayerOff.Text', nameOut);
      getClient()?.setTextField(t.inputKey, t.vmixFieldIn  || 'PlayerOn.Text',  nameIn);
    }

    const timePlayed = (accumulated[outId] ?? 0) +
      elapsed(entries[outId] ?? currentMs);

    const nextStarters = [...starterSlots];
    const nextSubs = [...subSlots];
    const starterIdx = nextStarters.indexOf(outId);
    const subIdx = nextSubs.indexOf(inId);
    if (starterIdx >= 0) nextStarters[starterIdx] = inId;
    if (subIdx >= 0) nextSubs[subIdx] = outId;

    const subbedOnPlayers: string[] = plCfg.subbedOnPlayers ?? [];
    const targetId = playerListWidget ? playerListWidget.id : widgetId;
    updateWidgetConfig(targetId, {
      starters: nextStarters,
      subs: nextSubs,
      onField: [...onField.filter(id => id !== outId), inId],
      entries: { ...entries, [inId]: currentMs },
      accumulated: { ...accumulated, [outId]: timePlayed },
      subbedOnPlayers: [...new Set([...subbedOnPlayers, inId])],
    });

    if (cfg.linkedTimelineId) {
      addTimelineEvent(cfg.linkedTimelineId, {
        type: 'substitution', team: side, timeMs: Date.now(),
        timeStr: timerCfg ? formatTime(currentMs, timeFormat) : wallClock(),
        player: nameIn,
        playerOff: nameOut,
        jerseyNo: incoming.jerseyNo || undefined,
        jerseyNoOff: outgoing.jerseyNo || undefined,
      });
    }

    setLastSub({ out: nameOut, in: nameIn });
    cancelSelection();
  };

  const teamColor = team?.color ?? '#3498db';

  return (
    <div className="wgt-sub">
      <div className="wgt-sub-header" style={{ '--tc': teamColor } as React.CSSProperties}>
        <span className="wgt-sub-team-dot" style={{ background: teamColor }} />
        <span className="wgt-sub-team-name">{team?.name ?? '—'}</span>
        <span className="wgt-sub-title">Quick Sub</span>
      </div>

      {!team ? (
        <div className="wgt-sub-empty">Link a team in ⚙</div>
      ) : !playerListWidget ? (
        <div className="wgt-sub-empty">Link a Player List widget in ⚙</div>
      ) : confirm ? (
        /* ── Confirmation dialog ── */
        <div className="wgt-sub-confirm">
          <div className="wgt-sub-confirm-title">Confirm Substitution</div>

          <div className="wgt-sub-confirm-row">
            <span className="wgt-sub-confirm-lbl wgt-sub-confirm-lbl--off">▼ Off</span>
            <input
              className="wgt-sub-confirm-inp"
              value={confirm.nameOut}
              onChange={e => setConfirm(c => c ? { ...c, nameOut: e.target.value } : c)}
            />
          </div>

          <div className="wgt-sub-confirm-row">
            <span className="wgt-sub-confirm-lbl wgt-sub-confirm-lbl--in">▲ On</span>
            <input
              className="wgt-sub-confirm-inp"
              value={confirm.nameIn}
              onChange={e => setConfirm(c => c ? { ...c, nameIn: e.target.value } : c)}
            />
          </div>

          {cfg.vmixInputKey && (
            <div className="wgt-sub-confirm-vmix">
              → vMix: {cfg.vmixFieldOut || 'PlayerOff.Text'} / {cfg.vmixFieldIn || 'PlayerOn.Text'}
            </div>
          )}

          <div className="wgt-sub-confirm-actions">
            <button className="wgt-sub-confirm-cancel" onClick={cancelSelection}>Cancel</button>
            <button
              className="wgt-sub-confirm-ok"
              onClick={() => executeSwap(confirm.outId, confirm.inId, confirm.nameOut, confirm.nameIn)}
            >
              Confirm Sub
            </button>
          </div>
        </div>
      ) : (
        <>
          {(selOut || selIn) && (
            <div className="wgt-sub-pending">
              {selOut && <span className="wgt-sub-pending-off">▼ {playerById[selOut]?.name}</span>}
              {selOut && selIn && <span className="wgt-sub-pending-arr">→</span>}
              {selIn && <span className="wgt-sub-pending-in">▲ {playerById[selIn]?.name}</span>}
              <button className="wgt-sub-cancel" onClick={cancelSelection}>✕</button>
            </div>
          )}

          {lastSub && !selOut && !selIn && (
            <div className="wgt-sub-last">Last: {lastSub.out} → {lastSub.in}</div>
          )}

          <div className="wgt-sub-cols">
            <div className="wgt-sub-col wgt-sub-col--off">
              <div className="wgt-sub-col-hdr">Coming OFF</div>
              {onFieldPlayers.length === 0 && (
                <span className="wgt-sub-col-empty">No players on field</span>
              )}
              {onFieldPlayers.map(p => (
                <button
                  key={p.id}
                  className={`wgt-sub-row${selOut === p.id ? ' wgt-sub-row--sel-off' : ''}`}
                  onClick={() => handleSelectOut(p.id)}
                >
                  <span className="wgt-sub-no">{p.jerseyNo || '—'}</span>
                  <span className="wgt-sub-name">{p.name}</span>
                </button>
              ))}
            </div>

            <div className="wgt-sub-vsep" />

            <div className="wgt-sub-col wgt-sub-col--in">
              <div className="wgt-sub-col-hdr">Coming ON</div>
              {availableSubs.length === 0 && (
                <span className="wgt-sub-col-empty">No subs available</span>
              )}
              {availableSubs.map(p => (
                <button
                  key={p.id}
                  className={`wgt-sub-row${selIn === p.id ? ' wgt-sub-row--sel-in' : ''}`}
                  onClick={() => handleSelectIn(p.id)}
                >
                  <span className="wgt-sub-no">{p.jerseyNo || '—'}</span>
                  <span className="wgt-sub-name">{p.name}</span>
                </button>
              ))}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
