// Pure schedule-generation helpers for the Tournament Database's Schedule tab.
// Kept independent of any store so the pairing/bracket math is easy to reason
// about and test in isolation from React/Zustand.

export interface ScheduleTeamRef {
  /** The originating SavedTeam's id, when this ref was built from a real
   *  Team DB record (not a placeholder like "1st Group A") — carried onto
   *  the generated fixture so downstream matching can use it instead of
   *  name+category string matching. */
  id?: string;
  name: string;
  shortName?: string;
  color: string;
  logo?: string;
}

export interface GeneratedFixture {
  round: string;
  /** 0-based calendar round — fixtures sharing a roundIndex are meant to be
   *  played on the same date; the next roundIndex is the next scheduled date. */
  roundIndex: number;
  /** Knockout bracket stage this fixture belongs to (e.g. "Quarterfinal",
   *  "Semifinal", "Final", "Round of 16") — shared by every match in that
   *  stage, unlike `round` which is per-match ("Quarterfinal 2"). Only set
   *  for knockout fixtures; round-robin fixtures leave this undefined. */
  stage?: string;
  /** Tiered-knockout bracket this fixture belongs to ("Cup"/"Plate"/"Bowl"/
   *  "Shield"/"Tier 5"…) — set only when generated via buildTieredKnockout
   *  (rugby-sevens style Cup/Plate/Bowl/Shield split). A SHARED Quarterfinal
   *  between two paired tiers (see buildTieredKnockout) carries a combined
   *  label like "Cup/Plate" instead of a single tier name — its winner
   *  continues in the upper tier's semifinal, its loser drops to the lower
   *  tier's. Undefined for every other format, including the single combined
   *  bracket of 'groups-knockout'. */
  tier?: string;
  a: ScheduleTeamRef;
  /** null = a bye — "a" advances/wins automatically, no match is played. */
  b: ScheduleTeamRef | null;
}

/** A pool/group's name plus its real team count — lets the knockout-slot
 *  builders below know which ranks a given pool can actually supply an
 *  entrant for (an uneven pool, e.g. 3 teams, has no "4th Pool X"), instead
 *  of assuming every pool is the same size. */
export interface PoolInfo { name: string; size: number }

/** Standard rugby-sevens tier names, top to bottom by pool finishing rank —
 *  rank 1 (pool winners) play the Cup, rank 2 the Plate, etc. Beyond 4 tiers
 *  there's no standard naming, so it falls back to "Tier 5", "Tier 6", ... */
export const TIER_NAMES = ['Cup', 'Plate', 'Bowl', 'Shield'];

export function tierName(rank: number): string {
  return TIER_NAMES[rank - 1] ?? `Tier ${rank}`;
}

/** Matches a placement-ladder round/tier label from buildPlacementLadder
 *  below ("9th-12th Placing") — this exact wording is never produced by any
 *  other generator, so it's safe to test with no extra context. */
export function isPlacementRoundLabel(label: string): boolean {
  return /^\d+(?:st|nd|rd|th)-\d+(?:st|nd|rd|th) Placing$/.test(label);
}

/** Parses the {lo, hi} place numbers back out of a label matching
 *  isPlacementRoundLabel, or null if it doesn't match. */
export function placementRoundRange(label: string): { lo: number; hi: number } | null {
  const m = label.match(/^(\d+)(?:st|nd|rd|th)-(\d+)(?:st|nd|rd|th) Placing$/);
  return m ? { lo: parseInt(m[1], 10), hi: parseInt(m[2], 10) } : null;
}

/** Inverts tierName — used to sort tier chips/columns in fixed Cup→Plate→
 *  Bowl→Shield→Tier5…→placement-range order instead of alphabetically
 *  (which would put "Bowl" before "Cup"). Unrecognized names sort last. */
export function tierRank(tier: string): number {
  const idx = TIER_NAMES.indexOf(tier);
  if (idx >= 0) return idx + 1;
  const m = tier.match(/^Tier (\d+)$/);
  if (m) return parseInt(m[1], 10);
  const p = placementRoundRange(tier);
  if (p) return 1000 + p.lo;
  return Number.MAX_SAFE_INTEGER;
}

/** Shifts every fixture's roundIndex by `offset` — used to place a knockout
 *  stage's rounds after a group stage's rounds on the calendar. */
export function offsetRounds(fixtures: GeneratedFixture[], offset: number): GeneratedFixture[] {
  return fixtures.map(f => ({ ...f, roundIndex: f.roundIndex + offset }));
}

export const PLACEHOLDER_COLOR = '#7f8c8d';

function placeholder(label: string): ScheduleTeamRef {
  return { name: label, color: PLACEHOLDER_COLOR };
}

export function ordinal(n: number): string {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return `${n}${s[(v - 20) % 10] ?? s[v] ?? s[0]}`;
}

