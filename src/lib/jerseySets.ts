import type { Player } from '../types/tournament';
import type { SavedTeam } from '../stores/teamDbStore';

/** Resolves the jersey number to actually show/use for a player, given
 *  which jersey set (if any) is active for their team in this match — the
 *  set's override when present and non-empty, else the player's own base
 *  jerseyNo. Role markers (MNG/HC) are never part of a jersey set — call
 *  sites that detect a role marker must keep reading player.jerseyNo
 *  directly rather than going through this resolver. */
export function effectiveJerseyNo(
  player: Player, team: SavedTeam | undefined, activeSetId: string | undefined,
): string {
  if (!activeSetId) return player.jerseyNo;
  const set = team?.jerseySets?.find(js => js.id === activeSetId);
  const override = set?.numbers[player.id];
  return override ? override : player.jerseyNo;
}
