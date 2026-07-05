import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useCanvasStore, formatTime } from '../../stores/canvasStore';
import { useVmixStore } from '../../stores/vmixStore';
import { useTournamentStore } from '../../stores/tournamentStore';

interface Props {
  widgetId: string;
  config: Record<string, any>;
  w: number;
  h: number;
}

interface SinBinPlayer {
  playerId: string;
  name: string;
  jerseyNo: string;
  teamName: string;
  teamColor: string;
  remainingMs: number;
}

export function SinBinLowerThirdWidget({ config }: Props) {
  const { pages, returnPlayerFromSinBin } = useCanvasStore();
  const { tournaments } = useTournamentStore();
  const { client, vmixState, overlayIn, overlayOut, vmixSyncVersion } = useVmixStore();

  const allWidgets = pages.flatMap(p => p.widgets);
  const plw = allWidgets.find(w => w.id === config.linkedPlayerListId);
  const plCfg = plw?.config ?? null;

  // ── Resolve active sin bin players from the linked player list ────────────
  const activePlayers: SinBinPlayer[] = (() => {
    if (!plCfg) return [];
    const sinBinEntries: Record<string, number> = plCfg.sinBinEntries ?? {};
    if (Object.keys(sinBinEntries).length === 0) return [];

    const sinBinDuration: number = plCfg.sinBinDuration ?? 600_000;

    const timerWidget = plCfg.linkedTimerWidgetId
      ? allWidgets.find(w => w.id === plCfg.linkedTimerWidgetId)
      : null;
    const timerCfg = timerWidget?.config ?? null;
    const currentMs: number = timerCfg?.currentMs ?? 0;
    const timerMode: string = timerCfg?.mode ?? 'countup';

    const tournament = tournaments.find(t => t.id === plCfg.linkedTournamentId);
    const side: 'A' | 'B' = plCfg.teamSide ?? 'A';
    const teamData = side === 'A' ? tournament?.teamA : tournament?.teamB;
    const players: any[] = teamData?.players ?? [];

    return Object.entries(sinBinEntries).flatMap(([playerId, startMs]) => {
      const elapsed = timerMode === 'countdown' ? startMs - currentMs : currentMs - startMs;
      const remaining = Math.max(0, sinBinDuration - elapsed);
      const player = players.find(p => p.id === playerId);
      if (!player) return [];
      return [{
        playerId,
        name: player.name,
        jerseyNo: player.jerseyNo ?? '',
        teamName: teamData?.name ?? (side === 'A' ? 'Team A' : 'Team B'),
        teamColor: teamData?.color ?? (side === 'A' ? '#e74c3c' : '#3498db'),
        remainingMs: remaining,
      }];
    }).sort((a, b) => a.remainingMs - b.remainingMs); // shortest remaining first
  })();

  // ── Selected player ───────────────────────────────────────────────────────
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [showPicker, setShowPicker] = useState(false);

  // ── Sin bin expiry dialog ─────────────────────────────────────────────────
  const [expiredQueue, setExpiredQueue] = useState<SinBinPlayer[]>([]);
  const prevRemainingRef = useRef<Record<string, number>>({});

  useEffect(() => {
    const newExpired: SinBinPlayer[] = [];
    const prev = prevRemainingRef.current;

    for (const p of activePlayers) {
      const prevMs = prev[p.playerId];
      if (prevMs !== undefined && prevMs > 0 && p.remainingMs === 0) {
        newExpired.push(p);
      }
      prev[p.playerId] = p.remainingMs;
    }
    // Remove players no longer in the list
    for (const id of Object.keys(prev)) {
      if (!activePlayers.find(p => p.playerId === id)) delete prev[id];
    }

    if (newExpired.length > 0) {
      setExpiredQueue(q => [...q, ...newExpired]);
    }
  // activePlayers is re-derived on every render — safe to list remaining values
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activePlayers.map(p => p.remainingMs).join(',')]);

  const dismissExpired = () => setExpiredQueue(q => q.slice(1));
  const returnAndDismiss = () => {
    if (currentExpired && config.linkedPlayerListId) {
      returnPlayerFromSinBin(config.linkedPlayerListId, currentExpired.playerId);
    }
    dismissExpired();
  };
  const currentExpired = expiredQueue[0] ?? null;

  // Auto-select the newest sin bin entry when count increases
  const prevCountRef = useRef(0);
  useEffect(() => {
    if (activePlayers.length > prevCountRef.current && activePlayers.length > 0) {
      const newest = [...activePlayers].sort((a, b) => b.remainingMs - a.remainingMs)[0];
      setSelectedId(newest.playerId);
    }
    prevCountRef.current = activePlayers.length;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activePlayers.length]);

  const selected = activePlayers.find(p => p.playerId === selectedId) ?? activePlayers[0] ?? null;

  // ── vMix ─────────────────────────────────────────────────────────────────
  const ch = config.overlayChannel ?? 1;
  const overlay = vmixState?.overlays?.find((o: any) => o.number === ch);
  const overlayActive = !!(overlay && overlay.key !== '');
  const hasInput = !!config.vmixInputKey;

  const sendToVmix = (player: SinBinPlayer | null) => {
    if (!client || !config.vmixInputKey || !player) return;
    const key = config.vmixInputKey;
    if (config.fieldJersey) client.setTextField(key, config.fieldJersey, player.jerseyNo);
    if (config.fieldName)   client.setTextField(key, config.fieldName,   player.name);
    if (config.fieldTimer)  client.setTextField(key, config.fieldTimer,  formatTime(player.remainingMs, 'mm:ss'));
    if (config.fieldTeam)   client.setTextField(key, config.fieldTeam,   player.teamName);
  };

  const lastSentRef = useRef<string | null>(null);
  useEffect(() => {
    if (!config.autoSend || !selected) return;
    if (selected.playerId === lastSentRef.current) return;
    lastSentRef.current = selected.playerId;
    sendToVmix(selected);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected?.playerId, config.autoSend]);

  // Re-push on reconnect
  useEffect(() => {
    if (!config.autoSend || !selected) return;
    sendToVmix(selected);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vmixSyncVersion]);

  // Auto-send timer field on every tick
  useEffect(() => {
    if (!client || !config.vmixInputKey || !config.fieldTimer || !selected) return;
    client.setTextField(config.vmixInputKey, config.fieldTimer, formatTime(selected.remainingMs, 'mm:ss'));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected?.remainingMs]);

  return (
    <div className="wgt-sblt">

      {/* ── Sin bin expiry popup (full-screen portal) ────────────────────── */}
      {currentExpired && createPortal(
        <div className="sinbin-popup-backdrop">
          <div className="sinbin-popup" style={{ '--sbp-color': currentExpired.teamColor } as React.CSSProperties}>
            <div className="sinbin-popup-strip" style={{ background: currentExpired.teamColor }} />
            <div className="sinbin-popup-icon">⏱</div>
            <div className="sinbin-popup-body">
              <div className="sinbin-popup-label">Sin Bin Ended</div>
              <div className="sinbin-popup-player">
                {currentExpired.jerseyNo && (
                  <span className="sinbin-popup-jersey">{currentExpired.jerseyNo}</span>
                )}
                <span className="sinbin-popup-name">{currentExpired.name}</span>
              </div>
              <div className="sinbin-popup-team" style={{ color: currentExpired.teamColor }}>
                {currentExpired.teamName} — can return to the field
              </div>
            </div>
            <div className="sinbin-popup-actions">
              <button
                className="sinbin-popup-return"
                onPointerDown={(e) => { e.stopPropagation(); e.currentTarget.setPointerCapture(e.pointerId); returnAndDismiss(); }}
                onClick={(e) => e.stopPropagation()}
              >✓ Return to Field</button>
              <button
                className="sinbin-popup-ok"
                onPointerDown={(e) => { e.stopPropagation(); e.currentTarget.setPointerCapture(e.pointerId); dismissExpired(); }}
                onClick={(e) => e.stopPropagation()}
              >Dismiss</button>
              {expiredQueue.length > 1 && (
                <span className="sinbin-popup-more">+{expiredQueue.length - 1} more</span>
              )}
            </div>
          </div>
        </div>,
        document.body,
      )}

      {/* ── Player picker overlay ─────────────────────────────────────────── */}
      {showPicker && (
        <div className="wgt-sblt-picker">
          <div className="wgt-sblt-picker-hdr">
            <span className="wgt-sblt-picker-title">Sin Bin — {plCfg ? (activePlayers[0]?.teamName ?? 'Team') : 'No team linked'}</span>
            <button
              className="wgt-sblt-picker-close"
              onPointerDown={(e) => { e.stopPropagation(); e.currentTarget.setPointerCapture(e.pointerId); setShowPicker(false); }}
              onClick={(e) => e.stopPropagation()}
            >✕</button>
          </div>
          <div className="wgt-sblt-picker-list">
            {activePlayers.length === 0 && (
              <div className="wgt-sblt-picker-empty">No players in sin bin</div>
            )}
            {activePlayers.map(p => (
              <button
                key={p.playerId}
                className={`wgt-sblt-picker-opt ${p.playerId === selected?.playerId ? 'wgt-sblt-picker-opt--active' : ''}`}
                onPointerDown={(ev) => { ev.stopPropagation(); ev.currentTarget.setPointerCapture(ev.pointerId); setSelectedId(p.playerId); setShowPicker(false); }}
                onClick={(ev) => ev.stopPropagation()}
              >
                {p.jerseyNo && <span className="wgt-sblt-picker-no">{p.jerseyNo}</span>}
                <span className="wgt-sblt-picker-name">{p.name}</span>
                <span className="wgt-sblt-picker-time">{formatTime(p.remainingMs, 'mm:ss')}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* ── Preview ───────────────────────────────────────────────────────── */}
      <div className="wgt-sblt-preview">
        {selected ? (
          <>
            <div className="wgt-sblt-team-bar" style={{ background: selected.teamColor }} />
            <div className="wgt-sblt-info">
              <div className="wgt-sblt-identity">
                {selected.jerseyNo && <span className="wgt-sblt-jersey">{selected.jerseyNo}</span>}
                <span className="wgt-sblt-name">{selected.name}</span>
                <span className="wgt-sblt-team-name" style={{ color: selected.teamColor }}>
                  {selected.teamName}
                </span>
              </div>
              <div className="wgt-sblt-timer">{formatTime(selected.remainingMs, 'mm:ss')}</div>
            </div>
            {activePlayers.length > 1 && (
              <button
                className="wgt-sblt-switch-btn"
                title="Switch player"
                onPointerDown={(e) => { e.stopPropagation(); e.currentTarget.setPointerCapture(e.pointerId); setShowPicker(true); }}
                onClick={(e) => e.stopPropagation()}
              >⇄ {activePlayers.length}</button>
            )}
          </>
        ) : (
          <div className="wgt-sblt-empty">
            {config.linkedPlayerListId ? 'No players in sin bin' : 'Link a player list in settings'}
          </div>
        )}
      </div>

      {/* ── Actions ───────────────────────────────────────────────────────── */}
      <div className="wgt-sblt-actions">
        <button
          className="wgt-sblt-pick-btn"
          onPointerDown={(e) => { e.stopPropagation(); e.currentTarget.setPointerCapture(e.pointerId); setShowPicker(true); }}
          onClick={(e) => e.stopPropagation()}
          disabled={activePlayers.length === 0}
          title="Pick player"
        >▾ Pick</button>
        <button
          className="wgt-sblt-btn wgt-sblt-btn--send"
          onPointerDown={(e) => { e.stopPropagation(); e.currentTarget.setPointerCapture(e.pointerId); sendToVmix(selected); }}
          onClick={(e) => e.stopPropagation()}
          disabled={!client || !hasInput || !selected}
          title="Send to vMix"
        >↑ Send</button>
        <button
          className={`wgt-sblt-btn wgt-sblt-btn--show${overlayActive ? ' wgt-sblt-btn--active' : ''}`}
          onPointerDown={(e) => { e.stopPropagation(); e.currentTarget.setPointerCapture(e.pointerId); overlayIn(ch, config.vmixInputKey || undefined); }}
          onClick={(e) => e.stopPropagation()}
          disabled={!vmixState || !hasInput}
          title="Show overlay"
        >▶ Show</button>
        <button
          className={`wgt-sblt-btn wgt-sblt-btn--hide${!overlayActive ? ' wgt-sblt-btn--active' : ''}`}
          onPointerDown={(e) => { e.stopPropagation(); e.currentTarget.setPointerCapture(e.pointerId); overlayOut(ch); }}
          onClick={(e) => e.stopPropagation()}
          disabled={!vmixState || !hasInput}
          title="Hide overlay"
        >■ Hide</button>
      </div>
    </div>
  );
}
