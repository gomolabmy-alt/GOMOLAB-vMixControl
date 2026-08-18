// Common spelling variants of "Muhammad" seen in local rosters — matched as
// a whole word (case-insensitive, trailing "." ignored) wherever it appears
// in the name, not just the first word (e.g. "Ahmad Muhammad", "Ali bin
// Muhammad Yusof") so this never touches an unrelated name, only ever
// replaces a like-for-like match with "M.".
const MUHAMMAD_VARIANTS = new Set([
  'muhammad', 'muhamad', 'muhamed', 'mohammad', 'mohamad', 'mohamed',
  'mohammed', 'mohd', 'muhd', 'md',
]);

// Malay/Islamic patronymic/matronymic connectors ("son of"/"daughter of") —
// dropped as whole words (case-insensitive, trailing "." ignored), keeping
// the father's/mother's name that follows (e.g. "Ahmad bin Abdullah" →
// "Ahmad Abdullah"), same word-boundary matching as MUHAMMAD_VARIANTS.
const BIN_MARKERS = new Set(['bin', 'binti', 'bt', 'b']);

export interface SimpleNameOptions {
  simplifyMuhammad?: boolean;
  firstNameOnly?: boolean;
  removeBinMarkers?: boolean;
  /** Drops the connector AND everything after it (e.g. "Ahmad bin Abdullah
   *  Hassan" → "Ahmad"), instead of just the connector word itself. Takes
   *  priority over removeBinMarkers when both are on — nothing's left for
   *  removeBinMarkers to do once the connector and its tail are gone. */
  truncateAtBinMarker?: boolean;
}

/** Shared "Simple Name" transform — used everywhere a player's name is
 *  DISPLAYED read-only or pushed to vMix (see App Settings' "Simple
 *  Names" section, useAppSettings' simplifyMuhammadNames/
 *  simplifyFirstNameOnly/removeBinMarkers/truncateAtBinMarker). All options
 *  are off by default and only ever apply once the operator turns them on
 *  in App Settings — that toggle IS the confirmation, there's no further
 *  per-name prompt.
 *
 *  Deliberately NEVER applied to an editable name input's value — only to
 *  read-only text/labels and vMix push payloads — so turning this on can
 *  never overwrite a player's real stored name with its shortened form. */
export function simplifyPlayerName(name: string, opts: SimpleNameOptions): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return name;
  let kept = [...words];
  if (opts.truncateAtBinMarker) {
    const idx = kept.findIndex(w => BIN_MARKERS.has(w.replace(/\.$/, '').toLowerCase()));
    // idx > 0 guards against a name that starts with the marker itself (or
    // has none at all) — leave it alone rather than returning an empty name.
    if (idx > 0) kept = kept.slice(0, idx);
  } else if (opts.removeBinMarkers) {
    const filtered = kept.filter(w => !BIN_MARKERS.has(w.replace(/\.$/, '').toLowerCase()));
    // Never drop every word (e.g. a name that's literally just "Bin") —
    // fall back to the original list rather than returning an empty name.
    if (filtered.length > 0) kept = filtered;
  }
  if (opts.firstNameOnly) kept = [kept[0]];
  if (opts.simplifyMuhammad) {
    kept = kept.map(w => MUHAMMAD_VARIANTS.has(w.replace(/\.$/, '').toLowerCase()) ? 'M.' : w);
  }
  return kept.join(' ');
}