/** Classic "circle method" round-robin: n-1 rounds (n teams, or n if odd —
 *  the extra slot is a bye that rotates to every team exactly once).
 *  Home/away (a/b) is assigned by a running per-team counter — whichever of
 *  the two teams has had fewer "a" (home) slots so far gets this one — so
 *  every team ends up close to an even home/away split. (A naive "flip
 *  every other round" scheme only balances the ONE team fixed at position 0
 *  during rotation; every other team's side is an accident of the rotation
 *  and can end up almost entirely on one side.) */
function roundRobinRounds<T>(teamsIn: T[]): Array<Array<{ a: T; b: T | null }>> {
  const teams: (T | null)[] = [...teamsIn];
  if (teams.length % 2 !== 0) teams.push(null);
  const n = teams.length;
  const rounds: Array<Array<{ a: T; b: T | null }>> = [];
  let arr = [...teams];
  const homeCount = new Map<T, number>();
  for (const t of teamsIn) homeCount.set(t, 0);
  for (let r = 0; r < n - 1; r++) {
    const roundPairs: Array<{ a: T; b: T | null }> = [];
    for (let i = 0; i < n / 2; i++) {
      const t1 = arr[i];
      const t2 = arr[n - 1 - i];
      if (t1 === null && t2 === null) continue;
      if (t1 === null) { roundPairs.push({ a: t2 as T, b: null }); continue; }
      if (t2 === null) { roundPairs.push({ a: t1, b: null }); continue; }
      const h1 = homeCount.get(t1) ?? 0;
      const h2 = homeCount.get(t2) ?? 0;
      if (h1 <= h2) {
        roundPairs.push({ a: t1, b: t2 });
        homeCount.set(t1, h1 + 1);
      } else {
        roundPairs.push({ a: t2, b: t1 });
        homeCount.set(t2, h2 + 1);
      }
    }
    rounds.push(roundPairs);
    const fixed = arr[0];
    const rest = arr.slice(1);
    rest.unshift(rest.pop()!);
    arr = [fixed, ...rest];
  }
  return rounds;
}

// `round` is deliberately bare ("Round 1") — no group/pool name baked in.
// Which pool a fixture belongs to is already carried on its own `group`
// field (see TournamentManager.tsx's generateForCategory), so merging it
// into `round` too just meant every consumer of `round` alone (e.g. the
// public scoring page) had to duplicate that field back out again.
export function generateRoundRobin(teams: ScheduleTeamRef[]): GeneratedFixture[] {
  const rounds = roundRobinRounds(teams);
  const out: GeneratedFixture[] = [];
  rounds.forEach((pairs, i) => {
    const label = `Round ${i + 1}`;
    for (const p of pairs) out.push({ round: label, roundIndex: i, a: p.a, b: p.b });
  });
  return out;
}

export function generateDoubleRoundRobin(teams: ScheduleTeamRef[]): GeneratedFixture[] {
  const rounds = roundRobinRounds(teams);
  const n = rounds.length;
  const out: GeneratedFixture[] = [];
  rounds.forEach((pairs, i) => {
    const label = `Round ${i + 1}`;
    for (const p of pairs) out.push({ round: label, roundIndex: i, a: p.a, b: p.b });
  });
  rounds.forEach((pairs, i) => {
    const label = `Round ${n + i + 1} (Return)`;
    for (const p of pairs) {
      if (p.b === null) out.push({ round: label, roundIndex: n + i, a: p.a, b: null });
      else out.push({ round: label, roundIndex: n + i, a: p.b, b: p.a });
    }
  });
  return out;
}

/** Round-robin's home/away balancer doesn't know or care about a group's
 *  own ranking — it just evens out home slots over the whole season. This
 *  ensures the group's top-ranked team (whatever team is at index 0 before
 *  any shuffle) specifically gets home advantage for their own earliest
 *  fixture, swapping a/b on just that one match if the balancer happened to
 *  put them away. A no-op for that team's bye rounds (no opponent either way). */
export function ensureTopTeamHomeEarly(fixtures: GeneratedFixture[], topTeamName: string): GeneratedFixture[] {
  let earliestIdx = -1;
  let earliestRoundIndex = Infinity;
  fixtures.forEach((f, i) => {
    if (f.roundIndex < earliestRoundIndex && (f.a.name === topTeamName || f.b?.name === topTeamName)) {
      earliestRoundIndex = f.roundIndex;
      earliestIdx = i;
    }
  });
  if (earliestIdx === -1) return fixtures;
  const f = fixtures[earliestIdx];
  if (f.a.name === topTeamName || !f.b) return fixtures; // already home, or a bye
  const out = fixtures.slice();
  out[earliestIdx] = { ...f, a: f.b, b: f.a };
  return out;
}

function nextPow2(n: number): number {
  let p = 1;
  while (p < n) p *= 2;
  return p;
}

/** Standard bracket seeding order (e.g. size 8 → 1,8,4,5,2,7,3,6) so that
 *  seed 1 and seed 2 can only meet in the final. */
