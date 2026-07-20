export interface ShootoutRound { a?: boolean; b?: boolean; }

export interface ShootoutStatus {
  scoreA: number;
  scoreB: number;
  decided: boolean;
  winner?: 'A' | 'B';
}

export function computeShootoutStatus(kicks: ShootoutRound[], kicksPerRound: number): ShootoutStatus {
  const scoreA = kicks.filter(k => k.a === true).length;
  const scoreB = kicks.filter(k => k.b === true).length;
  const reg = kicks.slice(0, kicksPerRound);
  const takenA = reg.filter(k => k.a !== undefined).length;
  const takenB = reg.filter(k => k.b !== undefined).length;
  const madeA = reg.filter(k => k.a === true).length;
  const madeB = reg.filter(k => k.b === true).length;
  const remA = kicksPerRound - takenA;
  const remB = kicksPerRound - takenB;
  // Standard shootout rule: decided the moment a side can't mathematically
  // be caught, even before every regulation kick is taken.
  if (madeA > madeB + remB) return { scoreA, scoreB, decided: true, winner: 'A' };
  if (madeB > madeA + remA) return { scoreA, scoreB, decided: true, winner: 'B' };
  if (takenA === kicksPerRound && takenB === kicksPerRound && madeA !== madeB) {
    return { scoreA, scoreB, decided: true, winner: madeA > madeB ? 'A' : 'B' };
  }
  // Sudden death: rounds after regulation, one kick each; decided as soon as
  // a fully-taken round leaves the cumulative makes unequal.
  for (let i = kicksPerRound; i < kicks.length; i++) {
    const k = kicks[i];
    if (k.a === undefined || k.b === undefined) break; // round still in progress
    const mA = kicks.slice(0, i + 1).filter(x => x.a === true).length;
    const mB = kicks.slice(0, i + 1).filter(x => x.b === true).length;
    if (mA !== mB) return { scoreA, scoreB, decided: true, winner: mA > mB ? 'A' : 'B' };
  }
  return { scoreA, scoreB, decided: false };
}

/** How many round rows the UI should render: always the full regulation
 *  length, plus one more sudden-death row each time the previous one
 *  finishes still tied. */
export function shootoutRoundsNeeded(kicks: ShootoutRound[], kicksPerRound: number): number {
  let n = kicksPerRound;
  while (true) {
    const slice = kicks.slice(0, n);
    if (computeShootoutStatus(slice, kicksPerRound).decided) return n;
    const fullyTaken = slice.length === n && slice.every(k => k.a !== undefined && k.b !== undefined);
    if (!fullyTaken) return n;
    n++;
    if (n > kicksPerRound + 50) return n; // safety bound, unreachable in practice
  }
}
