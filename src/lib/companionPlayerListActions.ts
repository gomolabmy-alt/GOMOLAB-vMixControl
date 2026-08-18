import type { CanvasPage } from '../types/canvas';
import { isDualPlayerList, resolvePlayerListRoster } from './playerListSquad';
import { autoLinkedWidget } from './autoLink';
import { useTeamDbStore } from '../stores/teamDbStore';
import { useTournamentStore } from '../stores/tournamentStore';
import { useAppSettings } from '../stores/appSettingsStore';
import { simplifyPlayerName } from './simpleName';
import { SPORT_DEFAULTS } from '../types/tournament';

export interface CompanionRosterChoice {
  playerId: string;
  jerseyNo: string;
  name: string;
  /** Where this player currently sits in the SAME Player List's lineup —
   *  e.g. "Starter 3"/"Sub 2" — or undefined when they're not currently in
   *  any slot. Only collectCompanionSlotTargets populates this (it's the
   *  one collector with starters/subs arrays already in scope); other
   *  roster consumers (cards/highlight) leave it unset. Lets the "Assign
   *  armed slot" player picker show at a glance that picking someone
   *  already in a slot MOVES them (removed from their old slot, placed in
   *  the armed one) rather than duplicating them — same whether that's a
   *  starter↔sub swap or within the same section. */
  currentSlot?: string;
}

function toRoster(players: { id: string; jerseyNo?: string; name: string }[]): CompanionRosterChoice[] {
  const { simplifyMuhammadNames, simplifyFirstNameOnly, removeBinMarkers, truncateAtBinMarker } = useAppSettings.getState();
  return players.map(p => ({
    playerId: p.id, jerseyNo: p.jerseyNo || '',
    name: simplifyPlayerName(p.name, { simplifyMuhammad: simplifyMuhammadNames, firstNameOnly: simplifyFirstNameOnly, removeBinMarkers, truncateAtBinMarker }),
  }));
}

export interface CompanionSlotTarget {
  /** `${widgetId}:slot:${side}:${section}:${slotIndex}` — slotIndex is
   *  0-based, matching the array index in config.starters/subs. */
  id: string;
  widgetId: string;
  side: 'A' | 'B';
  section: 'starter' | 'sub';
  slotIndex: number;
  label: string;
  /** Full team roster (every player, not just currently-assigned ones) —
   *  this fills the slot, it doesn't just show who's in it. */
  roster: CompanionRosterChoice[];
}

// Every fillable slot of every Player List widget — the write side of the
// same "Starter N"/"Sub N" fields collectCompanionAppText already exposes
// as read-only display text. Mirrors PlayerListWidget.tsx's own
// assignToSlot(): placing a player here removes them from wherever else
// they were (starter or sub), same as dragging them in the app's own UI.
export function collectCompanionSlotTargets(pages: CanvasPage[]): CompanionSlotTarget[] {
  const out: CompanionSlotTarget[] = [];
  const teams = useTeamDbStore.getState().teams;
  const tournaments = useTournamentStore.getState().tournaments;

  for (const page of pages) {
    for (const w of page.widgets) {
      if (w.type !== 'player-list' && w.type !== 'player-list-next') continue;
      const cfg: any = w.config ?? {};
      const tournamentId: string | undefined = cfg.linkedTournamentId || page.tournamentId;
      const tournament = tournaments.find(t => t.id === tournamentId);
      const settings = tournament ? (tournament.settings ?? SPORT_DEFAULTS[tournament.sport]) : undefined;
      const maxOnField = settings?.maxOnField ?? 11;
      const maxSubs = settings?.maxSubs ?? 7;
      const dual = isDualPlayerList(w);
      const sides: ('A' | 'B')[] = dual ? ['A', 'B'] : ['A'];
      const label = w.label || 'Player List';

      for (const side of sides) {
        const { team, starters, subs } = resolvePlayerListRoster(w, side, teams);
        const currentSlotOf = new Map<string, string>();
        starters.forEach((pid, i) => { if (pid) currentSlotOf.set(pid, `Starter ${i + 1}`); });
        subs.forEach((pid, i) => { if (pid) currentSlotOf.set(pid, `Sub ${i + 1}`); });
        const roster = toRoster(team?.players ?? []).map(p => ({ ...p, currentSlot: currentSlotOf.get(p.playerId) }));
        const sidePrefix = dual ? `${side} — ` : '';
        for (let i = 0; i < maxOnField; i++) {
          out.push({ id: `${w.id}:slot:${side}:starter:${i}`, widgetId: w.id, side, section: 'starter', slotIndex: i, label: `${label} — ${sidePrefix}Starter ${i + 1}`, roster });
        }
        for (let i = 0; i < maxSubs; i++) {
          out.push({ id: `${w.id}:slot:${side}:sub:${i}`, widgetId: w.id, side, section: 'sub', slotIndex: i, label: `${label} — ${sidePrefix}Sub ${i + 1}`, roster });
        }
      }
    }
  }
  return out;
}

