import { useEffect, useRef, useState } from 'react';
import { X, ChevronDown, ArrowUp, Eye, EyeOff, ArrowLeftRight } from 'lucide-react';
import { useCanvasStore } from '../../stores/canvasStore';
import { useVmixStore } from '../../stores/vmixStore';
import { useTeamDbStore } from '../../stores/teamDbStore';
import { useAppSettings } from '../../stores/appSettingsStore';
import { autoLinkedWidgetPair } from '../../lib/autoLink';
import { resolvePlayerListRoster } from '../../lib/playerListSquad';
import { simplifyPlayerName, type SimpleNameOptions } from '../../lib/simpleName';
import { resolveImageUrl } from '../../lib/imageUrl';
import type { CanvasWidget } from '../../types/canvas';
import type { SavedTeam } from '../../stores/teamDbStore';

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
  teamLogo?: string;
  teamSide: 'A' | 'B';
  cardType: RugbyCard;
}

const CARD_COLOR: Record<RugbyCard, string> = {
  yellow: '#f1c40f',
  orange: '#e67e22',
  red:    '#e74c3c',
};

// vMix merge composer (WidgetConfigPanel's 'card-lower-third' case).
type CardMergeKey = 'jersey' | 'name' | 'team' | 'cardType';
function resolveCardMergePart(player: CardPlayer, key: CardMergeKey): string {
  if (key === 'jersey') return player.jerseyNo;
  if (key === 'name') return player.name;
  if (key === 'team') return player.teamName;
  return CARD_LABEL[player.cardType];
}

const CARD_LABEL: Record<RugbyCard, string> = {
  yellow: 'Yellow Card',
  orange: 'Orange Card',
  red:    'Red Card',
};

function resolveCardPlayers(plw: CanvasWidget | undefined, teamDbTeams: SavedTeam[], side: 'A' | 'B', simpleNameOpts: SimpleNameOptions): CardPlayer[] {
  if (!plw) return [];

  const { team, playerCards } = resolvePlayerListRoster(plw, side, teamDbTeams);
  const players = team?.players ?? [];

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
      name: player ? simplifyPlayerName(player.name, simpleNameOpts) : '?',
      jerseyNo: player?.jerseyNo ?? '',
      teamName: team?.name ?? (side === 'A' ? 'Team A' : 'Team B'),
      teamColor: team?.color ?? (side === 'A' ? '#e74c3c' : '#3498db'),
      teamLogo: team?.logo,
      teamSide: side,
      cardType,
    });
  }

  return results;
}