function standardSeedOrder(size: number): number[] {
  let seeds = [1, 2];
  while (seeds.length < size) {
    const n = seeds.length * 2;
    const next: number[] = [];
    for (const s of seeds) next.push(s, n + 1 - s);
    seeds = next;
  }
  return seeds;
}

function knockoutRoundName(teamsInRound: number): string {
  if (teamsInRound === 2) return 'Final';
  if (teamsInRound === 4) return 'Semifinal';
  if (teamsInRound === 8) return 'Quarterfinal';
  return `Round of ${teamsInRound}`;
}

/** Runs a bracket from an already-positioned slot list (nulls = bye slots),
 *  advancing byes automatically and placeholdering unresolved winners. When
 *  `thirdPlace` is set and the bracket actually has a Semifinal round, also
 *  adds a "3rd Place Playoff" between the two Semifinal losers, scheduled
 *  for the same roundIndex as the Final. Tagged with stage "3rd Place" —
 *  deliberately not matching the Final/Semifinal/… pattern, so it's excluded
 *  from the main bracket tree and shown as its own standalone match instead. */
function runBracket(slots: (ScheduleTeamRef | null)[], thirdPlace = false): GeneratedFixture[] {
  const out: GeneratedFixture[] = [];
  let current = slots;
  let roundIndex = 0;
  while (current.length > 1) {
    const roundName = knockoutRoundName(current.length);
    const matchCount = current.length / 2;
    const next: (ScheduleTeamRef | null)[] = [];
    for (let i = 0; i < current.length; i += 2) {
      const matchNum = i / 2 + 1;
      const label = matchCount > 1 ? `${roundName} ${matchNum}` : roundName;
      const a = current[i];
      const b = current[i + 1];
      if (a && b) {
        out.push({ round: label, roundIndex, stage: roundName, a, b });
        next.push(placeholder(`Winner of ${label}`));
      } else if (a && !b) {
        out.push({ round: label, roundIndex, stage: roundName, a, b: null });
        next.push(a);
      } else if (!a && b) {
        out.push({ round: label, roundIndex, stage: roundName, a: b, b: null });
        next.push(b);
      } else {
        next.push(null);
      }
    }
    if (thirdPlace && current.length === 4) {
      out.push({
        round: '3rd Place Playoff',
        roundIndex: roundIndex + 1,
        stage: '3rd Place',
        a: placeholder('Loser of Semifinal 1'),
        b: placeholder('Loser of Semifinal 2'),
      });
    }
    current = next;
    roundIndex++;
  }
  return out;
}

/** Plain single-elimination knockout from a real, ranked team list (index 0
 *  = top seed). `thirdPlace` adds a Semifinal-losers playoff (no-op if the
 *  bracket is too small to have a Semifinal round). */
export function generateKnockout(teamsInSeedOrder: ScheduleTeamRef[], thirdPlace = false): GeneratedFixture[] {
  const size = nextPow2(teamsInSeedOrder.length);
  const seedOrder = standardSeedOrder(size);
  const slots = seedOrder.map(seed => teamsInSeedOrder[seed - 1] ?? null);
  return runBracket(slots, thirdPlace);
}

/** Builds the placeholder entrant list for a Groups→Knockout stage, ordered
 *  as bracket slots directly (no reseeding) so group-mates meet as late as
 *  possible. Handles the common even-group-count case explicitly; falls back
 *  to a simple grouping for uncommon group-count/advance-count combos. A
 *  pool smaller than a given rank (e.g. a 3-team pool has no "4th") simply
 *  contributes no slot at that rank instead of a dead placeholder. */
export function buildGroupKnockoutSlots(pools: PoolInfo[], advanceCount: number): ScheduleTeamRef[] {
  if (advanceCount === 2 && pools.length % 2 === 0 && pools.length >= 2 && pools.every(p => p.size >= advanceCount)) {
    const half = pools.length / 2;
    const firstHalf: ScheduleTeamRef[] = [];
    const secondHalf: ScheduleTeamRef[] = [];
    for (let i = 0; i < half; i++) {
      const gA = pools[i].name;
      const gB = pools[pools.length - 1 - i].name;
      firstHalf.push(placeholder(`1st ${gA}`), placeholder(`2nd ${gB}`));
      secondHalf.push(placeholder(`1st ${gB}`), placeholder(`2nd ${gA}`));
    }
    return [...firstHalf, ...secondHalf];
  }
  const list: ScheduleTeamRef[] = [];
  for (let rank = 1; rank <= advanceCount; rank++) {
    for (const p of pools) { if (p.size >= rank) list.push(placeholder(`${ordinal(rank)} ${p.name}`)); }
  }
  return list;
}

