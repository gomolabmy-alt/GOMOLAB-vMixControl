import { useMatchScheduleStore } from '../stores/matchScheduleStore';
import { findTierMismatches } from '../components/TournamentManager';

/** One-time-per-launch backfill: silently corrects every DETERMINISTIC tier
 *  mismatch findTierMismatches finds (resolvable: true — derived directly
 *  from a fixture's own round text or a "Winner/Loser of" reference, never
 *  a guess against another possibly-also-wrong fixture), so a drag/swap
 *  that left the wrong tier behind gets fixed automatically instead of
 *  needing the operator to click through the Schedule/Bracket tab's repair
 *  banner. A genuinely ambiguous mismatch (resolvable: false, or a match's
 *  flagged sides disagreeing on the fix) is deliberately left for that
 *  banner instead of guessing. Scoped per tournament — findTierMismatches
 *  itself only groups by category, so two different tournaments sharing a
 *  category name (e.g. both have "LELAKI") would otherwise get mixed
 *  together. Only ever changes `tier`; safe to rerun every launch (a
 *  no-op once nothing resolvable is left). Returns how many fixtures were
 *  corrected, for a console log. */
export function backfillTierMismatches(): number {
  const tournamentIds = Array.from(new Set(
    useMatchScheduleStore.getState().matches.map(m => m.tournamentId).filter((t): t is string => !!t)
  ));
  let count = 0;
  for (const tid of tournamentIds) {
    // Iterated to convergence, not just one pass: a Semifinal's own
    // correctness (via matchedPair/sibling-search in findTierMismatches)
    // depends on its feeding Quarterfinal ALREADY being fixed — reading a
    // single snapshot where BOTH are still wrong can leave the downstream
    // fixture unresolved (nothing to compare against yet) even though
    // fixing the Quarterfinal first would have unblocked it. Re-reading
    // fresh state and re-running detection each pass lets a whole
    // Quarterfinal->Semifinal->Final (or nested placement ladder) chain
    // resolve in one launch instead of needing one launch per level. The
    // cap is a safety net against an unexpected cycle, well above any
    // realistic bracket depth — normal convergence takes 2-3 passes.
    for (let pass = 0; pass < 10; pass++) {
      const { matches, updateMatch } = useMatchScheduleStore.getState();
      const tMatches = matches.filter(m => m.tournamentId === tid);
      const mismatches = findTierMismatches(tMatches);
      const byMatch = new Map<string, typeof mismatches>();
      for (const tm of mismatches) {
        if (!byMatch.has(tm.match.id)) byMatch.set(tm.match.id, []);
        byMatch.get(tm.match.id)!.push(tm);
      }
      let fixedThisPass = 0;
      for (const entries of byMatch.values()) {
        if (entries.some(e => !e.resolvable)) continue;
        const tiers = Array.from(new Set(entries.map(e => e.suggestedTier)));
        if (tiers.length !== 1) continue;
        updateMatch(entries[0].match.id, { tier: tiers[0] });
        count++;
        fixedThisPass++;
      }
      if (fixedThisPass === 0) break;
    }
  }
  return count;
}
