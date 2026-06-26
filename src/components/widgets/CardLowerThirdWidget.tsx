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

type RugbyCard = 'yellow' | 'orange' | 'red';

interface CardPlayer {
  playerId: string;
  name: string;
  jerseyNo: string;
  teamName: string;
  teamColor: string;
  teamSide: 'A' | 'B';
  cardType: RugbyCard;
}

const CARD_COLOR: Record<RugbyCard, string> = {
  yellow: '#f1c40f',
  orange: '#e67e22',
  red:    '#e74c3c',
};

const CARD_LABEL: Record<RugbyCard, string> = {
  yellow: 'Yellow Card',
  orange: 'Orange Card',
  red:    'Red Card',
};

function resolveCardPlayers(allWidgets: any[], tournaments: any[], linkedId: string): CardPlayer[] {
  const plw = allWidgets.find(w => w.id === linkedId);
  if (!plw) return [];

  const plCfg = plw.config;
  const tournament = tournaments.find(t => t.id === plCfg.linkedTournamentId);
  const side: 'A' | 'B' = plCfg.teamSide ?? 'A';
  const team = side === 'A' ? tournament?.teamA : tournament?.teamB;
  const players: any[] = team?.players ?? [];
  const playerCards: Record<string, RugbyCard[]> = plCfg.playerCards ?? {};

  const results: CardPlayer[] = [];

  for (const [id, cards] of Object.entries(playerCards)) {
    if (!cards || cards.length === 0) continue;
    const yellows = (cards as RugbyCard[]).filter(c => c === 'yellow').length;
    let cardType: RugbyCard;

    if ((cards as RugbyCard[]).includes('red') || yellows >= 2) {
      cardType = 'red';
    } else if (yellows === 1) {
      cardType = 'yellow';
    } else if ((cards as RugbyCard[]).includes('orange')) {
      cardType = 'orange';
    } else {
      continue;
    }

    const player = players.find(p => p.id === id);
    results.push({
      playerId: id,
      name: player?.name ?? '?',
      jerseyNo: player?.jerseyNo ?? '',
      teamName: team?.name ?? (side === 'A' ? 'Team A' : 'Team B'),
      teamColor: team?.color ?? (side === 'A' ? '#e74c3c' : '#3498db'),
      teamSide: side,
      cardType,
    });
  }

  return results;
}