/** Interleaved entrant list combining two adjacent pool-finishing ranks into
 *  one shared bracket (e.g. rank 1 + rank 2 for a combined Cup/Plate
 *  Quarterfinal) — same clash-avoidance ordering as buildGroupKnockoutSlots'
 *  even-group case (a pool's own two representatives never meet in the very
 *  first round), generalized to any pair of ranks instead of hardcoded to
 *  1st/2nd. Pools too small for either rank are left out of that rank's
 *  slots. */
function buildPairedRankSlots(pools: PoolInfo[], rankA: number, rankB: number): ScheduleTeamRef[] {
  if (pools.length % 2 === 0 && pools.length >= 2 && pools.every(p => p.size >= Math.max(rankA, rankB))) {
    const half = pools.length / 2;
    const firstHalf: ScheduleTeamRef[] = [];
    const secondHalf: ScheduleTeamRef[] = [];
    for (let i = 0; i < half; i++) {
      const gA = pools[i].name;
      const gB = pools[pools.length - 1 - i].name;
      firstHalf.push(placeholder(`${ordinal(rankA)} ${gA}`), placeholder(`${ordinal(rankB)} ${gB}`));
      secondHalf.push(placeholder(`${ordinal(rankA)} ${gB}`), placeholder(`${ordinal(rankB)} ${gA}`));
    }
    return [...firstHalf, ...secondHalf];
  }
  const list: ScheduleTeamRef[] = [];
  for (const p of pools) { if (p.size >= rankA) list.push(placeholder(`${ordinal(rankA)} ${p.name}`)); }
  for (const p of pools) { if (p.size >= rankB) list.push(placeholder(`${ordinal(rankB)} ${p.name}`)); }
  return list;
}

/** Splits `candidateCount` same-rank pool finishers (e.g. every pool's 3rd-
 *  place team) into a cross-pool ranked wildcard pool — "Best 3rd", "2nd
 *  Best 3rd", … — used by buildTieredKnockout to fill a shortfall in an
 *  adjacent tier's bracket when there aren't enough pools to supply one real
 *  entrant per slot. The top `neededUp` ranked placeholders promote into the
 *  short tier (`upSlots`); the rest cascade down to become that rank's own
 *  tier's entrant list in full (`downSlots`) — every one of that rank's real
 *  candidates ends up represented by exactly one of these labels, never a
 *  plain "Nth Pool X" one, since the actual team is now cross-ranked rather
 *  than tied to a single pool. */
export function buildBestNthWildcardSlots(
  candidateCount: number, sourceRank: number, neededUp: number,
): { upSlots: ScheduleTeamRef[]; downSlots: ScheduleTeamRef[] } {
  const up = Math.max(0, Math.min(neededUp, candidateCount));
  const all: ScheduleTeamRef[] = [];
  for (let i = 1; i <= candidateCount; i++) {
    const label = i === 1 ? `Best ${ordinal(sourceRank)}` : `${ordinal(i)} Best ${ordinal(sourceRank)}`;
    all.push(placeholder(label));
  }
  return { upSlots: all.slice(0, up), downSlots: all.slice(up) };
}

/** Builds one shared Quarterfinal round between two adjacent tiers (e.g.
 *  Cup/Plate) — the WINNER of each match continues into the upper tier's
 *  own bracket (Cup), the LOSER drops into the lower tier's (Plate), instead
 *  of each tier running a fully independent bracket from round 1. This is
 *  the standard rugby-sevens "reshuffle" format. Takes the already-assembled
 *  entrant slot list (real pool placeholders plus any wildcard slots —
 *  see buildTieredKnockout) instead of building it itself, since the caller
 *  may need to substitute wildcard-ranked slots for a rank that's been fully
 *  borrowed by a higher tier. Returns the QF fixtures themselves (roundIndex
 *  0, tagged with the combined tier label "UpperTier/LowerTier") plus each
 *  tier's own semifinal-entrant slot list ("Winner of .../Loser of ..."
 *  placeholders), ready to feed into generateKnockoutFromSlots for the rest
 *  of that tier's bracket. */