export interface CompanionCardTarget {
  /** `${widgetId}:card:${side}` — one per side, not per player: the player
   *  is a choice within it, alongside the card type. */
  id: string;
  widgetId: string;
  side: 'A' | 'B';
  label: string;
  /** Currently-assigned (starter or sub), non-dismissed players only — same
   *  eligibility PlayerListWidget.tsx's own card picker uses. */
  roster: CompanionRosterChoice[];
}

// One target per Player List side — giving a card needs picking both a
// player AND a card type, so the flattened dropdown choice has to encode
// player+type together (same reasoning as the scorer/player pickers before
// it); see companionBridge.ts for how giveCard's full side-effects
// (playerCards, on-field removal + accumulated time, sin bin/HIA timers,
// local stat count, timeline event) are replicated on trigger.
export function collectCompanionCardTargets(pages: CanvasPage[]): CompanionCardTarget[] {
  const out: CompanionCardTarget[] = [];
  const teams = useTeamDbStore.getState().teams;

  for (const page of pages) {
    for (const w of page.widgets) {
      if (w.type !== 'player-list' && w.type !== 'player-list-next') continue;
      const dual = isDualPlayerList(w);
      const sides: ('A' | 'B')[] = dual ? ['A', 'B'] : ['A'];
      const label = w.label || 'Player List';

      for (const side of sides) {
        const { team, starters, subs, playerCards } = resolvePlayerListRoster(w, side, teams);
        const assignedIds = [...starters, ...subs].filter((id, i, arr) => id && arr.indexOf(id) === i);
        const eligible = assignedIds
          .map(id => team?.players.find(p => p.id === id))
          .filter((p): p is NonNullable<typeof p> => {
            if (!p) return false;
            const cards = playerCards[p.id] ?? [];
            const yellows = cards.filter(c => c === 'yellow').length;
            return !(cards.includes('red') || yellows >= 2);
          });
        const sidePrefix = dual ? `${side} — ` : '';
        out.push({ id: `${w.id}:card:${side}`, widgetId: w.id, side, label: `${label} — ${sidePrefix}Give Card`, roster: toRoster(eligible) });
      }
    }
  }
  return out;
}

export interface CompanionHighlightTarget {
  /** `${widgetId}:highlight:${side}`. */
  id: string;
  widgetId: string;
  side: 'A' | 'B';
  /** The Player Lower Third widget this side's highlight writes into. */
  targetWidgetId: string;
  label: string;
  roster: CompanionRosterChoice[];
}

// One target per Player List side that has a Player Lower Third linked
// (config.linkedPlayerHighlightId) — replicates highlightPlayer() from
// PlayerListWidget.tsx: patches the linked lower third's own
// highlightedName/Jersey/Position/Team/TeamColor/Side fields directly,
// same as clicking a player's "highlight" button in the app.
export function collectCompanionHighlightTargets(pages: CanvasPage[]): CompanionHighlightTarget[] {
  const out: CompanionHighlightTarget[] = [];
  const teams = useTeamDbStore.getState().teams;

  for (const page of pages) {
    for (const w of page.widgets) {
      if (w.type !== 'player-list' && w.type !== 'player-list-next') continue;
      const cfg: any = w.config ?? {};
      if (!cfg.linkedPlayerHighlightId) continue;
      const targetWidget = autoLinkedWidget(pages, w.id, cfg.linkedPlayerHighlightId, 'player-lower-third');
      if (!targetWidget) continue;
      const dual = isDualPlayerList(w);
      const sides: ('A' | 'B')[] = dual ? ['A', 'B'] : ['A'];
      const label = w.label || 'Player List';

      for (const side of sides) {
        const { team } = resolvePlayerListRoster(w, side, teams);
        const sidePrefix = dual ? `${side} — ` : '';
        out.push({
          id: `${w.id}:highlight:${side}`, widgetId: w.id, side, targetWidgetId: targetWidget.id,
          label: `${label} — ${sidePrefix}Highlight Player`, roster: toRoster(team?.players ?? []),
        });
      }
    }
  }
  return out;
}
