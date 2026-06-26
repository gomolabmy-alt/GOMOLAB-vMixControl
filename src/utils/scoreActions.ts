const ACTION_ORDER = ['Try', 'Conversion', 'Penalty Try', 'Drop Kick', 'Penalty Kick'];

const PLURALS: Record<string, string> = {
  'try':          'Tries',
  'conversion':   'Conversions',
  'penalty try':  'Penalty Tries',
  'drop kick':    'Drop Kicks',
  'penalty kick': 'Penalty Kicks',
};

const SINGULARS: Record<string, string> = {
  'try':          'Try',
  'conversion':   'Conversion',
  'penalty try':  'Penalty Try',
  'drop kick':    'Drop Kick',
  'penalty kick': 'Penalty Kick',
};

function inflect(action: string, count: number): string {
  const key = action.toLowerCase();
  if (count === 1) return SINGULARS[key] ?? action;
  return PLURALS[key] ?? action + 's';
}

export function sortActionEntries(entries: [string, number][]): [string, number][] {
  return [...entries].sort(([a], [b]) => {
    const ai = ACTION_ORDER.findIndex(o => o.toLowerCase() === a.toLowerCase());
    const bi = ACTION_ORDER.findIndex(o => o.toLowerCase() === b.toLowerCase());
    const an = ai === -1 ? ACTION_ORDER.length : ai;
    const bn = bi === -1 ? ACTION_ORDER.length : bi;
    return an - bn;
  });
}

export function buildActionSummary(actions: Record<string, number>): string {
  return sortActionEntries(Object.entries(actions))
    .map(([act, count]) => `${count} ${inflect(act, count)}`)
    .join(', ');
}