function buildPairedTierQuarterfinal(entrantSlots: ScheduleTeamRef[], upperTier: string, lowerTier: string) {
  const pairLabel = `${upperTier}/${lowerTier}`;
  const slots: (ScheduleTeamRef | null)[] = [...entrantSlots];
  const size = nextPow2(slots.length);
  while (slots.length < size) slots.push(null);

  const qfFixtures: GeneratedFixture[] = [];
  const upperSemiSlots: ScheduleTeamRef[] = [];
  const lowerSemiSlots: ScheduleTeamRef[] = [];
  const matchCount = slots.length / 2;
  for (let i = 0; i < slots.length; i += 2) {
    const matchNum = i / 2 + 1;
    const label = matchCount > 1 ? `Quarterfinal ${matchNum}` : 'Quarterfinal';
    const a = slots[i];
    const b = slots[i + 1];
    if (a && b) {
      qfFixtures.push({ round: label, roundIndex: 0, stage: 'Quarterfinal', tier: pairLabel, a, b });
      upperSemiSlots.push(placeholder(`Winner of ${pairLabel} ${label}`));
      lowerSemiSlots.push(placeholder(`Loser of ${pairLabel} ${label}`));
    } else {
      // A bye in the shared QF — whichever side is real advances straight to
      // the UPPER tier's semifinal (a walkover "win"); there's no loser, so
      // the lower tier's slot is left as an unresolvable placeholder (same
      // as any other bracket bye — it just never fills in).
      const real = a ?? b;
      if (real) qfFixtures.push({ round: label, roundIndex: 0, stage: 'Quarterfinal', tier: pairLabel, a: real, b: null });
      upperSemiSlots.push(real ?? placeholder(`Winner of ${pairLabel} ${label}`));
      lowerSemiSlots.push(placeholder(`Loser of ${pairLabel} ${label}`));
    }
  }
  return { qfFixtures, upperSemiSlots, lowerSemiSlots };
}

/** Builds a full Cup/Plate/Bowl/Shield tiered knockout: adjacent tiers pair
 *  up (Cup+Plate, Bowl+Shield, Tier5+Tier6, …) sharing one Quarterfinal round
 *  whose winner continues in the upper tier and loser drops to the lower
 *  tier (see buildPairedTierQuarterfinal); a leftover odd tier at the bottom
 *  (e.g. 3 tiers total) runs as its own fully independent bracket instead,
 *  same as before this reshuffle format existed. Every stage from the shared
 *  Quarterfinal down to each tier's own Final uses relative roundIndex
 *  0, 1, 2… — caller offsets the whole result to wherever it belongs on the
 *  calendar (see GenerateScheduleModal), same convention as every other
 *  schedule-generation function here.
 *
 *  Built lowest tier first, Cup last: fixtures sharing the same calendar
 *  round (e.g. every tier's Final, all played the same day) keep their
 *  generated order as the Schedule tab's display/running order (via each
 *  fixture's auto-assigned sortIndex — see handleGenerate), so Cup landing
 *  last in this array is what makes the Cup Final the last, marquee match
 *  of the day instead of just another one in the middle of the list.
 *
 *  `useWildcards` handles uneven pool counts (e.g. 3 pools where the bracket
 *  shape wants 4): when a tier/pair's real entrant count falls short of the
 *  next power of 2, the shortfall is borrowed from the next rank down via
 *  buildBestNthWildcardSlots instead of padding with byes — cross-ranking
 *  that rank's pool finishers ("Best 3rd", "2nd Best 3rd"…) and promoting
 *  the top finishers up into the short tier while the remainder cascades
 *  down to become that rank's own tier's entrant list. Because a lower
 *  tier's entrant list can depend on a borrow decision made by the tier
 *  above it, this runs as two passes: an ascending-rank pass that resolves
 *  every borrow/carry-down first, then the descending-rank pass (above)
 *  that actually builds each tier consuming those results. A tier that ends
 *  up with ≤1 real entrant after all that is skipped (with a warning)
 *  instead of silently vanishing. */
