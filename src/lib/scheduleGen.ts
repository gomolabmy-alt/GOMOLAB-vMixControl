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
  a: ScheduleTeamRef;
  /** null = a bye — "a" advances/wins automatically, no match is played. */
  b: ScheduleTeamRef | null;
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

export function generateRoundRobin(teams: ScheduleTeamRef[], groupLabel?: string): GeneratedFixture[] {
  const rounds = roundRobinRounds(teams);
  const out: GeneratedFixture[] = [];
  rounds.forEach((pairs, i) => {
    const label = groupLabel ? `${groupLabel} · Round ${i + 1}` : `Round ${i + 1}`;
    for (const p of pairs) out.push({ round: label, roundIndex: i, a: p.a, b: p.b });
  });
  return out;
}

export function generateDoubleRoundRobin(teams: ScheduleTeamRef[], groupLabel?: string): GeneratedFixture[] {
  const rounds = roundRobinRounds(teams);
  const n = rounds.length;
  const out: GeneratedFixture[] = [];
  rounds.forEach((pairs, i) => {
    const label = groupLabel ? `${groupLabel} · Round ${i + 1}` : `Round ${i + 1}`;
    for (const p of pairs) out.push({ round: label, roundIndex: i, a: p.a, b: p.b });
  });
  rounds.forEach((pairs, i) => {
    const label = groupLabel ? `${groupLabel} · Round ${n + i + 1} (Return)` : `Round ${n + i + 1} (Return)`;
    for (const p of pairs) {
      if (p.b === null) out.push({ round: label, roundIndex: n + i, a: p.a, b: null });
      else out.push({ round: label, roundIndex: n + i, a: p.b, b: p.a });
    }
  });
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
