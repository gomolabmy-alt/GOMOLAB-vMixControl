import type { CanvasWidget } from '../types/canvas';
import type { SavedTeam } from '../stores/teamDbStore';

/** A "side-by-side" Player List (or its Next Match variant) covers both
 *  teams from one widget instance, under a_/b_-prefixed config fields —
 *  everything else is a single-team widget with unprefixed fields. */
export function isDualPlayerList(w: CanvasWidget): boolean {
  return w.type === 'player-list-next' || w.config?.layout === 'side-by-side';
}

export interface PlayerListRoster {
  team: SavedTeam | undefined;
  starters: string[];
  subs: string[];
  onField: string[];
  subbedOnPlayers: string[];
  playerCards: Record<string, ('yellow' | 'orange' | 'red')[]>;
  sinBinEntries: Record<string, number>;
}

const EMPTY_ROSTER: PlayerListRoster = {
  team: undefined, starters: [], subs: [], onField: [], subbedOnPlayers: [], playerCards: {}, sinBinEntries: {},
};

/**
 * Reads a Player List widget's roster for one side — the one place that
 * understands both shapes this widget can be in: a single-team widget
 * (unprefixed config fields, team cached in `resolvedTeamId`), or one
 * side-by-side/Next Match instance covering both sides at once (a_/b_
 * prefixed fields, team cached in `a_resolvedTeamId`/`b_resolvedTeamId`).
 * `resolvedTeamId` is written back by the Player List widget itself (see
 * PlayerListWidget.tsx) since the actual team lookup — direct pick, follow
 * a scoreboard, or the next unsent fixture — only that widget can do; every
 * other consumer (Scoreboard's scorer picker, Card Display, Timeline
 * highlight, etc.) just reads the cached result.
 */
export function resolvePlayerListRoster(
  w: CanvasWidget | undefined, side: 'A' | 'B', teams: SavedTeam[],
): PlayerListRoster {
  if (!w) return EMPTY_ROSTER;
  const prefix = isDualPlayerList(w) ? (side === 'A' ? 'a_' : 'b_') : '';
  const cfg = w.config;
  const team = teams.find(t => t.id === cfg[`${prefix}resolvedTeamId`]);
  return {
    team,
    starters: cfg[`${prefix}starters`] ?? [],
    subs: cfg[`${prefix}subs`] ?? [],
    onField: cfg[`${prefix}onField`] ?? [],
    subbedOnPlayers: cfg[`${prefix}subbedOnPlayers`] ?? [],
    playerCards: cfg[`${prefix}playerCards`] ?? {},
    sinBinEntries: cfg[`${prefix}sinBinEntries`] ?? {},
  };
}
