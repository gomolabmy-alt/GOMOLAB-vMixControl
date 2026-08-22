import { useState, useMemo, useContext } from 'react';
import { ArrowDown, ArrowUp, ArrowRight, X, Eye, EyeOff } from 'lucide-react';
import { useCanvasStore, formatTime } from '../../stores/canvasStore';
import { CanvasActionContext } from '../../lib/canvasContext';
import { useTeamDbStore } from '../../stores/teamDbStore';
import { useVmixStore } from '../../stores/vmixStore';
import { useAppSettings } from '../../stores/appSettingsStore';
import { autoLinkedWidget, autoLinkedWidgetId, autoLinkedWidgetPair } from '../../lib/autoLink';
import { isDualPlayerList, resolvePlayerListRoster } from '../../lib/playerListSquad';
import { findTeamRecord } from '../../lib/teamForm';
import { simplifyPlayerName } from '../../lib/simpleName';
import { resolveImageUrl, transparentLogoUrl } from '../../lib/imageUrl';
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
  jerseyOut: string;
  jerseyIn: string;
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
  const { getClient, vmixState, overlayIn, overlayOut } = useVmixStore();
  // Simple Names (App Settings) — prefills the confirm dialog and every
  // read-only row; the operator can still hand-edit the confirm dialog's
  // text before it's sent, and nothing here writes back to the roster.
  const { simplifyMuhammadNames, simplifyFirstNameOnly, removeBinMarkers, truncateAtBinMarker } = useAppSettings();
  const disp = (name: string) => simplifyPlayerName(name, { simplifyMuhammad: simplifyMuhammadNames, firstNameOnly: simplifyFirstNameOnly, removeBinMarkers, truncateAtBinMarker });

  const [selOut, setSelOut] = useState<string | null>(null);
  const [selIn, setSelIn] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<ConfirmState | null>(null);
  const [lastSub, setLastSub] = useState<{ out: string; in: string; jerseyOut: string; jerseyIn: string } | null>(null);

  // Follows a linked (or auto-detected) Scoreboard's own Team A/B — the
  // same team-and-roster source every other side-aware widget in this app
  // resolves through (Rugby Lineup, Card Display, Score Lower Third, Sin
  // Bin, Timeline) — rather than requiring a separately hand-picked Player
  // List widget. Each Quick Sub widget instance is single-team: Team Side
  // (settings-only) picks which of the scoreboard's two CURRENT teams this
  // widget serves; add a second widget with the other side for the rest.
  const side: 'A' | 'B' = cfg.teamSide ?? 'A';
  const linkedScoreboard = autoLinkedWidget(pages, widgetId, cfg.linkedScoreboardId, 'scoreboard');
  const dc = linkedScoreboard?.config ?? {};
  // '|| undefined' so a scoreboard whose name field is blank but whose id
  // IS set doesn't win an empty string over a real resolved name below.
  const scoreboardTeamId: string | undefined = linkedScoreboard ? (side === 'A' ? dc.teamAId : dc.teamBId) : undefined;
  const scoreboardTeamName: string | undefined = linkedScoreboard ? ((side === 'A' ? dc.teamAName : dc.teamBName) || undefined) : undefined;

  // Player List: explicit pick wins, else whichever side of the linked
  // Scoreboard's own paired Player Lists matches this widget's side, else
  // the sole Player List widget on the page (old single-team behavior, for
  // a standalone Quick Sub with no Scoreboard linked).
  const { a: sbPlA, b: sbPlB } = linkedScoreboard
    ? autoLinkedWidgetPair(pages, linkedScoreboard.id, dc.linkedPlayerListA, dc.linkedPlayerListB, 'player-list')
    : { a: undefined, b: undefined };
  const linkedPl = cfg.linkedPlayerListId
    ? pages.flatMap(p => p.widgets).find(w => w.id === cfg.linkedPlayerListId)
    : (side === 'A' ? sbPlA : sbPlB) ?? autoLinkedWidget(pages, widgetId, undefined, 'player-list');
  const roster = resolvePlayerListRoster(linkedPl, side, teamDbTeams);

  // Team: whichever team the linked Player List already resolved for this
  // side (most authoritative), else the Scoreboard's own team id/name
  // looked up in the Team DB directly (works with no Player List widget on
  // the page at all).
  const team = roster.team
    ?? (scoreboardTeamId ? teamDbTeams.find(t => t.id === scoreboardTeamId) : undefined)
    ?? (scoreboardTeamName ? findTeamRecord(teamDbTeams, scoreboardTeamName, dc.category, dc.linkedTournamentId) : undefined);
  const players: Player[] = team?.players ?? [];

  const playerListWidget = linkedPl ?? null;
  const activePrefix = linkedPl && isDualPlayerList(linkedPl) ? (side === 'A' ? 'a_' : 'b_') : '';
  const plCfg = playerListWidget?.config ?? {};

  // Falls back to the sole Timer/Timeline widget on this page when nothing's
  // been explicitly linked in settings — an explicit pick always wins.
  const timerWidget = autoLinkedWidget(pages, widgetId, cfg.linkedTimerWidgetId, 'timer') ?? null;
  const linkedTimelineId = autoLinkedWidgetId(pages, widgetId, cfg.linkedTimelineId, 'timeline');
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

  const starterSlots: string[] = roster.starters;
  const subSlots: string[] = roster.subs;
  const onField: string[] = roster.onField;
  // Not part of PlayerListRoster (playtime tracking only, unused by Rugby
  // Lineup — the other consumer of that shared helper) — read directly with
  // the same prefix.
  const entries: Record<string, number> = plCfg[`${activePrefix}entries`] ?? {};
  const accumulated: Record<string, number> = plCfg[`${activePrefix}accumulated`] ?? {};

  // Every starter slot is eligible to come off, whether or not "Kickoff"
  // has been pressed yet on the Player List widget — starters/subs already
  // stays self-maintaining as slots swap, so gating this on the separate
  // onField ledger (playtime tracking only, see PlayerListWidget's own
  // kickoff()) just meant a starter was unreachable here until an operator
  // remembered to go trigger kickoff on a different widget first.
  const onFieldPlayers = useMemo(() =>
    starterSlots.filter(id => id && playerById[id]).map(id => playerById[id]) as Player[],
    [starterSlots, playerById]
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
      nameOut: playerById[outId] ? disp(playerById[outId].name) : '',
      nameIn: playerById[inId] ? disp(playerById[inId].name) : '',
      jerseyOut: playerById[outId]?.jerseyNo || '',
      jerseyIn: playerById[inId]?.jerseyNo || '',
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

  const executeSwap = (outId: string, inId: string, nameOut: string, nameIn: string, jerseyOut: string, jerseyIn: string) => {
    const outgoing = playerById[outId];
    const incoming = playerById[inId];
    if (!outgoing || !incoming) return;

    // Send names + jersey numbers to vMix (all linked inputs) — same
    // name+jersey pairing every other player-facing widget in this app
    // sends (Player/Score/Card Lower Third, etc.); this used to only ever
    // send the name.
    const subTargets: Array<{inputKey:string;vmixFieldOut?:string;vmixFieldIn?:string;vmixFieldJerseyOut?:string;vmixFieldJerseyIn?:string;vmixFieldLogo?:string;mergedPrefix?:string;mergedParts?:string[];mergedSeparator?:string}> = cfg.vmixInputs?.length
      ? cfg.vmixInputs
      : cfg.vmixInputKey
        ? [{ inputKey: cfg.vmixInputKey, vmixFieldOut: cfg.vmixFieldOut, vmixFieldIn: cfg.vmixFieldIn, vmixFieldJerseyOut: cfg.vmixFieldJerseyOut, vmixFieldJerseyIn: cfg.vmixFieldJerseyIn, vmixFieldLogo: cfg.vmixFieldLogo }]
        : [];
    for (const t of subTargets) {
      if (!t.inputKey) continue;
      getClient()?.setTextField(t.inputKey, t.vmixFieldOut || 'PlayerOff.Text', nameOut);
      getClient()?.setTextField(t.inputKey, t.vmixFieldIn  || 'PlayerOn.Text',  nameIn);
      if (t.vmixFieldJerseyOut) getClient()?.setTextField(t.inputKey, t.vmixFieldJerseyOut, jerseyOut);
      if (t.vmixFieldJerseyIn)  getClient()?.setTextField(t.inputKey, t.vmixFieldJerseyIn,  jerseyIn);
      if (t.vmixFieldLogo) getClient()?.setImageField(t.inputKey, t.vmixFieldLogo, team?.logo || transparentLogoUrl());
      if (t.mergedPrefix && t.mergedParts?.length) {
        const src: Record<string, string> = { out: nameOut, in: nameIn, jerseyOut, jerseyIn };
        getClient()?.setTextField(t.inputKey, t.mergedPrefix, t.mergedParts.map(k => src[k] ?? '').join(t.mergedSeparator ?? ' '));
      }
    }

    const timePlayed = (accumulated[outId] ?? 0) +
      elapsed(entries[outId] ?? currentMs);

    const nextStarters = [...starterSlots];
    const nextSubs = [...subSlots];
    const starterIdx = nextStarters.indexOf(outId);
    const subIdx = nextSubs.indexOf(inId);
    if (starterIdx >= 0) nextStarters[starterIdx] = inId;
    if (subIdx >= 0) nextSubs[subIdx] = outId;

    // A sub made here can be the very first roster action of the match —
    // Quick Sub has no Kickoff button of its own, so if the other starters
    // were never marked on-field yet (PlayerListWidget's kickoff() never
    // ran), fold that in now: everyone still starting gets their playtime
    // clock started from this moment, same as a real kickoff would.
    const kickoffIds = starterSlots.filter(id => id && id !== outId && !onField.includes(id));
    const nextEntries = { ...entries };
    kickoffIds.forEach(id => { nextEntries[id] = currentMs; });
    nextEntries[inId] = currentMs;

    const subbedOnPlayers: string[] = roster.subbedOnPlayers;
    const targetId = playerListWidget ? playerListWidget.id : widgetId;
    updateWidgetConfig(targetId, {
      [`${activePrefix}starters`]: nextStarters,
      [`${activePrefix}subs`]: nextSubs,
      [`${activePrefix}onField`]: [...new Set([...onField.filter(id => id !== outId), ...kickoffIds, inId])],
      [`${activePrefix}entries`]: nextEntries,
      [`${activePrefix}accumulated`]: { ...accumulated, [outId]: timePlayed },
      [`${activePrefix}subbedOnPlayers`]: [...new Set([...subbedOnPlayers, inId])],
    });

    if (linkedTimelineId) {
      addTimelineEvent(linkedTimelineId, {
        type: 'substitution', team: side, timeMs: Date.now(),
        timeStr: timerCfg ? formatTime(currentMs, timeFormat) : wallClock(),
        player: nameIn,
        playerOff: nameOut,
        jerseyNo: incoming.jerseyNo || undefined,
        jerseyNoOff: outgoing.jerseyNo || undefined,
      });
    }

    setLastSub({ out: nameOut, in: nameIn, jerseyOut, jerseyIn });
    cancelSelection();
  };

  const teamColor = team?.color ?? '#3498db';

  // vMix overlay show/hide — same OverlayInput{ch}In/Out convention every
  // lower-third widget in this app uses (Player/Score/Card Lower Third),
  // targeting whichever vMix input this widget's Sub Overlay is configured
  // to push into (the first one, if several are configured).
  const overlayCh: number = cfg.overlayChannel ?? 1;
  const primaryInputKey: string | undefined = cfg.vmixInputs?.[0]?.inputKey || cfg.vmixInputKey;
  const overlay = vmixState?.overlays?.find((o: any) => o.number === overlayCh);
  const overlayActive = !!(overlay && overlay.key !== '');

  return (
    <div className="wgt-sub">
      <div className="wgt-sub-header" style={{ '--tc': teamColor } as React.CSSProperties}>
        <span className="wgt-sub-team-dot" style={{ background: teamColor }} />
        {team?.logo && <img className="wgt-sub-team-logo" src={resolveImageUrl(team.logo)} alt="" />}
        <span className="wgt-sub-team-name">{team?.name ?? '—'}</span>
        <span className="wgt-sub-title">Quick Sub</span>
      </div>

      <div className="wgt-sub-vmix-actions">
        <button
          className={`wgt-sub-vmix-btn wgt-sub-vmix-btn--show${overlayActive ? ' wgt-sub-vmix-btn--active' : ''}`}
          onClick={() => overlayIn(overlayCh, primaryInputKey || undefined)}
          disabled={!vmixState || !primaryInputKey}
          title="Show sub overlay on vMix"
        ><Eye size={12} strokeWidth={2} /> Show</button>
        <button
          className={`wgt-sub-vmix-btn wgt-sub-vmix-btn--hide${!overlayActive ? ' wgt-sub-vmix-btn--active' : ''}`}
          onClick={() => overlayOut(overlayCh)}
          disabled={!vmixState || !primaryInputKey}
          title="Hide sub overlay from vMix"
        ><EyeOff size={12} strokeWidth={2} /> Hide</button>
      </div>

      {!playerListWidget ? (
        <div className="wgt-sub-empty">Link a Scoreboard or Player List widget in settings</div>
      ) : !team ? (
        <div className="wgt-sub-empty">No team loaded yet</div>
      ) : confirm ? (
        /* ── Confirmation dialog ── */
        <div className="wgt-sub-confirm">
          <div className="wgt-sub-confirm-title">Confirm Substitution</div>

          <div className="wgt-sub-confirm-row">
            <span className="wgt-sub-confirm-lbl wgt-sub-confirm-lbl--off" style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}><ArrowDown size={12} strokeWidth={2} /> Off</span>
            {confirm.jerseyOut && <span className="wgt-sub-no">{confirm.jerseyOut}</span>}
            <input
              className="wgt-sub-confirm-inp"
              value={confirm.nameOut}
              onChange={e => setConfirm(c => c ? { ...c, nameOut: e.target.value } : c)}
            />
          </div>

          <div className="wgt-sub-confirm-row">
            <span className="wgt-sub-confirm-lbl wgt-sub-confirm-lbl--in" style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}><ArrowUp size={12} strokeWidth={2} /> On</span>
            {confirm.jerseyIn && <span className="wgt-sub-no">{confirm.jerseyIn}</span>}
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
              onClick={() => executeSwap(confirm.outId, confirm.inId, confirm.nameOut, confirm.nameIn, confirm.jerseyOut, confirm.jerseyIn)}
            >
              Confirm Sub
            </button>
          </div>
        </div>
      ) : (
        <>
          {(selOut || selIn) && (
            <div className="wgt-sub-pending">
              {selOut && <span className="wgt-sub-pending-off" style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}><ArrowDown size={12} strokeWidth={2} /> {playerById[selOut] ? `${playerById[selOut].jerseyNo ? `#${playerById[selOut].jerseyNo} ` : ''}${disp(playerById[selOut].name)}` : ''}</span>}
              {selOut && selIn && <span className="wgt-sub-pending-arr"><ArrowRight size={12} strokeWidth={2} /></span>}
              {selIn && <span className="wgt-sub-pending-in" style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}><ArrowUp size={12} strokeWidth={2} /> {playerById[selIn] ? `${playerById[selIn].jerseyNo ? `#${playerById[selIn].jerseyNo} ` : ''}${disp(playerById[selIn].name)}` : ''}</span>}
              <button className="wgt-sub-cancel" onClick={cancelSelection}><X size={12} strokeWidth={2} /></button>
            </div>
          )}

          {lastSub && !selOut && !selIn && (
            <div className="wgt-sub-last">
              Last: {lastSub.jerseyOut && `#${lastSub.jerseyOut} `}{lastSub.out} → {lastSub.jerseyIn && `#${lastSub.jerseyIn} `}{lastSub.in}
            </div>
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
                  <span className="wgt-sub-name">{disp(p.name)}</span>
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
                  <span className="wgt-sub-name">{disp(p.name)}</span>
                </button>
              ))}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
