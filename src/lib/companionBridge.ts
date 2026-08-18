import { useCanvasStore, formatTime } from '../stores/canvasStore';
import { useVmixStore } from '../stores/vmixStore';
import { useTournamentStore } from '../stores/tournamentStore';
import { useMatchScheduleStore } from '../stores/matchScheduleStore';
import { useAppSettings } from '../stores/appSettingsStore';
import { useTeamDbStore } from '../stores/teamDbStore';
import { simplifyPlayerName } from './simpleName';
import { syncClient } from './syncClient';
import { collectCompanionButtonTargets } from './hotkeyBindings';
import { collectCompanionScoreTargets, collectCompanionScoreboardStatus } from './companionScoreTargets';
import { collectCompanionPlayerSelectors } from './companionPlayerSelectors';
import {
  collectCompanionSlotTargets, collectCompanionCardTargets, collectCompanionHighlightTargets,
} from './companionPlayerListActions';
import { collectCompanionAppText, collectCompanionTimerStages } from './companionAppText';
import { collectCompanionMatchInfo } from './companionMatchInfo';
import { runButtonPress, runButtonRelease, deriveToggleOn } from './buttonActions';
import { isDualPlayerList, resolvePlayerListRoster } from './playerListSquad';
import { autoLinkedWidget } from './autoLink';
import type { CanvasPage, CanvasWidget, TimelineEvent } from '../types/canvas';

function findWidget(pages: CanvasPage[], id: string): CanvasWidget | undefined {
  for (const page of pages) {
    const w = page.widgets.find(x => x.id === id);
    if (w) return w;
  }
  return undefined;
}