export function CardLowerThirdWidget({ widgetId, config }: Props) {
  const { pages } = useCanvasStore();
  const { teams: teamDbTeams } = useTeamDbStore();
  const { client, vmixState, overlayIn, overlayOut, vmixSyncVersion } = useVmixStore();
  const { simplifyMuhammadNames, simplifyFirstNameOnly, removeBinMarkers, truncateAtBinMarker } = useAppSettings();
  const simpleNameOpts: SimpleNameOptions = { simplifyMuhammad: simplifyMuhammadNames, firstNameOnly: simplifyFirstNameOnly, removeBinMarkers, truncateAtBinMarker };

  // Falls back to the two Player List widgets on this page (assigned by
  // their own teamSide A/B, or left-to-right position) when neither side's
  // been explicitly linked in settings — an explicit pick always wins. A
  // lone side-by-side Player List widget covers both sides by itself.
  const { a: playerListA, b: playerListB } = autoLinkedWidgetPair(
    pages, widgetId, config.linkedPlayerListA, config.linkedPlayerListB, 'player-list'
  );

  const teamAPlayers = resolveCardPlayers(playerListA, teamDbTeams, 'A', simpleNameOpts);
  const teamBPlayers = resolveCardPlayers(playerListB, teamDbTeams, 'B', simpleNameOpts);
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
  const hasInput = !!(
    config.vmixInputKeyYellow || config.vmixInputKeyOrange || config.vmixInputKeyRed || config.vmixInputKey
  );

  const resolveInputKey = (cardType: RugbyCard): string => {
    if (cardType === 'yellow') return config.vmixInputKeyYellow ?? config.vmixInputKey ?? '';
    if (cardType === 'orange') return config.vmixInputKeyOrange ?? config.vmixInputKey ?? '';
    return config.vmixInputKeyRed ?? config.vmixInputKey ?? '';
  };

  const sendToVmix = (player: CardPlayer | null) => {
    if (!client || !player) return;
    const key = resolveInputKey(player.cardType);
    if (!key) return;
    if (config.fieldJersey)   client.setTextField(key, config.fieldJersey,   player.jerseyNo);
    if (config.fieldName)     client.setTextField(key, config.fieldName,     player.name);
    if (config.fieldTeam)     client.setTextField(key, config.fieldTeam,     player.teamName);
    if (config.fieldCardType) client.setTextField(key, config.fieldCardType, CARD_LABEL[player.cardType]);
    if (config.fieldTeamLogo && player.teamLogo) client.setImageField(key, config.fieldTeamLogo, player.teamLogo);
    if (config.mergedPrefix && config.mergedParts?.length) {
      client.setTextField(key, config.mergedPrefix, config.mergedParts.map((k: CardMergeKey) => resolveCardMergePart(player, k)).join(config.mergedSeparator ?? ' '));
    }
  };

  const selectedInputKey = selected ? resolveInputKey(selected.cardType) : undefined;

  const lastSentRef = useRef<string | null>(null);
  useEffect(() => {
    if (!config.autoSend || !selected) return;
    const key = `${selected.playerId}:${selected.cardType}`;
    if (key === lastSentRef.current) return;
    lastSentRef.current = key;
    sendToVmix(selected);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected?.playerId, selected?.cardType, config.autoSend]);

  // Re-push on reconnect regardless of dedup guard
  useEffect(() => {
    if (!config.autoSend || !selected) return;
    sendToVmix(selected);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vmixSyncVersion]);

  const configured = !!(playerListA || playerListB);

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
            ><X size={14} strokeWidth={2} /></button>
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
          <div className="wgt-clt-empty">Link player lists in settings</div>
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
                {selected.teamLogo && <img className="wgt-clt-team-logo" src={resolveImageUrl(selected.teamLogo)} alt="" />}
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
                style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}
              ><ArrowLeftRight size={12} strokeWidth={2} /> {allCardPlayers.length}</button>
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
          style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}
        ><ChevronDown size={12} strokeWidth={2} /> Pick</button>
        <button
          className="wgt-clt-btn wgt-clt-btn--send"
          onPointerDown={(e) => { e.stopPropagation(); e.currentTarget.setPointerCapture(e.pointerId); sendToVmix(selected); }}
          onClick={(e) => e.stopPropagation()}
          disabled={!client || !hasInput || !selected}
          title="Send to vMix"
          style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}
        ><ArrowUp size={12} strokeWidth={2} /> Send</button>
        <button
          className={`wgt-clt-btn wgt-clt-btn--show${overlayActive ? ' wgt-clt-btn--active' : ''}`}
          onPointerDown={(e) => { e.stopPropagation(); e.currentTarget.setPointerCapture(e.pointerId); overlayIn(ch, selectedInputKey); }}
          onClick={(e) => e.stopPropagation()}
          disabled={!vmixState || !hasInput}
          title="Show overlay"
          style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}
        ><Eye size={12} strokeWidth={2} /> Show</button>
        <button
          className={`wgt-clt-btn wgt-clt-btn--hide${!overlayActive ? ' wgt-clt-btn--active' : ''}`}
          onPointerDown={(e) => { e.stopPropagation(); e.currentTarget.setPointerCapture(e.pointerId); overlayOut(ch); }}
          onClick={(e) => e.stopPropagation()}
          disabled={!vmixState || !hasInput}
          title="Hide overlay"
          style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}
        ><EyeOff size={12} strokeWidth={2} /> Hide</button>
      </div>
    </div>
  );
}