export function CardLowerThirdWidget({ config }: Props) {
  const { pages } = useCanvasStore();
  const { tournaments } = useTournamentStore();
  const { client, vmixState, overlayIn, overlayOut } = useVmixStore();

  const allWidgets = pages.flatMap(p => p.widgets);

  const teamAPlayers = resolveCardPlayers(allWidgets, tournaments, config.linkedPlayerListA ?? '');
  const teamBPlayers = resolveCardPlayers(allWidgets, tournaments, config.linkedPlayerListB ?? '');
  const allCardPlayers = [...teamAPlayers, ...teamBPlayers];

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [showPicker, setShowPicker] = useState(false);

  // Auto-select the most recently carded player when count increases
  const prevCountRef = useRef(0);
  useEffect(() => {
    if (allCardPlayers.length > prevCountRef.current && allCardPlayers.length > 0) {
      setSelectedId(allCardPlayers[allCardPlayers.length - 1].playerId);
    }
    prevCountRef.current = allCardPlayers.length;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allCardPlayers.length]);

  const selected = allCardPlayers.find(p => p.playerId === selectedId) ?? allCardPlayers[0] ?? null;

  // ── vMix ─────────────────────────────────────────────────────────────────
  const ch = config.overlayChannel ?? 1;
  const overlay = vmixState?.overlays?.find((o: any) => o.number === ch);
  const overlayActive = !!(overlay && overlay.key !== '');
  const hasInput = !!config.vmixInputKey;

  const sendToVmix = (player: CardPlayer | null) => {
    if (!client || !config.vmixInputKey || !player) return;
    const key = config.vmixInputKey;
    if (config.fieldJersey)   client.setTextField(key, config.fieldJersey,   player.jerseyNo);
    if (config.fieldName)     client.setTextField(key, config.fieldName,     player.name);
    if (config.fieldTeam)     client.setTextField(key, config.fieldTeam,     player.teamName);
    if (config.fieldCardType) client.setTextField(key, config.fieldCardType, CARD_LABEL[player.cardType]);
  };

  const lastSentRef = useRef<string | null>(null);
  useEffect(() => {
    if (!config.autoSend || !selected) return;
    const key = `${selected.playerId}:${selected.cardType}`;
    if (key === lastSentRef.current) return;
    lastSentRef.current = key;
    sendToVmix(selected);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected?.playerId, selected?.cardType, config.autoSend]);

  const configured = config.linkedPlayerListA || config.linkedPlayerListB;

  return (
    <div className="wgt-clt">

      {/* ── Player picker overlay ─────────────────────────────────────────── */}
      {showPicker && (
        <div className="wgt-clt-picker">
          <div className="wgt-clt-picker-hdr">
            <span className="wgt-clt-picker-title">Card Players</span>
            <button
              className="wgt-clt-picker-close"
              onPointerDown={(e) => { e.stopPropagation(); e.currentTarget.setPointerCapture(e.pointerId); setShowPicker(false); }}
              onClick={(e) => e.stopPropagation()}
            >✕</button>
          </div>
          <div className="wgt-clt-picker-list">
            {allCardPlayers.length === 0 && (
              <div className="wgt-clt-picker-empty">No players with cards</div>
            )}
            {allCardPlayers.map(p => (
              <button
                key={p.playerId}
                className={`wgt-clt-picker-opt ${p.playerId === selected?.playerId ? 'wgt-clt-picker-opt--active' : ''}`}
                onPointerDown={(ev) => { ev.stopPropagation(); ev.currentTarget.setPointerCapture(ev.pointerId); setSelectedId(p.playerId); setShowPicker(false); }}
                onClick={(ev) => ev.stopPropagation()}
              >
                <span className="wgt-clt-picker-card" style={{ background: CARD_COLOR[p.cardType] }} title={CARD_LABEL[p.cardType]} />
                {p.jerseyNo && <span className="wgt-clt-picker-no">{p.jerseyNo}</span>}
                <span className="wgt-clt-picker-name">{p.name}</span>
                <span className="wgt-clt-picker-team" style={{ color: p.teamColor }}>{p.teamName}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* ── Preview ───────────────────────────────────────────────────────── */}
      <div className="wgt-clt-preview">
        {!configured ? (
          <div className="wgt-clt-empty">Link player lists in ⚙</div>
        ) : selected ? (
          <>
            <div className="wgt-clt-team-bar" style={{ background: selected.teamColor }} />
            <div
              className="wgt-clt-card-badge"
              style={{ background: CARD_COLOR[selected.cardType] }}
              title={CARD_LABEL[selected.cardType]}
            />
            <div className="wgt-clt-info">
              <div className="wgt-clt-identity">
                {selected.jerseyNo && <span className="wgt-clt-jersey">{selected.jerseyNo}</span>}
                <span className="wgt-clt-name">{selected.name}</span>
                <span className="wgt-clt-team-name" style={{ color: selected.teamColor }}>{selected.teamName}</span>
              </div>
              <div className="wgt-clt-card-label" style={{ color: CARD_COLOR[selected.cardType] }}>
                {CARD_LABEL[selected.cardType]}
              </div>
            </div>
            {allCardPlayers.length > 1 && (
              <button
                className="wgt-clt-switch-btn"
                title="Switch player"
                onPointerDown={(e) => { e.stopPropagation(); e.currentTarget.setPointerCapture(e.pointerId); setShowPicker(true); }}
                onClick={(e) => e.stopPropagation()}
              >⇄ {allCardPlayers.length}</button>
            )}
          </>
        ) : (
          <div className="wgt-clt-empty">No players with cards</div>
        )}
      </div>

      {/* ── Actions ───────────────────────────────────────────────────────── */}
      <div className="wgt-clt-actions">
        <button
          className="wgt-clt-pick-btn"
          onPointerDown={(e) => { e.stopPropagation(); e.currentTarget.setPointerCapture(e.pointerId); setShowPicker(true); }}
          onClick={(e) => e.stopPropagation()}
          disabled={allCardPlayers.length === 0}
          title="Pick player"
        >▾ Pick</button>
        <button
          className="wgt-clt-btn wgt-clt-btn--send"
          onPointerDown={(e) => { e.stopPropagation(); e.currentTarget.setPointerCapture(e.pointerId); sendToVmix(selected); }}
          onClick={(e) => e.stopPropagation()}
          disabled={!client || !hasInput || !selected}
          title="Send to vMix"
        >↑ Send</button>
        <button
          className={`wgt-clt-btn wgt-clt-btn--show${overlayActive ? ' wgt-clt-btn--active' : ''}`}
          onPointerDown={(e) => { e.stopPropagation(); e.currentTarget.setPointerCapture(e.pointerId); overlayIn(ch, config.vmixInputKey || undefined); }}
          onClick={(e) => e.stopPropagation()}
          disabled={!vmixState || !hasInput}
          title="Show overlay"
        >▶ Show</button>
        <button
          className={`wgt-clt-btn wgt-clt-btn--hide${!overlayActive ? ' wgt-clt-btn--active' : ''}`}
          onPointerDown={(e) => { e.stopPropagation(); e.currentTarget.setPointerCapture(e.pointerId); overlayOut(ch); }}
          onClick={(e) => e.stopPropagation()}
          disabled={!vmixState || !hasInput}
          title="Hide overlay"
        >■ Hide</button>
      </div>
    </div>
  );
}
