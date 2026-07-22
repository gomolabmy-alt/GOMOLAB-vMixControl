// Pure schedule-generation helpers for the Tournament Database's Schedule tab.
// Kept independent of any store so the pairing/bracket math is easy to reason
// about and test in isolation from React/Zustand.

export interface ScheduleTeamRef {
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

/** Standard rugby-sevens tier names, top to bottom by pool finishing rank —
 *  rank 1 (pool winners) play the Cup, rank 2 the Plate, etc. Beyond 4 tiers
 *  there's no standard naming, so it falls back to "Tier 5", "Tier 6", ... */
export const TIER_NAMES = ['Cup', 'Plate', 'Bowl', 'Shield'];

export function tierName(rank: number): string {
  return TIER_NAMES[rank - 1] ?? `Tier ${rank}`;
}

/** Inverts tierName — used to sort tier chips/columns in fixed Cup→Plate→
 *  Bowl→Shield→Tier5… order instead of alphabetically (which would put
 *  "Bowl" before "Cup"). Unrecognized names sort last. */
export function tierRank(tier: string): number {
  const idx = TIER_NAMES.indexOf(tier);
  if (idx >= 0) return idx + 1;
  const m = tier.match(/^Tier (\d+)$/);
  return m ? parseInt(m[1], 10) : Number.MAX_SAFE_INTEGER;
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
 *  to a simple grouping for uncommon group-count/advance-count combos. */
export function buildGroupKnockoutSlots(groupNames: string[], advanceCount: number): ScheduleTeamRef[] {
  if (advanceCount === 2 && groupNames.length % 2 === 0 && groupNames.length >= 2) {
    const half = groupNames.length / 2;
    const firstHalf: ScheduleTeamRef[] = [];
    const secondHalf: ScheduleTeamRef[] = [];
    for (let i = 0; i < half; i++) {
      const gA = groupNames[i];
      const gB = groupNames[groupNames.length - 1 - i];
      firstHalf.push(placeholder(`1st ${gA}`), placeholder(`2nd ${gB}`));
      secondHalf.push(placeholder(`1st ${gB}`), placeholder(`2nd ${gA}`));
    }
    return [...firstHalf, ...secondHalf];
  }
  const list: ScheduleTeamRef[] = [];
  for (let rank = 1; rank <= advanceCount; rank++) {
    for (const g of groupNames) list.push(placeholder(`${ordinal(rank)} ${g}`));
  }
  return list;
}

/** Interleaved entrant list combining two adjacent pool-finishing ranks into
 *  one shared bracket (e.g. rank 1 + rank 2 for a combined Cup/Plate
 *  Quarterfinal) — same clash-avoidance ordering as buildGroupKnockoutSlots'
 *  even-group case (a pool's own two representatives never meet in the very
 *  first round), generalized to any pair of ranks instead of hardcoded to
 *  1st/2nd. */
function buildPairedRankSlots(groupNames: string[], rankA: number, rankB: number): ScheduleTeamRef[] {
  if (groupNames.length % 2 === 0 && groupNames.length >= 2) {
    const half = groupNames.length / 2;
    const firstHalf: ScheduleTeamRef[] = [];
    const secondHalf: ScheduleTeamRef[] = [];
    for (let i = 0; i < half; i++) {
      const gA = groupNames[i];
      const gB = groupNames[groupNames.length - 1 - i];
      firstHalf.push(placeholder(`${ordinal(rankA)} ${gA}`), placeholder(`${ordinal(rankB)} ${gB}`));
      secondHalf.push(placeholder(`${ordinal(rankA)} ${gB}`), placeholder(`${ordinal(rankB)} ${gA}`));
    }
    return [...firstHalf, ...secondHalf];
  }
  const list: ScheduleTeamRef[] = [];
  for (const g of groupNames) list.push(placeholder(`${ordinal(rankA)} ${g}`));
  for (const g of groupNames) list.push(placeholder(`${ordinal(rankB)} ${g}`));
  return list;
}

/** Builds one shared Quarterfinal round between two adjacent tiers (e.g.
 *  Cup/Plate) — the WINNER of each match continues into the upper tier's
 *  own bracket (Cup), the LOSER drops into the lower tier's (Plate), instead
 *  of each tier running a fully independent bracket from round 1. This is
 *  the standard rugby-sevens "reshuffle" format. Returns the QF fixtures
 *  themselves (roundIndex 0, tagged with the combined tier label
 *  "UpperTier/LowerTier") plus each tier's own semifinal-entrant slot list
 *  ("Winner of .../Loser of ..." placeholders), ready to feed into
 *  generateKnockoutFromSlots for the rest of that tier's bracket. */
function buildPairedTierQuarterfinal(groupNames: string[], upperTier: string, lowerTier: string, rankA: number, rankB: number) {
  const pairLabel = `${upperTier}/${lowerTier}`;
  const slots: (ScheduleTeamRef | null)[] = buildPairedRankSlots(groupNames, rankA, rankB);
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
 *  of the day instead of just another one in the middle of the list. */
export function buildTieredKnockout(groupNames: string[], tierCount: number, thirdPlace = false): GeneratedFixture[] {
  const fixtures: GeneratedFixture[] = [];
  const pairStartRanks: number[] = [];
  for (let rank = 1; rank <= tierCount; rank += (rank + 1 <= tierCount ? 2 : 1)) pairStartRanks.push(rank);

  for (const rank of pairStartRanks.reverse()) {
    if (rank + 1 <= tierCount) {
      const upperTier = tierName(rank);
      const lowerTier = tierName(rank + 1);
      const { qfFixtures, upperSemiSlots, lowerSemiSlots } = buildPairedTierQuarterfinal(groupNames, upperTier, lowerTier, rank, rank + 1);
      fixtures.push(...qfFixtures);
      fixtures.push(...offsetRounds(generateKnockoutFromSlots(lowerSemiSlots, thirdPlace).map(f => ({ ...f, tier: lowerTier })), 1));
      fixtures.push(...offsetRounds(generateKnockoutFromSlots(upperSemiSlots, thirdPlace).map(f => ({ ...f, tier: upperTier })), 1));
    } else {
      const tier = tierName(rank);
      const slots = groupNames.map(g => placeholder(`${ordinal(rank)} ${g}`));
      fixtures.push(...generateKnockoutFromSlots(slots, thirdPlace).map(f => ({ ...f, tier })));
    }
  }
  return fixtures;
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
