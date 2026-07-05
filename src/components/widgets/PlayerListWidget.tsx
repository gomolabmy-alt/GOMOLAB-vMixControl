import { useState, useMemo, useCallback, useEffect, useRef, useContext } from 'react';
import { useCanvasStore, formatTime } from '../../stores/canvasStore';
import { CanvasActionContext } from '../../lib/canvasContext';
import { useTournamentStore } from '../../stores/tournamentStore';
import { useVmixStore } from '../../stores/vmixStore';
import { SPORT_DEFAULTS, DEFAULT_STAFF_ROLES } from '../../types/tournament';
import type { Player, StaffMember } from '../../types/tournament';

interface Props {
  widgetId: string;
  config: Record<string, any>;
}

function wallClock(): string {
  const d = new Date();
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export function PlayerListWidget({ widgetId, config: cfg }: Props) {
  const store = useCanvasStore();
  const ctx = useContext(CanvasActionContext);
  const { pages, addTimelineEvent } = store;
  const updateWidgetConfig = ctx?.updateWidgetConfig ?? store.updateWidgetConfig;
  const highlightPlayer = (player: Player) => {
    const targetId = cfg.linkedPlayerHighlightId;
    if (!targetId) return;
    updateWidgetConfig(targetId, {
      highlightedPlayerId:   player.id,
      highlightedName:       player.name,
      highlightedJersey:     player.jerseyNo,
      highlightedPosition:   player.position,
      highlightedTeam:       team?.name ?? '',
      highlightedTeamColor:  team?.color ?? '',
      highlightedSide:       side,
    });
  };
  const { tournaments, updatePlayer, updateTeam, updateStaffMember } = useTournamentStore();
  const { getClient, vmixState, vmixSyncVersion } = useVmixStore();

  // Slot assignment picker
  const [picking, setPicking] = useState<{ section: 'starter' | 'sub'; idx: number } | null>(null);
  // Sub swap: ID of bench player staged to enter
  const [pendingSubIn, setPendingSubIn] = useState<string | null>(null);
  // Card picker: which card type is being assigned
  const [cardPicker, setCardPicker] = useState<'yellow' | 'orange' | 'red' | null>(null);

  const tournament = tournaments.find(t => t.id === cfg.linkedTournamentId);
  const side: 'A' | 'B' = cfg.teamSide ?? 'A';
  const team = side === 'A' ? tournament?.teamA : tournament?.teamB;
  const players: Player[] = team?.players ?? [];

  const timerWidget = cfg.linkedTimerWidgetId
    ? pages.flatMap(p => p.widgets).find(w => w.id === cfg.linkedTimerWidgetId)
    : null;
  const timerCfg = timerWidget?.config ?? null;
  const currentMs: number = timerCfg?.currentMs ?? 0;
  const timeFormat: string = timerCfg?.format ?? 'mm:ss';
  const timerDown = timerCfg?.mode === 'countdown';

  // Returns ms elapsed since entryMs, regardless of timer direction
  const elapsed = (entryMs: number) =>
    timerDown ? Math.max(0, entryMs - currentMs) : Math.max(0, currentMs - entryMs);

  const settings = tournament ? (tournament.settings ?? SPORT_DEFAULTS[tournament.sport]) : null;
  const maxOnField: number = settings?.maxOnField ?? 11;
  const maxSubs: number = settings?.maxSubs ?? 7;

  // Slot arrays (always padded to exact length with '' for empty slots)
  const starterSlots: string[] = useMemo(() =>
    Array.from({ length: maxOnField }, (_, i) => (cfg.starters ?? [])[i] ?? ''),
    [cfg.starters, maxOnField]
  );
  const subSlots: string[] = useMemo(() =>
    Array.from({ length: maxSubs }, (_, i) => (cfg.subs ?? [])[i] ?? ''),
    [cfg.subs, maxSubs]
  );

  const onField: string[] = cfg.onField ?? [];
  const entries: Record<string, number> = cfg.entries ?? {};
  const accumulated: Record<string, number> = cfg.accumulated ?? {};
  const subbedOnPlayers: string[] = cfg.subbedOnPlayers ?? [];

  const playerById = useMemo(() =>
    Object.fromEntries(players.map(p => [p.id, p])),
    [players]
  );

  const SPECIAL_JERSEY_ROLES: Record<string, string> = {
    MNG: 'Manager',
    HC: 'Head Coach',
  };
  const specialRole = (jerseyNo: string) => SPECIAL_JERSEY_ROLES[jerseyNo.toUpperCase()] ?? null;

  const sortedPlayers = useMemo(() =>
    [...players].sort((a, b) => {
      const n1 = parseInt(a.jerseyNo) || 999;
      const n2 = parseInt(b.jerseyNo) || 999;
      return n1 !== n2 ? n1 - n2 : a.name.localeCompare(b.name);
    }),
    [players]
  );

  const assignedIds = useMemo(() =>
    new Set([
      ...starterSlots.filter(id => id && playerById[id]),
      ...subSlots.filter(id => id && playerById[id]),
    ]),
    [starterSlots, subSlots, playerById]
  );

  const unassigned = useMemo(() =>
    sortedPlayers.filter(p => !assignedIds.has(p.id)),
    [sortedPlayers, assignedIds]
  );

  const teamColor = team?.color ?? '#3498db';
  const showTime = cfg.showTime !== false && timerCfg !== null;
  const showPos = cfg.showPosition !== false;

  const highlightWidget = cfg.linkedPlayerHighlightId
    ? pages.flatMap(p => p.widgets).find(w => w.id === cfg.linkedPlayerHighlightId)
    : null;
  const highlightedPlayerId: string = highlightWidget?.config.highlightedPlayerId ?? '';

  // Resolve all vMix name-sync targets (multi-input or legacy single)
  const plVmixTargets: Array<{inputKey:string;vmixNamePrefix?:string;vmixJerseyPrefix?:string;vmixAutoSync?:boolean}> =
    cfg.vmixInputs?.length
      ? cfg.vmixInputs
      : cfg.vmixInputKey
        ? [{ inputKey: cfg.vmixInputKey, vmixNamePrefix: cfg.vmixNamePrefix, vmixJerseyPrefix: cfg.vmixJerseyPrefix, vmixAutoSync: cfg.vmixAutoSync }]
        : [];

  // vMix name sync: slotIdx is 1-based; overrides let callers pass fresh values before store update propagates
  const syncName = useCallback((slotIdx: number, playerId: string | null, overrides?: { name?: string; jerseyNo?: string }) => {
    const c = getClient();
    for (const t of plVmixTargets) {
      if (!t.inputKey || !t.vmixAutoSync) continue;
      const p = playerId ? playerById[playerId] : null;
      const name     = overrides?.name     ?? p?.name     ?? '';
      const jerseyNo = overrides?.jerseyNo ?? p?.jerseyNo ?? '';
      if (t.vmixNamePrefix && c)   c.setTextField(t.inputKey, `${t.vmixNamePrefix}${slotIdx}.Text`, name);
      if (t.vmixJerseyPrefix && c) c.setTextField(t.inputKey, `${t.vmixJerseyPrefix}${slotIdx}.Text`, jerseyNo);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cfg.vmixInputs, cfg.vmixInputKey, cfg.vmixAutoSync, cfg.vmixNamePrefix, cfg.vmixJerseyPrefix, playerById, getClient]);

  const syncAllNames = useCallback(() => {
    if (!plVmixTargets.length) return;
    const lastUsedIdx = maxOnField + subSlots.length;
    const c = getClient();
    if (!c) return;
    for (const t of plVmixTargets) {
      if (!t.inputKey) continue;
      starterSlots.forEach((id, i) => {
        const p = id ? playerById[id] : null;
        if (t.vmixNamePrefix)   c.setTextField(t.inputKey, `${t.vmixNamePrefix}${i + 1}.Text`,              p?.name     ?? '');
        if (t.vmixJerseyPrefix) c.setTextField(t.inputKey, `${t.vmixJerseyPrefix}${i + 1}.Text`,            p?.jerseyNo ?? '');
      });
      subSlots.forEach((id, i) => {
        const p = id ? playerById[id] : null;
        if (t.vmixNamePrefix)   c.setTextField(t.inputKey, `${t.vmixNamePrefix}${maxOnField + i + 1}.Text`,   p?.name     ?? '');
        if (t.vmixJerseyPrefix) c.setTextField(t.inputKey, `${t.vmixJerseyPrefix}${maxOnField + i + 1}.Text`, p?.jerseyNo ?? '');
      });
      // Clear any extra same-prefix fields in the vMix input beyond the last used slot
      const vmixInput = vmixState?.inputs?.find(inp => inp.key === t.inputKey);
      if (vmixInput) {
        const clearExtras = (prefix: string) => {
          if (!prefix) return;
          const esc = prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          const re = new RegExp(`^${esc}(\\d+)\\.Text$`, 'i');
          for (const field of vmixInput.textFields) {
            const m = field.name.match(re);
            if (m && parseInt(m[1]) > lastUsedIdx) c.setTextField(t.inputKey, field.name, '');
          }
        };
        clearExtras(t.vmixNamePrefix ?? '');
        clearExtras(t.vmixJerseyPrefix ?? '');
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cfg.vmixInputs, cfg.vmixInputKey, cfg.vmixNamePrefix, cfg.vmixJerseyPrefix, starterSlots, subSlots, playerById, maxOnField, getClient, vmixState]);

  // vMix staff names sync (MNG → Manager field, HC → Head Coach field)
  const sendStaffToVmix = useCallback(() => {
    const key = cfg.vmixStaffInputKey;
    if (!key) return;
    const c = getClient();
    if (!c) return;
    const manager = players.find(p => p.jerseyNo?.toUpperCase() === 'MNG');
    const hc      = players.find(p => p.jerseyNo?.toUpperCase() === 'HC');
    if (cfg.vmixManagerField) c.setTextField(key, cfg.vmixManagerField, manager?.name ?? '');
    if (cfg.vmixHCField)      c.setTextField(key, cfg.vmixHCField,      hc?.name      ?? '');
  }, [cfg.vmixStaffInputKey, cfg.vmixManagerField, cfg.vmixHCField, players, getClient]);

  useEffect(() => {
    if (cfg.vmixStaffAutoSync) sendStaffToVmix();
  }, [
    players.find(p => p.jerseyNo?.toUpperCase() === 'MNG')?.name,
    players.find(p => p.jerseyNo?.toUpperCase() === 'HC')?.name,
    cfg.vmixStaffAutoSync,
    sendStaffToVmix,
    vmixSyncVersion,
  ]);

  // vMix team title sync
  const sendTeamToVmix = useCallback(() => {
    const key = cfg.vmixTeamInputKey;
    if (!key || !team) return;
    const c = getClient();
    if (!c) return;
    if (cfg.vmixTeamFieldName) c.setTextField(key, cfg.vmixTeamFieldName, team.name ?? '');
    if (cfg.vmixTeamFieldShort) c.setTextField(key, cfg.vmixTeamFieldShort, team.shortName ?? team.name ?? '');
  }, [cfg.vmixTeamInputKey, cfg.vmixTeamFieldName, cfg.vmixTeamFieldShort, team, getClient]);

  useEffect(() => {
    if (cfg.vmixTeamAutoSync) sendTeamToVmix();
  }, [team?.name, team?.shortName, cfg.vmixTeamAutoSync, sendTeamToVmix, vmixSyncVersion]);

  // Auto-send full list whenever slots change and any target has auto-sync on
  // (also re-fires on vmixSyncVersion so a reconnect re-pushes the current
  // roster instead of leaving vMix stale until the next actual slot change).
  const anyAutoSync = plVmixTargets.some(t => t.inputKey && t.vmixAutoSync && (t.vmixNamePrefix || t.vmixJerseyPrefix));
  useEffect(() => {
    if (anyAutoSync) syncAllNames();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [starterSlots.join(','), subSlots.join(','), anyAutoSync, vmixSyncVersion]);

  // ── Rugby card tracking ───────────────────────────────────────────
  type RugbyCard = 'yellow' | 'orange' | 'red';
  const playerCards: Record<string, RugbyCard[]> = cfg.playerCards ?? {};

  // Effective disciplinary status (most severe)
  const effectiveCard = (playerId: string): 'none' | 'yellow' | 'orange' | 'red' => {
    const cards = playerCards[playerId] ?? [];
    const yellows = cards.filter(c => c === 'yellow').length;
    if (cards.includes('red') || yellows >= 2) return 'red';
    if (yellows === 1) return 'yellow';
    if (cards.includes('orange')) return 'orange';
    return 'none';
  };

  const CARD_LABELS: Record<RugbyCard, string> = {
    yellow: 'Yellow card — sin bin (10 min)',
    orange: 'Orange card — HIA (player off for assessment)',
    red: 'Red card — permanent dismissal',
  };

  // Timeline event type for each card
  const CARD_TIMELINE: Record<RugbyCard, 'yellow-card' | 'orange-card' | 'red-card'> = {
    yellow: 'yellow-card',
    orange: 'orange-card',
    red: 'red-card',
  };

  // Sin bin timer tracking: maps playerId → timer currentMs at the moment they were binned
  const sinBinEntries: Record<string, number> = cfg.sinBinEntries ?? {};
  const sinBinDuration: number = cfg.sinBinDuration ?? 600000; // 10 min default

  // HIA (orange card) tracking: maps playerId → currentMs when they went off for assessment
  const orangeCardEntries: Record<string, number> = cfg.orangeCardEntries ?? {};

  const getSinBinRemaining = (playerId: string): number => {
    const startMs = sinBinEntries[playerId];
    if (startMs === undefined) return sinBinDuration;
    const timerMode: string = timerCfg?.mode ?? 'countup';
    const elapsed = timerMode === 'countdown' ? startMs - currentMs : currentMs - startMs;
    return Math.max(0, sinBinDuration - elapsed);
  };

  const returnFromSinBin = (playerId: string) => {
    const player = playerById[playerId];
    if (!player) return;
    const nextSinBinEntries = { ...sinBinEntries };
    delete nextSinBinEntries[playerId];
    updateWidgetConfig(widgetId, {
      onField: [...onField, playerId],
      entries: { ...entries, [playerId]: currentMs },
      sinBinEntries: nextSinBinEntries,
    });
    if (cfg.linkedTimelineId) {
      addTimelineEvent(cfg.linkedTimelineId, {
        type: 'substitution', team: side, timeMs: Date.now(),
        timeStr: timerCfg ? formatTime(currentMs, timeFormat) : wallClock(),
        player: player.name,
        jerseyNo: player.jerseyNo || undefined,
      });
    }
  };

  const returnFromHIA = (playerId: string) => {
    const player = playerById[playerId];
    if (!player) return;
    const nextOrangeEntries = { ...orangeCardEntries };
    delete nextOrangeEntries[playerId];
    updateWidgetConfig(widgetId, {
      onField: [...onField, playerId],
      entries: { ...entries, [playerId]: currentMs },
      orangeCardEntries: nextOrangeEntries,
    });
    if (cfg.linkedTimelineId) {
      addTimelineEvent(cfg.linkedTimelineId, {
        type: 'substitution', team: side, timeMs: Date.now(),
        timeStr: timerCfg ? formatTime(currentMs, timeFormat) : wallClock(),
        player: player.name,
        jerseyNo: player.jerseyNo || undefined,
      });
    }
  };

  const giveCard = (playerId: string, type: RugbyCard) => {
    const player = playerById[playerId];
    if (!player) return;

    const existingCards = playerCards[playerId] ?? [];
    const newCards: RugbyCard[] = [...existingCards, type];
    const yellows = newCards.filter(c => c === 'yellow').length;
    const isEffectiveRed = type === 'red' || yellows >= 2;

    const patch: Record<string, any> = { playerCards: { ...playerCards, [playerId]: newCards } };

    // All cards remove player from field (yellow=sin bin, orange=HIA off, red=dismissed)
    if (onField.includes(playerId)) {
      const timePlayed = (accumulated[playerId] ?? 0) + elapsed(entries[playerId] ?? currentMs);
      patch.onField = onField.filter(id => id !== playerId);
      patch.accumulated = { ...accumulated, [playerId]: timePlayed };
    }

    // Record sin bin start time for yellow cards (not 2nd yellow which is a red)
    if (type === 'yellow' && !isEffectiveRed) {
      patch.sinBinEntries = { ...sinBinEntries, [playerId]: currentMs };
    } else {
      // Red or 2nd yellow: clear any existing sin bin entry
      const nextSinBinEntries = { ...sinBinEntries };
      delete nextSinBinEntries[playerId];
      patch.sinBinEntries = nextSinBinEntries;
    }

    // Record HIA entry for orange cards
    if (type === 'orange') {
      patch.orangeCardEntries = { ...orangeCardEntries, [playerId]: currentMs };
    } else {
      const nextOrangeEntries = { ...orangeCardEntries };
      delete nextOrangeEntries[playerId];
      patch.orangeCardEntries = nextOrangeEntries;
    }

    updateWidgetConfig(widgetId, patch);

    if (cfg.linkedTimelineId) {
      addTimelineEvent(cfg.linkedTimelineId, {
        type: isEffectiveRed ? 'red-card' : CARD_TIMELINE[type],
        team: side,
        timeMs: Date.now(),
        timeStr: timerCfg ? formatTime(currentMs, timeFormat) : wallClock(),
        player: player.name,
        jerseyNo: player.jerseyNo || undefined,
      });
    }
    setCardPicker(null);
  };

  // Squad players eligible to receive a card (exclude permanently dismissed)
  const cardPickerOptions = useMemo(() =>
    [...starterSlots, ...subSlots]
      .filter((id, i, arr) => id && arr.indexOf(id) === i)
      .map(id => playerById[id])
      .filter((p): p is Player => !!p && effectiveCard(p.id) !== 'red'),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [starterSlots, subSlots, playerById, playerCards]
  );

  const getTimePlayed = (playerId: string): number => {
    const acc = accumulated[playerId] ?? 0;
    if (onField.includes(playerId) && entries[playerId] !== undefined) {
      return acc + elapsed(entries[playerId]);
    }
    return acc;
  };

  // ── Squad management ──────────────────────────────────────────────

  const assignToSlot = (playerId: string, section: 'starter' | 'sub', idx: number) => {
    if (section === 'starter') {
      const next = [...starterSlots];
      // If player already in subs, remove from there
      const subIdx = subSlots.indexOf(playerId);
      const nextSubs = [...subSlots];
      if (subIdx >= 0) nextSubs[subIdx] = '';
      next[idx] = playerId;
      updateWidgetConfig(widgetId, { starters: next, subs: nextSubs });
    } else {
      const next = [...subSlots];
      const starterIdx = starterSlots.indexOf(playerId);
      const nextStarters = [...starterSlots];
      if (starterIdx >= 0) nextStarters[starterIdx] = '';
      next[idx] = playerId;
      updateWidgetConfig(widgetId, { starters: nextStarters, subs: next });
    }
    setPicking(null);
  };

  const removeFromSlot = (section: 'starter' | 'sub', idx: number) => {
    if (section === 'starter') {
      const next = [...starterSlots];
      const removed = next[idx];
      next[idx] = '';
      // also remove from onField if active
      updateWidgetConfig(widgetId, {
        starters: next,
        onField: onField.filter(id => id !== removed),
      });
    } else {
      const next = [...subSlots];
      const removed = next[idx];
      next[idx] = '';
      updateWidgetConfig(widgetId, {
        subs: next,
        onField: onField.filter(id => id !== removed),
      });
    }
  };

  const moveToSection = (playerId: string, to: 'starter' | 'sub') => {
    const nextStarters = [...starterSlots];
    const nextSubs = [...subSlots];
    // Remove from current position
    const si = nextStarters.indexOf(playerId);
    if (si >= 0) nextStarters[si] = '';
    const bi = nextSubs.indexOf(playerId);
    if (bi >= 0) nextSubs[bi] = '';
    // Add to first empty slot in target
    if (to === 'starter') {
      const emptyIdx = nextStarters.indexOf('');
      if (emptyIdx >= 0) nextStarters[emptyIdx] = playerId;
    } else {
      const emptyIdx = nextSubs.indexOf('');
      if (emptyIdx >= 0) nextSubs[emptyIdx] = playerId;
    }
    updateWidgetConfig(widgetId, { starters: nextStarters, subs: nextSubs });
  };

  const addUnassignedToSection = (playerId: string, section: 'starter' | 'sub') => {
    if (section === 'starter') {
      const next = [...starterSlots];
      let idx = next.indexOf('');
      if (idx < 0) idx = next.findIndex(id => id && !playerById[id]); // replace stale slot
      if (idx >= 0) next[idx] = playerId;
      else next.push(playerId);
      updateWidgetConfig(widgetId, { starters: next });
    } else {
      const next = [...subSlots];
      let idx = next.indexOf('');
      if (idx < 0) idx = next.findIndex(id => id && !playerById[id]); // replace stale slot
      if (idx >= 0) next[idx] = playerId;
      else next.push(playerId);
      updateWidgetConfig(widgetId, { subs: next });
    }
  };

  const autoFill = () => {
    const sorted = [...sortedPlayers];
    updateWidgetConfig(widgetId, {
      starters: Array.from({ length: maxOnField }, (_, i) => sorted[i]?.id ?? ''),
      subs: Array.from({ length: maxSubs }, (_, i) => sorted[maxOnField + i]?.id ?? ''),
    });
  };

  // ── Substitution swap ─────────────────────────────────────────────

  const executeSwap = (outgoingId: string, incomingId: string) => {
    const outgoing = playerById[outgoingId];
    const incoming = playerById[incomingId];
    if (!outgoing || !incoming) return;

    // Time-tracking: record outgoing player's accumulated time
    const timePlayed = (accumulated[outgoingId] ?? 0) +
      elapsed(entries[outgoingId] ?? currentMs);

    // Swap positions in the starter/sub arrays
    const nextStarters = [...starterSlots];
    const nextSubs = [...subSlots];
    const starterIdx = nextStarters.indexOf(outgoingId);
    const subIdx = nextSubs.indexOf(incomingId);
    if (starterIdx >= 0) nextStarters[starterIdx] = incomingId;
    if (subIdx >= 0) nextSubs[subIdx] = outgoingId;

    updateWidgetConfig(widgetId, {
      starters: nextStarters,
      subs: nextSubs,
      onField: [...onField.filter(id => id !== outgoingId), incomingId],
      entries: { ...entries, [incomingId]: currentMs },
      accumulated: { ...accumulated, [outgoingId]: timePlayed },
      subbedOnPlayers: [...new Set([...subbedOnPlayers, incomingId])],
    });

    if (cfg.linkedTimelineId) {
      addTimelineEvent(cfg.linkedTimelineId, {
        type: 'substitution', team: side, timeMs: Date.now(),
        timeStr: timerCfg ? formatTime(currentMs, timeFormat) : wallClock(),
        player: incoming.name,
        playerOff: outgoing.name,
        jerseyNo: incoming.jerseyNo || undefined,
        jerseyNoOff: outgoing.jerseyNo || undefined,
      });
    }
    setPendingSubIn(null);
  };

  // ── On-field tracking ─────────────────────────────────────────────

  const toggleOnField = (player: Player) => {
    const active = onField.includes(player.id);
    if (active) {
      const timePlayed = (accumulated[player.id] ?? 0) + elapsed(entries[player.id] ?? currentMs);
      updateWidgetConfig(widgetId, {
        onField: onField.filter(id => id !== player.id),
        accumulated: { ...accumulated, [player.id]: timePlayed },
      });
      if (cfg.linkedTimelineId) {
        addTimelineEvent(cfg.linkedTimelineId, {
          type: 'substitution', team: side, timeMs: Date.now(),
          timeStr: timerCfg ? formatTime(currentMs, timeFormat) : wallClock(),
          playerOff: player.name,
          jerseyNoOff: player.jerseyNo || undefined,
        });
      }
    } else {
      const fromBench = subSlots.includes(player.id);
      updateWidgetConfig(widgetId, {
        onField: [...onField, player.id],
        entries: { ...entries, [player.id]: currentMs },
        ...(fromBench ? { subbedOnPlayers: [...new Set([...subbedOnPlayers, player.id])] } : {}),
      });
      if (cfg.linkedTimelineId) {
        addTimelineEvent(cfg.linkedTimelineId, {
          type: 'substitution', team: side, timeMs: Date.now(),
          timeStr: timerCfg ? formatTime(currentMs, timeFormat) : wallClock(),
          player: player.name,
          jerseyNo: player.jerseyNo || undefined,
        });
      }
    }
  };

  const kickoff = () => {
    const ids = starterSlots.filter(id => id && playerById[id]);
    const newEntries = { ...entries };
    ids.forEach(id => { if (!onField.includes(id)) newEntries[id] = currentMs; });
    updateWidgetConfig(widgetId, {
      onField: [...new Set([...onField, ...ids])],
      entries: newEntries,
    });
  };

  // Auto-kickoff when linked timer starts (false → true transition)
  const prevTimerRunning = useRef<boolean>(false);
  useEffect(() => {
    const running = timerCfg?.running ?? false;
    if (running && !prevTimerRunning.current) {
      const ids = starterSlots.filter(id => id && playerById[id]);
      const alreadyOnField = onField.filter(id => ids.includes(id)).length;
      if (ids.length > 0 && alreadyOnField === 0) {
        const newEntries = { ...entries };
        ids.forEach(id => { if (!onField.includes(id)) newEntries[id] = currentMs; });
        updateWidgetConfig(widgetId, {
          onField: [...new Set([...onField, ...ids])],
          entries: newEntries,
        });
      }
    }
    prevTimerRunning.current = running;
  }, [timerCfg?.running]);

  const resetSession = () => {
    if (!confirm('Reset all playtime data and cards?')) return;
    updateWidgetConfig(widgetId, { onField: [], entries: {}, accumulated: {}, playerCards: {}, sinBinEntries: {}, orangeCardEntries: {}, subbedOnPlayers: [] });
  };

  // ── Render helpers ────────────────────────────────────────────────

  const starsOnField = starterSlots.filter(id => id && playerById[id] && onField.includes(id)).length;
  const subsOnField  = subSlots.filter(id => id && playerById[id] && onField.includes(id)).length;
  const totalOnField = starsOnField + subsOnField;

  // Available players for slot picker
  const pickOptions = useMemo(() => {
    if (!picking) return [];
    return sortedPlayers.filter(p => {
      if (picking.section === 'starter') return !starterSlots.includes(p.id);
      return !subSlots.includes(p.id);
    });
  }, [picking, sortedPlayers, starterSlots, subSlots]);

  function renderPlayerRow(
    playerId: string,
    section: 'starter' | 'sub',
    slotIdx: number,
  ) {
    const player = playerById[playerId];
    if (!player) return null;
    const active = onField.includes(player.id);
    const timePlayed = getTimePlayed(player.id);
    const isStarter = section === 'starter';
    const isSwapping = pendingSubIn !== null;
    const subbedOff = !active && (accumulated[player.id] ?? 0) > 0;
    const subbedOn  = !subbedOff && subbedOnPlayers.includes(player.id);
    const card = effectiveCard(player.id);
    const dismissed = card === 'red';

    // Swap-mode roles
    const isPendingIn  = pendingSubIn === player.id;
    const isSwapTarget = isSwapping && active && isStarter;
    const isDimmed     = isSwapping && !isPendingIn && !isSwapTarget;

    let rowClass = 'wgt-pl-row';
    if (active)          rowClass += ' wgt-pl-row--active';
    else if (!isStarter) rowClass += ' wgt-pl-row--bench';
    if (isPendingIn)     rowClass += ' wgt-pl-row--pending-in';
    if (isSwapTarget)    rowClass += ' wgt-pl-row--swap-target';
    if (isDimmed)        rowClass += ' wgt-pl-row--dimmed';
    if (card === 'yellow') rowClass += ' wgt-pl-row--sinbin';
    if (card === 'orange') rowClass += ' wgt-pl-row--hia';
    if (dismissed)         rowClass += ' wgt-pl-row--dismissed';

    const canEdit = !!tournament;

    return (
      <div key={player.id} className={rowClass}>
        {cfg.linkedPlayerHighlightId && (
          <button
            className={`wgt-pl-btn wgt-pl-btn--highlight wgt-pl-btn--highlight-left${highlightedPlayerId === player.id ? ' wgt-pl-btn--highlight--active' : ''}`}
            title="Highlight player"
            onClick={() => highlightPlayer(player)}
          >
            ★
          </button>
        )}
        {specialRole(player.jerseyNo) ? (
          <span className="wgt-pl-jersey wgt-pl-role-badge" title={specialRole(player.jerseyNo)!}>
            {player.jerseyNo.toUpperCase()}
          </span>
        ) : (
          <input
            key={`j-${player.id}-${player.jerseyNo}`}
            className="wgt-pl-jersey wgt-pl-jersey--inp"
            style={{ borderColor: active ? teamColor : undefined, color: active ? teamColor : undefined }}
            defaultValue={player.jerseyNo}
            placeholder="#"
            maxLength={3}
            onBlur={e => {
              if (!canEdit) return;
              const jersey = e.target.value.trim();
              const role = specialRole(jersey);
              updatePlayer(tournament!.id, side, player.id, {
                jerseyNo: jersey,
                ...(role && !player.position ? { position: role } : {}),
              });
            }}
            onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
            onClick={e => e.stopPropagation()}
          />
        )}

        <div className="wgt-pl-info">
          {showPos && player.position && (
            <span className="wgt-pl-pos">{player.position}</span>
          )}
          <input
            key={`n-${player.id}-${player.name}`}
            className="wgt-pl-name wgt-pl-name--inp"
            defaultValue={player.name}
            placeholder="Name"
            readOnly={!canEdit}
            onBlur={e => {
              const name = e.target.value.trim();
              if (canEdit) updatePlayer(tournament!.id, side, player.id, { name });
              const vmixIdx = isStarter ? slotIdx + 1 : maxOnField + slotIdx + 1;
              syncName(vmixIdx, player.id, { name });
            }}
            onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
            onClick={e => e.stopPropagation()}
          />
        </div>

        {(subbedOn || subbedOff) && (
          <span
            className={`wgt-pl-sub-ind wgt-pl-sub-ind--${subbedOn ? 'on' : 'off'}`}
            title={subbedOn ? 'Substituted on' : 'Substituted off'}
          >
            {subbedOn ? '↑' : '↓'}
          </span>
        )}

        {card !== 'none' && (
          <span className={`wgt-pl-card-badge wgt-pl-card-badge--${card}`} title={dismissed ? 'Red card — dismissed' : card === 'orange' ? 'Orange card — HIA' : 'Yellow card — sin bin'}>
            {(playerCards[player.id] ?? []).map((c, i) => (
              <span key={i} className={`wgt-pl-card-pip wgt-pl-card-pip--${c}`} />
            ))}
          </span>
        )}

        {/* Sin bin countdown + return button */}
        {card === 'yellow' && sinBinEntries[player.id] !== undefined && (
          (() => {
            const remaining = getSinBinRemaining(player.id);
            const done = remaining === 0;
            return (
              <div className={`wgt-pl-sinbin${done ? ' wgt-pl-sinbin--done' : ''}`} onClick={e => e.stopPropagation()}>
                <span className="wgt-pl-sinbin-timer">{formatTime(remaining, 'mm:ss')}</span>
                <button
                  className="wgt-pl-sinbin-return"
                  title="Return player to field"
                  onClick={() => returnFromSinBin(player.id)}
                >▶ Return</button>
              </div>
            );
          })()
        )}

        {/* HIA return button (orange card) */}
        {card === 'orange' && orangeCardEntries[player.id] !== undefined && (
          <div className="wgt-pl-hia" onClick={e => e.stopPropagation()}>
            <span className="wgt-pl-hia-label">HIA</span>
            <button
              className="wgt-pl-hia-return"
              title="Player cleared — return to field"
              onClick={() => returnFromHIA(player.id)}
            >▶ Return</button>
          </div>
        )}

        {showTime && (
          <span className={`wgt-pl-time ${active ? 'wgt-pl-time--live' : ''}`}>
            {formatTime(timePlayed, 'mm:ss')}
          </span>
        )}

        <div className="wgt-pl-actions">
          {/* ── Swap-mode: active starters show the confirm-swap button ── */}
          {isSwapTarget && (
            <button
              className="wgt-pl-btn wgt-pl-btn--swap"
              title={`Swap in ${playerById[pendingSubIn!]?.name ?? 'player'}`}
              onClick={() => executeSwap(player.id, pendingSubIn!)}
            >
              ↔
            </button>
          )}

          {/* ── Normal mode OR bench/off-field players during swap ── */}
          {!isSwapTarget && (
            <>
              {/* Sub in (bench) / Sub out (active non-starter can still toggle off) */}
              {(!isStarter || active) && !isSwapping && (
                <button
                  className={`wgt-pl-btn ${active ? 'wgt-pl-btn--out' : 'wgt-pl-btn--in'}`}
                  title={active ? 'Sub off' : 'Stage for substitution'}
                  onClick={() => toggleOnField(player)}
                >
                  {active ? '▼' : '▲'}
                </button>
              )}

              {/* Bench player: ▲ stages the swap / ✕ cancels it */}
              {!isStarter && !active && (
                <button
                  className={`wgt-pl-btn ${isPendingIn ? 'wgt-pl-btn--cancel-swap' : 'wgt-pl-btn--in'}`}
                  title={isPendingIn ? 'Cancel substitution' : 'Substitute into game'}
                  onClick={() => {
                    setPicking(null);
                    setPendingSubIn(isPendingIn ? null : player.id);
                  }}
                >
                  {isPendingIn ? '✕' : '▲'}
                </button>
              )}

              {/* Move / Remove — hidden during swap flow */}
              {!isSwapping && (
                <>
                  <button
                    className="wgt-pl-btn wgt-pl-btn--move"
                    title={isStarter ? 'Move to bench' : 'Move to starters'}
                    onClick={() => moveToSection(player.id, isStarter ? 'sub' : 'starter')}
                  >
                    {isStarter ? '⬇' : '⬆'}
                  </button>
                  <button
                    className="wgt-pl-btn wgt-pl-btn--remove"
                    title="Remove from squad"
                    onClick={() => removeFromSlot(section, slotIdx)}
                  >
                    ×
                  </button>
                </>
              )}
            </>
          )}
        </div>
      </div>
    );
  }

  function renderEmptySlot(section: 'starter' | 'sub', idx: number) {
    const isOpen = picking?.section === section && picking?.idx === idx;
    return (
      <div key={`empty-${section}-${idx}`} className="wgt-pl-row wgt-pl-row--empty">
        {isOpen ? (
          <div className="wgt-pl-picker">
            {pickOptions.length === 0 ? (
              <span className="wgt-pl-picker-none">No available players</span>
            ) : pickOptions.map(p => (
              <button
                key={p.id}
                className="wgt-pl-picker-opt"
                onClick={() => assignToSlot(p.id, section, idx)}
              >
                <span className="wgt-pl-picker-no">{p.jerseyNo}</span>
                <span className="wgt-pl-picker-name">{p.name}</span>
                {p.position && <span className="wgt-pl-picker-pos">{p.position}</span>}
              </button>
            ))}
            <button className="wgt-pl-picker-cancel" onClick={() => setPicking(null)}>Cancel</button>
          </div>
        ) : (
          <>
            <span className="wgt-pl-empty-label">— open slot —</span>
            <button
              className="wgt-pl-btn wgt-pl-btn--assign"
              onClick={() => setPicking({ section, idx })}
            >+</button>
          </>
        )}
      </div>
    );
  }

  return (
    <div className="wgt-players" onClick={() => { picking && setPicking(null); pendingSubIn && setPendingSubIn(null); cardPicker && setCardPicker(null); }}>

      {/* Header */}
      <div className="wgt-pl-header" style={{ '--tc': teamColor } as React.CSSProperties}>
        {team?.logo
          ? <img className="wgt-pl-team-logo" src={team.logo} alt="" />
          : <span className="wgt-pl-team-dot" style={{ background: teamColor }} />
        }
        <span className="wgt-pl-team-name">{team?.name ?? '—'}</span>
        {cfg.vmixTeamInputKey && (
          <button
            className="wgt-pl-team-vmix-btn"
            title="Send team name to vMix"
            onClick={e => { e.stopPropagation(); sendTeamToVmix(); }}
          >↗</button>
        )}
        <span className="wgt-pl-field-count">
          <span className={`wgt-pl-on-num ${totalOnField >= maxOnField ? 'wgt-pl-on-num--full' : ''}`}>
            {totalOnField}
          </span>
          <span className="wgt-pl-max-num">/{maxOnField}</span>
        </span>
        {tournament && (
          <div className="wgt-pl-card-btns" onClick={e => e.stopPropagation()}>
            <button
              className={`wgt-pl-card-btn wgt-pl-card-btn--yellow${cardPicker === 'yellow' ? ' wgt-pl-card-btn--active' : ''}`}
              title="Yellow card — sin bin (10 min)"
              onClick={() => setCardPicker(cardPicker === 'yellow' ? null : 'yellow')}
            />
            <button
              className={`wgt-pl-card-btn wgt-pl-card-btn--orange${cardPicker === 'orange' ? ' wgt-pl-card-btn--active' : ''}`}
              title="Orange card — HIA assessment"
              onClick={() => setCardPicker(cardPicker === 'orange' ? null : 'orange')}
            />
            <button
              className={`wgt-pl-card-btn wgt-pl-card-btn--red${cardPicker === 'red' ? ' wgt-pl-card-btn--active' : ''}`}
              title="Red card — permanent dismissal"
              onClick={() => setCardPicker(cardPicker === 'red' ? null : 'red')}
            />
          </div>
        )}
      </div>

      {/* Card picker panel */}
      {cardPicker && (
        <div className="wgt-pl-card-picker" onClick={e => e.stopPropagation()}>
          <div className="wgt-pl-card-picker-hdr">
            <span className={`wgt-pl-card-picker-ico wgt-pl-card-picker-ico--${cardPicker}`} />
            <span className="wgt-pl-card-picker-label">
              {cardPicker ? CARD_LABELS[cardPicker] : ''}
            </span>
            <button className="wgt-pl-card-picker-close" onClick={() => setCardPicker(null)}>✕</button>
          </div>
          <div className="wgt-pl-card-picker-list">
            {cardPickerOptions.length === 0
              ? <span className="wgt-pl-card-picker-empty">No eligible players</span>
              : cardPickerOptions.map(p => (
                  <button
                    key={p.id}
                    className="wgt-pl-card-picker-opt"
                    onClick={() => giveCard(p.id, cardPicker!)}
                  >
                    <span className="wgt-pl-card-picker-no">{p.jerseyNo || '—'}</span>
                    <span className="wgt-pl-card-picker-name">{p.name}</span>
                    {(playerCards[p.id] ?? []).map((c, i) => (
                      <span key={i} className={`wgt-pl-card-pip wgt-pl-card-pip--${c}`} />
                    ))}
                  </button>
                ))
            }
          </div>
        </div>
      )}

      {!tournament ? (
        <div className="wgt-pl-empty">Link a tournament in config</div>
      ) : (
        <div className="wgt-pl-body">

          {/* Auto-fill prompt when both lists are empty */}
          {starterSlots.every(s => !s) && subSlots.every(s => !s) && sortedPlayers.length > 0 && (
            <div className="wgt-pl-autofill">
              <span className="wgt-pl-autofill-hint">Squad not set up yet</span>
              <button className="wgt-pl-autofill-btn" onClick={autoFill}>
                Auto-fill from roster
              </button>
            </div>
          )}

          {/* Starters section */}
          <div className="wgt-pl-section">
            <div className="wgt-pl-section-hdr wgt-pl-section-hdr--starters">
              <span className="wgt-pl-section-icon">◈</span>
              <span className="wgt-pl-section-title">Starting {maxOnField}</span>
              <span className="wgt-pl-section-count">
                {starterSlots.filter(id => id && playerById[id]).length}/{maxOnField}
              </span>
              {/* Kickoff button: only show when starters assigned but not yet on field */}
              {starterSlots.some(id => id && playerById[id]) && starsOnField === 0 && (
                <button className="wgt-pl-kickoff-btn" onClick={kickoff} title="Put all starters on field">
                  Kickoff
                </button>
              )}
            </div>

            <div className="wgt-pl-list" onClick={e => e.stopPropagation()}>
              {starterSlots.map((id, i) =>
                id && playerById[id]
                  ? renderPlayerRow(id, 'starter', i)
                  : renderEmptySlot('starter', i)
              )}
            </div>
          </div>

          {/* Swap banner — shown when a bench player is staged */}
          {pendingSubIn && (
            <div className="wgt-pl-swap-banner" onClick={e => e.stopPropagation()}>
              <span className="wgt-pl-swap-banner-ico">↔</span>
              <span className="wgt-pl-swap-banner-txt">
                Tap a starter to substitute
                <strong> {playerById[pendingSubIn]?.name ?? '—'}</strong>
              </span>
              <button
                className="wgt-pl-swap-banner-cancel"
                onClick={() => setPendingSubIn(null)}
              >✕</button>
            </div>
          )}

          {/* Substitutes section */}
          <div className="wgt-pl-section">
            <div className="wgt-pl-section-hdr wgt-pl-section-hdr--subs">
              <span className="wgt-pl-section-icon">≡</span>
              <span className="wgt-pl-section-title">Substitutes</span>
              <span className="wgt-pl-section-count">
                {subSlots.filter(id => id && playerById[id]).length}/{maxSubs}
              </span>
            </div>

            <div className="wgt-pl-list" onClick={e => e.stopPropagation()}>
              {subSlots.map((id, i) =>
                id && playerById[id]
                  ? renderPlayerRow(id, 'sub', i)
                  : renderEmptySlot('sub', i)
              )}
            </div>
          </div>

          {/* Unassigned players */}
          {unassigned.length > 0 && (
            <div className="wgt-pl-section wgt-pl-section--unassigned">
              <div className="wgt-pl-section-hdr wgt-pl-section-hdr--unassigned">
                <span className="wgt-pl-section-title">Not in squad</span>
                <span className="wgt-pl-section-count">{unassigned.length}</span>
              </div>
              <div className="wgt-pl-list" onClick={e => e.stopPropagation()}>
                {unassigned.map(player => {
                  const uAcc = (accumulated[player.id] ?? 0) > 0;
                  const uSubbedOff = !onField.includes(player.id) && uAcc;
                  return (
                  <div key={player.id} className="wgt-pl-row wgt-pl-row--unassigned">
                    {specialRole(player.jerseyNo) ? (
                      <span className="wgt-pl-jersey wgt-pl-role-badge" title={specialRole(player.jerseyNo)!}>
                        {player.jerseyNo.toUpperCase()}
                      </span>
                    ) : (
                      <input
                        key={`j-${player.id}-${player.jerseyNo}`}
                        className="wgt-pl-jersey wgt-pl-jersey--inp"
                        defaultValue={player.jerseyNo}
                        placeholder="#"
                        maxLength={3}
                        onBlur={e => {
                          const jersey = e.target.value.trim();
                          const role = specialRole(jersey);
                          updatePlayer(tournament!.id, side, player.id, {
                            jerseyNo: jersey,
                            ...(role && !player.position ? { position: role } : {}),
                          });
                        }}
                        onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
                        onClick={e => e.stopPropagation()}
                      />
                    )}
                    <div className="wgt-pl-info">
                      {showPos && player.position && <span className="wgt-pl-pos">{player.position}</span>}
                      <input
                        key={`n-${player.id}-${player.name}`}
                        className="wgt-pl-name wgt-pl-name--inp"
                        defaultValue={player.name}
                        placeholder="Name"
                        onBlur={e => updatePlayer(tournament!.id, side, player.id, { name: e.target.value.trim() })}
                        onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
                        onClick={e => e.stopPropagation()}
                      />
                    </div>
                    {uSubbedOff && (
                      <span className="wgt-pl-sub-ind wgt-pl-sub-ind--off" title="Substituted off">↓</span>
                    )}
                    <div className="wgt-pl-actions">
                      {!specialRole(player.jerseyNo) && (
                        <>
                          <button
                            className="wgt-pl-btn wgt-pl-btn--assign"
                            title="Add to bench"
                            onClick={() => addUnassignedToSection(player.id, 'sub')}
                          >+bench</button>
                          <button
                            className="wgt-pl-btn wgt-pl-btn--assign"
                            title="Add to starters"
                            onClick={() => addUnassignedToSection(player.id, 'starter')}
                          >+start</button>
                        </>
                      )}
                      {!player.jerseyNo && (
                        <>
                          <button
                            className="wgt-pl-btn wgt-pl-btn--role"
                            title="Set as Manager"
                            onClick={() => updatePlayer(tournament!.id, side, player.id, { jerseyNo: 'MNG', position: 'Manager' })}
                          >+MNG</button>
                          <button
                            className="wgt-pl-btn wgt-pl-btn--role"
                            title="Set as Head Coach"
                            onClick={() => updatePlayer(tournament!.id, side, player.id, { jerseyNo: 'HC', position: 'Head Coach' })}
                          >+HC</button>
                        </>
                      )}
                    </div>
                  </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Staff section */}
          {tournament && (() => {
            const defaultStaff: StaffMember[] = DEFAULT_STAFF_ROLES.map(role => ({
              id: role.toLowerCase().replace(/\s+/g, '-'), role, name: '',
            }));
            const rawStaff: StaffMember[] = team?.staff?.length ? team.staff : defaultStaff;
            // Only show roles defined in DEFAULT_STAFF_ROLES — filters out stale roles like "Assistant Manager"
            const staffList: StaffMember[] = DEFAULT_STAFF_ROLES.map(role => {
              const existing = rawStaff.find(s => s.role.toLowerCase() === role.toLowerCase());
              return existing ?? { id: role.toLowerCase().replace(/\s+/g, '-'), role, name: '' };
            });
            const initialized = !!team?.staff?.length;

            // Map role → special jersey code so we can auto-fill from player roster
            const ROLE_TO_JERSEY: Record<string, string> = { 'Manager': 'MNG', 'Head Coach': 'HC' };
            const staffName = (role: string, stored: string): string => {
              const code = ROLE_TO_JERSEY[role];
              if (code) {
                const p = players.find(pl => pl.jerseyNo?.toUpperCase() === code);
                if (p?.name) return p.name;
              }
              return stored;
            };

            // Players with no jersey or non-numeric jersey (MNG, HC, etc.)
            const nonJerseyPlayers = players.filter(p => !p.jerseyNo || isNaN(parseInt(p.jerseyNo)));

            const handleStaffBlur = (memberId: string, name: string) => {
              if (!initialized) {
                const full = defaultStaff.map(s => s.id === memberId ? { ...s, name } : s);
                updateTeam(tournament.id, side, { staff: full });
              } else {
                updateStaffMember(tournament.id, side, memberId, name);
              }
            };

            return (
              <div className="wgt-pl-section wgt-pl-section--staff">
                <div className="wgt-pl-section-hdr wgt-pl-section-hdr--staff">
                  <span className="wgt-pl-section-icon">♟</span>
                  <span className="wgt-pl-section-title">Team Staff</span>
                </div>
                <div className="wgt-pl-list" onClick={e => e.stopPropagation()}>
                  {staffList.map(member => (
                    <div key={member.id} className="wgt-pl-row wgt-pl-row--staff">
                      {cfg.linkedPlayerHighlightId && (
                        <button
                          className={`wgt-pl-btn wgt-pl-btn--highlight wgt-pl-btn--highlight-left${highlightedPlayerId === member.id ? ' wgt-pl-btn--highlight--active' : ''}`}
                          title="Highlight staff member"
                          onClick={() => updateWidgetConfig(cfg.linkedPlayerHighlightId, {
                            highlightedPlayerId:  member.id,
                            highlightedName:      member.name,
                            highlightedJersey:    '',
                            highlightedPosition:  member.role,
                            highlightedTeam:      team?.name ?? '',
                            highlightedTeamColor: team?.color ?? '',
                            highlightedSide:      side,
                          })}
                        >
                          ★
                        </button>
                      )}
                      <span className="wgt-pl-staff-role">{member.role}</span>
                      {(() => {
                        const effective = staffName(member.role, member.name);
                        return (
                          <input
                            key={`staff-${member.id}-${effective}`}
                            className="wgt-pl-name wgt-pl-name--inp wgt-pl-staff-name"
                            defaultValue={effective}
                            placeholder="Enter name…"
                            onBlur={e => handleStaffBlur(member.id, e.target.value.trim())}
                            onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
                            onClick={e => e.stopPropagation()}
                          />
                        );
                      })()}
                      {nonJerseyPlayers.length > 0 && (
                        <select
                          className="wgt-pl-staff-picker"
                          value=""
                          onChange={e => {
                            const name = e.target.value;
                            if (name) handleStaffBlur(member.id, name);
                            e.target.value = '';
                          }}
                          onClick={e => e.stopPropagation()}
                          title="Pick from player list"
                        >
                          <option value="">▾</option>
                          {nonJerseyPlayers.map(p => (
                            <option key={p.id} value={p.name}>{p.name}</option>
                          ))}
                        </select>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            );
          })()}

          {/* Footer */}
          {(onField.length > 0 || Object.keys(cfg.playerCards ?? {}).length > 0 || cfg.vmixInputKey || cfg.vmixStaffInputKey) && (
            <div className="wgt-pl-footer">
              {(onField.length > 0 || Object.keys(cfg.playerCards ?? {}).length > 0) && (
                <button className="wgt-pl-reset" onClick={resetSession}>↺ Reset time &amp; cards</button>
              )}
              {cfg.vmixInputKey && (
                <button className="wgt-pl-reset" onClick={syncAllNames} title="Push all player names to vMix">⇒ Sync Names</button>
              )}
              {cfg.vmixStaffInputKey && (
                <button className="wgt-pl-reset" onClick={sendStaffToVmix} title="Push Manager and Head Coach names to vMix">⇒ Sync Staff</button>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