export function buildTieredKnockout(
  pools: PoolInfo[], tierCount: number, thirdPlace = false, useWildcards = false,
): { fixtures: GeneratedFixture[]; warnings: string[] } {
  const fixtures: GeneratedFixture[] = [];
  const warnings: string[] = [];
  const pairStartRanks: number[] = [];
  for (let rank = 1; rank <= tierCount; rank += (rank + 1 <= tierCount ? 2 : 1)) pairStartRanks.push(rank);

  // Pass 1 (ascending rank order — must run before the tier-building pass
  // below, since a lower tier's entrant list can depend on whether a higher
  // tier borrowed from it). `carryDown` is always keyed by a value that is
  // itself a pairStartRanks entry (a pair's own sourceRank is always the
  // next pair/leaf's rank), so a plain rank-keyed lookup works for both the
  // paired and standalone-leaf branches below.
  const borrowedUp = new Map<number, ScheduleTeamRef[]>();
  const carryDown = new Map<number, ScheduleTeamRef[]>();
  if (useWildcards) {
    for (const rank of pairStartRanks) {
      const isPair = rank + 1 <= tierCount;
      const carried = carryDown.get(rank);
      const rankACount = (carried && carried.length > 0) ? carried.length : pools.filter(p => p.size >= rank).length;
      const raw = isPair ? rankACount + pools.filter(p => p.size >= rank + 1).length : rankACount;
      if (raw === 0) continue;
      const target = nextPow2(raw);
      const shortfall = target - raw;
      if (shortfall <= 0) continue;
      const sourceRank = isPair ? rank + 2 : rank + 1;
      if (sourceRank > tierCount) continue; // nothing further down to borrow from — shortfall falls back to byes
      const candidateCount = pools.filter(p => p.size >= sourceRank).length;
      if (candidateCount < 2) continue; // not enough pools at that rank to make "best of" meaningful
      const { upSlots, downSlots } = buildBestNthWildcardSlots(candidateCount, sourceRank, shortfall);
      if (upSlots.length > 0) borrowedUp.set(rank, upSlots);
      if (downSlots.length > 0) carryDown.set(sourceRank, downSlots);
    }
  }

  // Pass 2 (descending rank order — lowest tier built first, Cup last).
  for (const rank of pairStartRanks.reverse()) {
    if (rank + 1 <= tierCount) {
      const upperTier = tierName(rank);
      const lowerTier = tierName(rank + 1);
      const carriedA = carryDown.get(rank);
      // If this pair's upper rank was itself fully borrowed by a higher
      // tier, its plain per-pool placeholders no longer exist — every real
      // candidate at that rank is now one of the carried-down wildcard
      // slots instead, so use those in place of (not in addition to) the
      // normal rank-A placeholder loop.
      let slots: ScheduleTeamRef[] = (carriedA && carriedA.length > 0)
        ? [...carriedA, ...pools.filter(p => p.size >= rank + 1).map(p => placeholder(`${ordinal(rank + 1)} ${p.name}`))]
        : buildPairedRankSlots(pools, rank, rank + 1);
      const extraUp = borrowedUp.get(rank);
      if (extraUp && extraUp.length > 0) slots = [...slots, ...extraUp];
      if (slots.length <= 1) {
        warnings.push(`${upperTier}/${lowerTier} would only have ${slots.length} entrant${slots.length === 1 ? '' : 's'} — skipped.`);
        continue;
      }
      const { qfFixtures, upperSemiSlots, lowerSemiSlots } = buildPairedTierQuarterfinal(slots, upperTier, lowerTier);
      fixtures.push(...qfFixtures);
      fixtures.push(...offsetRounds(generateKnockoutFromSlots(lowerSemiSlots, thirdPlace).map(f => ({ ...f, tier: lowerTier })), 1));
      fixtures.push(...offsetRounds(generateKnockoutFromSlots(upperSemiSlots, thirdPlace).map(f => ({ ...f, tier: upperTier })), 1));
    } else {
      const tier = tierName(rank);
      const carried = carryDown.get(rank);
      const slots = (carried && carried.length > 0)
        ? carried
        : pools.filter(p => p.size >= rank).map(p => placeholder(`${ordinal(rank)} ${p.name}`));
      if (slots.length <= 1) {
        warnings.push(`${tier} would only have ${slots.length} entrant${slots.length === 1 ? '' : 's'} — skipped.`);
        continue;
      }
      fixtures.push(...generateKnockoutFromSlots(slots, thirdPlace).map(f => ({ ...f, tier })));
    }
  }
  return { fixtures, warnings };
}

/** Runs a "placement ladder" — unlike runBracket, BOTH the winner and loser
 *  of every match keep playing, recursively, until every position in
 *  [startPlace, startPlace+orderedSlots.length-1] is individually decided.
 *  Round labels are always the exact place-range that round/match decides
 *  ("9th-12th Placing", or "13th-14th Placing" for a lone standalone match)
 *  — never Quarterfinal/Semifinal/Final wording, which is reserved for the
 *  Cup bracket (see buildRankedPlacementKnockout). Byes follow the same
 *  convention as runBracket: the real side auto-advances with no match
 *  played, and the "opponent" branch is left as an unresolvable
 *  placeholder — same as any other bracket bye, and it already interacts
 *  correctly with the existing Bye/Walkover auto-flagging (that keys off
 *  any schedule row with an empty Team B), so no new bye-handling is
 *  needed here. */
export function buildPlacementLadder(orderedSlots: ScheduleTeamRef[], startPlace: number): GeneratedFixture[] {
  const size = nextPow2(orderedSlots.length);
  const slots: (ScheduleTeamRef | null)[] = [...orderedSlots];
  while (slots.length < size) slots.push(null);
  return placementLadderRounds(slots, startPlace);
}

function placementLadderRounds(slots: (ScheduleTeamRef | null)[], startPlace: number): GeneratedFixture[] {
  const n = slots.length;
  if (n <= 1) return [];
  const endPlace = startPlace + n - 1;
  const roundLabel = `${ordinal(startPlace)}-${ordinal(endPlace)} Placing`;
  const matchCount = n / 2;
  const winners: (ScheduleTeamRef | null)[] = [];
  const losers: (ScheduleTeamRef | null)[] = [];
  const out: GeneratedFixture[] = [];
  for (let i = 0; i < n; i += 2) {
    const label = matchCount > 1 ? `${roundLabel} ${i / 2 + 1}` : roundLabel;
    const a = slots[i];
    const b = slots[i + 1];
    if (a && b) {
      out.push({ round: label, roundIndex: 0, stage: roundLabel, a, b });
      winners.push(placeholder(`Winner of ${label}`));
      losers.push(placeholder(`Loser of ${label}`));
    } else if (a || b) {
      const real = (a ?? b)!;
      out.push({ round: label, roundIndex: 0, stage: roundLabel, a: real, b: null });
      winners.push(real);
      losers.push(placeholder(`Loser of ${label}`)); // never resolves — same as any other bracket bye
    } else {
      winners.push(null);
      losers.push(null);
    }
  }
  return [
    ...out,
    ...offsetRounds(placementLadderRounds(winners, startPlace), 1),
    ...offsetRounds(placementLadderRounds(losers, startPlace + matchCount), 1),
  ];
}