function wallClock(): string {
  const d = new Date();
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

// Simple Names (App Settings) — this module runs outside React, so it reads
// the store directly rather than via the useAppSettings() hook.
function dispName(name: string): string {
  const { simplifyMuhammadNames, simplifyFirstNameOnly, removeBinMarkers, truncateAtBinMarker } = useAppSettings.getState();
  return simplifyPlayerName(name, { simplifyMuhammad: simplifyMuhammadNames, firstNameOnly: simplifyFirstNameOnly, removeBinMarkers, truncateAtBinMarker });
}

const _isTauriApp = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

function sendBindingList() {
  const pages = useCanvasStore.getState().pages;
  const bindings = collectCompanionButtonTargets(pages)
    .map(b => ({ id: b.id, label: b.label, mode: b.mode, accelerator: b.accelerator }));
  const scoreTargets = collectCompanionScoreTargets(pages)
    .map(t => ({ id: t.id, label: t.label, widgetId: t.widgetId, widgetLabel: t.widgetLabel, team: t.team, teamName: t.teamName, scoreLabel: t.scoreLabel, scorers: t.scorers, slots: t.slots }));
  const playerSelectors = collectCompanionPlayerSelectors(pages)
    .map(t => ({ id: t.id, label: t.label, needsTeamPick: t.needsTeamPick, choices: t.choices }));
  const slotTargets = collectCompanionSlotTargets(pages)
    .map(t => ({ id: t.id, label: t.label, roster: t.roster }));
  const cardTargets = collectCompanionCardTargets(pages)
    .map(t => ({ id: t.id, label: t.label, roster: t.roster }));
  const highlightTargets = collectCompanionHighlightTargets(pages)
    .map(t => ({ id: t.id, label: t.label, roster: t.roster }));
  syncClient.send({
    type: 'COMPANION_LIST', bindings, scoreTargets, playerSelectors,
    slotTargets, cardTargets, highlightTargets,
  });
}

function sendFeedback() {
  const vmixState = useVmixStore.getState().vmixState;
  const targets = collectCompanionButtonTargets(useCanvasStore.getState().pages);
  const toggles: Record<string, boolean> = {};
  for (const b of targets) {
    if (b.mode !== 'toggle') continue;
    toggles[b.id] = deriveToggleOn([...(b.actions ?? []), ...(b.releaseActions ?? [])], vmixState);
  }
  const pages = useCanvasStore.getState().pages;
  const scoreboards = collectCompanionScoreboardStatus(pages);
  const appText = collectCompanionAppText(pages);
  const matchInfo = collectCompanionMatchInfo();
  const timerStages = collectCompanionTimerStages(pages);
  syncClient.send({
    type: 'COMPANION_FEEDBACK',
    recording: !!vmixState?.recording,
    streaming: !!vmixState?.streaming,
    fadeToBlack: !!vmixState?.fadeToBlack,
    toggles,
    scoreboards,
    appText,
    matchInfo,
    timerStages,
  });
}

// Throttle, not a plain debounce: a plain debounce (clear-and-reschedule on
// every call) never fires at all while changes keep arriving faster than
// the window — which a millisecond-precision Timer widget does (it ticks
// every 20ms while running). That starved Companion of any update for as
// long as such a timer kept running. This still coalesces bursts into one
// send, but guarantees a flush at least once per SYNC_INTERVAL_MS even
// under continuous activity (leading-edge fire when idle, one trailing
// call otherwise).
let trailingTimer: ReturnType<typeof setTimeout> | null = null;
let lastSyncAt = 0;
const SYNC_INTERVAL_MS = 200;

function flushSync() {
  lastSyncAt = Date.now();
  sendBindingList();
  sendFeedback();
}

function scheduleSync() {
  const elapsed = Date.now() - lastSyncAt;
  if (elapsed >= SYNC_INTERVAL_MS) {
    if (trailingTimer) { clearTimeout(trailingTimer); trailingTimer = null; }
    flushSync();
  } else if (!trailingTimer) {
    trailingTimer = setTimeout(() => {
      trailingTimer = null;
      flushSync();
    }, SYNC_INTERVAL_MS - elapsed);
  }
}

/**
 * Bridges a Companion (Bitfocus Stream Deck software) module connected as a
 * plain read-only or commentator sync client. Companion asks for the
 * current list of triggerable targets (COMPANION_REQUEST_LIST), which is six
 * kinds combined into one COMPANION_LIST reply:
 *   - buttons — every Button widget's main + side buttons, plus Scoreboard
 *     "Hotkey Actions" entries, regardless of whether any of them also has
 *     a keyboard shortcut (collectCompanionButtonTargets);
 *   - score targets — every Scoreboard widget's own score buttons (one per
 *     team+increment), each carrying that team's current roster so
 *     Companion can offer a jersey-number picker (collectCompanionScoreTargets);
 *   - player selectors — every widget with its own "pick a player to show"
 *     UI (Player Stats, Head to Head, ...), each carrying the relevant
 *     roster(s) so Companion can offer the same team-then-jersey flow the
 *     widget's own UI has (collectCompanionPlayerSelectors);
 *   - slot targets — every fillable starter/sub slot of every Player List
 *     widget, each carrying that team's full roster to assign into it
 *     (collectCompanionSlotTargets);
 *   - card targets — one per Player List side, carrying its currently
 *     eligible (assigned, not dismissed) players, for giving a card
 *     (collectCompanionCardTargets);
 *   - highlight targets — one per Player List side that has a Player Lower
 *     Third linked, carrying its roster (collectCompanionHighlightTargets).
 * Triggering a button (COMPANION_TRIGGER) is routed through the exact same
 * runButtonPress/runButtonRelease path a real click or OS hotkey uses, so a
 * Stream Deck button (including toggle-mode ones) behaves identically.
 * Triggering a score target calls scoreWidgetAction directly, resolving the
 * scorer's name from the jersey number Companion sent (or none, if the
 * button was configured with no jersey — same as clicking "Skip" in the
 * app's own scorer picker). Triggering a player selector or slot target
 * patches the widget's own config fields directly (playerId/teamSide, or
 * starters/subs) — a persistent state change, not a momentary press.
 * Triggering a card target replicates PlayerListWidget.tsx's own
 * giveCard() in full (playerCards, on-field removal + accumulated time,
 * sin bin/HIA timers, local stat count, timeline event). Triggering a
 * highlight target replicates its own highlightPlayer(), patching the
 * linked Player Lower Third's config directly. Also periodically re-sends
 * the list (widgets can be added/removed/edited) and a feedback broadcast
 * (REC/STR/FTB + toggle on/off per button id, each Scoreboard's live score
 * and most recent scorer, what the controller app itself is displaying —
 * Timer time, Label text, etc, NOT vMix's own state — and general
 * match-context info: current tournament/venue scope and the next unsent
 * fixture) so Companion can color its own buttons and populate Variables
 * without needing to parse anything itself.
 *
 * Desktop-host only — same as every other write-owning background process
 * in this app (cloud sync, hotkeys, tournament auto-advance).
 */
export function startCompanionBridge() {
  if (!_isTauriApp) return;

  syncClient.onMessage((msg) => {
    if (!syncClient.isHost) return;
    if (msg.type === 'COMPANION_REQUEST_LIST') {
      sendBindingList();
      return;
    }
    if (msg.type === 'COMPANION_TRIGGER') {
      const pages = useCanvasStore.getState().pages;

      const scoreTarget = collectCompanionScoreTargets(pages).find(t => t.id === msg.id);
      if (scoreTarget) {
        // Score once on press only — there's no press/release pair for a
        // score, unlike a button (which may be toggle-mode).
        if (msg.state !== 'press') return;
        const scorer = msg.jerseyNo ? scoreTarget.scorers.find(s => s.jerseyNo === msg.jerseyNo) : undefined;
        useCanvasStore.getState().scoreWidgetAction(
          scoreTarget.widgetId, scoreTarget.team, scoreTarget.value, scoreTarget.scoreLabel,
          scorer?.name, msg.jerseyNo || undefined,
        );
        return;
      }

      const selector = collectCompanionPlayerSelectors(pages).find(t => t.id === msg.id);
      if (selector) {
        // Sets which player the widget shows — a persistent config change,
        // not a momentary press/release pair.
        if (msg.state !== 'press') return;
        const choice = selector.choices.find(c => c.playerId === msg.playerId);
        if (!choice) return;
        const patch: Record<string, unknown> = { [selector.configKey]: choice.playerId };
        if (selector.teamSideConfigKey && choice.side) patch[selector.teamSideConfigKey] = choice.side;
        useCanvasStore.getState().updateWidgetConfig(selector.widgetId, patch);
        return;
      }

      const slotTarget = collectCompanionSlotTargets(pages).find(t => t.id === msg.id);
      if (slotTarget) {
        if (msg.state !== 'press') return;
        // Empty playerId means "clear this slot" — a valid choice, not a
        // miss, so only bail if the whole field was omitted.
        if (msg.playerId === undefined) return;
        const w = findWidget(pages, slotTarget.widgetId);
        if (!w) return;
        const dual = isDualPlayerList(w);
        const prefix = dual ? (slotTarget.side === 'A' ? 'a_' : 'b_') : '';
        const cfg: any = w.config ?? {};
        const starters: string[] = [...(cfg[`${prefix}starters`] ?? [])];
        const subs: string[] = [...(cfg[`${prefix}subs`] ?? [])];
        while (starters.length <= slotTarget.slotIndex) starters.push('');
        while (subs.length <= slotTarget.slotIndex) subs.push('');
        // Same as PlayerListWidget.tsx's own assignToSlot(): remove the
        // player from wherever else they were first, so they can't occupy
        // two slots at once.
        if (msg.playerId) {
          const si = starters.indexOf(msg.playerId);
          if (si >= 0) starters[si] = '';
          const bi = subs.indexOf(msg.playerId);
          if (bi >= 0) subs[bi] = '';
        }
        if (slotTarget.section === 'starter') starters[slotTarget.slotIndex] = msg.playerId;
        else subs[slotTarget.slotIndex] = msg.playerId;
        useCanvasStore.getState().updateWidgetConfig(slotTarget.widgetId, {
          [`${prefix}starters`]: starters, [`${prefix}subs`]: subs,
        });
        return;
      }

      const cardTarget = collectCompanionCardTargets(pages).find(t => t.id === msg.id);
      if (cardTarget) {
        if (msg.state !== 'press' || !msg.playerId || !msg.cardType) return;
        const w = findWidget(pages, cardTarget.widgetId);
        if (!w) return;
        const dual = isDualPlayerList(w);
        const prefix = dual ? (cardTarget.side === 'A' ? 'a_' : 'b_') : '';
        const cfg: any = w.config ?? {};
        const k = (key: string) => `${prefix}${key}`;
        const teams = useTeamDbStore.getState().teams;
        const { team } = resolvePlayerListRoster(w, cardTarget.side, teams);
        const fullPlayer = team?.players.find(p => p.id === msg.playerId);
        if (!fullPlayer) return;

        const playerCards: Record<string, ('yellow' | 'orange' | 'red')[]> = cfg[k('playerCards')] ?? {};
        const onField: string[] = cfg[k('onField')] ?? [];
        const accumulated: Record<string, number> = cfg[k('accumulated')] ?? {};
        const entries: Record<string, number> = cfg[k('entries')] ?? {};
        const sinBinEntries: Record<string, number> = cfg[k('sinBinEntries')] ?? {};
        const orangeCardEntries: Record<string, number> = cfg[k('orangeCardEntries')] ?? {};

        const timerWidget = autoLinkedWidget(pages, w.id, cfg.linkedTimerWidgetId, 'timer');
        const timerCfg = timerWidget?.config;
        const currentMs: number = timerCfg?.currentMs ?? 0;
        const timerDown = timerCfg?.mode === 'countdown';
        const elapsed = (entryMs: number) => timerDown ? Math.max(0, entryMs - currentMs) : Math.max(0, currentMs - entryMs);

        const existingCards = playerCards[msg.playerId] ?? [];
        const newCards = [...existingCards, msg.cardType];
        const yellows = newCards.filter(c => c === 'yellow').length;
        const isEffectiveRed = msg.cardType === 'red' || yellows >= 2;

        // Mirrors PlayerListTeamPanel's own giveCard() in PlayerListWidget.tsx.
        const patch: Record<string, unknown> = { [k('playerCards')]: { ...playerCards, [msg.playerId]: newCards } };
        if (onField.includes(msg.playerId)) {
          const timePlayed = (accumulated[msg.playerId] ?? 0) + elapsed(entries[msg.playerId] ?? currentMs);
          patch[k('onField')] = onField.filter(id => id !== msg.playerId);
          patch[k('accumulated')] = { ...accumulated, [msg.playerId]: timePlayed };
        }
        if (msg.cardType === 'yellow' && !isEffectiveRed) {
          patch[k('sinBinEntries')] = { ...sinBinEntries, [msg.playerId]: currentMs };
        } else {
          const next = { ...sinBinEntries };
          delete next[msg.playerId];
          patch[k('sinBinEntries')] = next;
        }
        if (msg.cardType === 'orange') {
          patch[k('orangeCardEntries')] = { ...orangeCardEntries, [msg.playerId]: currentMs };
        } else {
          const next = { ...orangeCardEntries };
          delete next[msg.playerId];
          patch[k('orangeCardEntries')] = next;
        }
        useCanvasStore.getState().updateWidgetConfig(w.id, patch);

        if (team && team.statsSource === 'local' && (msg.cardType === 'yellow' || msg.cardType === 'red')) {
          const statKey = msg.cardType === 'yellow' ? 'yellowCards' : 'redCards';
          useTeamDbStore.getState().updatePlayer(team.id, msg.playerId, { [statKey]: ((fullPlayer as any)[statKey] ?? 0) + 1 });
        }

        const linkedTimelineId = autoLinkedWidget(pages, w.id, cfg.linkedTimelineId, 'timeline')?.id;
        if (linkedTimelineId) {
          const CARD_TIMELINE: Record<string, TimelineEvent['type']> = { yellow: 'yellow-card', orange: 'orange-card', red: 'red-card' };
          useCanvasStore.getState().addTimelineEvent(linkedTimelineId, {
            type: isEffectiveRed ? 'red-card' : CARD_TIMELINE[msg.cardType],
            team: cardTarget.side,
            timeMs: Date.now(),
            timeStr: timerWidget ? formatTime(currentMs, timerCfg?.format ?? 'mm:ss') : wallClock(),
            player: dispName(fullPlayer.name),
            jerseyNo: fullPlayer.jerseyNo || undefined,
          });
        }
        return;
      }

      const highlightTarget = collectCompanionHighlightTargets(pages).find(t => t.id === msg.id);
      if (highlightTarget) {
        if (msg.state !== 'press' || !msg.playerId) return;
        const w = findWidget(pages, highlightTarget.widgetId);
        if (!w) return;
        const teams = useTeamDbStore.getState().teams;
        const { team } = resolvePlayerListRoster(w, highlightTarget.side, teams);
        const fullPlayer = team?.players.find(p => p.id === msg.playerId);
        if (!fullPlayer) return;
        useCanvasStore.getState().updateWidgetConfig(highlightTarget.targetWidgetId, {
          highlightedPlayerId: fullPlayer.id,
          highlightedName: dispName(fullPlayer.name),
          highlightedJersey: fullPlayer.jerseyNo,
          highlightedPosition: fullPlayer.position,
          highlightedTeam: team?.name ?? '',
          highlightedTeamColor: team?.color ?? '',
          highlightedSide: highlightTarget.side,
        });
        return;
      }

      const target = collectCompanionButtonTargets(pages).find(b => b.id === msg.id);
      if (!target) return;
      if (msg.state === 'press') runButtonPress(target);
      else runButtonRelease(target);
    }
  });

  useCanvasStore.subscribe(scheduleSync);
  useVmixStore.subscribe(scheduleSync);
  useTournamentStore.subscribe(scheduleSync);
  useMatchScheduleStore.subscribe(scheduleSync);
  useAppSettings.subscribe(scheduleSync);
  sendBindingList();
  sendFeedback();
}