/** Builds the "ranked placement" variant of a Cup/tiered knockout: only the
 *  top pair (1st+2nd pool finishers) reshuffle via a shared Quarterfinal
 *  into "Cup" (winners) and a placement bracket (losers) the same way
 *  buildTieredKnockout already does — but every rank below that runs as
 *  its own fully independent placement ladder (see buildPlacementLadder),
 *  labeled purely by the placements it decides ("9th-12th Placing"), with
 *  NO Bowl/Shield/tier-name wording and no reshuffle pairing between
 *  adjacent ranks. This is the shape a real-world tournament schedule (a
 *  rugby-sevens SUKMA sheet) turned out to actually use: Cup's own
 *  Semifinal/Final path is untouched machinery, just re-labeled "Gold
 *  Final"/"Bronze Final" for display; everything else is a flat placement
 *  ladder per rank, merging (via wildcard cascade) into its neighbor only
 *  when it doesn't have enough real entrants to stand on its own.
 *  Additive — does not modify or call buildTieredKnockout. */
export function buildRankedPlacementKnockout(
  pools: PoolInfo[], tierCount: number, thirdPlace = false, useWildcards = false,
): { fixtures: GeneratedFixture[]; warnings: string[] } {
  const fixtures: GeneratedFixture[] = [];
  const warnings: string[] = [];
  if (tierCount < 1) return { fixtures, warnings };

  const realCount = (rank: number) => pools.filter(p => p.size >= rank).length;

  // reducedOwn/cascadeIn below are shared with the rank-3+ walk: a rank
  // used as a wildcard-borrow SOURCE has its plain per-pool placeholders
  // fully REPLACED (never both) by the cross-ranked remainder; a fully
  // degenerate rank's lone leftover cascades whole into the next rank.
  const reducedOwn = new Map<number, ScheduleTeamRef[]>();
  const cascadeIn = new Map<number, ScheduleTeamRef[]>();
  let startPlace: number;

  if (tierCount >= 2) {
    // ── Top pair (ranks 1+2, "Cup") — reshuffles via a shared QF exactly
    // like buildTieredKnockout's own top tier, just with a placement-range
    // label instead of a "Plate" tier name for the loser branch. ─────────
    const topRawSlots = buildPairedRankSlots(pools, 1, 2);
    let topSlots: ScheduleTeamRef[] = topRawSlots;
    if (topRawSlots.length > 0) {
      const topTarget = nextPow2(topRawSlots.length);
      const topShortfall = topTarget - topRawSlots.length;
      if (useWildcards && topShortfall > 0 && tierCount >= 3) {
        const candidateCount = realCount(3);
        if (candidateCount >= 2) {
          const { upSlots, downSlots } = buildBestNthWildcardSlots(candidateCount, 3, topShortfall);
          if (upSlots.length > 0) topSlots = [...topRawSlots, ...upSlots];
          if (downSlots.length > 0) reducedOwn.set(3, downSlots);
        }
      }
    }

    if (topSlots.length > 1) {
      const topSize = nextPow2(topSlots.length);
      const lowerLo = topSize / 2 + 1;
      const lowerHi = topSize;
      const placingLabel = `${ordinal(lowerLo)}-${ordinal(lowerHi)} Placing`;
      const { qfFixtures, upperSemiSlots, lowerSemiSlots } = buildPairedTierQuarterfinal(topSlots, 'Cup', placingLabel);
      fixtures.push(...qfFixtures);
      // "5th-8th Placing" pushed BEFORE Cup's own SF/Final so Cup still
      // lands last in the array — same "marquee match last" convention
      // buildTieredKnockout already relies on for its own Cup tier.
      const placingFixtures = buildPlacementLadder(lowerSemiSlots, lowerLo).map(f => ({ ...f, tier: placingLabel }));
      fixtures.push(...offsetRounds(placingFixtures, 1));
      const cupFixtures = generateKnockoutFromSlots(upperSemiSlots, thirdPlace).map(f => ({
        ...f,
        tier: 'Cup',
        // Cup keeps the existing SF/Final machinery (stage/group
        // untouched, so every existing resolution/display mechanism keeps
        // working) — only the displayed round text for the final changes.
        round: f.round === 'Final' ? 'Gold Final' : f.round === '3rd Place Playoff' ? 'Bronze Final' : f.round,
      }));
      fixtures.push(...offsetRounds(cupFixtures, 1));
    } else if (topSlots.length === 1) {
      warnings.push(`Cup would only have 1 entrant — skipped.`);
    }
    startPlace = nextPow2(topSlots.length) + 1;
  } else {
    // Only rank 1 exists — no pairing partner, so no reshuffle and no
    // lower placement bracket at all, same as buildTieredKnockout's own
    // leaf-only behavior when tierCount === 1.
    const rank1Slots = pools.filter(p => p.size >= 1).map(p => placeholder(`1st ${p.name}`));
    if (rank1Slots.length > 1) {
      fixtures.push(...generateKnockoutFromSlots(rank1Slots, thirdPlace).map(f => ({
        ...f,
        tier: 'Cup',
        round: f.round === 'Final' ? 'Gold Final' : f.round === '3rd Place Playoff' ? 'Bronze Final' : f.round,
      })));
    } else if (rank1Slots.length === 1) {
      warnings.push(`Cup would only have 1 entrant — skipped.`);
    }
    startPlace = nextPow2(rank1Slots.length) + 1;
  }

  // ── Ranks 3..tierCount, each independent ─────────────────────────────
  // startPlace tracks the next unclaimed place number — advances by each
  // bracket's own PADDED slot count (not just real entrants) so a
  // bye-shortened bracket never overlaps the next rank's own numbering.
  const placementByRank = new Map<number, { slots: ScheduleTeamRef[]; startPlace: number }>();

  for (let rank = 3; rank <= tierCount; rank++) {
    const carriedReplacement = reducedOwn.get(rank);
    const ownList = (carriedReplacement && carriedReplacement.length > 0)
      ? carriedReplacement
      : pools.filter(p => p.size >= rank).map(p => placeholder(`${ordinal(rank)} ${p.name}`));
    const cascaded = cascadeIn.get(rank) ?? [];
    // A degenerate rank cascading into this one means every one of THIS
    // rank's own real candidates should also read as cross-ranked labels
    // (e.g. "Best 4th"), for label consistency with the cascaded item,
    // even though this rank's own count didn't itself need a borrow.
    const ownRanked = cascaded.length > 0 && ownList.length > 0
      ? buildBestNthWildcardSlots(ownList.length, rank, ownList.length).upSlots
      : ownList;
    let combined = [...cascaded, ...ownRanked];

    if (combined.length === 0) continue;

    if (combined.length <= 1) {
      // Not enough to stand on its own — cascade the whole thing into the
      // next rank instead of warning-and-skipping (the norm here, unlike
      // buildTieredKnockout, where a degenerate tier really is unusual).
      if (rank + 1 <= tierCount) cascadeIn.set(rank + 1, combined);
      else warnings.push(`${ordinal(rank)}-place bracket would only have ${combined.length} entrant — skipped.`);
      continue;
    }

    const target = nextPow2(combined.length);
    const shortfall = target - combined.length;
    if (useWildcards && shortfall > 0 && rank + 1 <= tierCount) {
      const candidateCount = realCount(rank + 1);
      if (candidateCount >= 2) {
        const { upSlots, downSlots } = buildBestNthWildcardSlots(candidateCount, rank + 1, shortfall);
        if (upSlots.length > 0) combined = [...combined, ...upSlots];
        if (downSlots.length > 0) reducedOwn.set(rank + 1, downSlots);
      }
    }

    placementByRank.set(rank, { slots: combined, startPlace });
    startPlace += nextPow2(combined.length);
  }

  // Push ranks 3..tierCount FIRST (descending), Cup fixtures were already
  // pushed above — same "marquee match lands last in the array" build
  // order buildTieredKnockout already documents and relies on.
  const placementFixtures: GeneratedFixture[] = [];
  for (let rank = tierCount; rank >= 3; rank--) {
    const entry = placementByRank.get(rank);
    if (!entry) continue;
    const hi = entry.startPlace + nextPow2(entry.slots.length) - 1;
    const rangeLabel = `${ordinal(entry.startPlace)}-${ordinal(hi)} Placing`;
    placementFixtures.push(...buildPlacementLadder(entry.slots, entry.startPlace).map(f => ({ ...f, tier: rangeLabel })));
  }
  fixtures.unshift(...placementFixtures);

  return { fixtures, warnings };
}

/** Runs a bracket from already-ordered slots (used for Groups→Knockout, where
 *  the slot order already encodes group-clash avoidance — no reseeding). */
export function generateKnockoutFromSlots(orderedSlots: ScheduleTeamRef[], thirdPlace = false): GeneratedFixture[] {
  const size = nextPow2(orderedSlots.length);
  const slots: (ScheduleTeamRef | null)[] = [...orderedSlots];
  while (slots.length < size) slots.push(null);
  return runBracket(slots, thirdPlace);
}

export function shuffle<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
